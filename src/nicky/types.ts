// Shared TypeScript types for the Nicky payment kit.
//
// These types are intentionally framework-agnostic and are shared between the
// React frontend kit and (conceptually) the Supabase Edge Functions. They
// describe the public-facing contract of the kit, not the full Nicky API.

/**
 * Local payment lifecycle status.
 *
 * This is the kit's own status model. It is deliberately richer than the set of
 * statuses Nicky returns, because it also models UX-only states (such as
 * redirecting to Nicky) that have no server-side equivalent.
 *
 * IMPORTANT: only `paid` means a product/feature should be unlocked, and a local
 * order should only ever reach `paid` after a server-side Nicky lookup returns
 * `Finished`. See docs/security.md.
 */
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
 * Payment request statuses as returned by the Nicky public API.
 */
export type NickyRemoteStatus =
  | "PaymentPending"
  | "PaymentValidationRequired"
  | "Finished"
  | "Canceled";

/**
 * A settlement asset offered by Nicky, normalized for frontend consumption.
 *
 * The kit never hardcodes a currency list. The available assets are read from
 * the Nicky API via the `nicky-list-assets` Edge Function and mapped into this
 * shape.
 */
export interface NickyAsset {
  /** Blockchain asset id used as `blockchainAssetId` when creating a payment. */
  id: string;
  /** Short ticker symbol, e.g. "USDC", "BTC", "ETH". */
  symbol: string;
  /** Human-friendly name, e.g. "USD Coin". */
  name: string;
  /** Network / chain label when available, e.g. "Ethereum", "Polygon". */
  network?: string;
  /** Optional icon URL provided by Nicky. */
  iconUrl?: string;
  /** Number of decimals the asset supports, when known. */
  decimals?: number;
}

/**
 * Input accepted by the `nicky-create-payment` Edge Function.
 */
export interface CreatePaymentInput {
  /** Selected settlement asset id (Nicky `blockchainAssetId`). */
  blockchainAssetId: string;
  /** Native amount expected, as a string to avoid float precision issues. */
  amountExpectedNative: string;
  /** Merchant-side invoice reference / local order reference. */
  invoiceReference: string;
  /** Human-readable description of what is being paid for. */
  description: string;
  /** Payer email address. */
  payerEmail: string;
  /** Payer name. */
  payerName: string;
  /** Whether Nicky should send the payer a notification. Defaults to true. */
  sendNotification?: boolean;
  /** Optional override for the success redirect URL. */
  successUrl?: string;
  /** Optional override for the cancel redirect URL. */
  cancelUrl?: string;
  /**
   * Optional client-supplied idempotency key. If omitted, the Edge Function
   * derives one from the invoice reference. Reusing a key returns the existing
   * order instead of creating a duplicate.
   */
  idempotencyKey?: string;
}

/**
 * Response returned by the `nicky-create-payment` Edge Function.
 */
export interface CreatePaymentResult {
  /** Local order id (primary key in `nicky_orders`). */
  orderId: string;
  /** Nicky payment request id (uuid). */
  nickyPaymentRequestId: string;
  /** Nicky short id / bill id. */
  nickyShortId: string;
  /** URL to redirect the payer to in order to complete payment. */
  paymentUrl: string;
  /** Current local status. */
  status: NickyLocalStatus;
}

/**
 * Response returned by the `nicky-sync-payment-status` Edge Function and used
 * when polling for status from a success page.
 */
export interface SyncPaymentStatusResult {
  orderId: string;
  nickyPaymentRequestId?: string;
  nickyShortId?: string;
  /** Local status after the sync. */
  status: NickyLocalStatus;
  /** Raw Nicky status, for display/debugging. */
  remoteStatus?: NickyRemoteStatus;
  /** Whether the order is fully paid (status === "paid"). Convenience flag. */
  paid: boolean;
}

/**
 * Identifier accepted by the sync endpoint. Provide at least one.
 */
export interface SyncPaymentStatusInput {
  orderId?: string;
  nickyPaymentRequestId?: string;
  nickyShortId?: string;
}

/**
 * Configuration consumed by the frontend hooks/components. These are *public*
 * values only — never the Nicky API key.
 */
export interface NickyClientConfig {
  /** Base URL of your deployed Supabase Edge Functions, e.g.
   *  `https://<project-ref>.functions.supabase.co`. */
  functionsBaseUrl: string;
  /** Supabase anon key, sent as the Authorization bearer + apikey header. */
  supabaseAnonKey: string;
}
