import type { NickyLocalStatus } from "./types";

export interface NickyPaymentStatusProps {
  status: NickyLocalStatus;
  error?: string | null;
  className?: string;
}

const STATUS_COPY: Record<NickyLocalStatus, string> = {
  idle: "Ready.",
  creating_payment: "Creating your payment…",
  redirecting_to_nicky: "Redirecting you to Nicky…",
  waiting_payment: "Waiting for your payment to be completed.",
  webhook_received: "Payment update received — confirming…",
  syncing_status: "Checking payment status…",
  paid: "Payment confirmed. Thank you!",
  validation_required:
    "Your payment needs additional validation by Nicky. Access stays locked until it clears.",
  canceled: "This payment was canceled.",
  expired_or_abandoned: "This payment expired or was not completed.",
  failed: "Something went wrong with this payment.",
};

/**
 * Small, unstyled status banner. Renders human-readable copy for every status
 * in the kit's local model. Replace or restyle freely.
 *
 * Note: only the `paid` status should gate access to paid features, and it is
 * set from a server-side Nicky confirmation — never from the success redirect.
 */
export function NickyPaymentStatus({ status, error, className }: NickyPaymentStatusProps) {
  return (
    <div className={className} role="status" aria-live="polite">
      <p>{STATUS_COPY[status]}</p>
      {error ? <p style={{ color: "crimson" }}>{error}</p> : null}
    </div>
  );
}
