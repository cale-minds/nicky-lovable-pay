// Pure, dependency-free helpers for the scheduled reconciliation function.
// No Deno/Supabase imports so they can be unit-tested with vitest.

/**
 * Local statuses considered "open" / still in flight. Terminal states (paid,
 * canceled, expired_or_abandoned, failed) are intentionally excluded.
 */
export const OPEN_STATUSES: readonly string[] = [
  "creating_payment",
  "waiting_payment",
  "webhook_received",
  "syncing_status",
  "validation_required",
];

export interface ReconcileParams {
  limit: number;
  olderThanMinutes: number;
  dryRun: boolean;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_OLDER_THAN_MINUTES = 5;

function toInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return Math.floor(n);
  }
  return undefined;
}

function toBool(value: unknown): boolean {
  return value === true || value === "true" || value === "1";
}

/**
 * Parses + clamps reconciliation parameters from a body/query object.
 * - limit: default 50, clamped to [1, 200]
 * - olderThanMinutes: default 5, clamped to >= 0
 * - dryRun: default false
 */
export function parseReconcileParams(input: Record<string, unknown> | null | undefined): ReconcileParams {
  const src = input ?? {};

  let limit = toInt(src.limit) ?? DEFAULT_LIMIT;
  if (limit < 1) limit = 1;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;

  let olderThanMinutes = toInt(src.olderThanMinutes) ?? DEFAULT_OLDER_THAN_MINUTES;
  if (olderThanMinutes < 0) olderThanMinutes = 0;

  return { limit, olderThanMinutes, dryRun: toBool(src.dryRun) };
}

/** Computes the ISO cutoff timestamp for "older than N minutes". */
export function cutoffIso(olderThanMinutes: number, now: number = Date.now()): string {
  return new Date(now - olderThanMinutes * 60 * 1000).toISOString();
}

/** An order is eligible only if it has at least one Nicky identifier. */
export function hasNickyIdentifier(order: {
  nicky_payment_request_id?: string | null;
  nicky_short_id?: string | null;
}): boolean {
  return Boolean(order.nicky_payment_request_id || order.nicky_short_id);
}
