-- =============================================================================
-- Nicky Payment Kit — initial schema
-- Migration: 001_nicky_payment_kit.sql
-- =============================================================================
--
-- This migration creates the tables the Nicky payment kit uses to track orders,
-- the Nicky payment requests they map to, incoming webhook events, and the
-- audit trail of server-side status checks.
--
-- Design notes / security:
--   * All tables have Row Level Security ENABLED with NO permissive policies by
--     default. The Edge Functions use the service-role key (which bypasses RLS),
--     so the browser/anon role can never read or write these tables directly.
--     If you want end users to read their own orders from the client, add a
--     scoped SELECT policy yourself — do not open these tables blindly.
--   * Raw Nicky/webhook payloads are stored as JSONB for auditability.
--   * Idempotency is enforced with unique constraints, not application logic
--     alone.
-- =============================================================================

create extension if not exists "pgcrypto";

-- -----------------------------------------------------------------------------
-- Enum: local payment status model
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_type where typname = 'nicky_local_status') then
    create type nicky_local_status as enum (
      'idle',
      'creating_payment',
      'redirecting_to_nicky',
      'waiting_payment',
      'webhook_received',
      'syncing_status',
      'paid',
      'validation_required',
      'canceled',
      'expired_or_abandoned',
      'failed'
    );
  end if;
end$$;

-- -----------------------------------------------------------------------------
-- updated_at trigger helper
-- -----------------------------------------------------------------------------
create or replace function nicky_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- nicky_orders
-- The local commercial obligation. One row per checkout/order.
-- -----------------------------------------------------------------------------
create table if not exists nicky_orders (
  id                        uuid primary key default gen_random_uuid(),

  -- Idempotency: a unique key supplied (or derived) at creation time. Reusing
  -- the same key returns the existing order instead of creating a duplicate.
  idempotency_key           text not null unique,

  -- Commercial details.
  invoice_reference         text not null,
  description               text not null,
  amount_expected_native    numeric(38, 18) not null check (amount_expected_native > 0),

  -- Selected settlement asset (Nicky blockchainAssetId) + display metadata.
  blockchain_asset_id       text not null,
  asset_symbol              text,
  asset_network             text,

  -- Payer.
  payer_email               text not null,
  payer_name                text not null,

  -- Local status (kit's own model).
  status                    nicky_local_status not null default 'creating_payment',

  -- Linkage to Nicky.
  nicky_payment_request_id  text,        -- uuid returned by Nicky
  nicky_short_id            text,        -- short / bill id
  payment_url               text,        -- pay.nicky.me redirect URL

  -- Last known remote status string from Nicky, for debugging/audit.
  last_remote_status        text,

  -- Raw create response from Nicky for auditability.
  nicky_create_response     jsonb,

  -- Arbitrary app metadata (e.g. local user id, product sku). Never trusted for
  -- fulfillment decisions on its own.
  metadata                  jsonb not null default '{}'::jsonb,

  -- Timestamp the order was confirmed paid (server-side Finished only).
  -- Set exactly ONCE, on the first transition to `paid`; never overwritten on
  -- subsequent reconciliations (see _shared/reconcile-helpers.ts).
  paid_at                   timestamptz,

  -- Concurrency guard for create-payment. A non-null, recent value means some
  -- invocation currently "owns" creating the Nicky Payment Request for this
  -- idempotency key. A stale value (older than the claim window) can be
  -- re-claimed so a previously-failed attempt can be retried — but ONLY if the
  -- Nicky create call was not yet attempted (see nicky_create_attempted_at and
  -- nicky_create_or_claim_order() below).
  creation_claimed_at       timestamptz,

  -- Set immediately BEFORE the external Nicky "create payment request" call.
  -- If this is set but there is no nicky_payment_request_id, we cannot tell
  -- whether Nicky created a Payment Request (the external call may have
  -- succeeded while the local write failed). In that case the claim is NOT
  -- auto-re-granted; an operator must review to avoid creating a duplicate
  -- Nicky Payment Request. See docs/operations.md and docs/security.md.
  nicky_create_attempted_at timestamptz,

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create unique index if not exists nicky_orders_payment_request_id_uidx
  on nicky_orders (nicky_payment_request_id)
  where nicky_payment_request_id is not null;

create unique index if not exists nicky_orders_short_id_uidx
  on nicky_orders (nicky_short_id)
  where nicky_short_id is not null;

create index if not exists nicky_orders_status_idx on nicky_orders (status);
create index if not exists nicky_orders_invoice_reference_idx on nicky_orders (invoice_reference);

drop trigger if exists nicky_orders_set_updated_at on nicky_orders;
create trigger nicky_orders_set_updated_at
  before update on nicky_orders
  for each row execute function nicky_set_updated_at();

-- -----------------------------------------------------------------------------
-- nicky_payment_requests
-- A normalized record of the Nicky payment request created for an order. Kept
-- separate from the order so the order remains the durable local object even if
-- the Nicky linkage is recreated.
-- -----------------------------------------------------------------------------
create table if not exists nicky_payment_requests (
  id                        uuid primary key default gen_random_uuid(),
  order_id                  uuid not null references nicky_orders (id) on delete cascade,

  nicky_payment_request_id  text not null unique,  -- uuid from Nicky
  nicky_short_id            text unique,           -- short / bill id
  payment_url               text,

  blockchain_asset_id       text not null,
  amount_expected_native    numeric(38, 18) not null,

  -- Latest remote status seen for this request.
  remote_status             text,

  raw_response              jsonb,                 -- full create/lookup payload

  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

create index if not exists nicky_payment_requests_order_id_idx
  on nicky_payment_requests (order_id);

drop trigger if exists nicky_payment_requests_set_updated_at on nicky_payment_requests;
create trigger nicky_payment_requests_set_updated_at
  before update on nicky_payment_requests
  for each row execute function nicky_set_updated_at();

-- -----------------------------------------------------------------------------
-- nicky_webhook_events
-- Raw, immutable record of every webhook Nicky sends us. Stored BEFORE any
-- processing so we always retain the audit trail, even for events we reject.
-- -----------------------------------------------------------------------------
create table if not exists nicky_webhook_events (
  id                  uuid primary key default gen_random_uuid(),

  -- Idempotency key derived from the webhook payload (see nicky-webhook fn).
  -- Unique so a redelivered webhook is recorded once and acknowledged as a
  -- duplicate.
  dedupe_key          text not null unique,

  web_hook_id         text,
  web_hook_type       text,
  item_id             text,                  -- Nicky payment request id (uuid)

  previous_status     text,
  new_status          text,

  source_ip           text,
  ip_allowed          boolean not null default false,

  raw_payload         jsonb not null,        -- full webhook body, for audit
  raw_headers         jsonb,                 -- selected headers, for audit

  -- Lifecycle of THIS event (drives safe dedupe — see nicky-webhook):
  --   received              : stored, not yet successfully processed
  --   processed             : reconciled successfully (the only "success")
  --   rejected              : refused (e.g. unauthorized source IP)
  --   failed_retryable      : a transient failure; a later delivery may retry
  --   failed_non_retryable  : structurally unusable (e.g. missing itemId)
  -- IMPORTANT: a 'rejected' (unauthorized) event must NOT block a later
  -- authorized event with the same dedupe key from being processed. Only
  -- 'processed' (and 'failed_non_retryable') stop reprocessing.
  processing_status   text not null default 'received'
    check (processing_status in
      ('received','processed','rejected','failed_retryable','failed_non_retryable')),

  -- Retained for audit/back-compat; `processing_status = 'processed'` is the
  -- single source of truth for success.
  processed           boolean not null default false,
  processing_error    text,

  -- The order this event resolved to (if any), for traceability.
  order_id            uuid references nicky_orders (id) on delete set null,

  received_at         timestamptz not null default now(),
  processed_at        timestamptz
);

create index if not exists nicky_webhook_events_item_id_idx
  on nicky_webhook_events (item_id);
create index if not exists nicky_webhook_events_order_id_idx
  on nicky_webhook_events (order_id);

-- -----------------------------------------------------------------------------
-- nicky_payment_status_checks
-- Audit trail of every server-side status lookup we performed against Nicky.
-- This is the source of truth for *why* an order changed status.
-- -----------------------------------------------------------------------------
create table if not exists nicky_payment_status_checks (
  id                        uuid primary key default gen_random_uuid(),
  order_id                  uuid references nicky_orders (id) on delete set null,

  nicky_payment_request_id  text,
  nicky_short_id            text,

  -- What triggered the check: 'webhook', 'frontend_sync', 'manual', 'scheduled'.
  source                    text not null default 'manual',

  remote_status             text,
  resulting_local_status    nicky_local_status,

  raw_response              jsonb,

  created_at                timestamptz not null default now()
);

create index if not exists nicky_payment_status_checks_order_id_idx
  on nicky_payment_status_checks (order_id);
create index if not exists nicky_payment_status_checks_request_id_idx
  on nicky_payment_status_checks (nicky_payment_request_id);

-- -----------------------------------------------------------------------------
-- nicky_assets_cache (optional)
-- Caches the normalized asset list returned by nicky-list-assets so the
-- frontend can be served quickly without hitting Nicky on every page load.
-- -----------------------------------------------------------------------------
create table if not exists nicky_assets_cache (
  id              uuid primary key default gen_random_uuid(),

  -- Single-row cache keyed by a constant; upsert on this key.
  cache_key       text not null unique default 'default',

  assets          jsonb not null,        -- normalized NickyAsset[]
  raw_response    jsonb,

  fetched_at      timestamptz not null default now(),
  -- Cache is considered stale after expires_at.
  expires_at      timestamptz not null default (now() + interval '1 hour')
);

-- -----------------------------------------------------------------------------
-- nicky_create_or_claim_order()
-- Race-safe "create-or-claim" for the create-payment Edge Function.
--
-- Concurrency problem this solves: two simultaneous create-payment calls with
-- the same idempotency key could both see "no existing order", both insert, and
-- both call Nicky — creating duplicate Payment Requests. This function makes the
-- decision atomic in the database:
--
--   1. INSERT ... ON CONFLICT (idempotency_key) DO NOTHING  (atomic de-dupe).
--   2. If the row already has a payment_url -> idempotent hit; return it with
--      claimed = false (caller just returns the existing URL).
--   3. Otherwise try to CLAIM creation with a conditional UPDATE that only
--      succeeds when creation_claimed_at is NULL or older than the stale window.
--      Exactly one concurrent caller wins the claim (claimed = true) and may
--      call Nicky; the others get claimed = false and should ask the caller to
--      retry shortly.
--
-- The stale window lets a previously-failed creation be retried later without
-- permanently locking the idempotency key, while still preventing parallel
-- Nicky Payment Requests for the same key.
--
-- EXTERNAL-CALL CONSISTENCY GUARD: a stale claim is only re-granted when the
-- Nicky create call was NOT yet attempted (nicky_create_attempted_at IS NULL).
-- If the call was attempted but no linkage was persisted, we cannot know
-- whether Nicky created a Payment Request, so we refuse to auto-create another
-- and instead flag `needs_review` for an operator. (Nicky's public API has no
-- documented idempotent-create or lookup-by-invoice-reference, so this manual
-- gate is the safe option — see docs/operations.md and docs/security.md.)
-- -----------------------------------------------------------------------------
create or replace function nicky_create_or_claim_order(
  p_idempotency_key    text,
  p_invoice_reference  text,
  p_description        text,
  p_amount             numeric,
  p_asset_id           text,
  p_payer_email        text,
  p_payer_name         text,
  p_metadata           jsonb default '{}'::jsonb,
  p_claim_stale_seconds int default 120
)
returns table (
  order_id                 uuid,
  status                   nicky_local_status,
  payment_url              text,
  nicky_payment_request_id text,
  nicky_short_id           text,
  claimed                  boolean,
  needs_review             boolean
)
language plpgsql
as $$
declare
  v_row nicky_orders;
begin
  -- 1. Atomic insert-or-ignore on the unique idempotency key.
  insert into nicky_orders (
    idempotency_key, invoice_reference, description, amount_expected_native,
    blockchain_asset_id, payer_email, payer_name, status, metadata
  ) values (
    p_idempotency_key, p_invoice_reference, p_description, p_amount,
    p_asset_id, p_payer_email, p_payer_name, 'creating_payment',
    coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (idempotency_key) do nothing;

  select * into v_row from nicky_orders where idempotency_key = p_idempotency_key;

  -- 2. Already created: return idempotently, no claim needed.
  if v_row.payment_url is not null then
    return query select v_row.id, v_row.status, v_row.payment_url,
      v_row.nicky_payment_request_id, v_row.nicky_short_id, false, false;
    return;
  end if;

  -- 3. Try to claim creation. Grant when:
  --      (a) unclaimed, OR
  --      (b) the claim is stale AND the Nicky call was never attempted.
  --    A stale claim where the Nicky call WAS attempted (but no linkage) is
  --    intentionally NOT re-granted — see the consistency guard above.
  update nicky_orders
     set creation_claimed_at = now()
   where id = v_row.id
     and (
       creation_claimed_at is null
       or (creation_claimed_at < now() - make_interval(secs => p_claim_stale_seconds)
           and nicky_create_attempted_at is null)
     )
  returning * into v_row;

  if found then
    return query select v_row.id, v_row.status, v_row.payment_url,
      v_row.nicky_payment_request_id, v_row.nicky_short_id, true, false;
    return;
  end if;

  -- 4. Claim not granted. Distinguish "another active claim / in progress" from
  --    "needs operator review" (stale claim, Nicky call was attempted, but no
  --    linkage was ever persisted -> possible orphaned Nicky Payment Request).
  select * into v_row from nicky_orders where idempotency_key = p_idempotency_key;

  if v_row.payment_url is null
     and v_row.nicky_payment_request_id is null
     and v_row.nicky_create_attempted_at is not null
     and v_row.creation_claimed_at is not null
     and v_row.creation_claimed_at < now() - make_interval(secs => p_claim_stale_seconds)
  then
    return query select v_row.id, v_row.status, v_row.payment_url,
      v_row.nicky_payment_request_id, v_row.nicky_short_id, false, true;
  else
    return query select v_row.id, v_row.status, v_row.payment_url,
      v_row.nicky_payment_request_id, v_row.nicky_short_id, false, false;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- Row Level Security
-- Enable RLS on every table; add NO policies. The service-role key used by the
-- Edge Functions bypasses RLS. The anon/authenticated browser roles therefore
-- cannot touch these tables unless you intentionally add policies later.
-- -----------------------------------------------------------------------------
alter table nicky_orders                 enable row level security;
alter table nicky_payment_requests        enable row level security;
alter table nicky_webhook_events          enable row level security;
alter table nicky_payment_status_checks   enable row level security;
alter table nicky_assets_cache            enable row level security;
