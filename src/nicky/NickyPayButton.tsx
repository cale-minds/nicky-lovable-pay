import React, { useState } from "react";
import type { CreatePaymentInput, CreatePaymentResult, NickyClientConfig } from "./types";
import { useNickyPayment } from "./useNickyPayment";

export interface NickyPayButtonProps {
  config: NickyClientConfig;
  /** Everything needed to create the payment request. */
  payment: CreatePaymentInput;
  /** If true (default), redirects to Nicky on success. If false, calls onCreated only. */
  redirect?: boolean;
  /** Called after the payment request is created (before any redirect). */
  onCreated?: (result: CreatePaymentResult) => void;
  onError?: (error: Error) => void;
  disabled?: boolean;
  className?: string;
  children?: React.ReactNode;
}

/**
 * Drop-in "Pay with Nicky" button. Creates a payment request via the
 * `nicky-create-payment` Edge Function and (by default) redirects the browser
 * to the Nicky-hosted payment page.
 *
 * The button is intentionally unstyled and dependency-free. Wrap or restyle it
 * to match your app.
 */
export function NickyPayButton({
  config,
  payment,
  redirect = true,
  onCreated,
  onError,
  disabled = false,
  className,
  children,
}: NickyPayButtonProps) {
  const { createPayment, status } = useNickyPayment(config);
  const [busy, setBusy] = useState(false);

  const isBusy = busy || status === "creating_payment" || status === "redirecting_to_nicky";

  async function handleClick() {
    setBusy(true);
    try {
      // Create the payment request exactly once.
      const result = await createPayment(payment);
      onCreated?.(result);
      if (redirect) {
        // Full-page navigation to the Nicky-hosted payment page.
        window.location.assign(result.paymentUrl);
      }
    } catch (err) {
      onError?.(err as Error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className={className}
      disabled={disabled || isBusy}
      onClick={handleClick}
    >
      {children ?? (isBusy ? "Processing…" : "Pay with Nicky")}
    </button>
  );
}
