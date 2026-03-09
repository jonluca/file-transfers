import * as Crypto from "expo-crypto";
import type { File } from "expo-file-system";
import {
  cancelNativeRangeDownload,
  getNativeRangeDownloadProgress,
  isNativeDirectTransferAvailable,
  startNativeRangeDownload,
} from "./direct-transfer-native";

export interface DirectTransferDownloadProgress {
  bytesTransferred: number;
  diskWriteDurationMs: number;
  requestDurationMs: number;
  totalBytes: number;
}

export interface DirectTransferDownloadResult extends DirectTransferDownloadProgress {
  fallbackReason: string | null;
  usedNative: boolean;
}

interface DirectTransferDownloadOptions {
  chunkBytes: number;
  destination: File;
  headers: Record<string, string>;
  maxBytesPerSecond: number | null;
  maxConcurrentChunks: number;
  signal: AbortSignal;
  totalBytes: number;
  url: string;
}

interface DirectTransferDownloadRuntimeOptions extends DirectTransferDownloadOptions {
  onProgress: (progress: DirectTransferDownloadProgress) => void;
}

export interface DirectTransferClientAdapter {
  kind: "js" | "native";
  downloadFile(options: DirectTransferDownloadRuntimeOptions): Promise<DirectTransferDownloadResult>;
}

function parseContentRangeHeader(value: string | null) {
  if (!value) {
    return null;
  }

  const match = /^bytes (\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim());
  if (!match) {
    return null;
  }

  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === "*" ? null : Number(match[3]);

  if (!Number.isFinite(start) || !Number.isFinite(end) || (total !== null && !Number.isFinite(total))) {
    return null;
  }

  return {
    start,
    end,
    total,
  };
}

export async function downloadFileInChunksJs({
  chunkBytes,
  url,
  destination,
  maxBytesPerSecond,
  maxConcurrentChunks,
  totalBytes,
  headers,
  signal,
  onProgress,
}: DirectTransferDownloadRuntimeOptions): Promise<DirectTransferDownloadResult> {
  destination.create({ overwrite: true, intermediates: true });
  if (totalBytes === 0) {
    return {
      bytesTransferred: 0,
      totalBytes,
      requestDurationMs: 0,
      diskWriteDurationMs: 0,
      usedNative: false,
      fallbackReason: null,
    };
  }

  const totalChunkCount = Math.ceil(totalBytes / chunkBytes);
  let nextChunkIndex = 0;
  let bytesTransferred = 0;
  let requestDurationMs = 0;
  let diskWriteDurationMs = 0;

  function emitProgress() {
    onProgress({
      bytesTransferred,
      totalBytes,
      requestDurationMs,
      diskWriteDurationMs,
    });
  }

  async function runWorker() {
    const handle = destination.open();
    try {
      while (nextChunkIndex < totalChunkCount) {
        if (signal.aborted) {
          throw new Error("Download canceled.");
        }

        const currentChunkIndex = nextChunkIndex++;
        const chunkStart = currentChunkIndex * chunkBytes;
        const chunkEnd = Math.min(chunkStart + chunkBytes - 1, totalBytes - 1);
        const requestStartedAt = Date.now();
        const response = await fetch(url, {
          method: "GET",
          headers: {
            ...headers,
            Range: `bytes=${chunkStart}-${chunkEnd}`,
          },
          signal,
        });
        requestDurationMs += Date.now() - requestStartedAt;

        if (!response.ok) {
          throw new Error(`Unable to download file chunk (${response.status}).`);
        }

        const contentRange = parseContentRangeHeader(response.headers.get("content-range"));
        const expectedChunkBytes = chunkEnd - chunkStart + 1;
        if (
          response.status !== 206 ||
          !contentRange ||
          contentRange.start !== chunkStart ||
          contentRange.end !== chunkEnd ||
          (contentRange.total !== null && contentRange.total !== totalBytes)
        ) {
          throw new Error("The sender returned an unexpected file chunk.");
        }

        let chunkBytesDownloaded = 0;
        if (!response.body) {
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.byteLength !== expectedChunkBytes) {
            throw new Error("The sender returned an incomplete file chunk.");
          }
          const writeStartedAt = Date.now();
          handle.offset = chunkStart;
          handle.writeBytes(bytes);
          diskWriteDurationMs += Date.now() - writeStartedAt;
          bytesTransferred += bytes.byteLength;
          emitProgress();
          continue;
        }

        const reader = response.body.getReader();
        while (chunkBytesDownloaded < expectedChunkBytes) {
          if (signal.aborted) {
            throw new Error("Download canceled.");
          }

          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          if (!value?.byteLength) {
            continue;
          }

          const remainingChunkBytes = expectedChunkBytes - chunkBytesDownloaded;
          if (value.byteLength > remainingChunkBytes) {
            throw new Error("The sender returned too many bytes for this file chunk.");
          }

          const writeStartedAt = Date.now();
          handle.offset = chunkStart + chunkBytesDownloaded;
          handle.writeBytes(value);
          diskWriteDurationMs += Date.now() - writeStartedAt;
          chunkBytesDownloaded += value.byteLength;
          bytesTransferred += value.byteLength;
          emitProgress();
        }

        if (chunkBytesDownloaded !== expectedChunkBytes) {
          throw new Error("The sender returned an incomplete file chunk.");
        }

        if (maxBytesPerSecond && chunkBytesDownloaded > 0) {
          const minimumDurationMs = Math.ceil((chunkBytesDownloaded / maxBytesPerSecond) * 1000);
          const elapsedMs = Date.now() - requestStartedAt;
          const remainingMs = minimumDurationMs - elapsedMs;
          if (remainingMs > 0) {
            await new Promise((resolve) => {
              setTimeout(resolve, remainingMs);
            });
          }
        }
      }
    } finally {
      handle.close();
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, maxConcurrentChunks) }, () => runWorker()));

  return {
    bytesTransferred,
    totalBytes,
    requestDurationMs,
    diskWriteDurationMs,
    usedNative: false,
    fallbackReason: null,
  };
}

export const JsRangeTransferAdapter: DirectTransferClientAdapter = {
  kind: "js",
  async downloadFile(options) {
    return downloadFileInChunksJs(options);
  },
};

async function pollNativeDownloadProgress({
  taskId,
  signal,
  onProgress,
}: {
  taskId: string;
  signal: AbortSignal;
  onProgress: (progress: DirectTransferDownloadProgress) => void;
}) {
  let stopped = false;

  const tick = async () => {
    if (stopped || signal.aborted) {
      return;
    }

    const progress = await getNativeRangeDownloadProgress(taskId);
    if (progress) {
      onProgress(progress);
    }

    if (!stopped && !signal.aborted) {
      setTimeout(() => {
        void tick();
      }, 250);
    }
  };

  void tick();

  return () => {
    stopped = true;
  };
}

export const NativeRangeTransferAdapter: DirectTransferClientAdapter = {
  kind: "native",
  async downloadFile({
    chunkBytes,
    destination,
    headers,
    maxBytesPerSecond,
    maxConcurrentChunks,
    signal,
    totalBytes,
    url,
    onProgress,
  }) {
    if (!isNativeDirectTransferAvailable()) {
      throw new Error("Native direct transfer is unavailable.");
    }

    const taskId = Crypto.randomUUID();
    const stopPolling = await pollNativeDownloadProgress({
      taskId,
      signal,
      onProgress,
    });

    const abortListener = () => {
      void cancelNativeRangeDownload(taskId).catch(() => {});
    };
    signal.addEventListener("abort", abortListener, { once: true });

    try {
      const result = await startNativeRangeDownload({
        taskId,
        chunkBytes,
        destinationUri: destination.uri,
        headers,
        maxBytesPerSecond,
        maxConcurrentChunks,
        totalBytes,
        url,
      });
      onProgress(result);
      return {
        bytesTransferred: result.bytesTransferred,
        totalBytes: result.totalBytes,
        requestDurationMs: result.requestDurationMs,
        diskWriteDurationMs: result.diskWriteDurationMs,
        usedNative: true,
        fallbackReason: null,
      };
    } finally {
      signal.removeEventListener("abort", abortListener);
      stopPolling();
    }
  },
};

function getPreferredNativeDownloadOptions(options: DirectTransferDownloadRuntimeOptions) {
  // The sender advertises the safe direct-download policy in the manifest.
  // Native clients must honor it instead of silently increasing chunk size or
  // concurrency, otherwise slower JS senders can be overwhelmed by extra
  // simultaneous range requests.
  return options;
}

export async function downloadFileWithBestAvailableAdapter(options: DirectTransferDownloadRuntimeOptions) {
  if (isNativeDirectTransferAvailable()) {
    const nativeOptions = getPreferredNativeDownloadOptions(options);
    try {
      return await NativeRangeTransferAdapter.downloadFile(nativeOptions);
    } catch (error) {
      if (options.signal.aborted) {
        throw error;
      }

      const fallbackResult = await JsRangeTransferAdapter.downloadFile(options);
      return {
        ...fallbackResult,
        fallbackReason: error instanceof Error ? error.message : "Native direct transfer failed before completion.",
      } satisfies DirectTransferDownloadResult;
    }
  }

  return JsRangeTransferAdapter.downloadFile(options);
}

export function getDirectTransferClientAdapterKind() {
  return isNativeDirectTransferAvailable() ? "native" : "js";
}
