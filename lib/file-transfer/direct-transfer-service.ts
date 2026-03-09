import * as Crypto from "expo-crypto";
import { BonjourScanner, type ScanResult } from "@dawidzawada/bonjour-zeroconf";
import { File, type Directory } from "expo-file-system";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import NearbyAdvertiser from "@/modules/nearby-advertiser";
import { downloadFileWithBestAvailableAdapter } from "./direct-transfer-adapters";
import {
  DIRECT_TOKEN_HEADER,
  buildNearbyDiscoveryUrl,
  buildDirectSessionUrl,
  createDiscoveryQrPayload,
  createDiscoveryRecord,
  createServiceName,
  getUsableLanHost,
  getUsableNearbyHost,
  nowIso,
  parseNearbyDiscoveryResponse,
  parseDiscoveryQrPayload as parseDirectDiscoveryQrPayload,
  resolveDiscoveryHost,
} from "./direct-transfer-protocol";
import {
  LOCAL_TRANSFER_KEEP_AWAKE_TAG,
  LOCAL_TRANSFER_SERVICE_DOMAIN,
  LOCAL_TRANSFER_SERVICE_PROTOCOL,
  LOCAL_TRANSFER_SERVICE_TYPE,
} from "./constants";
import { assertSelectedFilesTransferAllowed, getTransferPolicy, type TransferPolicy } from "./transfer-policy";
import { getReceivedFilesStagingDirectory, moveReceivedFileToDefaultLocationAsync } from "./files";
import {
  collectDirectSendPayloadMetrics,
  registerDirectReceiveSession,
  registerDirectSendSession,
  unregisterDirectReceiveSession,
  unregisterDirectSendSession,
  updateDirectReceiveServiceName,
} from "./local-http-runtime";
import {
  ensureTransferPerfSnapshot,
  finalizeTransferPerfSnapshot,
  noteTransferPerfProgressEvent,
  updateTransferPerfSnapshot,
} from "./transfer-perf";
import type {
  DirectPeerAccess,
  DiscoveryRecord,
  DownloadableTransferManifest,
  IncomingTransferOffer,
  ReceiveSession,
  ReceivedFileRecord,
  SelectedTransferFile,
  TransferManifest,
  TransferManifestFile,
  TransferProgress,
  TransferSession,
} from "./types";

type SendRuntimeUpdate = (session: TransferSession) => void;
type ReceiveRuntimeUpdate = (session: ReceiveSession) => void;

type ReceiverToSenderEvent =
  | {
      kind: "accepted";
      receiverDeviceName: string;
    }
  | {
      kind: "rejected";
      message: string;
    }
  | {
      kind: "progress";
      progress: TransferProgress;
    }
  | {
      kind: "completed";
      detail: string | null;
    }
  | {
      kind: "failed";
      message: string;
    }
  | {
      kind: "canceled";
      message: string;
    };

type SenderToReceiverEvent =
  | {
      kind: "failed";
      message: string;
    }
  | {
      kind: "canceled";
      message: string;
    };

interface SendRuntime {
  session: TransferSession;
  target: DiscoveryRecord;
  transferPolicy: TransferPolicy;
  updateSession?: SendRuntimeUpdate;
  offerDelivered: boolean;
  stopping: boolean;
}

interface ReceiveRuntime {
  session: ReceiveSession;
  transferPolicy: TransferPolicy;
  updateSession?: ReceiveRuntimeUpdate;
  activeDownloadAbortController?: AbortController;
  stopZeroconfPublishing?: () => Promise<void>;
  stopping: boolean;
}

interface TransferResult {
  diskWriteDurationMs: number;
  receivedFiles: ReceivedFileRecord[];
  bytesTransferred: number;
  detail: string | null;
  fallbackReason: string | null;
  requestDurationMs: number;
  usedNativeClient: boolean;
}

const activeSendRuntimes = new Map<string, SendRuntime>();
const activeReceiveRuntimes = new Map<string, ReceiveRuntime>();
const PEER_REQUEST_TIMEOUT_MS = 8000;
const NEARBY_DISCOVERY_REQUEST_TIMEOUT_MS = 2500;
const NEARBY_DISCOVERY_RESCAN_INTERVAL_MS = 5_000;
const NEARBY_DISCOVERY_RETRY_DELAY_MS = 1_000;
const NEARBY_DISCOVERY_STOP_WAIT_TIMEOUT_MS = 2_000;
const NEARBY_DISCOVERY_STOP_WAIT_POLL_INTERVAL_MS = 100;
const PROGRESS_UPDATE_INTERVAL_MS = 250;
const PROGRESS_UPDATE_BYTES = 256 * 1024;
const DIRECT_TRANSFER_DEBUG_PREFIX = "[DirectTransfer]";

function logDirectTransferDebug(message: string, details?: Record<string, unknown>) {
  if (!__DEV__) {
    return;
  }

  if (details) {
    console.debug(`${DIRECT_TRANSFER_DEBUG_PREFIX} ${message}`, details);
    return;
  }

  console.debug(`${DIRECT_TRANSFER_DEBUG_PREFIX} ${message}`);
}

function getSessionDebugId(sessionId: string | null | undefined) {
  return sessionId?.slice(0, 8) ?? null;
}

function getErrorDebugDetails(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
    };
  }

  return {
    error: String(error),
  };
}

function getDiscoveryDebugDetails(
  record: Pick<DiscoveryRecord, "sessionId" | "method" | "deviceName" | "host" | "port">,
) {
  return {
    sessionId: getSessionDebugId(record.sessionId),
    method: record.method,
    deviceName: record.deviceName,
    host: record.host,
    port: record.port,
  };
}

function getPeerDebugDetails(peer: Pick<DirectPeerAccess, "sessionId" | "host" | "port">) {
  return {
    sessionId: getSessionDebugId(peer.sessionId),
    host: peer.host,
    port: peer.port,
  };
}

function toTransferManifestFile(file: SelectedTransferFile): TransferManifestFile {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
  };
}

function createTransferManifest({
  files,
  deviceName,
  sessionId,
}: {
  files: SelectedTransferFile[];
  deviceName: string;
  sessionId: string;
}): TransferManifest {
  const manifestFiles = files.map(toTransferManifestFile);
  const totalBytes = manifestFiles.reduce((sum, file) => sum + file.sizeBytes, 0);

  return {
    sessionId,
    deviceName,
    files: manifestFiles,
    fileCount: manifestFiles.length,
    totalBytes,
    createdAt: nowIso(),
  };
}

function createProgress(totalBytes: number, phase: TransferProgress["phase"], detail: string | null): TransferProgress {
  return {
    phase,
    totalBytes,
    bytesTransferred: 0,
    currentFileName: null,
    speedBytesPerSecond: 0,
    detail,
    updatedAt: nowIso(),
  };
}

function withSendSessionUpdate(runtime: SendRuntime, patch: Partial<TransferSession>) {
  const previousSession = runtime.session;
  runtime.session = {
    ...runtime.session,
    ...patch,
    progress: patch.progress ?? runtime.session.progress,
  };

  if (
    previousSession.status !== runtime.session.status ||
    previousSession.awaitingReceiverResponse !== runtime.session.awaitingReceiverResponse ||
    previousSession.progress.phase !== runtime.session.progress.phase ||
    previousSession.progress.detail !== runtime.session.progress.detail ||
    previousSession.progress.bytesTransferred !== runtime.session.progress.bytesTransferred
  ) {
    logDirectTransferDebug("Sender session state changed", {
      sessionId: getSessionDebugId(runtime.session.id),
      fromStatus: previousSession.status,
      toStatus: runtime.session.status,
      fromPhase: previousSession.progress.phase,
      toPhase: runtime.session.progress.phase,
      awaitingReceiverResponse: runtime.session.awaitingReceiverResponse,
      bytesTransferred: runtime.session.progress.bytesTransferred,
      totalBytes: runtime.session.progress.totalBytes,
      detail: runtime.session.progress.detail,
      peerDeviceName: runtime.session.peerDeviceName,
    });
  }

  noteTransferPerfProgressEvent(runtime.session.id, "send");
  runtime.updateSession?.(runtime.session);
}

function withReceiveSessionUpdate(runtime: ReceiveRuntime, patch: Partial<ReceiveSession>) {
  runtime.session = {
    ...runtime.session,
    ...patch,
    progress: patch.progress ?? runtime.session.progress,
    receivedFiles: patch.receivedFiles ?? runtime.session.receivedFiles,
  };
  noteTransferPerfProgressEvent(runtime.session.id, "receive");
  runtime.updateSession?.(runtime.session);
}

function createIncomingTransferOffer({
  manifest,
  direct,
}: {
  manifest: TransferManifest;
  direct: DirectPeerAccess;
}): IncomingTransferOffer {
  return {
    id: manifest.sessionId,
    senderDeviceName: manifest.deviceName,
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    sender: direct,
    createdAt: manifest.createdAt,
  };
}

function createInitialSendSession(manifest: TransferManifest, target: DiscoveryRecord): TransferSession {
  return {
    id: manifest.sessionId,
    direction: "send",
    status: "waiting",
    manifest,
    peerDeviceName: target.deviceName,
    awaitingReceiverResponse: true,
    progress: createProgress(manifest.totalBytes, "waiting", `Waiting for ${target.deviceName} to accept.`),
  };
}

function createInitialReceiveSession(record: DiscoveryRecord): ReceiveSession {
  return {
    id: record.sessionId,
    status: "discoverable",
    discoveryRecord: record,
    qrPayload: createDiscoveryQrPayload(record),
    incomingOffer: null,
    peerDeviceName: null,
    receivedFiles: [],
    progress: createProgress(0, "discoverable", "Ready to receive files."),
  };
}

function createTransferOutputFile(directory: Directory, fileName: string) {
  const safeName = fileName.replace(/[^\w.\-() ]+/g, "_");
  const outputFile = new File(directory, `${Date.now()}-${safeName}`);
  outputFile.create({ overwrite: true, intermediates: true });
  return outputFile;
}

function getNearbyBonjourServiceType() {
  return `_${LOCAL_TRANSFER_SERVICE_TYPE}._${LOCAL_TRANSFER_SERVICE_PROTOCOL}`;
}

function getNearbyBonjourDomain() {
  return LOCAL_TRANSFER_SERVICE_DOMAIN.replace(/\.+$/, "") || "local";
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function waitForNearbyScannerToStop(scanner: BonjourScanner) {
  const startedAt = Date.now();

  while (scanner.isScanning && Date.now() - startedAt < NEARBY_DISCOVERY_STOP_WAIT_TIMEOUT_MS) {
    await wait(NEARBY_DISCOVERY_STOP_WAIT_POLL_INTERVAL_MS);
  }
}

function toNearbyScanError(error: unknown, fallbackMessage = "Nearby scanning failed.") {
  return error instanceof Error ? error : new Error(fallbackMessage);
}

async function createNearbyAdvertiser({
  requestedServiceName,
  port,
  sessionId,
}: {
  requestedServiceName: string;
  port: number;
  sessionId: string;
}) {
  logDirectTransferDebug("Publishing nearby receiver service", {
    sessionId: getSessionDebugId(sessionId),
    port,
    requestedServiceName,
  });

  const result = await NearbyAdvertiser.startAdvertising(
    requestedServiceName,
    getNearbyBonjourServiceType(),
    LOCAL_TRANSFER_SERVICE_DOMAIN,
    port,
  );
  const serviceName = result.serviceName || requestedServiceName;

  return {
    serviceName,
    async stop() {
      logDirectTransferDebug("Stopping nearby receiver service", {
        sessionId: getSessionDebugId(sessionId),
        serviceName,
      });
      await NearbyAdvertiser.stopAdvertising(serviceName);
    },
  };
}

async function fetchNearbyDiscoveryRecords({ host, port }: { host: string; port: number }) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, NEARBY_DISCOVERY_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(buildNearbyDiscoveryUrl(host, port), {
      method: "GET",
      headers: {
        accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Nearby discovery returned ${response.status}.`);
    }

    return parseNearbyDiscoveryResponse(await response.json());
  } finally {
    clearTimeout(timer);
  }
}

function findReplacementDiscoveryRecord(target: DiscoveryRecord, records: DiscoveryRecord[]) {
  if (target.serviceName) {
    const exactServiceMatch = records.find((record) => record.serviceName === target.serviceName);
    if (exactServiceMatch) {
      return exactServiceMatch;
    }
  }

  if (records.length === 1) {
    return records[0]!;
  }

  const exactDeviceMatches = records.filter((record) => record.deviceName === target.deviceName);
  if (exactDeviceMatches.length === 1) {
    return exactDeviceMatches[0]!;
  }

  return null;
}

async function refreshDiscoveryTarget(target: DiscoveryRecord) {
  const host = resolveDiscoveryHost(target);
  if (!host || target.port <= 0) {
    return target;
  }

  try {
    const refreshed = findReplacementDiscoveryRecord(
      target,
      await fetchNearbyDiscoveryRecords({
        host,
        port: target.port,
      }),
    );

    if (!refreshed) {
      logDirectTransferDebug("Receiver discovery refresh found no replacement", {
        targetDeviceName: target.deviceName,
        targetMethod: target.method,
        targetHost: target.host,
        targetPort: target.port,
        targetSessionId: getSessionDebugId(target.sessionId),
      });
      return target;
    }

    if (
      refreshed.sessionId === target.sessionId &&
      refreshed.token === target.token &&
      refreshed.host === target.host &&
      refreshed.port === target.port
    ) {
      return target;
    }

    logDirectTransferDebug("Receiver discovery target refreshed", {
      targetDeviceName: target.deviceName,
      previousHost: target.host,
      previousPort: target.port,
      previousSessionId: getSessionDebugId(target.sessionId),
      refreshedHost: refreshed.host,
      refreshedPort: refreshed.port,
      refreshedSessionId: getSessionDebugId(refreshed.sessionId),
    });

    return {
      ...refreshed,
      method: target.method,
    };
  } catch (error) {
    logDirectTransferDebug("Receiver discovery refresh failed", {
      targetDeviceName: target.deviceName,
      targetMethod: target.method,
      targetHost: target.host,
      targetPort: target.port,
      targetSessionId: getSessionDebugId(target.sessionId),
      ...getErrorDebugDetails(error),
    });
    return target;
  }
}

function buildPeerAccessFromDiscovery(record: DiscoveryRecord): DirectPeerAccess {
  return {
    sessionId: record.sessionId,
    host: record.host,
    port: record.port,
    token: record.token,
  };
}

async function postJsonWithTimeout({ url, token, body }: { url: string; token: string; body: unknown }) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, PEER_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [DIRECT_TOKEN_HEADER]: token,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new Error(payload?.error ?? `Direct transfer request failed with status ${response.status}.`);
    }
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Nearby device did not respond in time.", {
        cause: error,
      });
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function postDirectEvent(peer: DirectPeerAccess, event: ReceiverToSenderEvent | SenderToReceiverEvent) {
  await postJsonWithTimeout({
    url: buildDirectSessionUrl(peer, "/events"),
    token: peer.token,
    body: {
      event,
    },
  });
}

async function postIncomingOffer(peer: DiscoveryRecord, offer: IncomingTransferOffer) {
  await postJsonWithTimeout({
    url: buildDirectSessionUrl(peer, "/offers"),
    token: peer.token,
    body: {
      offer,
    },
  });
}

async function fetchDownloadableManifest({
  peer,
  offer,
  sessionId,
  signal,
}: {
  peer: DirectPeerAccess;
  offer: IncomingTransferOffer;
  sessionId: string;
  signal: AbortSignal;
}) {
  logDirectTransferDebug("Fetching sender manifest", {
    offerId: getSessionDebugId(offer.id),
    senderDeviceName: offer.senderDeviceName,
    ...getPeerDebugDetails(peer),
  });

  const startedAt = Date.now();
  const response = await fetch(buildDirectSessionUrl(peer, "/manifest"), {
    method: "GET",
    headers: {
      [DIRECT_TOKEN_HEADER]: peer.token,
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(`Unable to load the sender manifest (${response.status}).`);
  }

  const payload = (await response.json()) as DownloadableTransferManifest;
  if (payload.kind !== "direct-http-transfer") {
    throw new Error("The sender did not provide a valid direct-transfer manifest.");
  }

  if (payload.sessionId !== offer.id) {
    throw new Error("The sender provided a manifest for a different transfer.");
  }

  logDirectTransferDebug("Sender manifest loaded", {
    offerId: getSessionDebugId(offer.id),
    fileCount: payload.files.length,
    totalBytes: payload.totalBytes,
  });

  updateTransferPerfSnapshot(sessionId, "receive", (snapshot) => {
    snapshot.manifestLatencyMs = Date.now() - startedAt;
    snapshot.totalBytes = payload.totalBytes;
  });

  return payload;
}

function isSendRuntimeSettled(runtime: SendRuntime) {
  return ["completed", "failed", "canceled"].includes(runtime.session.status);
}

async function finalizeSendPerf(runtime: SendRuntime) {
  await collectDirectSendPayloadMetrics(runtime.session.id).catch(() => {});
  finalizeTransferPerfSnapshot(runtime.session.id, "send", {
    bytesTransferred: runtime.session.progress.bytesTransferred,
    totalBytes: runtime.session.manifest.totalBytes,
  });
}

function finalizeReceivePerf(runtime: ReceiveRuntime) {
  finalizeTransferPerfSnapshot(runtime.session.id, "receive", {
    bytesTransferred: runtime.session.progress.bytesTransferred,
    totalBytes: runtime.session.incomingOffer?.totalBytes ?? runtime.session.progress.totalBytes,
  });
}

async function failSendSession(runtime: SendRuntime, detail: string) {
  if (isSendRuntimeSettled(runtime)) {
    return;
  }

  withSendSessionUpdate(runtime, {
    status: "failed",
    awaitingReceiverResponse: false,
    progress: {
      ...runtime.session.progress,
      phase: "failed",
      detail,
      updatedAt: nowIso(),
    },
  });

  await finalizeSendPerf(runtime);
}

async function cancelSendSession(runtime: SendRuntime, detail: string) {
  if (isSendRuntimeSettled(runtime)) {
    return;
  }

  withSendSessionUpdate(runtime, {
    status: "canceled",
    awaitingReceiverResponse: false,
    progress: {
      ...runtime.session.progress,
      phase: "canceled",
      detail,
      updatedAt: nowIso(),
    },
  });

  await finalizeSendPerf(runtime);
}

async function completeSendSession(runtime: SendRuntime, detail: string) {
  if (isSendRuntimeSettled(runtime)) {
    return;
  }

  withSendSessionUpdate(runtime, {
    status: "completed",
    awaitingReceiverResponse: false,
    progress: {
      phase: "completed",
      totalBytes: runtime.session.manifest.totalBytes,
      bytesTransferred: runtime.session.manifest.totalBytes,
      currentFileName: null,
      speedBytesPerSecond: 0,
      detail,
      updatedAt: nowIso(),
    },
  });

  await finalizeSendPerf(runtime);
}

function resetReceiveToDiscoverable(runtime: ReceiveRuntime, detail = "Ready to receive files.") {
  runtime.activeDownloadAbortController?.abort();
  runtime.activeDownloadAbortController = undefined;

  withReceiveSessionUpdate(runtime, {
    status: "discoverable",
    incomingOffer: null,
    peerDeviceName: null,
    receivedFiles: [],
    progress: {
      phase: "discoverable",
      totalBytes: 0,
      bytesTransferred: 0,
      currentFileName: null,
      speedBytesPerSecond: 0,
      detail,
      updatedAt: nowIso(),
    },
  });
}

async function failReceiveSession(runtime: ReceiveRuntime, detail: string) {
  if (["completed", "failed", "canceled"].includes(runtime.session.status)) {
    return;
  }

  runtime.activeDownloadAbortController?.abort();
  runtime.activeDownloadAbortController = undefined;

  withReceiveSessionUpdate(runtime, {
    status: "failed",
    progress: {
      phase: "failed",
      totalBytes: runtime.session.incomingOffer?.totalBytes ?? runtime.session.progress.totalBytes,
      bytesTransferred: runtime.session.progress.bytesTransferred,
      currentFileName: null,
      speedBytesPerSecond: 0,
      detail,
      updatedAt: nowIso(),
    },
  });

  finalizeReceivePerf(runtime);
}

async function cancelReceiveSession(runtime: ReceiveRuntime, detail: string) {
  if (["completed", "failed", "canceled"].includes(runtime.session.status)) {
    return;
  }

  runtime.activeDownloadAbortController?.abort();
  runtime.activeDownloadAbortController = undefined;

  withReceiveSessionUpdate(runtime, {
    status: "canceled",
    progress: {
      phase: "canceled",
      totalBytes: runtime.session.incomingOffer?.totalBytes ?? runtime.session.progress.totalBytes,
      bytesTransferred: runtime.session.progress.bytesTransferred,
      currentFileName: null,
      speedBytesPerSecond: 0,
      detail,
      updatedAt: nowIso(),
    },
  });

  finalizeReceivePerf(runtime);
}

function isReceiveRuntimeBusy(runtime: ReceiveRuntime) {
  return Boolean(
    runtime.session.incomingOffer ||
    runtime.session.status === "connecting" ||
    runtime.session.status === "transferring",
  );
}

function registerIncomingOffer(runtime: ReceiveRuntime, offer: IncomingTransferOffer) {
  if (isReceiveRuntimeBusy(runtime)) {
    logDirectTransferDebug("Ignoring incoming offer because receiver is busy", {
      offerId: getSessionDebugId(offer.id),
      senderDeviceName: offer.senderDeviceName,
      receiverSessionId: getSessionDebugId(runtime.session.id),
      receiverStatus: runtime.session.status,
    });
    return false;
  }

  logDirectTransferDebug("Incoming offer registered", {
    offerId: getSessionDebugId(offer.id),
    senderDeviceName: offer.senderDeviceName,
    fileCount: offer.fileCount,
    totalBytes: offer.totalBytes,
    receiverSessionId: getSessionDebugId(runtime.session.id),
  });

  withReceiveSessionUpdate(runtime, {
    status: "waiting",
    incomingOffer: offer,
    peerDeviceName: offer.senderDeviceName,
    receivedFiles: [],
    progress: {
      phase: "waiting",
      totalBytes: offer.totalBytes,
      bytesTransferred: 0,
      currentFileName: null,
      speedBytesPerSecond: 0,
      detail: `${offer.senderDeviceName} wants to send ${offer.fileCount} file${offer.fileCount === 1 ? "" : "s"}.`,
      updatedAt: nowIso(),
    },
  });

  return true;
}

function createReceiveProgressReporter(runtime: ReceiveRuntime) {
  let lastSentAt = 0;
  let lastSentBytes = 0;

  return (progress: TransferProgress, force = false) => {
    withReceiveSessionUpdate(runtime, {
      status: progress.phase === "transferring" ? "transferring" : "connecting",
      progress,
    });

    const offer = runtime.session.incomingOffer;
    if (!offer) {
      return;
    }

    const now = Date.now();
    const shouldSend =
      force ||
      progress.phase === "completed" ||
      progress.phase === "failed" ||
      progress.bytesTransferred === progress.totalBytes ||
      progress.bytesTransferred - lastSentBytes >= PROGRESS_UPDATE_BYTES ||
      now - lastSentAt >= PROGRESS_UPDATE_INTERVAL_MS;

    if (!shouldSend) {
      return;
    }

    lastSentAt = now;
    lastSentBytes = progress.bytesTransferred;
    void postDirectEvent(offer.sender, {
      kind: "progress",
      progress,
    }).catch(() => {});
  };
}

async function receiveDirectHttpTransfer({
  runtime,
  offer,
  onProgress,
}: {
  runtime: ReceiveRuntime;
  offer: IncomingTransferOffer;
  onProgress: (progress: TransferProgress, force?: boolean) => void;
}) {
  const abortController = new AbortController();
  runtime.activeDownloadAbortController = abortController;
  const createdFiles: File[] = [];

  await activateKeepAwakeAsync(LOCAL_TRANSFER_KEEP_AWAKE_TAG).catch(() => {});

  try {
    logDirectTransferDebug("Receiver starting direct transfer", {
      offerId: getSessionDebugId(offer.id),
      senderDeviceName: offer.senderDeviceName,
      receiverSessionId: getSessionDebugId(runtime.session.id),
      totalBytes: offer.totalBytes,
      fileCount: offer.fileCount,
      ...getPeerDebugDetails(offer.sender),
    });

    onProgress(
      {
        phase: "connecting",
        totalBytes: offer.totalBytes,
        bytesTransferred: 0,
        currentFileName: null,
        speedBytesPerSecond: 0,
        detail: "Connecting to the sender over local WiFi.",
        updatedAt: nowIso(),
      },
      true,
    );

    const manifest = await fetchDownloadableManifest({
      peer: offer.sender,
      offer,
      sessionId: runtime.session.id,
      signal: abortController.signal,
    });
    const downloadPolicy = manifest.downloadPolicy ?? {
      chunkBytes: runtime.transferPolicy.chunkBytes,
      maxConcurrentChunks: runtime.transferPolicy.maxConcurrentChunks,
    };

    const downloadedFiles: Array<{
      fileName: string;
      mimeType: string;
      outputFile: File;
      sizeBytes: number;
    }> = [];
    let bytesTransferred = 0;
    const downloadStartedAt = Date.now();
    let totalRequestDurationMs = 0;
    let totalDiskWriteDurationMs = 0;
    let usedNativeClient = false;
    let fallbackReason: string | null = null;

    for (const file of manifest.files) {
      const outputFile = createTransferOutputFile(getReceivedFilesStagingDirectory(), file.name);
      createdFiles.push(outputFile);

      logDirectTransferDebug("Downloading file from sender", {
        offerId: getSessionDebugId(offer.id),
        fileName: file.name,
        sizeBytes: file.sizeBytes,
        destinationUri: outputFile.uri,
      });

      let fileBytesTransferred = 0;
      let lastReportedFileBytes = 0;

      onProgress({
        phase: "transferring",
        totalBytes: offer.totalBytes,
        bytesTransferred,
        currentFileName: file.name,
        speedBytesPerSecond: 0,
        detail: "Downloading files over local WiFi.",
        updatedAt: nowIso(),
      });

      const adapterResult = await downloadFileWithBestAvailableAdapter({
        chunkBytes: downloadPolicy.chunkBytes,
        url: file.downloadUrl,
        destination: outputFile,
        maxBytesPerSecond: null,
        maxConcurrentChunks: downloadPolicy.maxConcurrentChunks,
        totalBytes: file.sizeBytes,
        headers: {
          [DIRECT_TOKEN_HEADER]: offer.sender.token,
        },
        signal: abortController.signal,
        onProgress: (progress) => {
          const delta = Math.max(progress.bytesTransferred - lastReportedFileBytes, 0);
          lastReportedFileBytes = progress.bytesTransferred;
          fileBytesTransferred = progress.bytesTransferred;
          bytesTransferred += delta;
          const elapsedMilliseconds = Math.max(Date.now() - downloadStartedAt, 1);
          const speedBytesPerSecond = Math.round((bytesTransferred / elapsedMilliseconds) * 1000);

          onProgress({
            phase: "transferring",
            totalBytes: offer.totalBytes,
            bytesTransferred,
            currentFileName: file.name,
            speedBytesPerSecond,
            detail: "Downloading files over local WiFi.",
            updatedAt: nowIso(),
          });
        },
      });
      totalRequestDurationMs += adapterResult.requestDurationMs;
      totalDiskWriteDurationMs += adapterResult.diskWriteDurationMs;
      usedNativeClient = usedNativeClient || adapterResult.usedNative;
      fallbackReason ??= adapterResult.fallbackReason;

      downloadedFiles.push({
        fileName: file.name,
        mimeType: file.mimeType,
        outputFile,
        sizeBytes: file.sizeBytes,
      });

      logDirectTransferDebug("Finished downloading file from sender", {
        offerId: getSessionDebugId(offer.id),
        fileName: file.name,
        bytesTransferred: fileBytesTransferred,
      });
    }

    logDirectTransferDebug("Receiver completed direct transfer", {
      offerId: getSessionDebugId(offer.id),
      receivedFileCount: downloadedFiles.length,
      bytesTransferred,
    });

    const savedResults = await Promise.all(
      downloadedFiles.map((file) =>
        moveReceivedFileToDefaultLocationAsync({
          transferId: offer.id,
          sourceFile: file.outputFile,
          fileName: file.fileName,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
        }),
      ),
    );
    const receivedFiles = savedResults.map((result) => result.record);
    const savedLocationLabel = savedResults.every((result) => result.savedLocationLabel === "Downloads")
      ? "Downloads"
      : "Files";

    return {
      receivedFiles,
      bytesTransferred,
      detail: `Transfer complete. Saved to ${savedLocationLabel}.`,
      diskWriteDurationMs: totalDiskWriteDurationMs,
      fallbackReason,
      requestDurationMs: totalRequestDurationMs,
      usedNativeClient,
    } satisfies TransferResult;
  } catch (error) {
    logDirectTransferDebug("Receiver direct transfer failed", {
      offerId: getSessionDebugId(offer.id),
      createdFileCount: createdFiles.length,
      ...getErrorDebugDetails(error),
    });

    for (const file of createdFiles) {
      try {
        if (file.exists) {
          file.delete();
        }
      } catch {
        // Best-effort cleanup for partially downloaded files.
      }
    }

    if (error instanceof Error && error.message === "Download canceled.") {
      throw new Error("Transfer canceled.", {
        cause: error,
      });
    }

    throw error instanceof Error ? error : new Error("Unable to download files over local WiFi.");
  } finally {
    runtime.activeDownloadAbortController = undefined;
    await deactivateKeepAwake(LOCAL_TRANSFER_KEEP_AWAKE_TAG).catch(() => {});
  }
}

async function runReceiveTransfer(runtime: ReceiveRuntime) {
  const offer = runtime.session.incomingOffer;
  if (!offer) {
    throw new Error("That transfer request is no longer available.");
  }

  logDirectTransferDebug("Receiver accepted transfer offer", {
    offerId: getSessionDebugId(offer.id),
    senderDeviceName: offer.senderDeviceName,
    receiverSessionId: getSessionDebugId(runtime.session.id),
  });

  await postDirectEvent(offer.sender, {
    kind: "accepted",
    receiverDeviceName: runtime.session.discoveryRecord.deviceName,
  });

  withReceiveSessionUpdate(runtime, {
    status: "connecting",
    peerDeviceName: offer.senderDeviceName,
    progress: {
      phase: "connecting",
      totalBytes: offer.totalBytes,
      bytesTransferred: 0,
      currentFileName: null,
      speedBytesPerSecond: 0,
      detail: "Connecting to the sender over local WiFi.",
      updatedAt: nowIso(),
    },
  });

  return receiveDirectHttpTransfer({
    runtime,
    offer,
    onProgress: createReceiveProgressReporter(runtime),
  });
}

function getPeerName(value: string | undefined) {
  return value?.trim() ? value.trim().slice(0, 40) : "Nearby device";
}

async function handleSenderEvent(runtime: SendRuntime, event: ReceiverToSenderEvent) {
  if (event.kind === "accepted") {
    logDirectTransferDebug("Sender received receiver acceptance", {
      sessionId: getSessionDebugId(runtime.session.id),
      receiverDeviceName: event.receiverDeviceName,
    });
    const receiverName = getPeerName(event.receiverDeviceName ?? runtime.target.deviceName);
    withSendSessionUpdate(runtime, {
      status: "connecting",
      peerDeviceName: receiverName,
      awaitingReceiverResponse: false,
      progress: {
        phase: "connecting",
        totalBytes: runtime.session.manifest.totalBytes,
        bytesTransferred: runtime.session.progress.bytesTransferred,
        currentFileName: null,
        speedBytesPerSecond: 0,
        detail: `Waiting for ${receiverName} to download files over local WiFi.`,
        updatedAt: nowIso(),
      },
    });
    return;
  }

  if (event.kind === "progress") {
    if (event.progress.phase !== runtime.session.progress.phase) {
      logDirectTransferDebug("Sender observed receiver progress phase change", {
        sessionId: getSessionDebugId(runtime.session.id),
        phase: event.progress.phase,
        bytesTransferred: event.progress.bytesTransferred,
        totalBytes: event.progress.totalBytes,
        currentFileName: event.progress.currentFileName,
      });
    }

    withSendSessionUpdate(runtime, {
      status: event.progress.phase === "transferring" ? "transferring" : "connecting",
      awaitingReceiverResponse: false,
      progress: {
        ...event.progress,
        detail: event.progress.detail ?? runtime.session.progress.detail,
      },
    });
    return;
  }

  if (event.kind === "completed") {
    logDirectTransferDebug("Sender received transfer completion", {
      sessionId: getSessionDebugId(runtime.session.id),
      detail: event.detail,
    });
    await completeSendSession(runtime, event.detail ?? "Transfer complete.");
    return;
  }

  if (event.kind === "rejected") {
    logDirectTransferDebug("Sender received transfer rejection", {
      sessionId: getSessionDebugId(runtime.session.id),
      message: event.message,
    });
    await failSendSession(runtime, event.message || "Transfer declined.");
    return;
  }

  logDirectTransferDebug("Sender received terminal receiver event", {
    sessionId: getSessionDebugId(runtime.session.id),
    kind: event.kind,
    message: event.message,
  });
  if (event.kind === "canceled") {
    await cancelSendSession(runtime, event.message || "Transfer stopped.");
    return;
  }

  await failSendSession(runtime, event.message || "Transfer stopped.");
}

async function handleReceiverEvent(runtime: ReceiveRuntime, event: SenderToReceiverEvent) {
  const detail = event.message || "Sender stopped the transfer.";

  logDirectTransferDebug("Receiver received sender event", {
    sessionId: getSessionDebugId(runtime.session.id),
    kind: event.kind,
    detail,
  });

  if (runtime.session.status === "waiting") {
    resetReceiveToDiscoverable(runtime, detail);
    return;
  }

  if (event.kind === "canceled") {
    await cancelReceiveSession(runtime, detail);
    return;
  }

  await failReceiveSession(runtime, detail);
}

async function startOffer(runtime: SendRuntime, offer: IncomingTransferOffer) {
  try {
    logDirectTransferDebug("Sending offer to receiver", {
      senderSessionId: getSessionDebugId(runtime.session.id),
      targetDeviceName: runtime.target.deviceName,
      fileCount: offer.fileCount,
      totalBytes: offer.totalBytes,
      targetMethod: runtime.target.method,
      targetHost: runtime.target.host,
      targetPort: runtime.target.port,
      targetSessionId: getSessionDebugId(runtime.target.sessionId),
    });
    await postIncomingOffer(runtime.target, offer);
    runtime.offerDelivered = true;
    logDirectTransferDebug("Receiver offer delivered", {
      sessionId: getSessionDebugId(runtime.session.id),
      targetDeviceName: runtime.target.deviceName,
    });
  } catch (error) {
    logDirectTransferDebug("Failed to deliver receiver offer", {
      sessionId: getSessionDebugId(runtime.session.id),
      targetDeviceName: runtime.target.deviceName,
      ...getErrorDebugDetails(error),
    });
    await failSendSession(runtime, error instanceof Error ? error.message : "Unable to reach that receiver.");
  }
}

async function handleSendRegistrationInterrupted(runtime: SendRuntime, detail: string) {
  if (runtime.stopping || isSendRuntimeSettled(runtime)) {
    return;
  }

  logDirectTransferDebug("Sender registration interrupted", {
    sessionId: getSessionDebugId(runtime.session.id),
    detail,
    offerDelivered: runtime.offerDelivered,
  });

  if (runtime.offerDelivered) {
    await postDirectEvent(buildPeerAccessFromDiscovery(runtime.target), {
      kind: "failed",
      message: detail,
    }).catch(() => {});
  }

  await failSendSession(runtime, detail);
}

async function handleReceiveRegistrationInterrupted(runtime: ReceiveRuntime, detail: string) {
  if (runtime.stopping) {
    return;
  }

  logDirectTransferDebug("Receiver registration interrupted", {
    sessionId: getSessionDebugId(runtime.session.id),
    detail,
    status: runtime.session.status,
  });

  const offer = runtime.session.incomingOffer;
  if (offer) {
    const event: ReceiverToSenderEvent =
      runtime.session.status === "waiting"
        ? {
            kind: "rejected",
            message: detail,
          }
        : {
            kind: "canceled",
            message: detail,
          };
    await postDirectEvent(offer.sender, event).catch(() => {});
  }

  await failReceiveSession(runtime, detail);
}

export async function startSendingTransfer({
  files,
  target,
  deviceName,
  isPremium,
  updateSession,
}: {
  files: SelectedTransferFile[];
  target: DiscoveryRecord;
  deviceName: string;
  isPremium: boolean;
  updateSession?: SendRuntimeUpdate;
}) {
  const sessionId = Crypto.randomUUID();
  const transferPolicy = assertSelectedFilesTransferAllowed(files, isPremium, "send");
  ensureTransferPerfSnapshot(sessionId, "send");

  logDirectTransferDebug("Starting sender transfer session", {
    senderSessionId: getSessionDebugId(sessionId),
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    targetDeviceName: target.deviceName,
    targetMethod: target.method,
    targetHost: target.host,
    targetPort: target.port,
    targetSessionId: getSessionDebugId(target.sessionId),
  });

  const refreshedTarget = await refreshDiscoveryTarget(target);

  if (refreshedTarget.port <= 0 || !refreshedTarget.token.trim()) {
    logDirectTransferDebug("Sender target is no longer valid", {
      senderSessionId: getSessionDebugId(sessionId),
      targetPort: refreshedTarget.port,
      hasToken: Boolean(refreshedTarget.token.trim()),
      targetMethod: refreshedTarget.method,
      targetHost: refreshedTarget.host,
      targetDeviceName: refreshedTarget.deviceName,
      targetSessionId: getSessionDebugId(refreshedTarget.sessionId),
    });
    throw new Error("That receiver is no longer available.");
  }

  const validatedTargetHost = resolveDiscoveryHost(refreshedTarget);
  if (!validatedTargetHost) {
    logDirectTransferDebug("Sender target host could not be resolved", {
      senderSessionId: getSessionDebugId(sessionId),
      targetMethod: refreshedTarget.method,
      targetHost: refreshedTarget.host,
      targetPort: refreshedTarget.port,
      targetDeviceName: refreshedTarget.deviceName,
      targetSessionId: getSessionDebugId(refreshedTarget.sessionId),
    });
    throw new Error(
      refreshedTarget.method === "qr"
        ? "That QR code does not contain a usable local WiFi address."
        : "That receiver is not advertising a usable local WiFi address.",
    );
  }

  const resolvedTarget =
    validatedTargetHost === refreshedTarget.host
      ? refreshedTarget
      : {
          ...refreshedTarget,
          host: validatedTargetHost,
        };

  logDirectTransferDebug("Sender target resolved", {
    senderSessionId: getSessionDebugId(sessionId),
    originalHost: refreshedTarget.host,
    resolvedHost: resolvedTarget.host,
    targetMethod: resolvedTarget.method,
    targetPort: resolvedTarget.port,
    targetDeviceName: resolvedTarget.deviceName,
    targetSessionId: getSessionDebugId(resolvedTarget.sessionId),
  });

  const manifest = createTransferManifest({
    files,
    deviceName,
    sessionId,
  });
  updateTransferPerfSnapshot(sessionId, "send", (snapshot) => {
    snapshot.totalBytes = manifest.totalBytes;
  });

  const direct = await registerDirectSendSession({
    sessionId,
    token: Crypto.randomUUID().replace(/-/g, ""),
    deviceName,
    transferPolicy,
    startedAt: manifest.createdAt,
    files,
    onEvent: async (event) => {
      const runtime = activeSendRuntimes.get(sessionId);
      if (!runtime) {
        return;
      }

      await handleSenderEvent(runtime, event as ReceiverToSenderEvent);
    },
    onInterrupted: async (detail) => {
      const runtime = activeSendRuntimes.get(sessionId);
      if (!runtime) {
        return;
      }

      await handleSendRegistrationInterrupted(runtime, detail);
    },
  });

  logDirectTransferDebug("Sender local direct session registered", {
    sessionId: getSessionDebugId(sessionId),
    localHost: direct.host,
    localPort: direct.port,
  });

  const runtime: SendRuntime = {
    session: createInitialSendSession(manifest, resolvedTarget),
    target: resolvedTarget,
    transferPolicy,
    updateSession,
    offerDelivered: false,
    stopping: false,
  };

  activeSendRuntimes.set(sessionId, runtime);
  updateSession?.(runtime.session);

  logDirectTransferDebug("Sender runtime is ready", {
    sessionId: getSessionDebugId(sessionId),
    targetDeviceName: runtime.target.deviceName,
    targetHost: runtime.target.host,
    targetPort: runtime.target.port,
  });

  const offer = createIncomingTransferOffer({
    manifest,
    direct,
  });

  void startOffer(runtime, offer);
  return runtime.session;
}

export async function stopSendingTransfer(sessionId: string) {
  const runtime = activeSendRuntimes.get(sessionId);
  if (!runtime) {
    return;
  }

  runtime.stopping = true;

  logDirectTransferDebug("Stopping sender transfer session", {
    sessionId: getSessionDebugId(sessionId),
    offerDelivered: runtime.offerDelivered,
    status: runtime.session.status,
  });

  if (!isSendRuntimeSettled(runtime) && runtime.offerDelivered) {
    await postDirectEvent(buildPeerAccessFromDiscovery(runtime.target), {
      kind: "canceled",
      message: "Sender canceled the transfer.",
    }).catch(() => {});
  }

  if (!isSendRuntimeSettled(runtime)) {
    await cancelSendSession(runtime, "Sender canceled the transfer.");
  }

  await unregisterDirectSendSession(runtime.session.id).catch(() => {});
  activeSendRuntimes.delete(sessionId);
}

export async function startReceivingAvailability({
  deviceName,
  isPremium,
  serviceInstanceId,
  updateSession,
}: {
  deviceName: string;
  isPremium: boolean;
  serviceInstanceId: string;
  updateSession?: ReceiveRuntimeUpdate;
}) {
  const sessionId = Crypto.randomUUID();
  const receiverToken = Crypto.randomUUID().replace(/-/g, "");
  const requestedServiceName = createServiceName(serviceInstanceId);
  const transferPolicy = getTransferPolicy(isPremium, "receive");
  ensureTransferPerfSnapshot(sessionId, "receive");
  updateTransferPerfSnapshot(sessionId, "receive", (snapshot) => {
    snapshot.totalBytes = 0;
  });

  logDirectTransferDebug("Starting receiver availability", {
    sessionId: getSessionDebugId(sessionId),
    deviceName,
  });

  const direct = await registerDirectReceiveSession({
    sessionId,
    token: receiverToken,
    deviceName,
    serviceName: requestedServiceName,
    canAcceptOffer: () => activeReceiveRuntimes.get(sessionId)?.session.status === "discoverable",
    onOffer: async (offer) => {
      const runtime = activeReceiveRuntimes.get(sessionId);
      if (!runtime) {
        logDirectTransferDebug("Incoming offer arrived for missing receiver runtime", {
          sessionId: getSessionDebugId(sessionId),
          offerId: getSessionDebugId(offer.id),
          senderDeviceName: offer.senderDeviceName,
        });
        return {
          accepted: false,
          statusCode: 404,
          message: "That receiver is no longer available.",
        };
      }

      return registerIncomingOffer(runtime, offer)
        ? { accepted: true }
        : {
            accepted: false,
            statusCode: 409,
            message: "That receiver is busy right now.",
          };
    },
    onEvent: async (event) => {
      const runtime = activeReceiveRuntimes.get(sessionId);
      if (!runtime) {
        return;
      }

      await handleReceiverEvent(runtime, event as SenderToReceiverEvent);
    },
    onInterrupted: async (detail) => {
      const runtime = activeReceiveRuntimes.get(sessionId);
      if (!runtime) {
        return;
      }

      await handleReceiveRegistrationInterrupted(runtime, detail);
    },
  });

  logDirectTransferDebug("Receiver local direct session registered", {
    sessionId: getSessionDebugId(sessionId),
    deviceName,
    localHost: direct.host,
    localPort: direct.port,
  });

  let nearbyAdvertiser: Awaited<ReturnType<typeof createNearbyAdvertiser>>;
  try {
    nearbyAdvertiser = await createNearbyAdvertiser({
      sessionId,
      requestedServiceName,
      port: direct.port,
    });
  } catch (error) {
    await unregisterDirectReceiveSession(sessionId).catch(() => {});
    throw error;
  }

  if (nearbyAdvertiser.serviceName !== requestedServiceName) {
    await updateDirectReceiveServiceName(sessionId, nearbyAdvertiser.serviceName);
  }

  const runtime: ReceiveRuntime = {
    session: createInitialReceiveSession(
      createDiscoveryRecord({
        sessionId,
        method: "nearby",
        deviceName,
        host: direct.host,
        port: direct.port,
        token: direct.token,
        serviceName: nearbyAdvertiser.serviceName,
      }),
    ),
    transferPolicy,
    updateSession,
    stopZeroconfPublishing: nearbyAdvertiser.stop,
    stopping: false,
  };

  activeReceiveRuntimes.set(sessionId, runtime);
  updateSession?.(runtime.session);

  logDirectTransferDebug("Receiver runtime is discoverable", {
    qrReady: Boolean(runtime.session.qrPayload),
    ...getDiscoveryDebugDetails(runtime.session.discoveryRecord),
  });
  return runtime.session;
}

export async function stopReceivingAvailability(sessionId: string) {
  const runtime = activeReceiveRuntimes.get(sessionId);
  if (!runtime) {
    return;
  }

  runtime.stopping = true;
  runtime.activeDownloadAbortController?.abort();

  logDirectTransferDebug("Stopping receiver availability", {
    sessionId: getSessionDebugId(sessionId),
    status: runtime.session.status,
    hasIncomingOffer: Boolean(runtime.session.incomingOffer),
  });

  if (runtime.session.incomingOffer) {
    if (runtime.session.status === "waiting") {
      await postDirectEvent(runtime.session.incomingOffer.sender, {
        kind: "rejected",
        message: "Receiver is no longer available.",
      }).catch(() => {});
    } else if (runtime.session.status === "connecting" || runtime.session.status === "transferring") {
      await postDirectEvent(runtime.session.incomingOffer.sender, {
        kind: "canceled",
        message: "Receiver canceled the transfer.",
      }).catch(() => {});
      await cancelReceiveSession(runtime, "Receiver canceled the transfer.");
    }
  }

  await runtime.stopZeroconfPublishing?.().catch(() => {});
  await unregisterDirectReceiveSession(sessionId).catch(() => {});
  activeReceiveRuntimes.delete(sessionId);
}

export function isReceivingAvailabilityActive(sessionId: string) {
  const runtime = activeReceiveRuntimes.get(sessionId);
  return Boolean(runtime && !runtime.stopping);
}

export async function acceptIncomingTransferOffer(sessionId: string) {
  const runtime = activeReceiveRuntimes.get(sessionId);
  if (!runtime?.session.incomingOffer || runtime.session.status !== "waiting") {
    return false;
  }

  logDirectTransferDebug("Accepting incoming transfer offer", {
    sessionId: getSessionDebugId(sessionId),
    offerId: getSessionDebugId(runtime.session.incomingOffer.id),
    senderDeviceName: runtime.session.incomingOffer.senderDeviceName,
  });

  try {
    const result = await runReceiveTransfer(runtime);

    await postDirectEvent(runtime.session.incomingOffer.sender, {
      kind: "completed",
      detail: result.detail,
    }).catch(() => {});

    withReceiveSessionUpdate(runtime, {
      status: "completed",
      receivedFiles: result.receivedFiles,
      progress: {
        phase: "completed",
        totalBytes: runtime.session.incomingOffer.totalBytes,
        bytesTransferred: result.bytesTransferred,
        currentFileName: null,
        speedBytesPerSecond: 0,
        detail: result.detail,
        updatedAt: nowIso(),
      },
    });
    updateTransferPerfSnapshot(sessionId, "receive", (snapshot) => {
      snapshot.receiverRequestDurationMs += result.requestDurationMs;
      snapshot.receiverDiskWriteDurationMs += result.diskWriteDurationMs;
      snapshot.usedNativeClient = result.usedNativeClient;
      snapshot.fallbackReason = result.fallbackReason;
    });
    finalizeReceivePerf(runtime);
    logDirectTransferDebug("Incoming transfer offer completed", {
      sessionId: getSessionDebugId(sessionId),
      offerId: getSessionDebugId(runtime.session.incomingOffer?.id),
      receivedFileCount: result.receivedFiles.length,
      bytesTransferred: result.bytesTransferred,
    });
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "The transfer could not be completed.";

    logDirectTransferDebug("Incoming transfer offer failed", {
      sessionId: getSessionDebugId(sessionId),
      offerId: getSessionDebugId(runtime.session.incomingOffer?.id),
      detail,
      ...getErrorDebugDetails(error),
    });

    if (!runtime.stopping && runtime.session.incomingOffer) {
      await postDirectEvent(runtime.session.incomingOffer.sender, {
        kind: "failed",
        message: detail,
      }).catch(() => {});
    }

    await failReceiveSession(runtime, detail);
    return false;
  }
}

export async function declineIncomingTransferOffer(sessionId: string) {
  const runtime = activeReceiveRuntimes.get(sessionId);
  if (!runtime?.session.incomingOffer || runtime.session.status !== "waiting") {
    return false;
  }

  const offer = runtime.session.incomingOffer;
  logDirectTransferDebug("Declining incoming transfer offer", {
    sessionId: getSessionDebugId(sessionId),
    offerId: getSessionDebugId(offer.id),
    senderDeviceName: offer.senderDeviceName,
  });
  await postDirectEvent(offer.sender, {
    kind: "rejected",
    message: "Transfer declined.",
  }).catch(() => {});
  resetReceiveToDiscoverable(runtime);
  return true;
}

export async function startNearbyScan({
  onUpdate,
  onError,
}: {
  onUpdate: (records: DiscoveryRecord[]) => void;
  onError?: (error: Error) => void;
}) {
  const currentRecords = new Map<string, DiscoveryRecord>();
  const scanner = new BonjourScanner({
    id: "direct-transfer-nearby",
  });
  let stopped = false;
  let syncToken = 0;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let restarting = false;

  function emitCurrentRecords() {
    logDirectTransferDebug("Nearby discovery records updated", {
      count: currentRecords.size,
      sessionIds: Array.from(currentRecords.keys()).map((sessionId) => getSessionDebugId(sessionId)),
    });
    onUpdate(
      Array.from(currentRecords.values()).sort((left, right) => right.advertisedAt.localeCompare(left.advertisedAt)),
    );
  }

  async function syncNearbyRecords(results: ScanResult[]) {
    const currentSyncToken = ++syncToken;
    const nextRecords = new Map<string, DiscoveryRecord>();

    const groups = await Promise.all(
      results.map(async (result) => {
        const host = getUsableLanHost(result.ipv4) ?? getUsableNearbyHost(result.hostname);
        const port = result.port ?? 0;
        if (!host || port <= 0) {
          logDirectTransferDebug("Ignoring nearby service without usable host or port", {
            serviceName: result.name ?? null,
            host: result.ipv4 ?? result.hostname ?? null,
            port: result.port ?? null,
          });
          return [];
        }

        try {
          const resolvedRecords = await fetchNearbyDiscoveryRecords({
            host,
            port,
          });

          if (!result.name) {
            return resolvedRecords;
          }

          const exactMatches = resolvedRecords.filter((record) => record.serviceName === result.name);
          if (exactMatches.length > 0) {
            return exactMatches;
          }

          return resolvedRecords.length === 1 ? resolvedRecords : [];
        } catch (error) {
          logDirectTransferDebug("Failed to hydrate nearby service metadata", {
            serviceName: result.name ?? null,
            host,
            port,
            ...getErrorDebugDetails(error),
          });
          return [];
        }
      }),
    );

    if (stopped || currentSyncToken !== syncToken) {
      return;
    }

    for (const group of groups) {
      for (const record of group) {
        nextRecords.set(record.sessionId, record);
      }
    }

    currentRecords.clear();
    nextRecords.forEach((record, sessionId) => {
      currentRecords.set(sessionId, record);
    });
    emitCurrentRecords();
  }

  function clearRestartTimer() {
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
  }

  function scheduleRestart(delayMs: number, reason: "scheduled" | "failure") {
    if (stopped) {
      return;
    }

    clearRestartTimer();
    restartTimer = setTimeout(() => {
      restartTimer = null;
      void restartScan(reason);
    }, delayMs);
  }

  function startScanner() {
    if (stopped) {
      return;
    }

    logDirectTransferDebug("Starting nearby discovery scan", {
      currentRecordCount: currentRecords.size,
    });

    try {
      scanner.scan(getNearbyBonjourServiceType(), getNearbyBonjourDomain(), {
        addressResolveTimeout: NEARBY_DISCOVERY_REQUEST_TIMEOUT_MS,
      });
    } catch (error) {
      const nextError = toNearbyScanError(error, "Unable to start nearby scanning.");
      logDirectTransferDebug("Nearby discovery scan start failed", getErrorDebugDetails(nextError));
      onError?.(nextError);
      scheduleRestart(NEARBY_DISCOVERY_RETRY_DELAY_MS, "failure");
    }
  }

  async function restartScan(reason: "scheduled" | "failure") {
    if (stopped || restarting) {
      return;
    }

    restarting = true;
    syncToken += 1;

    logDirectTransferDebug("Restarting nearby discovery scan", {
      reason,
      currentRecordCount: currentRecords.size,
    });

    try {
      scanner.stop();
      await waitForNearbyScannerToStop(scanner);
    } finally {
      restarting = false;
    }

    if (stopped) {
      return;
    }

    if (scanner.isScanning) {
      logDirectTransferDebug("Nearby discovery scan restart is waiting for the native scanner to stop", {
        reason,
        currentRecordCount: currentRecords.size,
      });
      scheduleRestart(NEARBY_DISCOVERY_RETRY_DELAY_MS, "failure");
      return;
    }

    startScanner();
    scheduleRestart(NEARBY_DISCOVERY_RESCAN_INTERVAL_MS, "scheduled");
  }

  const resultsListener = scanner.listenForScanResults((results) => {
    void syncNearbyRecords(results);
  });
  const failListener = scanner.listenForScanFail((error) => {
    logDirectTransferDebug("Nearby discovery scan error", getErrorDebugDetails(error));
    const errorMessage =
      typeof error === "object" && error && "message" in (error as Record<string, unknown>)
        ? (error as { message?: unknown }).message
        : null;
    const nextError = typeof errorMessage === "string" ? new Error(errorMessage) : new Error("Nearby scanning failed.");
    onError?.(nextError);
    scheduleRestart(NEARBY_DISCOVERY_RETRY_DELAY_MS, "failure");
  });

  startScanner();
  scheduleRestart(NEARBY_DISCOVERY_RESCAN_INTERVAL_MS, "scheduled");

  return () => {
    stopped = true;
    syncToken += 1;
    clearRestartTimer();
    logDirectTransferDebug("Stopping nearby discovery scan", {
      remainingRecords: currentRecords.size,
    });
    scanner.stop();
    resultsListener.remove();
    failListener.remove();
  };
}

export function parseDiscoveryQrPayload(value: string) {
  try {
    const record = parseDirectDiscoveryQrPayload(value);
    logDirectTransferDebug("Parsed receiver QR payload", getDiscoveryDebugDetails(record));
    return record;
  } catch (error) {
    logDirectTransferDebug("Failed to parse receiver QR payload", getErrorDebugDetails(error));
    throw error;
  }
}
