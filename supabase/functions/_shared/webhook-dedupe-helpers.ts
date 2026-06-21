// Pure, dependency-free helper for safe webhook duplicate handling. No
// Deno/Supabase imports so it can be unit-tested with vitest.
//
// Background: the raw webhook event is persisted BEFORE IP validation (for
// audit). A naive "if a row with this dedupe key exists, ack as duplicate"
// rule is exploitable: an UNAUTHORIZED caller could pre-insert a row with the
// same dedupe key a future legitimate Nicky webhook will use, causing the
// legitimate event to be skipped (dedupe poisoning / denial-of-processing).
//
// This helper decides what to do on a duplicate dedupe key based on the PRIOR
// event's processing_status and whether the CURRENT request is authorized
// (source IP allowed). Only 'processed' (and structurally non-retryable) prior
// events stop reprocessing; a 'rejected' prior event never blocks a later
// authorized delivery.

export type WebhookProcessingStatus =
  | "received"
  | "processed"
  | "rejected"
  | "failed_retryable"
  | "failed_non_retryable";

export type DuplicateAction = "duplicate_ack" | "reprocess" | "reject";

export interface PriorEventState {
  processing_status?: string | null;
}

/**
 * Decide how to handle a redelivered event with an already-seen dedupe key.
 *
 *  - prior 'processed'             -> duplicate_ack (succeeded before; no work)
 *  - prior 'failed_non_retryable'  -> duplicate_ack (same payload won't improve)
 *  - prior 'rejected'/'received'/'failed_retryable':
 *      * current request authorized   -> reprocess (a legitimate delivery wins)
 *      * current request unauthorized  -> reject (don't let it touch anything)
 *
 * A current AUTHORIZED request is never blocked by a prior UNAUTHORIZED event.
 */
export function decideDuplicateAction(
  prior: PriorEventState | null | undefined,
  currentRequestAuthorized: boolean,
): DuplicateAction {
  const status = prior?.processing_status ?? null;

  // Already succeeded — never redo work.
  if (status === "processed") return "duplicate_ack";

  // Structurally unusable before; reprocessing the same payload won't help.
  if (status === "failed_non_retryable") return "duplicate_ack";

  // Otherwise (rejected / received / failed_retryable / unknown): a legitimate
  // authorized delivery should be processed; an unauthorized one is refused.
  return currentRequestAuthorized ? "reprocess" : "reject";
}
