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
  paid_at                   timestamptz,

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
