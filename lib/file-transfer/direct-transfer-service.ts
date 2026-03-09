import * as Crypto from "expo-crypto";
import { BonjourScanner, type ScanResult } from "@dawidzawada/bonjour-zeroconf";
import { File, type Directory } from "expo-file-system";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import NearbyAdvertiser from "@/modules/nearby-advertiser";
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
import { getReceivedFilesDirectory } from "./files";
import {
  registerDirectReceiveSession,
  registerDirectSendSession,
  unregisterDirectReceiveSession,
  unregisterDirectSendSession,
  updateDirectReceiveServiceName,
} from "./local-http-runtime";
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
  updateSession?: SendRuntimeUpdate;
  offerDelivered: boolean;
  stopping: boolean;
}

interface ReceiveRuntime {
  session: ReceiveSession;
  updateSession?: ReceiveRuntimeUpdate;
  activeDownloadAbortController?: AbortController;
  stopZeroconfPublishing?: () => Promise<void>;
  stopping: boolean;
}

interface TransferResult {
  receivedFiles: ReceivedFileRecord[];
  bytesTransferred: number;
  detail: string | null;
}

const activeSendRuntimes = new Map<string, SendRuntime>();
const activeReceiveRuntimes = new Map<string, ReceiveRuntime>();
const PEER_REQUEST_TIMEOUT_MS = 8000;
const NEARBY_DISCOVERY_REQUEST_TIMEOUT_MS = 2500;
const PROGRESS_UPDATE_INTERVAL_MS = 250;
const PROGRESS_UPDATE_BYTES = 128 * 1024;
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
  runtime.session = {
    ...runtime.session,
    ...patch,
    progress: patch.progress ?? runtime.session.progress,
  };
  runtime.updateSession?.(runtime.session);
}

function withReceiveSessionUpdate(runtime: ReceiveRuntime, patch: Partial<ReceiveSession>) {
  runtime.session = {
    ...runtime.session,
    ...patch,
    progress: patch.progress ?? runtime.session.progress,
    receivedFiles: patch.receivedFiles ?? runtime.session.receivedFiles,
  };
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
  signal,
}: {
  peer: DirectPeerAccess;
  offer: IncomingTransferOffer;
  signal: AbortSignal;
}) {
  logDirectTransferDebug("Fetching sender manifest", {
    offerId: getSessionDebugId(offer.id),
    senderDeviceName: offer.senderDeviceName,
    ...getPeerDebugDetails(peer),
  });

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

  return payload;
}

async function streamResponseToFile({
  response,
  destination,
  signal,
  onBytes,
}: {
  response: Response;
  destination: File;
  signal: AbortSignal;
  onBytes: (value: number) => void;
}) {
  destination.create({ overwrite: true, intermediates: true });
  const handle = destination.open();

  try {
    if (!response.body) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (signal.aborted) {
        throw new Error("Download canceled.");
      }
      handle.writeBytes(bytes);
      onBytes(bytes.byteLength);
      return;
    }

    const reader = response.body.getReader();
    while (true) {
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

      handle.writeBytes(value);
      onBytes(value.byteLength);
    }
  } finally {
    handle.close();
  }
}

function isSendRuntimeSettled(runtime: SendRuntime) {
  return ["completed", "failed", "canceled"].includes(runtime.session.status);
}

function failSendSession(runtime: SendRuntime, detail: string) {
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
}

function completeSendSession(runtime: SendRuntime, detail: string) {
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

function failReceiveSession(runtime: ReceiveRuntime, detail: string) {
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
      signal: abortController.signal,
    });

    const receivedFiles: ReceivedFileRecord[] = [];
    let bytesTransferred = 0;

    for (const file of manifest.files) {
      const outputFile = createTransferOutputFile(getReceivedFilesDirectory(), file.name);
      createdFiles.push(outputFile);

      logDirectTransferDebug("Downloading file from sender", {
        offerId: getSessionDebugId(offer.id),
        fileName: file.name,
        sizeBytes: file.sizeBytes,
        destinationUri: outputFile.uri,
      });

      const startedAt = Date.now();
      let fileBytesTransferred = 0;

      onProgress({
        phase: "transferring",
        totalBytes: offer.totalBytes,
        bytesTransferred,
        currentFileName: file.name,
        speedBytesPerSecond: 0,
        detail: "Downloading files over local WiFi.",
        updatedAt: nowIso(),
      });

      const response = await fetch(file.downloadUrl, {
        method: "GET",
        headers: {
          [DIRECT_TOKEN_HEADER]: offer.sender.token,
        },
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`Unable to download "${file.name}" (${response.status}).`);
      }

      await streamResponseToFile({
        response,
        destination: outputFile,
        signal: abortController.signal,
        onBytes: (chunkBytes) => {
          fileBytesTransferred += chunkBytes;
          bytesTransferred += chunkBytes;
          const elapsedMilliseconds = Math.max(Date.now() - startedAt, 1);
          const speedBytesPerSecond = Math.round((fileBytesTransferred / elapsedMilliseconds) * 1000);

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

      receivedFiles.push({
        id: Crypto.randomUUID(),
        transferId: offer.id,
        name: file.name,
        uri: outputFile.uri,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        receivedAt: nowIso(),
      });

      logDirectTransferDebug("Finished downloading file from sender", {
        offerId: getSessionDebugId(offer.id),
        fileName: file.name,
        bytesTransferred: fileBytesTransferred,
      });
    }

    logDirectTransferDebug("Receiver completed direct transfer", {
      offerId: getSessionDebugId(offer.id),
      receivedFileCount: receivedFiles.length,
      bytesTransferred,
    });

    return {
      receivedFiles,
      bytesTransferred,
      detail: "Transfer complete.",
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
    completeSendSession(runtime, event.detail ?? "Transfer complete.");
    return;
  }

  if (event.kind === "rejected") {
    logDirectTransferDebug("Sender received transfer rejection", {
      sessionId: getSessionDebugId(runtime.session.id),
      message: event.message,
    });
    failSendSession(runtime, event.message || "Transfer declined.");
    return;
  }

  logDirectTransferDebug("Sender received terminal receiver event", {
    sessionId: getSessionDebugId(runtime.session.id),
    kind: event.kind,
    message: event.message,
  });
  failSendSession(runtime, event.message || "Transfer stopped.");
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

  failReceiveSession(runtime, detail);
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
    failSendSession(runtime, error instanceof Error ? error.message : "Unable to reach that receiver.");
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

  failSendSession(runtime, detail);
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

  failReceiveSession(runtime, detail);
}

export async function startSendingTransfer({
  files,
  target,
  deviceName,
  updateSession,
}: {
  files: SelectedTransferFile[];
  target: DiscoveryRecord;
  deviceName: string;
  updateSession?: SendRuntimeUpdate;
}) {
  const sessionId = Crypto.randomUUID();

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

  if (target.port <= 0 || !target.token.trim()) {
    logDirectTransferDebug("Sender target is no longer valid", {
      senderSessionId: getSessionDebugId(sessionId),
      targetPort: target.port,
      hasToken: Boolean(target.token.trim()),
      targetMethod: target.method,
      targetHost: target.host,
      targetDeviceName: target.deviceName,
      targetSessionId: getSessionDebugId(target.sessionId),
    });
    throw new Error("That receiver is no longer available.");
  }

  const validatedTargetHost = resolveDiscoveryHost(target);
  if (!validatedTargetHost) {
    logDirectTransferDebug("Sender target host could not be resolved", {
      senderSessionId: getSessionDebugId(sessionId),
      targetMethod: target.method,
      targetHost: target.host,
      targetPort: target.port,
      targetDeviceName: target.deviceName,
      targetSessionId: getSessionDebugId(target.sessionId),
    });
    throw new Error(
      target.method === "qr"
        ? "That QR code does not contain a usable local WiFi address."
        : "That receiver is not advertising a usable local WiFi address.",
    );
  }

  const resolvedTarget =
    validatedTargetHost === target.host
      ? target
      : {
          ...target,
          host: validatedTargetHost,
        };

  logDirectTransferDebug("Sender target resolved", {
    senderSessionId: getSessionDebugId(sessionId),
    originalHost: target.host,
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

  const direct = await registerDirectSendSession({
    sessionId,
    token: Crypto.randomUUID().replace(/-/g, ""),
    deviceName,
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

  await unregisterDirectSendSession(runtime.session.id).catch(() => {});
  activeSendRuntimes.delete(sessionId);
}

export async function startReceivingAvailability({
  deviceName,
  updateSession,
}: {
  deviceName: string;
  updateSession?: ReceiveRuntimeUpdate;
}) {
  const sessionId = Crypto.randomUUID();
  const receiverToken = Crypto.randomUUID().replace(/-/g, "");
  const requestedServiceName = createServiceName(deviceName, sessionId);

  logDirectTransferDebug("Starting receiver availability", {
    sessionId: getSessionDebugId(sessionId),
    deviceName,
  });

  const direct = await registerDirectReceiveSession({
    sessionId,
    token: receiverToken,
    deviceName,
    serviceName: requestedServiceName,
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
    }
  }

  await runtime.stopZeroconfPublishing?.().catch(() => {});
  await unregisterDirectReceiveSession(sessionId).catch(() => {});
  activeReceiveRuntimes.delete(sessionId);
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

    failReceiveSession(runtime, detail);
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

  logDirectTransferDebug("Starting nearby discovery scan");
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
  });
  scanner.scan(getNearbyBonjourServiceType(), getNearbyBonjourDomain(), {
    addressResolveTimeout: NEARBY_DISCOVERY_REQUEST_TIMEOUT_MS,
  });

  return () => {
    stopped = true;
    syncToken += 1;
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
