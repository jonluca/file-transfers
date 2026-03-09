import { formatBytes } from "./files";

export interface TransferPerfSnapshot {
  bytesTransferred: number;
  completedAtMs: number | null;
  direction: "send" | "receive";
  effectiveMegabytesPerSecond: number | null;
  fallbackReason: string | null;
  manifestLatencyMs: number | null;
  progressEventCount: number;
  receiverDiskWriteDurationMs: number;
  receiverRequestDurationMs: number;
  senderFileReadDurationMs: number;
  senderResponseCopyDurationMs: number;
  sessionId: string;
  startedAtMs: number;
  totalBytes: number;
  transferScreenRenderCount: number;
  usedNativeClient: boolean;
  usedNativeServer: boolean;
}

type MutableTransferPerfSnapshot = TransferPerfSnapshot;

const snapshots = new Map<string, MutableTransferPerfSnapshot>();
const TRANSFER_PERF_DEBUG_PREFIX = "[DirectTransferPerf]";

function shouldTrackTransferPerf() {
  return __DEV__;
}

function getOrCreateSnapshot(sessionId: string, direction: "send" | "receive") {
  const existing = snapshots.get(sessionId);
  if (existing) {
    return existing;
  }

  const snapshot: MutableTransferPerfSnapshot = {
    sessionId,
    direction,
    startedAtMs: Date.now(),
    completedAtMs: null,
    totalBytes: 0,
    bytesTransferred: 0,
    manifestLatencyMs: null,
    senderFileReadDurationMs: 0,
    senderResponseCopyDurationMs: 0,
    receiverRequestDurationMs: 0,
    receiverDiskWriteDurationMs: 0,
    progressEventCount: 0,
    transferScreenRenderCount: 0,
    effectiveMegabytesPerSecond: null,
    fallbackReason: null,
    usedNativeClient: false,
    usedNativeServer: false,
  };
  snapshots.set(sessionId, snapshot);
  return snapshot;
}

export function ensureTransferPerfSnapshot(sessionId: string, direction: "send" | "receive") {
  if (!shouldTrackTransferPerf()) {
    return;
  }

  getOrCreateSnapshot(sessionId, direction);
}

export function updateTransferPerfSnapshot(
  sessionId: string,
  direction: "send" | "receive",
  mutate: (snapshot: MutableTransferPerfSnapshot) => void,
) {
  if (!shouldTrackTransferPerf()) {
    return;
  }

  mutate(getOrCreateSnapshot(sessionId, direction));
}

export function noteTransferPerfProgressEvent(sessionId: string, direction: "send" | "receive") {
  updateTransferPerfSnapshot(sessionId, direction, (snapshot) => {
    snapshot.progressEventCount += 1;
  });
}

export function noteTransferScreenRender(sessionId: string | null | undefined, direction: "send" | "receive") {
  if (!sessionId) {
    return;
  }

  updateTransferPerfSnapshot(sessionId, direction, (snapshot) => {
    snapshot.transferScreenRenderCount += 1;
  });
}

export function finalizeTransferPerfSnapshot(
  sessionId: string,
  direction: "send" | "receive",
  outcome: {
    bytesTransferred: number;
    totalBytes: number;
  },
) {
  if (!shouldTrackTransferPerf()) {
    return;
  }

  const snapshot = getOrCreateSnapshot(sessionId, direction);
  if (snapshot.completedAtMs !== null) {
    return;
  }

  snapshot.completedAtMs = Date.now();
  snapshot.bytesTransferred = outcome.bytesTransferred;
  snapshot.totalBytes = outcome.totalBytes;

  const elapsedMs = Math.max(snapshot.completedAtMs - snapshot.startedAtMs, 1);
  snapshot.effectiveMegabytesPerSecond = Number(
    (((snapshot.bytesTransferred / 1024 / 1024) * 1000) / elapsedMs).toFixed(2),
  );

  console.info(
    `${TRANSFER_PERF_DEBUG_PREFIX} ${JSON.stringify({
      sessionId: snapshot.sessionId.slice(0, 8),
      direction: snapshot.direction,
      totalBytes: snapshot.totalBytes,
      totalBytesLabel: formatBytes(snapshot.totalBytes),
      bytesTransferred: snapshot.bytesTransferred,
      manifestLatencyMs: snapshot.manifestLatencyMs,
      senderFileReadDurationMs: snapshot.senderFileReadDurationMs,
      senderResponseCopyDurationMs: snapshot.senderResponseCopyDurationMs,
      receiverRequestDurationMs: snapshot.receiverRequestDurationMs,
      receiverDiskWriteDurationMs: snapshot.receiverDiskWriteDurationMs,
      progressEventCount: snapshot.progressEventCount,
      transferScreenRenderCount: snapshot.transferScreenRenderCount,
      effectiveMegabytesPerSecond: snapshot.effectiveMegabytesPerSecond,
      fallbackReason: snapshot.fallbackReason,
      usedNativeClient: snapshot.usedNativeClient,
      usedNativeServer: snapshot.usedNativeServer,
      elapsedMs,
    })}`,
  );
}
