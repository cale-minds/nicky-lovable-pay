// Public entry point for the Nicky payment kit (frontend).
//
// Import from here in your Lovable app:
//   import { NickyPayButton, useNickyAssets, useNickyPayment } from "@/nicky";

export * from "./types";
export { mapRemoteStatus, isTerminal, TERMINAL_STATUSES } from "./status";
export { callFunction, NickyFunctionError } from "./client";

export { useNickyAssets } from "./useNickyAssets";
export type { UseNickyAssetsResult } from "./useNickyAssets";

export { useNickyPayment } from "./useNickyPayment";
export type { UseNickyPaymentResult } from "./useNickyPayment";

export { NickyPayButton } from "./NickyPayButton";
export type { NickyPayButtonProps } from "./NickyPayButton";

export { NickyAssetSelector } from "./NickyAssetSelector";
export type { NickyAssetSelectorProps } from "./NickyAssetSelector";

export { NickyPaymentStatus } from "./NickyPaymentStatus";
export type { NickyPaymentStatusProps } from "./NickyPaymentStatus";
