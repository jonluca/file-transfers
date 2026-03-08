import { Buffer } from "buffer";
import * as Crypto from "expo-crypto";
import { File, type Directory } from "expo-file-system";
import * as Network from "expo-network";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import type { ZeroconfService } from "react-native-zeroconf";
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
  LOCAL_TRANSFER_CERT_FINGERPRINT,
  LOCAL_TRANSFER_CERTIFICATE_ASSET,
  LOCAL_TRANSFER_KEEP_AWAKE_TAG,
  LOCAL_TRANSFER_KEYSTORE_ASSET,
  LOCAL_TRANSFER_SERVICE_DOMAIN,
  LOCAL_TRANSFER_SERVICE_PROTOCOL,
  LOCAL_TRANSFER_SERVICE_TYPE,
} from "./constants";
import { createReceivedFileRecord, getReceivedFilesDirectory } from "./files";
import { startLocalHttpSession, stopLocalHttpSession, type LocalHttpSession } from "./local-http-runtime";
import type {
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

type SenderControlMessage =
  | {
      kind: "offer";
      receiverSessionId: string;
      receiverToken: string;
      offer: IncomingTransferOffer;
    }
  | {
      kind: "http-ready";
      manifestUrl: string;
      shareUrl: string;
    }
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

type ReceiverControlMessage =
  | {
      kind: "offer-received";
    }
  | {
      kind: "accepted";
      receiverDeviceName: string;
    }
  | {
      kind: "rejected";
      message: string;
    }
  | {
      kind: "busy";
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

type ControlMessage = SenderControlMessage | ReceiverControlMessage;

interface SendRuntime {
  session: TransferSession;
  files: SelectedTransferFile[];
  target: DiscoveryRecord;
  updateSession?: SendRuntimeUpdate;
  controlSocket?: TransferSocket;
  relayPollTimer?: ReturnType<typeof setInterval>;
  relayUploadStarted: boolean;
  httpSessionId: string | null;
  stopping: boolean;
}

interface PendingHttpReadyRequest {
  resolve: (value: { manifestUrl: string; shareUrl: string }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingRelayReadyRequest {
  resolve: (value: IncomingTransferOffer) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ReceiveRuntime {
  session: ReceiveSession;
  updateSession?: ReceiveRuntimeUpdate;
  controlSocket?: TransferSocket;
  pendingHttpReady?: PendingHttpReadyRequest;
  pendingRelayReady?: PendingRelayReadyRequest;
  activeDownloadAbortController?: AbortController;
  zeroconf?: {
    publisher: {
      stop(): void;
    };
  };
  server?: {
    close(): void;
  };
  stopping: boolean;
}

interface TransferSocket {
  destroy(): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  off?(event: string, handler: (...args: unknown[]) => void): void;
  removeAllListeners?(event?: string): void;
  remoteAddress?: string;
  setNoDelay?(noDelay?: boolean): void;
  write(buffer: Uint8Array | Buffer | string, cb?: (error?: Error) => void): boolean;
}

interface TransferServer {
  once(event: string, handler: (error: Error) => void): void;
  off(event: string, handler: (error: Error) => void): void;
  listen(options: { port: number; host: string; reuseAddress: boolean }, callback: () => void): void;
  close(): void;
  address(): { port?: number } | null;
}

interface ZeroconfInstance {
  on(event: string, handler: (...args: unknown[]) => void): void;
  scan(type: string, protocol: string, domain: string, implType: string): void;
  stop(implType?: string): void;
  publishService(
    type: string,
    protocol: string,
    domain: string,
    name: string,
    port: number,
    txt: Record<string, string>,
    implType: string,
  ): void;
  unpublishService(name: string, implType?: string): void;
  removeAllListeners?(): void;
  removeDeviceListeners(): void;
}

interface ZeroconfModuleLike {
  Zeroconf: new () => ZeroconfInstance;
  ImplType: { DNSSD: string };
}

interface TcpSocketLike {
  createTLSServer: (options: { keystore: number }, listener: (socket: TransferSocket) => void) => TransferServer;
  connectTLS: (options: {
    host: string;
    port: number;
    ca: number;
    tlsCheckValidity: boolean;
    interface?: "wifi" | "cellular" | "ethernet";
  }) => TransferSocket;
}

interface TransferResult {
  receivedFiles: ReceivedFileRecord[];
  bytesTransferred: number;
  detail: string | null;
}

const activeSendRuntimes = new Map<string, SendRuntime>();
const activeReceiveRuntimes = new Map<string, ReceiveRuntime>();
const RELAY_POLL_INTERVAL_MS = 1500;
const CONTROL_RESPONSE_TIMEOUT_MS = 8000;
const HTTP_READY_TIMEOUT_MS = 15000;
const RELAY_FALLBACK_WAIT_TIMEOUT_MS = 12000;
const CONTROL_MESSAGE_BUFFER_LIMIT = 64 * 1024;
const PROGRESS_UPDATE_INTERVAL_MS = 250;
const PROGRESS_UPDATE_BYTES = 128 * 1024;

class DirectTransferFallbackError extends Error {}

function createProgress(totalBytes: number, phase: TransferProgress["phase"], detail: string | null): TransferProgress {
  return {
    phase,
    totalBytes,
    bytesTransferred: 0,
    currentFileName: null,
    speedBytesPerSecond: 0,
    detail,
    updatedAt: new Date().toISOString(),
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

async function loadTcpSocket() {
  try {
    const module = (await import("react-native-tcp-socket")) as unknown as { default?: TcpSocketLike };
    return (module.default ?? module) as TcpSocketLike;
  } catch (error) {
    console.warn("react-native-tcp-socket unavailable, using preview mode", error);
    return null;
  }
}

async function loadZeroconf() {
  try {
    const module = (await import("react-native-zeroconf")) as unknown as {
      default?: new () => ZeroconfInstance;
      ImplType?: { DNSSD: string };
    };
    const Zeroconf = (module.default ??
      (module as unknown as {
        new (): ZeroconfInstance;
      })) as new () => ZeroconfInstance;

    return {
      Zeroconf,
      ImplType: module.ImplType ?? { DNSSD: "DNSSD" },
    } satisfies ZeroconfModuleLike;
  } catch (error) {
    console.warn("react-native-zeroconf unavailable, using QR only", error);
    return null;
  }
}

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

function createSenderTransferAccess(manifest: TransferManifest, relay: RelayCredentials | null): SenderTransferAccess {
  return {
    sessionId: manifest.sessionId,
    relay: toRelayAccess(relay),
  };
}

function createIncomingTransferOffer(
  manifest: TransferManifest,
  relay: RelayCredentials | null,
): IncomingTransferOffer {
  return {
    id: manifest.sessionId,
    senderDeviceName: manifest.deviceName,
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    sender: createSenderTransferAccess(manifest, relay),
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
    certificateFingerprint: LOCAL_TRANSFER_CERT_FINGERPRINT,
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
    certificateFingerprint: record.certificateFingerprint,
    advertisedAt: record.advertisedAt,
  });
}

function createServiceName(deviceName: string, sessionId: string) {
  return `${deviceName.trim().slice(0, 24)}-${sessionId.slice(0, 6)}`;
}

function createInitialSendSession(
  manifest: TransferManifest,
  target: DiscoveryRecord,
  previewMode: boolean,
  relay: RelayCredentials | null,
): TransferSession {
  return {
    id: manifest.sessionId,
    direction: "send",
    status: "waiting",
    manifest,
    previewMode,
    peerDeviceName: target.deviceName,
    awaitingReceiverResponse: true,
    relay,
    progress: createProgress(manifest.totalBytes, "waiting", `Waiting for ${target.deviceName} to accept.`),
  };
}

function createInitialReceiveSession(record: DiscoveryRecord, previewMode: boolean): ReceiveSession {
  return {
    id: record.sessionId,
    status: "discoverable",
    discoveryRecord: record,
    qrPayload: buildQrPayload({ ...record, method: "qr" }),
    previewMode,
    incomingOffer: null,
    peerDeviceName: null,
    receivedFiles: [],
    progress: createProgress(0, "discoverable", "Ready to receive files."),
  };
}

function createTransferOutputFile(directory: Directory, fileName: string, mimeType: string) {
  const safeName = fileName.replace(/[^\w.\-() ]+/g, "_");
  const targetName = `${Date.now()}-${safeName}`;
  const outputFile = new File(directory, targetName);
  outputFile.create({ overwrite: true, intermediates: true });
  return {
    file: outputFile,
    mimeType,
  };
}

async function sleep(milliseconds: number) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function writeSocket(socket: Pick<TransferSocket, "write">, payload: Uint8Array | Buffer | string) {
  await new Promise<void>((resolve, reject) => {
    socket.write(payload, (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function writeControlMessage(socket: Pick<TransferSocket, "write">, message: ControlMessage) {
  await writeSocket(socket, `${JSON.stringify(message)}\n`);
}

function createControlMessageParser(onMessage: (message: ControlMessage) => void) {
  let buffer = "";

  return (chunk: Uint8Array | Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    if (buffer.length > CONTROL_MESSAGE_BUFFER_LIMIT) {
      throw new Error("Control connection exceeded the supported message size.");
    }

    while (true) {
      const newLineIndex = buffer.indexOf("\n");
      if (newLineIndex === -1) {
        return;
      }

      const rawLine = buffer.slice(0, newLineIndex);
      buffer = buffer.slice(newLineIndex + 1);

      const line = rawLine.trim();
      if (!line) {
        continue;
      }

      onMessage(JSON.parse(line) as ControlMessage);
    }
  };
}

function getPeerName(value: string | undefined) {
  return value?.trim() ? value.trim().slice(0, 40) : "Nearby device";
}

function stopRelayPolling(runtime: SendRuntime) {
  if (!runtime.relayPollTimer) {
    return;
  }

  clearInterval(runtime.relayPollTimer);
  runtime.relayPollTimer = undefined;
}

function closeSendControlSocket(runtime: SendRuntime, activeSocket?: TransferSocket) {
  if (!runtime.controlSocket) {
    return;
  }

  if (!activeSocket || runtime.controlSocket !== activeSocket) {
    runtime.controlSocket.destroy();
  }

  if (!activeSocket || runtime.controlSocket === activeSocket) {
    runtime.controlSocket = undefined;
  }
}

function closeReceiveControlSocket(runtime: ReceiveRuntime, activeSocket?: TransferSocket) {
  if (!runtime.controlSocket) {
    return;
  }

  if (!activeSocket || runtime.controlSocket !== activeSocket) {
    runtime.controlSocket.destroy();
  }

  if (!activeSocket || runtime.controlSocket === activeSocket) {
    runtime.controlSocket = undefined;
  }
}

function isSendRuntimeSettled(runtime: SendRuntime) {
  return ["completed", "failed", "canceled"].includes(runtime.session.status);
}

function takePendingHttpReady(runtime: ReceiveRuntime) {
  if (!runtime.pendingHttpReady) {
    return null;
  }

  const pending = runtime.pendingHttpReady;
  clearTimeout(pending.timer);
  runtime.pendingHttpReady = undefined;
  return pending;
}

function rejectPendingHttpReady(runtime: ReceiveRuntime, error: Error) {
  takePendingHttpReady(runtime)?.reject(error);
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

function rejectPendingReceiveWaits(runtime: ReceiveRuntime, error: Error) {
  rejectPendingHttpReady(runtime, error);
  rejectPendingRelayReady(runtime, error);
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

async function stopSenderHttpRuntime(runtime: SendRuntime, detail: string) {
  if (!runtime.httpSessionId) {
    return;
  }

  const sessionId = runtime.httpSessionId;
  runtime.httpSessionId = null;
  await stopLocalHttpSession(sessionId, detail).catch(() => {});
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
  await stopSenderHttpRuntime(runtime, detail);

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
  closeReceiveControlSocket(runtime);
  rejectPendingReceiveWaits(runtime, new Error("That transfer request is no longer available."));
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

function isReceiveRuntimeBusy(runtime: ReceiveRuntime) {
  return Boolean(
    runtime.session.incomingOffer ||
    runtime.session.status === "connecting" ||
    runtime.session.status === "transferring",
  );
}

function registerIncomingOffer(runtime: ReceiveRuntime, offer: IncomingTransferOffer, socket?: TransferSocket) {
  if (isReceiveRuntimeBusy(runtime)) {
    return false;
  }

  runtime.controlSocket = socket;

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

async function runPreviewTransfer(senderRuntime: SendRuntime, receiverRuntime: ReceiveRuntime) {
  const offer = receiverRuntime.session.incomingOffer;
  if (!offer) {
    throw new Error("That transfer request is no longer available.");
  }

  const receivedFiles: ReceivedFileRecord[] = [];
  let bytesTransferred = 0;

  await activateKeepAwakeAsync(LOCAL_TRANSFER_KEEP_AWAKE_TAG).catch(() => {});

  try {
    withSendSessionUpdate(senderRuntime, {
      status: "transferring",
      awaitingReceiverResponse: false,
      progress: {
        ...senderRuntime.session.progress,
        phase: "transferring",
        detail: "Sending files in preview mode.",
        updatedAt: nowIso(),
      },
    });

    withReceiveSessionUpdate(receiverRuntime, {
      status: "transferring",
      progress: {
        ...receiverRuntime.session.progress,
        phase: "transferring",
        totalBytes: offer.totalBytes,
        detail: "Receiving files in preview mode.",
        updatedAt: nowIso(),
      },
    });

    for (const file of senderRuntime.files) {
      const record = createReceivedFileRecord({
        transferId: offer.id,
        sourceFileUri: file.uri,
        fileName: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
      });

      bytesTransferred += file.sizeBytes;
      receivedFiles.push(record);

      withSendSessionUpdate(senderRuntime, {
        progress: {
          phase: "transferring",
          totalBytes: senderRuntime.session.manifest.totalBytes,
          bytesTransferred,
          currentFileName: file.name,
          speedBytesPerSecond: 0,
          detail: "Sending files in preview mode.",
          updatedAt: nowIso(),
        },
      });

      withReceiveSessionUpdate(receiverRuntime, {
        progress: {
          phase: "transferring",
          totalBytes: offer.totalBytes,
          bytesTransferred,
          currentFileName: file.name,
          speedBytesPerSecond: 0,
          detail: "Receiving files in preview mode.",
          updatedAt: nowIso(),
        },
      });

      await sleep(120);
    }

    withSendSessionUpdate(senderRuntime, {
      status: "completed",
      progress: {
        phase: "completed",
        totalBytes: senderRuntime.session.manifest.totalBytes,
        bytesTransferred: senderRuntime.session.manifest.totalBytes,
        currentFileName: null,
        speedBytesPerSecond: 0,
        detail: "Transfer complete.",
        updatedAt: nowIso(),
      },
    });

    return {
      receivedFiles,
      bytesTransferred,
      detail: "Transfer complete.",
    } satisfies TransferResult;
  } catch (error) {
    failSendSession(senderRuntime, error instanceof Error ? error.message : "Transfer failed.");
    throw error;
  } finally {
    await deactivateKeepAwake(LOCAL_TRANSFER_KEEP_AWAKE_TAG).catch(() => {});
  }
}

function createReceiveProgressReporter(runtime: ReceiveRuntime) {
  let lastSentAt = 0;
  let lastSentBytes = 0;

  return (progress: TransferProgress, force = false) => {
    withReceiveSessionUpdate(runtime, {
      status: progress.phase === "transferring" ? "transferring" : "connecting",
      progress,
    });

    if (!runtime.controlSocket) {
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
    void writeControlMessage(runtime.controlSocket, {
      kind: "progress",
      progress,
    }).catch(() => {});
  };
}

function validateDownloadableManifest(offer: IncomingTransferOffer, payload: DownloadableTransferManifest) {
  if (payload.kind !== "direct-http-transfer") {
    throw new Error("The sender did not provide a valid direct-transfer manifest.");
  }

  if (payload.sessionId !== offer.id) {
    throw new Error("The sender provided a manifest for a different transfer.");
  }

  return payload;
}

async function fetchDownloadableManifest({
  manifestUrl,
  offer,
  signal,
}: {
  manifestUrl: string;
  offer: IncomingTransferOffer;
  signal: AbortSignal;
}) {
  const response = await fetch(manifestUrl, {
    method: "GET",
    signal,
  });

  if (!response.ok) {
    throw new Error(`Unable to load the sender manifest (${response.status}).`);
  }

  return validateDownloadableManifest(offer, (await response.json()) as DownloadableTransferManifest);
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

async function receiveDirectHttpTransfer({
  runtime,
  offer,
  manifestUrl,
  onProgress,
}: {
  runtime: ReceiveRuntime;
  offer: IncomingTransferOffer;
  manifestUrl: string;
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
      manifestUrl,
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

function waitForHttpReady(runtime: ReceiveRuntime) {
  if (runtime.pendingHttpReady) {
    throw new Error("Receiver is already waiting for the sender.");
  }

  return new Promise<{ manifestUrl: string; shareUrl: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (runtime.pendingHttpReady?.timer !== timer) {
        return;
      }

      runtime.pendingHttpReady = undefined;
      reject(new DirectTransferFallbackError("The sender did not provide local download access in time."));
    }, HTTP_READY_TIMEOUT_MS);

    runtime.pendingHttpReady = {
      resolve,
      reject,
      timer,
    };
  });
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

async function notifySenderAccepted(runtime: ReceiveRuntime, offer: IncomingTransferOffer) {
  if (runtime.controlSocket) {
    await writeControlMessage(runtime.controlSocket, {
      kind: "accepted",
      receiverDeviceName: runtime.session.discoveryRecord.deviceName,
    });
    return true;
  }

  const senderRuntime = activeSendRuntimes.get(offer.id);
  if (!senderRuntime) {
    return false;
  }

  withSendSessionUpdate(senderRuntime, {
    status: "connecting",
    peerDeviceName: runtime.session.discoveryRecord.deviceName,
    awaitingReceiverResponse: false,
    progress: {
      phase: "connecting",
      totalBytes: senderRuntime.session.manifest.totalBytes,
      bytesTransferred: 0,
      currentFileName: null,
      speedBytesPerSecond: 0,
      detail: `${runtime.session.discoveryRecord.deviceName} accepted. Preparing transfer.`,
      updatedAt: nowIso(),
    },
  });

  return true;
}

async function notifySenderRejected(runtime: ReceiveRuntime, offer: IncomingTransferOffer, detail: string) {
  if (runtime.controlSocket) {
    const socket = runtime.controlSocket;
    runtime.controlSocket = undefined;

    await writeControlMessage(socket, {
      kind: "rejected",
      message: detail,
    }).catch(() => {});

    socket.destroy();
    return true;
  }

  const senderRuntime = activeSendRuntimes.get(offer.id);
  if (!senderRuntime) {
    return false;
  }

  failSendSession(senderRuntime, detail);
  return true;
}

async function notifySenderCanceled(runtime: ReceiveRuntime, detail: string) {
  if (!runtime.controlSocket) {
    return;
  }

  await writeControlMessage(runtime.controlSocket, {
    kind: "canceled",
    message: detail,
  }).catch(() => {});
}

async function runReceiveTransfer(runtime: ReceiveRuntime) {
  const offer = runtime.session.incomingOffer;
  if (!offer) {
    throw new Error("That transfer request is no longer available.");
  }

  const canUsePreview = runtime.session.previewMode && activeSendRuntimes.has(offer.id);
  const reportProgress = createReceiveProgressReporter(runtime);

  if (canUsePreview) {
    const didNotifySender = await notifySenderAccepted(runtime, offer);
    if (!didNotifySender) {
      throw new Error("Sender is no longer available.");
    }

    const senderRuntime = activeSendRuntimes.get(offer.id);
    if (!senderRuntime) {
      throw new Error("Sender is no longer available.");
    }

    return runPreviewTransfer(senderRuntime, runtime);
  }

  if (!runtime.controlSocket) {
    throw new Error("Sender is no longer available.");
  }

  await notifySenderAccepted(runtime, offer);

  withReceiveSessionUpdate(runtime, {
    status: "connecting",
    peerDeviceName: offer.senderDeviceName,
    progress: {
      phase: "connecting",
      totalBytes: offer.totalBytes,
      bytesTransferred: 0,
      currentFileName: null,
      speedBytesPerSecond: 0,
      detail: "Waiting for the sender to prepare local download access.",
      updatedAt: nowIso(),
    },
  });

  try {
    const { manifestUrl } = await waitForHttpReady(runtime);
    return await receiveDirectHttpTransfer({
      runtime,
      offer,
      manifestUrl,
      onProgress: reportProgress,
    });
  } catch (error) {
    if (!(error instanceof DirectTransferFallbackError)) {
      throw error;
    }

    await writeControlMessage(runtime.controlSocket, {
      kind: "direct-http-failed",
      message: error.message,
    }).catch(() => {});

    return receiveRelayFallbackTransfer({
      runtime,
      offer,
      onProgress: reportProgress,
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
    if (runtime.controlSocket) {
      await writeControlMessage(runtime.controlSocket, {
        kind: "failed",
        message,
      }).catch(() => {});
    }
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

async function provisionRelayFallback(runtime: SendRuntime, receiverName: string) {
  if (runtime.session.relay) {
    if (runtime.controlSocket) {
      await writeControlMessage(runtime.controlSocket, {
        kind: "relay-ready",
        relay: toRelayAccess(runtime.session.relay)!,
      }).catch(() => {});
    }
    return true;
  }

  if (!runtime.controlSocket) {
    failSendSession(runtime, `${receiverName} is no longer available for relay fallback.`);
    return false;
  }

  let relay: RelayCredentials;

  try {
    relay = await createRelayTransferSession({
      senderDeviceName: runtime.session.manifest.deviceName,
      files: runtime.files,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to prepare relay fallback.";
    await writeControlMessage(runtime.controlSocket, {
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
    await writeControlMessage(runtime.controlSocket, {
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

async function handleSenderHttpSessionFinalized(runtime: SendRuntime, httpSession: LocalHttpSession) {
  if (runtime.httpSessionId !== httpSession.id) {
    return;
  }

  runtime.httpSessionId = null;

  if (isSendRuntimeSettled(runtime) || runtime.stopping) {
    return;
  }

  const detail = httpSession.detail ?? "Local transfer server stopped unexpectedly.";
  if (runtime.controlSocket) {
    await writeControlMessage(runtime.controlSocket, {
      kind: "failed",
      message: detail,
    }).catch(() => {});
  }
  failSendSession(runtime, detail);
}

async function startSenderHostedHttpTransfer(runtime: SendRuntime, receiverName: string) {
  if (isSendRuntimeSettled(runtime)) {
    return;
  }

  withSendSessionUpdate(runtime, {
    status: "connecting",
    awaitingReceiverResponse: false,
    peerDeviceName: receiverName,
    progress: {
      phase: "connecting",
      totalBytes: runtime.session.manifest.totalBytes,
      bytesTransferred: runtime.session.progress.bytesTransferred,
      currentFileName: null,
      speedBytesPerSecond: 0,
      detail: `${receiverName} accepted. Preparing local download access.`,
      updatedAt: nowIso(),
    },
  });

  try {
    const httpSession = await startLocalHttpSession({
      sessionId: runtime.session.id,
      files: runtime.files,
      deviceName: runtime.session.manifest.deviceName,
      mode: "direct",
      keepAwakeTag: LOCAL_TRANSFER_KEEP_AWAKE_TAG,
      onFinalized: (session) => {
        void handleSenderHttpSessionFinalized(runtime, session);
      },
    });

    runtime.httpSessionId = httpSession.id;

    if (!runtime.controlSocket) {
      await stopSenderHttpRuntime(runtime, "Receiver is no longer available.");
      failSendSession(runtime, "Receiver is no longer available.");
      return;
    }

    await writeControlMessage(runtime.controlSocket, {
      kind: "http-ready",
      manifestUrl: httpSession.manifestUrl,
      shareUrl: httpSession.shareUrl,
    });

    withSendSessionUpdate(runtime, {
      status: "connecting",
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
  } catch {
    await provisionRelayFallback(runtime, receiverName);
  }
}

function handleSenderOfferRejected(runtime: SendRuntime, detail: string) {
  failSendSession(runtime, detail);
}

async function handleSenderControlMessage(runtime: SendRuntime, message: ReceiverControlMessage) {
  if (message.kind === "offer-received") {
    return;
  }

  if (message.kind === "accepted") {
    const receiverName = getPeerName(message.receiverDeviceName ?? runtime.target.deviceName);
    await startSenderHostedHttpTransfer(runtime, receiverName);
    return;
  }

  if (message.kind === "progress") {
    withSendSessionUpdate(runtime, {
      status: message.progress.phase === "transferring" ? "transferring" : "connecting",
      awaitingReceiverResponse: false,
      progress: {
        ...message.progress,
        detail: message.progress.detail ?? runtime.session.progress.detail,
      },
    });
    return;
  }

  if (message.kind === "completed") {
    await completeSendSession(runtime, message.detail ?? "Transfer complete.");
    return;
  }

  if (message.kind === "direct-http-failed") {
    await stopSenderHttpRuntime(runtime, message.message || "Direct transfer unavailable.");
    await provisionRelayFallback(runtime, runtime.session.peerDeviceName ?? runtime.target.deviceName);
    return;
  }

  if (message.kind === "rejected" || message.kind === "busy") {
    handleSenderOfferRejected(runtime, message.message || "That receiver is busy right now.");
    return;
  }

  if (message.kind === "failed" || message.kind === "canceled") {
    await stopSenderHttpRuntime(runtime, message.message || "Transfer stopped.");
    failSendSession(runtime, message.message || "Transfer stopped.");
  }
}

async function sendOfferOverControlSocket(
  runtime: SendRuntime,
  target: DiscoveryRecord,
  offer: IncomingTransferOffer,
  tcpSocket: TcpSocketLike,
) {
  const socket = tcpSocket.connectTLS({
    host: target.host,
    port: target.port,
    ca: LOCAL_TRANSFER_CERTIFICATE_ASSET,
    tlsCheckValidity: false,
    interface: "wifi",
  });

  runtime.controlSocket = socket;
  socket.setNoDelay?.(true);

  let didReceiveInitialResponse = false;
  const responseTimer = setTimeout(() => {
    if (didReceiveInitialResponse || isSendRuntimeSettled(runtime) || runtime.stopping) {
      return;
    }

    handleSenderOfferRejected(runtime, `Unable to reach ${target.deviceName}.`);
    socket.destroy();
  }, CONTROL_RESPONSE_TIMEOUT_MS);

  const clearResponseTimer = () => {
    clearTimeout(responseTimer);
  };

  const parser = createControlMessageParser((message) => {
    if (!didReceiveInitialResponse) {
      didReceiveInitialResponse = true;
      clearResponseTimer();
    }

    void handleSenderControlMessage(runtime, message as ReceiverControlMessage);
  });

  socket.on("secureConnect", () => {
    void writeControlMessage(socket, {
      kind: "offer",
      receiverSessionId: target.sessionId,
      receiverToken: target.token,
      offer,
    }).catch((error) => {
      clearResponseTimer();
      handleSenderOfferRejected(runtime, error instanceof Error ? error.message : "Unable to reach that receiver.");
    });
  });

  socket.on("data", (chunk) => {
    try {
      parser(chunk as Uint8Array | Buffer | string);
    } catch (error) {
      handleSenderOfferRejected(
        runtime,
        error instanceof Error ? error.message : "Unable to decode receiver response.",
      );
    }
  });

  socket.on("error", (error) => {
    clearResponseTimer();
    if (!isSendRuntimeSettled(runtime)) {
      const message = error instanceof Error ? error.message : "Unable to reach that receiver.";
      if (runtime.session.awaitingReceiverResponse) {
        handleSenderOfferRejected(runtime, message);
      } else {
        failSendSession(runtime, message);
      }
    }
  });

  socket.on("close", () => {
    clearResponseTimer();
    if (runtime.controlSocket === socket) {
      runtime.controlSocket = undefined;
    }

    if (!isSendRuntimeSettled(runtime) && !runtime.stopping) {
      failSendSession(runtime, "That receiver is no longer available.");
    }
  });
}

function handleReceiveControlMessage(runtime: ReceiveRuntime, message: SenderControlMessage) {
  if (message.kind === "http-ready") {
    const pending = takePendingHttpReady(runtime);
    if (pending) {
      pending.resolve({
        manifestUrl: message.manifestUrl,
        shareUrl: message.shareUrl,
      });
    }
    return;
  }

  if (message.kind === "relay-ready") {
    const nextOffer = updateIncomingOfferRelay(runtime, message.relay);
    rejectPendingHttpReady(
      runtime,
      new DirectTransferFallbackError("Direct transfer unavailable. Switching to relay."),
    );
    if (nextOffer) {
      const pending = takePendingRelayReady(runtime);
      if (pending) {
        pending.resolve(nextOffer);
      }
    }
    return;
  }

  if (message.kind === "relay-failed") {
    const error = new Error(message.message || "Unable to prepare relay fallback.");
    rejectPendingHttpReady(runtime, error);
    rejectPendingRelayReady(runtime, error);
    return;
  }

  if (message.kind === "failed" || message.kind === "canceled") {
    const error = new Error(message.message || "Sender stopped the transfer.");
    rejectPendingHttpReady(runtime, error);
    rejectPendingRelayReady(runtime, error);
    runtime.activeDownloadAbortController?.abort();
  }
}

function mapResolvedService(service: ZeroconfService) {
  const sessionId = service.txt?.sessionId;
  const receiverToken = service.txt?.receiverToken;
  const host =
    service.addresses?.map((address) => getUsableLanHost(address)).find((address) => Boolean(address)) ??
    getUsableLanHost(service.host);

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
    certificateFingerprint: service.txt?.certificateFingerprint ?? LOCAL_TRANSFER_CERT_FINGERPRINT,
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
  const tcpSocket = await loadTcpSocket();
  const previewTarget = target.method === "preview" && activeReceiveRuntimes.has(target.sessionId);

  if (!tcpSocket && !previewTarget) {
    throw new Error("Nearby transfer is unavailable on this build.");
  }

  const manifest = createTransferManifest({
    files,
    deviceName,
    sessionId,
    isPremium,
  });

  const runtime: SendRuntime = {
    session: createInitialSendSession(manifest, target, previewTarget, null),
    files,
    target,
    updateSession,
    relayUploadStarted: false,
    httpSessionId: null,
    stopping: false,
  };

  activeSendRuntimes.set(sessionId, runtime);
  updateSession?.(runtime.session);

  const offer = createIncomingTransferOffer(manifest, null);

  if (previewTarget) {
    const receiverRuntime = activeReceiveRuntimes.get(target.sessionId);
    if (!receiverRuntime || !registerIncomingOffer(receiverRuntime, offer)) {
      handleSenderOfferRejected(runtime, "That receiver is busy right now.");
      return runtime.session;
    }

    return runtime.session;
  }

  if (!tcpSocket || target.port <= 0 || !target.token.trim()) {
    failSendSession(runtime, "That receiver is no longer available.");
    return runtime.session;
  }

  if (!getUsableLanHost(target.host)) {
    failSendSession(
      runtime,
      target.method === "qr"
        ? "That QR code does not contain a usable local WiFi address."
        : "That receiver is not advertising a usable local WiFi address.",
    );
    return runtime.session;
  }

  void sendOfferOverControlSocket(runtime, target, offer, tcpSocket);
  return runtime.session;
}

export async function stopSendingTransfer(sessionId: string) {
  const runtime = activeSendRuntimes.get(sessionId);

  if (!runtime) {
    return;
  }

  runtime.stopping = true;

  if (!isSendRuntimeSettled(runtime)) {
    if (runtime.controlSocket) {
      await writeControlMessage(runtime.controlSocket, {
        kind: "canceled",
        message: "Sender canceled the transfer.",
      }).catch(() => {});
    }
  }

  closeSendControlSocket(runtime);
  stopRelayPolling(runtime);
  await stopSenderHttpRuntime(runtime, "Sender canceled the transfer.");

  if (runtime.target.method === "preview") {
    const receiverRuntime = activeReceiveRuntimes.get(runtime.target.sessionId);
    if (
      receiverRuntime &&
      receiverRuntime.session.status === "waiting" &&
      receiverRuntime.session.incomingOffer?.id === sessionId
    ) {
      resetReceiveToDiscoverable(receiverRuntime);
    }
  }

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
  const deviceIp = getUsableLanHost(await Network.getIpAddressAsync().catch(() => null));
  const tcpSocket = await loadTcpSocket();
  const zeroconfModule = await loadZeroconf();
  let resolvedPort = 0;
  let server: TransferServer | null = null;

  if (tcpSocket) {
    server = tcpSocket.createTLSServer(
      {
        keystore: LOCAL_TRANSFER_KEYSTORE_ASSET,
      },
      (socket: TransferSocket) => {
        let registeredOfferId: string | null = null;
        const parser = createControlMessageParser((message) => {
          const runtime = activeReceiveRuntimes.get(sessionId);
          if (!runtime) {
            socket.destroy();
            return;
          }

          if (!registeredOfferId) {
            const offerMessage = message as SenderControlMessage;
            if (
              offerMessage.kind !== "offer" ||
              offerMessage.receiverSessionId !== sessionId ||
              offerMessage.receiverToken !== receiverToken
            ) {
              void writeControlMessage(socket, {
                kind: "failed",
                message: "Unable to validate receiver.",
              }).catch(() => {});
              socket.destroy();
              return;
            }

            if (!registerIncomingOffer(runtime, offerMessage.offer, socket)) {
              void writeControlMessage(socket, {
                kind: "busy",
                message: "That receiver is busy right now.",
              }).catch(() => {});
              socket.destroy();
              return;
            }

            registeredOfferId = offerMessage.offer.id;
            void writeControlMessage(socket, {
              kind: "offer-received",
            }).catch(() => {});
            return;
          }

          handleReceiveControlMessage(runtime, message as SenderControlMessage);
        });

        const handleData = (chunk: unknown) => {
          try {
            parser(chunk as Uint8Array | Buffer | string);
          } catch (error) {
            console.warn("Unable to decode sender control message", error);
            socket.destroy();
          }
        };

        const handleSocketEnded = () => {
          const runtime = activeReceiveRuntimes.get(sessionId);
          if (!runtime) {
            return;
          }

          if (runtime.controlSocket === socket) {
            runtime.controlSocket = undefined;
            rejectPendingReceiveWaits(runtime, new Error("Sender is no longer available."));
            runtime.activeDownloadAbortController?.abort();
          }

          if (runtime.session.status === "waiting" && runtime.session.incomingOffer?.id === registeredOfferId) {
            resetReceiveToDiscoverable(runtime);
          }
        };

        socket.on("data", handleData);
        socket.on("error", handleSocketEnded);
        socket.on("close", handleSocketEnded);
      },
    );

    const controlServer = server;
    await new Promise<void>((resolve, reject) => {
      const handleError = (error: Error) => {
        reject(error);
      };

      controlServer.once("error", handleError);
      controlServer.listen({ port: 0, host: "0.0.0.0", reuseAddress: true }, () => {
        controlServer.off("error", handleError);
        resolve();
      });
    }).catch((error) => {
      console.error("Failed to start receiver control server", error);
    });

    resolvedPort = controlServer.address()?.port ?? 0;
  }

  let serviceName: string | null = null;
  let record = createReceiverDiscoveryRecord({
    sessionId,
    method: "preview",
    deviceName,
    host: deviceIp ?? "0.0.0.0",
    port: resolvedPort,
    token: receiverToken,
    serviceName: null,
  });

  const runtime: ReceiveRuntime = {
    session: createInitialReceiveSession(record, !resolvedPort),
    updateSession,
    ...(resolvedPort && server
      ? {
          server: {
            close() {
              server?.close();
            },
          },
        }
      : {}),
    stopping: false,
  };

  if (resolvedPort && zeroconfModule) {
    serviceName = createServiceName(deviceName, sessionId);
    const publishedServiceName = serviceName;
    const zeroconf = new zeroconfModule.Zeroconf();
    zeroconf.publishService(
      LOCAL_TRANSFER_SERVICE_TYPE,
      LOCAL_TRANSFER_SERVICE_PROTOCOL,
      LOCAL_TRANSFER_SERVICE_DOMAIN,
      publishedServiceName,
      resolvedPort,
      {
        sessionId,
        receiverToken,
        deviceName,
        certificateFingerprint: LOCAL_TRANSFER_CERT_FINGERPRINT,
      },
      zeroconfModule.ImplType.DNSSD,
    );

    runtime.zeroconf = {
      publisher: {
        stop() {
          zeroconf.unpublishService(publishedServiceName, zeroconfModule.ImplType.DNSSD);
          zeroconf.removeDeviceListeners();
        },
      },
    };
  }

  record = createReceiverDiscoveryRecord({
    sessionId,
    method: resolvedPort ? (zeroconfModule ? "nearby" : "qr") : "preview",
    deviceName,
    host: deviceIp ?? "0.0.0.0",
    port: resolvedPort,
    token: receiverToken,
    serviceName,
  });

  runtime.session = createInitialReceiveSession(record, !resolvedPort);
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
  rejectPendingReceiveWaits(runtime, new Error("Receiver is no longer available."));
  runtime.activeDownloadAbortController?.abort();

  if (runtime.session.incomingOffer) {
    if (runtime.session.status === "waiting") {
      if (runtime.session.incomingOffer.sender.relay) {
        await declineRelayTransferSession(runtime.session.incomingOffer.sender.relay).catch(() => {});
      }
      await notifySenderRejected(runtime, runtime.session.incomingOffer, "Receiver is no longer available.").catch(
        () => {},
      );
    } else if (runtime.session.status === "connecting" || runtime.session.status === "transferring") {
      await notifySenderCanceled(runtime, "Receiver canceled the transfer.").catch(() => {});
    }
  }

  closeReceiveControlSocket(runtime);
  runtime.zeroconf?.publisher.stop();
  runtime.server?.close();
  activeReceiveRuntimes.delete(sessionId);
}

export async function acceptIncomingTransferOffer(sessionId: string) {
  const runtime = activeReceiveRuntimes.get(sessionId);
  if (!runtime?.session.incomingOffer || runtime.session.status !== "waiting") {
    return false;
  }

  try {
    const result = await runReceiveTransfer(runtime);

    if (runtime.controlSocket) {
      const detail = result.detail;
      await writeControlMessage(runtime.controlSocket, {
        kind: "completed",
        detail,
      }).catch(() => {});
    }

    withReceiveSessionUpdate(runtime, {
      status: "completed",
      receivedFiles: result.receivedFiles,
      progress: {
        phase: "completed",
        totalBytes: runtime.session.incomingOffer?.totalBytes ?? result.bytesTransferred,
        bytesTransferred: result.bytesTransferred,
        currentFileName: null,
        speedBytesPerSecond: 0,
        detail: result.detail,
        updatedAt: nowIso(),
      },
    });
    return true;
  } catch (error) {
    if (runtime.controlSocket && !(error instanceof DirectTransferFallbackError)) {
      await writeControlMessage(runtime.controlSocket, {
        kind: "failed",
        message: error instanceof Error ? error.message : "The transfer could not be completed.",
      }).catch(() => {});
    }

    withReceiveSessionUpdate(runtime, {
      status: "failed",
      progress: {
        phase: "failed",
        totalBytes: runtime.session.incomingOffer?.totalBytes ?? 0,
        bytesTransferred: runtime.session.progress.bytesTransferred,
        currentFileName: null,
        speedBytesPerSecond: 0,
        detail: error instanceof Error ? error.message : "The transfer could not be completed.",
        updatedAt: nowIso(),
      },
    });
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

  await notifySenderRejected(runtime, offer, "Transfer declined.").catch(() => {});
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
    for (const runtime of activeReceiveRuntimes.values()) {
      if (runtime.session.discoveryRecord.method === "preview") {
        currentRecords.set(runtime.session.id, runtime.session.discoveryRecord);
      }
    }

    onUpdate(
      Array.from(currentRecords.values()).sort((left, right) => right.advertisedAt.localeCompare(left.advertisedAt)),
    );
  }

  emitCurrentRecords();

  const zeroconfModule = await loadZeroconf();
  if (!zeroconfModule) {
    return () => {
      currentRecords.clear();
    };
  }

  const zeroconf = new zeroconfModule.Zeroconf();
  const handleResolved = (service: ZeroconfService) => {
    const nextRecord = mapResolvedService(service);
    if (!nextRecord) {
      return;
    }

    currentRecords.set(nextRecord.sessionId, nextRecord);
    emitCurrentRecords();
  };

  const handleRemove = (serviceName: string) => {
    for (const [sessionId, record] of currentRecords) {
      if (record.serviceName === serviceName && record.method === "nearby") {
        currentRecords.delete(sessionId);
      }
    }
    emitCurrentRecords();
  };

  zeroconf.on("resolved", (service) => {
    handleResolved(service as ZeroconfService);
  });
  zeroconf.on("remove", (serviceName) => {
    handleRemove(serviceName as string);
  });
  zeroconf.on("error", (error) => {
    onError?.(error instanceof Error ? error : new Error("Nearby scanning failed."));
  });
  zeroconf.scan(
    LOCAL_TRANSFER_SERVICE_TYPE,
    LOCAL_TRANSFER_SERVICE_PROTOCOL,
    LOCAL_TRANSFER_SERVICE_DOMAIN,
    zeroconfModule.ImplType.DNSSD,
  );

  return () => {
    zeroconf.stop(zeroconfModule.ImplType.DNSSD);
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
    certificateFingerprint: string;
    advertisedAt: string;
  };

  return {
    sessionId: parsed.sessionId,
    method: "qr",
    deviceName: parsed.deviceName,
    host: parsed.host,
    port: parsed.port,
    token: parsed.token,
    certificateFingerprint: parsed.certificateFingerprint,
    advertisedAt: parsed.advertisedAt,
    serviceName: null,
  } satisfies DiscoveryRecord;
}
