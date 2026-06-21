// Pure, dependency-free status mapping shared by the Edge Functions.
//
// Kept free of any Deno/Supabase imports so it can be unit-tested directly with
// vitest in Node.

export type NickyRemoteStatus =
  | "PaymentPending"
  | "PaymentValidationRequired"
  | "Finished"
  | "Canceled";

export type NickyLocalStatus =
  | "idle"
  | "creating_payment"
  | "redirecting_to_nicky"
  | "waiting_payment"
  | "webhook_received"
  | "syncing_status"
  | "paid"
  | "validation_required"
  | "canceled"
  | "expired_or_abandoned"
  | "failed";

/**
 * Maps a Nicky remote status string to the kit's local status model.
 *
 * Nicky statuses are strings — there is intentionally NO numeric enum fallback.
 *
 * DECISION: any unrecognized/missing status maps to `failed`. This is the safe,
 * conservative choice: an unknown status must never be treated as `paid`, and
 * `failed` makes the anomaly visible rather than silently leaving the order in a
 * pending-looking state. Only the explicit `Finished` value yields `paid`.
 */
export function mapRemoteStatus(remote: string | undefined | null): NickyLocalStatus {
  switch (remote) {
    case "PaymentPending":
      return "waiting_payment";
    case "PaymentValidationRequired":
      return "validation_required";
    case "Finished":
      return "paid";
    case "Canceled":
      return "canceled";
    default:
      // Unknown or missing status: never assume success.
      return "failed";
  }
}
