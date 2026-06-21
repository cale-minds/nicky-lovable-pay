import { useCallback, useRef, useState } from "react";
import type {
  CreatePaymentInput,
  CreatePaymentResult,
  NickyClientConfig,
  NickyLocalStatus,
  SyncPaymentStatusInput,
  SyncPaymentStatusResult,
} from "./types";
import { isTerminal } from "./status";
import { callFunction } from "./client";

export interface UseNickyPaymentResult {
  status: NickyLocalStatus;
  error: string | null;
  orderId: string | null;
  paymentUrl: string | null;
  nickyShortId: string | null;
  remoteStatus: SyncPaymentStatusResult["remoteStatus"] | null;
  paid: boolean;

  /** Creates a payment request and returns its details (does not redirect). */
  createPayment: (input: CreatePaymentInput) => Promise<CreatePaymentResult>;
  /** Creates a payment and immediately redirects the browser to Nicky. */
  createAndRedirect: (input: CreatePaymentInput) => Promise<void>;
  /** Performs a single server-side status sync against Nicky. */
  syncStatus: (locator: SyncPaymentStatusInput) => Promise<SyncPaymentStatusResult>;
  /**
   * Polls `syncStatus` until a terminal status or `maxAttempts` is reached.
   * Intended for the success page after the payer returns from Nicky.
   */
  pollStatus: (
    locator: SyncPaymentStatusInput,
    opts?: { intervalMs?: number; maxAttempts?: number },
  ) => Promise<SyncPaymentStatusResult>;
  reset: () => void;
}

/**
 * Orchestrates the full client-side payment lifecycle against the kit's Edge
 * Functions. No payment is ever marked paid here on its own authority — `paid`
 * only reflects what the server-side Nicky lookup reported (`Finished`).
 */
export function useNickyPayment(config: NickyClientConfig): UseNickyPaymentResult {
  const [status, setStatus] = useState<NickyLocalStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);
  const [paymentUrl, setPaymentUrl] = useState<string | null>(null);
  const [nickyShortId, setNickyShortId] = useState<string | null>(null);
  const [remoteStatus, setRemoteStatus] =
    useState<SyncPaymentStatusResult["remoteStatus"] | null>(null);
  const [paid, setPaid] = useState(false);

  const cancelPollRef = useRef(false);

  const createPayment = useCallback(
    async (input: CreatePaymentInput): Promise<CreatePaymentResult> => {
      setStatus("creating_payment");
      setError(null);
      try {
        const result = await callFunction<CreatePaymentResult>(config, "nicky-create-payment", {
          method: "POST",
          body: input,
        });
        setOrderId(result.orderId);
        setPaymentUrl(result.paymentUrl);
        setNickyShortId(result.nickyShortId);
        setStatus(result.status ?? "waiting_payment");
        return result;
      } catch (err) {
        setStatus("failed");
        setError((err as Error).message);
        throw err;
      }
    },
    [config],
  );

  const createAndRedirect = useCallback(
    async (input: CreatePaymentInput): Promise<void> => {
      const result = await createPayment(input);
      setStatus("redirecting_to_nicky");
      // Full-page redirect to the Nicky-hosted payment page.
      window.location.assign(result.paymentUrl);
    },
    [createPayment],
  );

  const syncStatus = useCallback(
    async (locator: SyncPaymentStatusInput): Promise<SyncPaymentStatusResult> => {
      setStatus("syncing_status");
      setError(null);
      try {
        const result = await callFunction<SyncPaymentStatusResult>(
          config,
          "nicky-sync-payment-status",
          { method: "POST", body: locator },
        );
        setStatus(result.status);
        setRemoteStatus(result.remoteStatus ?? null);
        setPaid(result.paid);
        if (result.orderId) setOrderId(result.orderId);
        if (result.nickyShortId) setNickyShortId(result.nickyShortId);
        return result;
      } catch (err) {
        setError((err as Error).message);
        // Keep prior status rather than forcing failure on a transient sync error.
        throw err;
      }
    },
    [config],
  );

  const pollStatus = useCallback(
    async (
      locator: SyncPaymentStatusInput,
      opts?: { intervalMs?: number; maxAttempts?: number },
    ): Promise<SyncPaymentStatusResult> => {
      const intervalMs = opts?.intervalMs ?? 4000;
      const maxAttempts = opts?.maxAttempts ?? 15;
      cancelPollRef.current = false;

      let last: SyncPaymentStatusResult | null = null;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (cancelPollRef.current) break;
        try {
          last = await syncStatus(locator);
          if (isTerminal(last.status) || last.status === "validation_required") {
            return last;
          }
        } catch {
          // Ignore transient errors and keep polling until attempts run out.
        }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      if (last) return last;
      throw new Error("Could not determine payment status after polling.");
    },
    [syncStatus],
  );

  const reset = useCallback(() => {
    cancelPollRef.current = true;
    setStatus("idle");
    setError(null);
    setOrderId(null);
    setPaymentUrl(null);
    setNickyShortId(null);
    setRemoteStatus(null);
    setPaid(false);
  }, []);

  return {
    status,
    error,
    orderId,
    paymentUrl,
    nickyShortId,
    remoteStatus,
    paid,
    createPayment,
    createAndRedirect,
    syncStatus,
    pollStatus,
    reset,
  };
}
