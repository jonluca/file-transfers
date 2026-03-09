import { Platform } from "react-native";
import DirectTransferNative from "@/modules/direct-transfer-native";
import type {
  DirectTransferNativeModuleType,
  DirectTransferNativePayloadMetric,
  DirectTransferNativePayloadSessionOptions,
  DirectTransferNativeRangeDownloadOptions,
  DirectTransferNativeRangeDownloadProgress,
  DirectTransferNativeRangeDownloadResult,
} from "@/modules/direct-transfer-native";

function getModule(): DirectTransferNativeModuleType | null {
  if (Platform.OS === "web") {
    return null;
  }

  return DirectTransferNative;
}

export function isNativeDirectTransferAvailable() {
  return Boolean(getModule());
}

export async function ensureNativePayloadServerStarted() {
  return getModule()?.ensurePayloadServerStarted() ?? null;
}

export async function stopNativePayloadServer() {
  await getModule()?.stopPayloadServer();
}

export async function registerNativePayloadSession(options: DirectTransferNativePayloadSessionOptions) {
  await getModule()?.registerPayloadSession(options);
}

export async function unregisterNativePayloadSession(sessionId: string) {
  await getModule()?.unregisterPayloadSession(sessionId);
}

export async function collectNativePayloadMetrics(sessionId: string): Promise<DirectTransferNativePayloadMetric[]> {
  return (await getModule()?.collectPayloadMetrics(sessionId)) ?? [];
}

export async function startNativeRangeDownload(options: DirectTransferNativeRangeDownloadOptions) {
  const module = getModule();
  if (!module) {
    throw new Error("Native direct transfer is unavailable.");
  }

  return module.startRangeDownload(options);
}

export async function getNativeRangeDownloadProgress(
  taskId: string,
): Promise<DirectTransferNativeRangeDownloadProgress | null> {
  return (await getModule()?.getRangeDownloadProgress(taskId)) ?? null;
}

export async function cancelNativeRangeDownload(taskId: string) {
  await getModule()?.cancelRangeDownload(taskId);
}

export type {
  DirectTransferNativePayloadMetric,
  DirectTransferNativeRangeDownloadOptions,
  DirectTransferNativeRangeDownloadProgress,
  DirectTransferNativeRangeDownloadResult,
};
