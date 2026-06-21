import type { NickyLocalStatus, NickyRemoteStatus } from "./types";

/**
 * Maps a Nicky remote payment-request status onto the kit's local status model.
 *
 * Only `Finished` maps to `paid`. Everything else is treated conservatively so
 * that paid features are never unlocked on an unconfirmed payment.
 */
export function mapRemoteStatus(remote: NickyRemoteStatus): NickyLocalStatus {
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
      // Unknown status: never assume success.
      return "failed";
  }
}

/** Statuses that represent a terminal outcome (no further polling needed). */
export const TERMINAL_STATUSES: readonly NickyLocalStatus[] = [
  "paid",
  "canceled",
  "expired_or_abandoned",
  "failed",
];

export function isTerminal(status: NickyLocalStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
