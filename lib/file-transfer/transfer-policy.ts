import { FILE_TRANSFERS_PRO_NAME } from "@/lib/subscriptions";
import {
  DIRECT_TRANSFER_CHUNK_BYTES,
  FREE_TRANSFER_CHUNK_BYTES,
  FREE_TRANSFER_MAX_BYTES,
  FREE_TRANSFER_MAX_SPEED_BYTES_PER_SECOND,
} from "./constants";
import type { SelectedTransferFile } from "./types";

export const FREE_TRANSFER_MAX_SIZE_LABEL = "100 MB";
export const FREE_TRANSFER_MAX_SPEED_LABEL = "5 MB/s";

export interface TransferPolicy {
  chunkBytes: number;
  isPremium: boolean;
  maxBytesPerSecond: number | null;
  maxTransferBytes: number | null;
}

export function getTransferPolicy(isPremium: boolean): TransferPolicy {
  if (isPremium) {
    return {
      chunkBytes: DIRECT_TRANSFER_CHUNK_BYTES,
      isPremium: true,
      maxBytesPerSecond: null,
      maxTransferBytes: null,
    };
  }

  return {
    chunkBytes: FREE_TRANSFER_CHUNK_BYTES,
    isPremium: false,
    maxBytesPerSecond: FREE_TRANSFER_MAX_SPEED_BYTES_PER_SECOND,
    maxTransferBytes: FREE_TRANSFER_MAX_BYTES,
  };
}

export function getTransferSizeLimitMessage(context: "send" | "share" | "receive") {
  if (context === "share") {
    return `Free shares you start can include up to ${FREE_TRANSFER_MAX_SIZE_LABEL} at a time. Upgrade to ${FILE_TRANSFERS_PRO_NAME} for larger shares.`;
  }

  if (context === "receive") {
    return `Free receivers can download at up to ${FREE_TRANSFER_MAX_SPEED_LABEL}. Upgrade to ${FILE_TRANSFERS_PRO_NAME} for full-speed receiving.`;
  }

  return `Free senders can transfer up to ${FREE_TRANSFER_MAX_SIZE_LABEL} at a time. Upgrade to ${FILE_TRANSFERS_PRO_NAME} for larger sends.`;
}

export function assertTransferSizeAllowed({
  context,
  isPremium,
  totalBytes,
}: {
  context: "send" | "share" | "receive";
  isPremium: boolean;
  totalBytes: number;
}) {
  const policy = getTransferPolicy(isPremium);
  if (policy.maxTransferBytes !== null && totalBytes > policy.maxTransferBytes) {
    throw new Error(getTransferSizeLimitMessage(context));
  }

  return policy;
}

export function assertSelectedFilesTransferAllowed(
  files: Pick<SelectedTransferFile, "sizeBytes">[],
  isPremium: boolean,
  context: "send" | "share",
) {
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  return assertTransferSizeAllowed({
    context,
    isPremium,
    totalBytes,
  });
}
