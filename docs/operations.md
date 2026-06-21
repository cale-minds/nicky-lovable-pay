# Operations Runbook

Day-2 operations for the Nicky payment kit. All queries assume the service-role
context (SQL editor or a server-side admin tool) — these tables are RLS-protected
and not readable from the browser.

## Tables to know

| Table                          | What it holds                                                        |
| ------------------------------ | -------------------------------------------------------------------- |
| `nicky_orders`                 | The local order/obligation, status, Nicky linkage, `paid_at`.        |
| `nicky_payment_requests`       | Normalized record of the Nicky Payment Request for an order.         |
| `nicky_webhook_events`         | Raw, immutable webhook deliveries + processing outcome (audit).      |
| `nicky_payment_status_checks`  | Every server-side Nicky lookup and the resulting local status.       |
| `nicky_assets_cache`           | Cached normalized accepted-assets list.                              |

## Inspect a payment

By local order id:

```sql
select * from nicky_orders where id = '<order-uuid>';
select * from nicky_payment_requests where order_id = '<order-uuid>';
select * from nicky_payment_status_checks where order_id = '<order-uuid>' order by created_at desc;
```

By Nicky Payment Request id (UUID):

```sql
select * from nicky_orders where nicky_payment_request_id = '<request-uuid>';
select * from nicky_webhook_events where item_id = '<request-uuid>' order by received_at desc;
```

By short id:

```sql
select * from nicky_orders where nicky_short_id = '<short-id>';
```

## Manually re-sync one order

Call `nicky-sync-payment-status` (re-queries Nicky and updates local status). It
accepts any one of `orderId`, `nickyPaymentRequestId`, `nickyShortId`:

```bash
curl -X POST "https://<project-ref>.functions.supabase.co/nicky-sync-payment-status" \
  -H "apikey: <anon-key>" -H "Authorization: Bearer <anon-key>" \
  -H "Content-Type: application/json" \
  -d '{"orderId":"<order-uuid>"}'
```

## Manually run the scheduled reconciliation

`nicky-reconcile-open-orders` reconciles open/stuck orders. It requires the
shared secret header. Use `dryRun` first to see what would be touched:

```bash
curl -X POST "https://<project-ref>.functions.supabase.co/nicky-reconcile-open-orders" \
  -H "x-nicky-reconciliation-secret: <NICKY_RECONCILIATION_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"limit":50,"olderThanMinutes":5,"dryRun":true}'
```

Remove `dryRun` (or set it to false) to actually reconcile.

## Scheduling reconciliation

Run the function periodically (e.g. every 5–15 minutes). Options:

- **Supabase scheduled functions / `pg_cron` + `pg_net`** to POST to the function
  URL with the `x-nicky-reconciliation-secret` header.
- An external scheduler (GitHub Actions cron, a worker, etc.) doing the same POST.

This is the operational fallback for **missed/delayed webhooks** and **abandoned
browser redirects**. It never marks anything paid except via a server-side
`Finished` lookup.

## Playbooks

### Order stuck in `waiting_payment`

1. Confirm the payer actually paid (Nicky dashboard).
2. Re-sync the order (above). If Nicky now returns `Finished`, it becomes `paid`.
3. If still pending, it likely was not paid — leave it; reconciliation will keep
   it current. Consider your own expiry policy (move to `expired_or_abandoned`).

### Order stuck in `validation_required`

This is expected while Nicky validates the payment. **Do not unlock paid
features.** Re-sync periodically; it becomes `paid` only when Nicky returns
`Finished`. If it stays here unusually long, collect the logs below and contact
Nicky support.

### Webhook returns 403

The source IP didn't match `NICKY_WEBHOOK_ALLOWED_IP`. Inspect the stored event:

```sql
select source_ip, ip_allowed, raw_headers, raw_payload
from nicky_webhook_events order by received_at desc limit 20;
```

Confirm Nicky's current source IP and that you're reading the **first**
`x-forwarded-for` entry. The event is recorded even when rejected, so you can
diagnose after the fact. Reconciliation still keeps orders current regardless.

### Nicky lookup fails (sync/webhook/reconcile)

- Check the function logs for the HTTP status.
- Verify `NICKY_API_KEY` and `NICKY_API_BASE_URL`.
- The local order is not corrupted by a failed lookup; retry the sync or let
  reconciliation pick it up.

### `nicky_payment_requests` row missing but `nicky_orders` has a Nicky id

This is the known partial-failure case (the order saved but the normalized row
didn't). The order is flagged with `metadata.payment_request_row_missing = true`.
To repair, re-invoke `nicky-create-payment` with the **same idempotency key /
invoice reference** — it hits the idempotent path and re-creates the missing row
via a non-clobbering upsert. Verify:

```sql
select id, status, nicky_payment_request_id, metadata from nicky_orders where id = '<order-uuid>';
select * from nicky_payment_requests where order_id = '<order-uuid>';
```

### Order stuck in `creating_payment`

A creation attempt was interrupted. The `creation_claimed_at` column gates
retries: after the stale window (~2 minutes) a retry with the same idempotency
key can re-claim and re-attempt. If it never progresses, inspect
`nicky_create_response` and the function logs.

## Logs to collect before escalating to Nicky support

- The `nicky_orders` row (id, status, `nicky_payment_request_id`, `nicky_short_id`,
  `last_remote_status`, `nicky_create_response`).
- Relevant `nicky_payment_status_checks` rows (what Nicky returned, when).
- Relevant `nicky_webhook_events` rows (raw payloads + processing outcome).
- Edge Function logs for the time window (`supabase functions logs <name>`).
