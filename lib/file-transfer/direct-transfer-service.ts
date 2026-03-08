import * as Crypto from "expo-crypto";
import { File, type Directory } from "expo-file-system";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import Zeroconf, { ImplType, type ZeroconfService } from "react-native-zeroconf";
import {
  acceptRelayTransferSession,
  completeRelayTransferSession,
  createRelayTransferSession,
  declineRelayTransferSession,
  deleteRelayTransferSession,
  fetchRelayTransferFile,
  getRelayReceiverState,
  getRelaySenderState,
  uploadRelayTransferFile,
} from "./relay-client";
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
} from "./local-http-runtime";
import type {
  DirectPeerAccess,
  DiscoveryRecord,
  DownloadableTransferManifest,
  IncomingTransferOffer,
  ReceiveSession,
  ReceivedFileRecord,
  RelayAccess,
  RelayCredentials,
  SelectedTransferFile,
  SenderTransferAccess,
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
      kind: "direct-http-failed";
      message: string;
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
      kind: "relay-ready";
      relay: RelayAccess;
    }
  | {
      kind: "relay-failed";
      message: string;
    }
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
  files: SelectedTransferFile[];
  target: DiscoveryRecord;
  direct: DirectPeerAccess;
  updateSession?: SendRuntimeUpdate;
  relayPollTimer?: ReturnType<typeof setInterval>;
  relayUploadStarted: boolean;
  offerDelivered: boolean;
  stopping: boolean;
}

interface PendingRelayReadyRequest {
  resolve: (value: IncomingTransferOffer) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ReceiveRuntime {
  session: ReceiveSession;
  updateSession?: ReceiveRuntimeUpdate;
  pendingRelayReady?: PendingRelayReadyRequest;
  activeDownloadAbortController?: AbortController;
  stopZeroconfPublishing?: () => void;
  stopping: boolean;
}

interface TransferResult {
  receivedFiles: ReceivedFileRecord[];
  bytesTransferred: number;
  detail: string | null;
}

const activeSendRuntimes = new Map<string, SendRuntime>();
const activeReceiveRuntimes = new Map<string, ReceiveRuntime>();
const RELAY_POLL_INTERVAL_MS = 1500;
const RELAY_FALLBACK_WAIT_TIMEOUT_MS = 12000;
const PEER_REQUEST_TIMEOUT_MS = 8000;
const PROGRESS_UPDATE_INTERVAL_MS = 250;
const PROGRESS_UPDATE_BYTES = 128 * 1024;
const DIRECT_TOKEN_HEADER = "x-direct-token";
const ZEROCONF_IMPL_TYPE = ImplType.DNSSD;

class DirectTransferFallbackError extends Error {}

function nowIso() {
  return new Date().toISOString();
}

function normalizeIpv4Address(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const normalized =
    value
      .trim()
      .replace(/^\[|\]$/g, "")
      .replace(/^::ffff:/i, "")
      .split("%")[0] ?? "";

  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized) ? normalized : null;
}

function isPrivateIpv4Address(value: string) {
  return (
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(value) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(value)
  );
}

function getUsableLanHost(value: string | null | undefined) {
  const normalized = normalizeIpv4Address(value);
  if (!normalized) {
    return null;
  }

  return isPrivateIpv4Address(normalized) ? normalized : null;
}

function normalizeMdnsHostname(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const normalized =
    value
      .trim()
      .replace(/^\[|\]$/g, "")
      .split("%")[0]
      ?.replace(/\.+$/, "") ?? "";
  if (!normalized || normalized.includes("://") || /\s/.test(normalized)) {
    return null;
  }

  return normalized.toLowerCase().endsWith(".local") ? normalized : null;
}

function getUsableNearbyHost(value: string | null | undefined) {
  return getUsableLanHost(value) ?? normalizeMdnsHostname(value);
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
  isPremium,
}: {
  files: SelectedTransferFile[];
  deviceName: string;
  sessionId: string;
  isPremium: boolean;
}): TransferManifest {
  const manifestFiles = files.map(toTransferManifestFile);
  const totalBytes = manifestFiles.reduce((sum, file) => sum + file.sizeBytes, 0);

  return {
    sessionId,
    deviceName,
    files: manifestFiles,
    fileCount: manifestFiles.length,
    totalBytes,
    isPremiumSender: isPremium,
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

function toRelayAccess(relay: RelayCredentials | null): RelayAccess | null {
  if (!relay) {
    return null;
  }

  return {
    sessionId: relay.sessionId,
    receiverToken: relay.receiverToken,
    expiresAt: relay.expiresAt,
  };
}

function createSenderTransferAccess({
  manifest,
  direct,
  relay,
}: {
  manifest: TransferManifest;
  direct: DirectPeerAccess;
  relay: RelayCredentials | null;
}): SenderTransferAccess {
  return {
    sessionId: manifest.sessionId,
    direct,
    relay: toRelayAccess(relay),
  };
}

function createIncomingTransferOffer({
  manifest,
  direct,
  relay,
}: {
  manifest: TransferManifest;
  direct: DirectPeerAccess;
  relay: RelayCredentials | null;
}): IncomingTransferOffer {
  return {
    id: manifest.sessionId,
    senderDeviceName: manifest.deviceName,
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    sender: createSenderTransferAccess({
      manifest,
      direct,
      relay,
    }),
    createdAt: manifest.createdAt,
  };
}

function createReceiverDiscoveryRecord({
  sessionId,
  method,
  deviceName,
  host,
  port,
  token,
  serviceName,
}: {
  sessionId: string;
  method: DiscoveryRecord["method"];
  deviceName: string;
  host: string;
  port: number;
  token: string;
  serviceName: string | null;
}): DiscoveryRecord {
  return {
    sessionId,
    method,
    deviceName,
    host,
    port,
    token,
    advertisedAt: nowIso(),
    serviceName,
  };
}

function buildQrPayload(record: DiscoveryRecord) {
  const host = getUsableLanHost(record.host);
  if (!host || record.port <= 0) {
    return null;
  }

  return JSON.stringify({
    version: 1,
    sessionId: record.sessionId,
    host,
    port: record.port,
    token: record.token,
    deviceName: record.deviceName,
    advertisedAt: record.advertisedAt,
  });
}

function createServiceName(deviceName: string, sessionId: string) {
  return `${deviceName.trim().slice(0, 24)}-${sessionId.slice(0, 6)}`;
}

function createInitialSendSession(
  manifest: TransferManifest,
  target: DiscoveryRecord,
  relay: RelayCredentials | null,
): TransferSession {
  return {
    id: manifest.sessionId,
    direction: "send",
    status: "waiting",
    manifest,
    previewMode: false,
    peerDeviceName: target.deviceName,
    awaitingReceiverResponse: true,
    relay,
    progress: createProgress(manifest.totalBytes, "waiting", `Waiting for ${target.deviceName} to accept.`),
  };
}

function createInitialReceiveSession(record: DiscoveryRecord): ReceiveSession {
  return {
    id: record.sessionId,
    status: "discoverable",
    discoveryRecord: record,
    qrPayload: buildQrPayload(record),
    previewMode: false,
    incomingOffer: null,
    peerDeviceName: null,
    receivedFiles: [],
    progress: createProgress(0, "discoverable", "Ready to receive files."),
  };
}

function createTransferOutputFile(directory: Directory, fileName: string, mimeType: string) {
  const safeName = fileName.replace(/[^\w.\-() ]+/g, "_");
  const outputFile = new File(directory, `${Date.now()}-${safeName}`);
  outputFile.create({ overwrite: true, intermediates: true });
  return {
    file: outputFile,
    mimeType,
  };
}

async function sleep(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createZeroconfPublisher({
  deviceName,
  port,
  receiverToken,
  sessionId,
}: {
  deviceName: string;
  port: number;
  receiverToken: string;
  sessionId: string;
}) {
  const serviceName = createServiceName(deviceName, sessionId);
  const zeroconf = new Zeroconf();

  zeroconf.publishService(
    LOCAL_TRANSFER_SERVICE_TYPE,
    LOCAL_TRANSFER_SERVICE_PROTOCOL,
    LOCAL_TRANSFER_SERVICE_DOMAIN,
    serviceName,
    port,
    {
      sessionId,
      receiverToken,
      deviceName,
    },
    ZEROCONF_IMPL_TYPE,
  );

  return {
    serviceName,
    stop() {
      zeroconf.unpublishService(serviceName, ZEROCONF_IMPL_TYPE);
      zeroconf.removeDeviceListeners();
    },
  };
}

function buildDirectSessionUrl(peer: Pick<DirectPeerAccess, "host" | "port" | "sessionId">, suffix: string) {
  return `http://${peer.host}:${peer.port}/direct/sessions/${encodeURIComponent(peer.sessionId)}${suffix}`;
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

function stopRelayPolling(runtime: SendRuntime) {
  if (!runtime.relayPollTimer) {
    return;
  }

  clearInterval(runtime.relayPollTimer);
  runtime.relayPollTimer = undefined;
}

function isSendRuntimeSettled(runtime: SendRuntime) {
  return ["completed", "failed", "canceled"].includes(runtime.session.status);
}

function failSendSession(runtime: SendRuntime, detail: string) {
  stopRelayPolling(runtime);
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

async function completeSendSession(runtime: SendRuntime, detail: string) {
  stopRelayPolling(runtime);
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

function takePendingRelayReady(runtime: ReceiveRuntime) {
  if (!runtime.pendingRelayReady) {
    return null;
  }

  const pending = runtime.pendingRelayReady;
  clearTimeout(pending.timer);
  runtime.pendingRelayReady = undefined;
  return pending;
}

function rejectPendingRelayReady(runtime: ReceiveRuntime, error: Error) {
  takePendingRelayReady(runtime)?.reject(error);
}

function resetReceiveToDiscoverable(runtime: ReceiveRuntime, detail = "Ready to receive files.") {
  rejectPendingRelayReady(runtime, new Error("That transfer request is no longer available."));
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
  rejectPendingRelayReady(runtime, new Error(detail));
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
    return false;
  }

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

function createReceiveProgressReporter(runtime: ReceiveRuntime, mirrorToSender: boolean) {
  let lastSentAt = 0;
  let lastSentBytes = 0;

  return (progress: TransferProgress, force = false) => {
    withReceiveSessionUpdate(runtime, {
      status: progress.phase === "transferring" ? "transferring" : "connecting",
      progress,
    });

    if (!mirrorToSender) {
      return;
    }

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
    void postDirectEvent(offer.sender.direct, {
      kind: "progress",
      progress,
    }).catch(() => {});
  };
}

function updateIncomingOfferRelay(runtime: ReceiveRuntime, relay: RelayAccess) {
  const offer = runtime.session.incomingOffer;
  if (!offer) {
    return null;
  }

  const nextOffer = {
    ...offer,
    sender: {
      ...offer.sender,
      relay,
    },
  } satisfies IncomingTransferOffer;

  withReceiveSessionUpdate(runtime, {
    incomingOffer: nextOffer,
  });

  return nextOffer;
}

function waitForRelayReady(runtime: ReceiveRuntime) {
  const offer = runtime.session.incomingOffer;
  if (!offer) {
    throw new Error("That transfer request is no longer available.");
  }

  if (offer.sender.relay) {
    return Promise.resolve(offer);
  }

  if (runtime.pendingRelayReady) {
    throw new Error("Receiver is already waiting for relay fallback.");
  }

  return new Promise<IncomingTransferOffer>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (runtime.pendingRelayReady?.timer !== timer) {
        return;
      }

      runtime.pendingRelayReady = undefined;
      reject(new Error("The sender could not prepare relay fallback."));
    }, RELAY_FALLBACK_WAIT_TIMEOUT_MS);

    runtime.pendingRelayReady = {
      resolve,
      reject,
      timer,
    };
  });
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
      peer: offer.sender.direct,
      offer,
      signal: abortController.signal,
    });

    const receivedFiles: ReceivedFileRecord[] = [];
    let bytesTransferred = 0;

    for (const file of manifest.files) {
      const output = createTransferOutputFile(getReceivedFilesDirectory(), file.name, file.mimeType);
      createdFiles.push(output.file);

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
          [DIRECT_TOKEN_HEADER]: offer.sender.direct.token,
        },
        signal: abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`Unable to download "${file.name}" (${response.status}).`);
      }

      await streamResponseToFile({
        response,
        destination: output.file,
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
        uri: output.file.uri,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        receivedAt: nowIso(),
      });
    }

    return {
      receivedFiles,
      bytesTransferred,
      detail: "Transfer complete.",
    } satisfies TransferResult;
  } catch (error) {
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

    throw error instanceof Error
      ? new DirectTransferFallbackError(error.message)
      : new DirectTransferFallbackError("Unable to download files over local WiFi.");
  } finally {
    runtime.activeDownloadAbortController = undefined;
    await deactivateKeepAwake(LOCAL_TRANSFER_KEEP_AWAKE_TAG).catch(() => {});
  }
}

async function ensureRelayReceiverAccepted({
  offer,
  receiverDeviceName,
}: {
  offer: IncomingTransferOffer;
  receiverDeviceName: string;
}) {
  if (!offer.sender.relay) {
    return;
  }

  await acceptRelayTransferSession({
    relay: offer.sender.relay,
    receiverDeviceName,
  });
}

async function receiveRelayTransfer({
  runtime,
  offer,
  receiverDeviceName,
  onProgress,
}: {
  runtime: ReceiveRuntime;
  offer: IncomingTransferOffer;
  receiverDeviceName: string;
  onProgress: (progress: TransferProgress, force?: boolean) => void;
}) {
  if (!offer.sender.relay) {
    throw new Error("Relay access is not available for this transfer.");
  }

  const abortController = new AbortController();
  runtime.activeDownloadAbortController = abortController;
  const createdFiles: File[] = [];

  await activateKeepAwakeAsync(LOCAL_TRANSFER_KEEP_AWAKE_TAG).catch(() => {});

  try {
    await ensureRelayReceiverAccepted({
      offer,
      receiverDeviceName,
    });

    let state = await getRelayReceiverState(offer.sender.relay);

    while (!["ready", "completed"].includes(state.status)) {
      if (abortController.signal.aborted) {
        throw new Error("Transfer canceled.");
      }

      if (state.status === "rejected") {
        throw new Error("Transfer declined.");
      }

      if (state.status === "expired") {
        throw new Error("This relay transfer expired before it could start.");
      }

      onProgress(
        {
          phase: "connecting",
          totalBytes: offer.totalBytes,
          bytesTransferred: 0,
          currentFileName: null,
          speedBytesPerSecond: 0,
          detail:
            state.status === "accepted"
              ? "Waiting for the sender to prepare relay transfer."
              : "Connecting through relay.",
          updatedAt: nowIso(),
        },
        true,
      );

      await sleep(RELAY_POLL_INTERVAL_MS);
      state = await getRelayReceiverState(offer.sender.relay);
    }

    const receivedFiles: ReceivedFileRecord[] = [];
    let bytesTransferred = 0;

    for (const file of state.files) {
      const output = createTransferOutputFile(getReceivedFilesDirectory(), file.name, file.mimeType);
      createdFiles.push(output.file);
      const startedAt = Date.now();
      let fileBytesTransferred = 0;

      onProgress({
        phase: "transferring",
        totalBytes: offer.totalBytes,
        bytesTransferred,
        currentFileName: file.name,
        speedBytesPerSecond: 0,
        detail: "Downloading files through relay.",
        updatedAt: nowIso(),
      });

      const response = await fetchRelayTransferFile({
        relay: offer.sender.relay,
        fileId: file.id,
        signal: abortController.signal,
      });

      await streamResponseToFile({
        response,
        destination: output.file,
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
            detail: "Downloading files through relay.",
            updatedAt: nowIso(),
          });
        },
      });

      receivedFiles.push({
        id: Crypto.randomUUID(),
        transferId: offer.id,
        name: file.name,
        uri: output.file.uri,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        receivedAt: nowIso(),
      });
    }

    await completeRelayTransferSession(offer.sender.relay).catch(() => {});

    return {
      receivedFiles,
      bytesTransferred,
      detail: "Transfer complete through relay.",
    } satisfies TransferResult;
  } catch (error) {
    for (const file of createdFiles) {
      try {
        if (file.exists) {
          file.delete();
        }
      } catch {
        // Best-effort cleanup for partially downloaded relay files.
      }
    }

    throw error instanceof Error ? error : new Error("Unable to receive files through relay.");
  } finally {
    runtime.activeDownloadAbortController = undefined;
    await deactivateKeepAwake(LOCAL_TRANSFER_KEEP_AWAKE_TAG).catch(() => {});
  }
}

async function receiveRelayFallbackTransfer({
  runtime,
  offer,
  onProgress,
}: {
  runtime: ReceiveRuntime;
  offer: IncomingTransferOffer;
  onProgress: (progress: TransferProgress, force?: boolean) => void;
}) {
  const relayOffer = offer.sender.relay ? offer : await waitForRelayReady(runtime);

  withReceiveSessionUpdate(runtime, {
    status: "connecting",
    incomingOffer: relayOffer,
    progress: {
      phase: "connecting",
      totalBytes: relayOffer.totalBytes,
      bytesTransferred: 0,
      currentFileName: null,
      speedBytesPerSecond: 0,
      detail: "Direct transfer unavailable. Switching to relay.",
      updatedAt: nowIso(),
    },
  });

  return receiveRelayTransfer({
    runtime,
    offer: relayOffer,
    receiverDeviceName: runtime.session.discoveryRecord.deviceName,
    onProgress,
  });
}

async function runReceiveTransfer(runtime: ReceiveRuntime) {
  const offer = runtime.session.incomingOffer;
  if (!offer) {
    throw new Error("That transfer request is no longer available.");
  }

  await postDirectEvent(offer.sender.direct, {
    kind: "accepted",
    receiverDeviceName: runtime.session.discoveryRecord.deviceName,
  });

  const directProgressReporter = createReceiveProgressReporter(runtime, true);

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

  try {
    return await receiveDirectHttpTransfer({
      runtime,
      offer,
      onProgress: directProgressReporter,
    });
  } catch (error) {
    if (!(error instanceof DirectTransferFallbackError)) {
      throw error;
    }

    await postDirectEvent(offer.sender.direct, {
      kind: "direct-http-failed",
      message: error.message,
    });

    return receiveRelayFallbackTransfer({
      runtime,
      offer,
      onProgress: createReceiveProgressReporter(runtime, false),
    });
  }
}

function startRelayPolling(runtime: SendRuntime) {
  if (!runtime.session.relay || runtime.relayPollTimer) {
    return;
  }

  void syncRelaySenderState(runtime);
  runtime.relayPollTimer = setInterval(() => {
    void syncRelaySenderState(runtime);
  }, RELAY_POLL_INTERVAL_MS);
}

async function uploadFilesToRelay(runtime: SendRuntime) {
  if (!runtime.session.relay || runtime.relayUploadStarted || isSendRuntimeSettled(runtime)) {
    return;
  }

  runtime.relayUploadStarted = true;
  await activateKeepAwakeAsync(LOCAL_TRANSFER_KEEP_AWAKE_TAG).catch(() => {});

  let bytesTransferred = 0;

  try {
    withSendSessionUpdate(runtime, {
      status: "transferring",
      awaitingReceiverResponse: false,
      progress: {
        ...runtime.session.progress,
        phase: "transferring",
        detail: "Uploading files through relay.",
        updatedAt: nowIso(),
      },
    });

    for (const file of runtime.files) {
      const startedAt = Date.now();
      await uploadRelayTransferFile({
        relay: runtime.session.relay,
        file,
      });

      bytesTransferred += file.sizeBytes;
      const elapsedMilliseconds = Math.max(Date.now() - startedAt, 1);
      const speedBytesPerSecond = Math.round((file.sizeBytes / elapsedMilliseconds) * 1000);

      withSendSessionUpdate(runtime, {
        progress: {
          phase: "transferring",
          totalBytes: runtime.session.manifest.totalBytes,
          bytesTransferred,
          currentFileName: file.name,
          speedBytesPerSecond,
          detail: "Uploading files through relay.",
          updatedAt: nowIso(),
        },
      });
    }

    withSendSessionUpdate(runtime, {
      status: "transferring",
      progress: {
        phase: "transferring",
        totalBytes: runtime.session.manifest.totalBytes,
        bytesTransferred,
        currentFileName: null,
        speedBytesPerSecond: 0,
        detail: "Waiting for the receiver to finish relay download.",
        updatedAt: nowIso(),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Relay upload failed.";
    await postDirectEvent(buildPeerAccessFromDiscovery(runtime.target), {
      kind: "failed",
      message,
    }).catch(() => {});
    failSendSession(runtime, message);
    throw error;
  } finally {
    await deactivateKeepAwake(LOCAL_TRANSFER_KEEP_AWAKE_TAG).catch(() => {});
  }
}

async function syncRelaySenderState(runtime: SendRuntime) {
  if (!runtime.session.relay || isSendRuntimeSettled(runtime)) {
    return;
  }

  try {
    const state = await getRelaySenderState(runtime.session.relay);
    const receiverName = getPeerName(state.receiverDeviceName ?? runtime.session.peerDeviceName ?? undefined);

    if (state.status === "accepted" && !runtime.relayUploadStarted) {
      withSendSessionUpdate(runtime, {
        peerDeviceName: receiverName,
        status: "connecting",
        progress: {
          phase: "connecting",
          totalBytes: runtime.session.manifest.totalBytes,
          bytesTransferred: runtime.session.progress.bytesTransferred,
          currentFileName: null,
          speedBytesPerSecond: 0,
          detail: `${receiverName} accepted relay fallback. Uploading files.`,
          updatedAt: nowIso(),
        },
      });
      void uploadFilesToRelay(runtime).catch(() => {});
      return;
    }

    if (state.status === "rejected") {
      failSendSession(runtime, "Relay transfer declined.");
      return;
    }

    if (state.status === "completed") {
      await completeSendSession(runtime, "Transfer complete through relay.");
      return;
    }

    if (state.status === "expired") {
      failSendSession(runtime, "This relay transfer expired.");
    }
  } catch (error) {
    console.warn("Unable to refresh relay sender state", error);
  }
}

function getPeerName(value: string | undefined) {
  return value?.trim() ? value.trim().slice(0, 40) : "Nearby device";
}

async function provisionRelayFallback(runtime: SendRuntime, receiverName: string) {
  if (runtime.session.relay) {
    await postDirectEvent(buildPeerAccessFromDiscovery(runtime.target), {
      kind: "relay-ready",
      relay: toRelayAccess(runtime.session.relay)!,
    }).catch(() => {});
    return true;
  }

  let relay: RelayCredentials;

  try {
    relay = await createRelayTransferSession({
      senderDeviceName: runtime.session.manifest.deviceName,
      files: runtime.files,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to prepare relay fallback.";
    await postDirectEvent(buildPeerAccessFromDiscovery(runtime.target), {
      kind: "relay-failed",
      message,
    }).catch(() => {});
    failSendSession(runtime, message);
    return false;
  }

  if (isSendRuntimeSettled(runtime)) {
    await deleteRelayTransferSession(relay).catch(() => {});
    return false;
  }

  withSendSessionUpdate(runtime, {
    relay,
    progress: {
      phase: "connecting",
      totalBytes: runtime.session.manifest.totalBytes,
      bytesTransferred: runtime.session.progress.bytesTransferred,
      currentFileName: null,
      speedBytesPerSecond: 0,
      detail: `${receiverName} could not connect over local WiFi. Preparing relay transfer.`,
      updatedAt: nowIso(),
    },
  });

  startRelayPolling(runtime);

  try {
    await postDirectEvent(buildPeerAccessFromDiscovery(runtime.target), {
      kind: "relay-ready",
      relay: toRelayAccess(relay)!,
    });
    return true;
  } catch (error) {
    stopRelayPolling(runtime);
    withSendSessionUpdate(runtime, {
      relay: null,
    });
    await deleteRelayTransferSession(relay).catch(() => {});
    failSendSession(
      runtime,
      error instanceof Error ? error.message : "Unable to notify the receiver about relay fallback.",
    );
    return false;
  }
}

async function handleSenderEvent(runtime: SendRuntime, event: ReceiverToSenderEvent) {
  if (event.kind === "accepted") {
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
    await completeSendSession(runtime, event.detail ?? "Transfer complete.");
    return;
  }

  if (event.kind === "direct-http-failed") {
    await provisionRelayFallback(runtime, runtime.session.peerDeviceName ?? runtime.target.deviceName);
    return;
  }

  if (event.kind === "rejected") {
    failSendSession(runtime, event.message || "Transfer declined.");
    return;
  }

  failSendSession(runtime, event.message || "Transfer stopped.");
}

async function handleReceiverEvent(runtime: ReceiveRuntime, event: SenderToReceiverEvent) {
  if (event.kind === "relay-ready") {
    const nextOffer = updateIncomingOfferRelay(runtime, event.relay);
    if (nextOffer) {
      takePendingRelayReady(runtime)?.resolve(nextOffer);
    }
    return;
  }

  if (event.kind === "relay-failed") {
    rejectPendingRelayReady(runtime, new Error(event.message || "Unable to prepare relay fallback."));
    return;
  }

  if (runtime.session.status === "waiting") {
    resetReceiveToDiscoverable(runtime, event.message || "Sender stopped the transfer.");
    return;
  }

  rejectPendingRelayReady(runtime, new Error(event.message || "Sender stopped the transfer."));
  runtime.activeDownloadAbortController?.abort();
}

async function startOffer(runtime: SendRuntime, offer: IncomingTransferOffer) {
  try {
    await postIncomingOffer(runtime.target, offer);
    runtime.offerDelivered = true;
  } catch (error) {
    failSendSession(runtime, error instanceof Error ? error.message : "Unable to reach that receiver.");
  }
}

async function handleSendRegistrationInterrupted(runtime: SendRuntime, detail: string) {
  if (runtime.stopping || isSendRuntimeSettled(runtime)) {
    return;
  }

  failSendSession(runtime, detail);
}

async function handleReceiveRegistrationInterrupted(runtime: ReceiveRuntime, detail: string) {
  if (runtime.stopping) {
    return;
  }

  failReceiveSession(runtime, detail);
}

function mapResolvedService(service: ZeroconfService) {
  const sessionId = service.txt?.sessionId;
  const receiverToken = service.txt?.receiverToken;
  const host =
    service.addresses?.map((address) => getUsableLanHost(address)).find((address) => Boolean(address)) ??
    getUsableNearbyHost(service.host);

  if (!sessionId || !receiverToken || !host) {
    return null;
  }

  return {
    sessionId,
    method: "nearby",
    deviceName: service.txt?.deviceName ?? service.name,
    host,
    port: service.port ?? 0,
    token: receiverToken,
    advertisedAt: nowIso(),
    serviceName: service.name,
  } satisfies DiscoveryRecord;
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

  if (target.port <= 0 || !target.token.trim()) {
    throw new Error("That receiver is no longer available.");
  }

  const validatedTargetHost =
    target.method === "nearby" ? getUsableNearbyHost(target.host) : getUsableLanHost(target.host);
  if (!validatedTargetHost) {
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

  const manifest = createTransferManifest({
    files,
    deviceName,
    sessionId,
    isPremium,
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

  const runtime: SendRuntime = {
    session: createInitialSendSession(manifest, resolvedTarget, null),
    files,
    target: resolvedTarget,
    direct,
    updateSession,
    relayUploadStarted: false,
    offerDelivered: false,
    stopping: false,
  };

  activeSendRuntimes.set(sessionId, runtime);
  updateSession?.(runtime.session);

  const offer = createIncomingTransferOffer({
    manifest,
    direct,
    relay: null,
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
  stopRelayPolling(runtime);

  if (!isSendRuntimeSettled(runtime) && runtime.offerDelivered) {
    await postDirectEvent(buildPeerAccessFromDiscovery(runtime.target), {
      kind: "canceled",
      message: "Sender canceled the transfer.",
    }).catch(() => {});
  }

  await unregisterDirectSendSession(runtime.session.id).catch(() => {});

  if (runtime.session.relay) {
    await deleteRelayTransferSession(runtime.session.relay).catch((error) => {
      console.warn("Unable to delete relay transfer session", error);
    });
  }

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

  const direct = await registerDirectReceiveSession({
    sessionId,
    token: receiverToken,
    deviceName,
    onOffer: async (offer) => {
      const runtime = activeReceiveRuntimes.get(sessionId);
      if (!runtime) {
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
  const zeroconfPublisher = createZeroconfPublisher({
    sessionId,
    deviceName,
    port: direct.port,
    receiverToken,
  });

  const runtime: ReceiveRuntime = {
    session: createInitialReceiveSession(
      createReceiverDiscoveryRecord({
        sessionId,
        method: "nearby",
        deviceName,
        host: direct.host,
        port: direct.port,
        token: direct.token,
        serviceName: zeroconfPublisher.serviceName,
      }),
    ),
    updateSession,
    stopZeroconfPublishing: zeroconfPublisher.stop,
    stopping: false,
  };

  activeReceiveRuntimes.set(sessionId, runtime);
  updateSession?.(runtime.session);
  return runtime.session;
}

export async function stopReceivingAvailability(sessionId: string) {
  const runtime = activeReceiveRuntimes.get(sessionId);
  if (!runtime) {
    return;
  }

  runtime.stopping = true;
  rejectPendingRelayReady(runtime, new Error("Receiver is no longer available."));
  runtime.activeDownloadAbortController?.abort();

  if (runtime.session.incomingOffer) {
    if (runtime.session.status === "waiting") {
      if (runtime.session.incomingOffer.sender.relay) {
        await declineRelayTransferSession(runtime.session.incomingOffer.sender.relay).catch(() => {});
      }
      await postDirectEvent(runtime.session.incomingOffer.sender.direct, {
        kind: "rejected",
        message: "Receiver is no longer available.",
      }).catch(() => {});
    } else if (runtime.session.status === "connecting" || runtime.session.status === "transferring") {
      await postDirectEvent(runtime.session.incomingOffer.sender.direct, {
        kind: "canceled",
        message: "Receiver canceled the transfer.",
      }).catch(() => {});
    }
  }

  runtime.stopZeroconfPublishing?.();
  await unregisterDirectReceiveSession(sessionId).catch(() => {});
  activeReceiveRuntimes.delete(sessionId);
}

export async function acceptIncomingTransferOffer(sessionId: string) {
  const runtime = activeReceiveRuntimes.get(sessionId);
  if (!runtime?.session.incomingOffer || runtime.session.status !== "waiting") {
    return false;
  }

  try {
    const result = await runReceiveTransfer(runtime);

    await postDirectEvent(runtime.session.incomingOffer.sender.direct, {
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
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "The transfer could not be completed.";

    if (!runtime.stopping && runtime.session.incomingOffer) {
      await postDirectEvent(runtime.session.incomingOffer.sender.direct, {
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
  if (offer.sender.relay) {
    await declineRelayTransferSession(offer.sender.relay).catch(() => {});
  }

  await postDirectEvent(offer.sender.direct, {
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

  function emitCurrentRecords() {
    onUpdate(
      Array.from(currentRecords.values()).sort((left, right) => right.advertisedAt.localeCompare(left.advertisedAt)),
    );
  }
  const zeroconf = new Zeroconf();
  zeroconf.on("resolved", (service: ZeroconfService) => {
    const nextRecord = mapResolvedService(service);
    if (!nextRecord) {
      return;
    }

    currentRecords.set(nextRecord.sessionId, nextRecord);
    emitCurrentRecords();
  });
  zeroconf.on("remove", (serviceName: string) => {
    for (const [sessionId, record] of currentRecords) {
      if (record.serviceName === serviceName && record.method === "nearby") {
        currentRecords.delete(sessionId);
      }
    }
    emitCurrentRecords();
  });
  zeroconf.on("error", (error: unknown) => {
    onError?.(error instanceof Error ? error : new Error("Nearby scanning failed."));
  });
  zeroconf.scan(
    LOCAL_TRANSFER_SERVICE_TYPE,
    LOCAL_TRANSFER_SERVICE_PROTOCOL,
    LOCAL_TRANSFER_SERVICE_DOMAIN,
    ZEROCONF_IMPL_TYPE,
  );

  return () => {
    zeroconf.stop(ZEROCONF_IMPL_TYPE);
    zeroconf.removeAllListeners?.();
    zeroconf.removeDeviceListeners();
  };
}

export function parseDiscoveryQrPayload(value: string) {
  const parsed = JSON.parse(value) as {
    sessionId: string;
    host: string;
    port: number;
    token: string;
    deviceName: string;
    advertisedAt: string;
  };

  return {
    sessionId: parsed.sessionId,
    method: "qr",
    deviceName: parsed.deviceName,
    host: parsed.host,
    port: parsed.port,
    token: parsed.token,
    advertisedAt: parsed.advertisedAt,
    serviceName: null,
  } satisfies DiscoveryRecord;
}
