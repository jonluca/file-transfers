import { getTransferChunkSettings } from "@/store";
import { FILE_TRANSFERS_PRO_NAME } from "@/lib/subscriptions";
import {
  FREE_TRANSFER_MAX_BYTES,
  FREE_TRANSFER_MAX_SPEED_BYTES_PER_SECOND,
} from "./constants";
import type { SelectedTransferFile } from "./types";

const DIRECT_TRANSFER_MAX_CONCURRENT_CHUNKS = 2;
const FREE_TRANSFER_MAX_CONCURRENT_CHUNKS = 1;

export const FREE_TRANSFER_MAX_SIZE_LABEL = "100 MB";
export const FREE_TRANSFER_MAX_SPEED_LABEL = "5 MB/s";

export type TransferPolicyContext = "send" | "share" | "receive";

export interface TransferPolicy {
  chunkBytes: number;
  isPremium: boolean;
  maxConcurrentChunks: number;
  maxBytesPerSecond: number | null;
  maxTransferBytes: number | null;
}

export interface TransferSizeLimitNotice {
  title: string;
  description: string;
}

export class TransferSizeLimitError extends Error {
  context: TransferPolicyContext;
  description: string;
  maxTransferBytes: number;
  title: string;
  totalBytes: number;

  constructor({
    context,
    maxTransferBytes,
    totalBytes,
  }: {
    context: TransferPolicyContext;
    maxTransferBytes: number;
    totalBytes: number;
  }) {
    const notice = getTransferSizeLimitNotice({
      context,
      maxTransferBytes,
      totalBytes,
    });

    super(notice.description);

    this.name = "TransferSizeLimitError";
    this.context = context;
    this.description = notice.description;
    this.maxTransferBytes = maxTransferBytes;
    this.title = notice.title;
    this.totalBytes = totalBytes;
  }
}

function formatPolicyBytes(value: number) {
  if (value < 1024) {
    return `${value} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let current = value / 1024;
  let unitIndex = 0;

  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }

  return `${current.toFixed(current >= 100 ? 0 : 1)} ${units[unitIndex]}`;
}

export function getTransferPolicy(isPremium: boolean, context: TransferPolicyContext = "send"): TransferPolicy {
  const { directTransferChunkBytes, freeTransferChunkBytes } = getTransferChunkSettings();

  if (context === "receive") {
    return {
      chunkBytes: directTransferChunkBytes,
      isPremium,
      maxConcurrentChunks: DIRECT_TRANSFER_MAX_CONCURRENT_CHUNKS,
      maxBytesPerSecond: null,
      maxTransferBytes: null,
    };
  }

  if (isPremium) {
    return {
      chunkBytes: directTransferChunkBytes,
      isPremium: true,
      maxConcurrentChunks: DIRECT_TRANSFER_MAX_CONCURRENT_CHUNKS,
      maxBytesPerSecond: null,
      maxTransferBytes: null,
    };
  }

  return {
    chunkBytes: freeTransferChunkBytes,
    isPremium: false,
    maxConcurrentChunks: FREE_TRANSFER_MAX_CONCURRENT_CHUNKS,
    maxBytesPerSecond: FREE_TRANSFER_MAX_SPEED_BYTES_PER_SECOND,
    maxTransferBytes: FREE_TRANSFER_MAX_BYTES,
  };
}

export function getTransferSizeLimitNotice({
  context,
  maxTransferBytes = FREE_TRANSFER_MAX_BYTES,
  totalBytes,
}: {
  context: TransferPolicyContext;
  maxTransferBytes?: number;
  totalBytes?: number;
}): TransferSizeLimitNotice {
  const limitLabel = formatPolicyBytes(maxTransferBytes);
  const selectedSizePrefix = totalBytes ? `This selection is ${formatPolicyBytes(totalBytes)}. ` : "";

  if (context === "share") {
    return {
      title: "Selection too large for free tier",
      description: `${selectedSizePrefix}Free browser shares are limited to ${limitLabel}. Upgrade to ${FILE_TRANSFERS_PRO_NAME} for larger shares.`,
    };
  }

  if (context === "receive") {
    return {
      title: "Nearby receiving is uncapped",
      description: "Nearby transfers only slow down when the sender is on the free tier.",
    };
  }

  return {
    title: "Selection too large for free tier",
    description: `${selectedSizePrefix}Free sends are limited to ${limitLabel} at a time. Remove a file or upgrade to ${FILE_TRANSFERS_PRO_NAME} for larger transfers.`,
  };
}

export function getTransferSizeLimitMessage(context: TransferPolicyContext) {
  return getTransferSizeLimitNotice({ context }).description;
}

export function isTransferSizeLimitError(error: unknown): error is TransferSizeLimitError {
  return error instanceof TransferSizeLimitError;
}

export function assertTransferSizeAllowed({
  context,
  isPremium,
  totalBytes,
}: {
  context: TransferPolicyContext;
  isPremium: boolean;
  totalBytes: number;
}) {
  const policy = getTransferPolicy(isPremium, context);
  if (policy.maxTransferBytes !== null && totalBytes > policy.maxTransferBytes) {
    throw new TransferSizeLimitError({
      context,
      maxTransferBytes: policy.maxTransferBytes,
      totalBytes,
    });
  }

  return policy;
}

export function assertSelectedFilesTransferAllowed(
  files: Pick<SelectedTransferFile, "sizeBytes">[],
  isPremium: boolean,
  context: Extract<TransferPolicyContext, "send" | "share">,
) {
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  return assertTransferSizeAllowed({
    context,
    isPremium,
    totalBytes,
  });
}
