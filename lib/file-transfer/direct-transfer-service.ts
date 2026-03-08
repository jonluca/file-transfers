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
  downloadRelayTransferFile,
  getRelayReceiverState,
  getRelaySenderState,
  uploadRelayTransferFile,
} from "./relay-client";
import {
  LOCAL_TRANSFER_CERT_FINGERPRINT,
  LOCAL_TRANSFER_CERTIFICATE_ASSET,
  LOCAL_TRANSFER_CHUNK_SIZE_BYTES,
  LOCAL_TRANSFER_KEEP_AWAKE_TAG,
  LOCAL_TRANSFER_KEYSTORE_ASSET,
  LOCAL_TRANSFER_SERVICE_DOMAIN,
  LOCAL_TRANSFER_SERVICE_PROTOCOL,
  LOCAL_TRANSFER_SERVICE_TYPE,
  LOCAL_TRANSFER_SPEED_LIMIT_BYTES_PER_SECOND,
} from "./constants";
import { getReceivedFilesDirectory } from "./files";
import { createFrameParser, decodeJsonFrame, encodeChunkFrame, encodeJsonFrame } from "./protocol";
import type {
  DiscoveryRecord,
  IncomingTransferOffer,
  ReceiveSession,
  ReceivedFileRecord,
  RelayAccess,
  RelayCredentials,
  SelectedTransferFile,
  SenderTransferAccess,
  TransferManifest,
  TransferProgress,
  TransferSession,
} from "./types";

type SendRuntimeUpdate = (session: TransferSession) => void;
type ReceiveRuntimeUpdate = (session: ReceiveSession) => void;

interface SendRuntime {
  session: TransferSession;
  files: SelectedTransferFile[];
  target: DiscoveryRecord;
  updateSession?: SendRuntimeUpdate;
  controlSocket?: TransferSocket;
  relayPollTimer?: ReturnType<typeof setInterval>;
  connectTimer?: ReturnType<typeof setTimeout>;
  server?: {
    close(): void;
  };
  relayUploadStarted: boolean;
  didConnectDirectly: boolean;
}

interface ReceiveRuntime {
  session: ReceiveSession;
  updateSession?: ReceiveRuntimeUpdate;
  pendingOfferSocket?: TransferSocket;
  zeroconf?: {
    publisher: {
      stop(): void;
    };
  };
  server?: {
    close(): void;
  };
}

interface TransferSocket {
  destroy(): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
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
const DIRECT_CONNECT_TIMEOUT_MS = 8000;

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

function safeDeviceIp(value: string | null | undefined) {
  if (!value || value === "0.0.0.0" || value === "::1" || value === "127.0.0.1") {
    return "127.0.0.1";
  }

  return value;
}

function createTransferManifest({
  files,
  deviceName,
  sessionId,
  transferToken,
  host,
  port,
  isPremium,
}: {
  files: SelectedTransferFile[];
  deviceName: string;
  sessionId: string;
  transferToken: string;
  host: string;
  port: number;
  isPremium: boolean;
}): TransferManifest {
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);

  return {
    sessionId,
    deviceName,
    files,
    fileCount: files.length,
    totalBytes,
    transferToken,
    advertisedHost: host,
    advertisedPort: port,
    certificateFingerprint: LOCAL_TRANSFER_CERT_FINGERPRINT,
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
    host: manifest.advertisedHost,
    port: manifest.advertisedPort,
    token: manifest.transferToken,
    certificateFingerprint: manifest.certificateFingerprint,
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
  return JSON.stringify({
    version: 1,
    sessionId: record.sessionId,
    host: record.host,
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
  return directory.createFile(targetName, mimeType);
}

function createTransferOutputReference(directory: Directory, fileName: string) {
  const safeName = fileName.replace(/[^\w.\-() ]+/g, "_");
  const targetName = `${Date.now()}-${safeName}`;
  return new File(directory, targetName);
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

function releaseKeepAwakeSoon() {
  setTimeout(() => {
    void deactivateKeepAwake(LOCAL_TRANSFER_KEEP_AWAKE_TAG).catch(() => {});
  }, 0);
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

function clearSenderConnectTimer(runtime: SendRuntime) {
  if (!runtime.connectTimer) {
    return;
  }

  clearTimeout(runtime.connectTimer);
  runtime.connectTimer = undefined;
}

function hasDirectSendPath(runtime: SendRuntime) {
  return Boolean(runtime.server && runtime.session.manifest.advertisedPort > 0);
}

function failSendSession(runtime: SendRuntime, detail: string) {
  clearSenderConnectTimer(runtime);
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

function resetReceiveToDiscoverable(runtime: ReceiveRuntime, detail = "Ready to receive files.") {
  runtime.pendingOfferSocket = undefined;
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

async function streamFilesToSocket(runtime: SendRuntime, socket: TransferSocket) {
  const speedLimit = runtime.session.manifest.isPremiumSender ? null : LOCAL_TRANSFER_SPEED_LIMIT_BYTES_PER_SECOND;
  let bytesTransferred = 0;
  let windowBytesTransferred = 0;
  let windowStartedAt = Date.now();

  clearSenderConnectTimer(runtime);
  stopRelayPolling(runtime);

  await activateKeepAwakeAsync(LOCAL_TRANSFER_KEEP_AWAKE_TAG).catch(() => {});

  try {
    withSendSessionUpdate(runtime, {
      status: "transferring",
      awaitingReceiverResponse: false,
      progress: {
        ...runtime.session.progress,
        phase: "transferring",
        detail: "Sending files over local WiFi.",
        updatedAt: nowIso(),
      },
    });

    await writeSocket(socket, encodeJsonFrame({ kind: "manifest", manifest: runtime.session.manifest }));

    for (const file of runtime.files) {
      await writeSocket(
        socket,
        encodeJsonFrame({
          kind: "file-start",
          fileId: file.id,
          fileName: file.name,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
        }),
      );

      const inputFile = new File(file.uri);
      const handle = inputFile.open();

      try {
        while (handle.offset !== null && handle.offset < (handle.size ?? file.sizeBytes)) {
          const nextChunk = handle.readBytes(LOCAL_TRANSFER_CHUNK_SIZE_BYTES);
          if (nextChunk.byteLength === 0) {
            break;
          }

          await writeSocket(socket, encodeChunkFrame(nextChunk));
          bytesTransferred += nextChunk.byteLength;
          windowBytesTransferred += nextChunk.byteLength;

          const now = Date.now();
          const elapsedMilliseconds = now - windowStartedAt;
          const speedBytesPerSecond =
            elapsedMilliseconds > 0 ? Math.round((windowBytesTransferred / elapsedMilliseconds) * 1000) : 0;

          withSendSessionUpdate(runtime, {
            progress: {
              phase: "transferring",
              totalBytes: runtime.session.manifest.totalBytes,
              bytesTransferred,
              currentFileName: file.name,
              speedBytesPerSecond,
              detail: "Sending files over local WiFi.",
              updatedAt: nowIso(),
            },
          });

          if (speedLimit && windowBytesTransferred >= speedLimit) {
            const waitFor = Math.max(0, 1000 - elapsedMilliseconds);
            if (waitFor > 0) {
              await sleep(waitFor);
            }

            windowStartedAt = Date.now();
            windowBytesTransferred = 0;
          } else if (elapsedMilliseconds >= 1000) {
            windowStartedAt = now;
            windowBytesTransferred = 0;
          }
        }
      } finally {
        handle.close();
      }

      await writeSocket(
        socket,
        encodeJsonFrame({
          kind: "file-end",
          fileId: file.id,
        }),
      );
    }

    await writeSocket(socket, encodeJsonFrame({ kind: "complete" }));

    withSendSessionUpdate(runtime, {
      status: "completed",
      progress: {
        phase: "completed",
        totalBytes: runtime.session.manifest.totalBytes,
        bytesTransferred: runtime.session.manifest.totalBytes,
        currentFileName: null,
        speedBytesPerSecond: 0,
        detail: "Transfer complete.",
        updatedAt: nowIso(),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Transfer failed.";

    await writeSocket(
      socket,
      encodeJsonFrame({
        kind: "error",
        message,
      }),
    ).catch(() => {});

    failSendSession(runtime, message);
  } finally {
    await deactivateKeepAwake(LOCAL_TRANSFER_KEEP_AWAKE_TAG).catch(() => {});
    socket.destroy();
  }
}

async function uploadFilesToRelay(runtime: SendRuntime) {
  if (!runtime.session.relay || runtime.relayUploadStarted) {
    return;
  }

  runtime.relayUploadStarted = true;
  clearSenderConnectTimer(runtime);

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
      status: "completed",
      progress: {
        phase: "completed",
        totalBytes: runtime.session.manifest.totalBytes,
        bytesTransferred: runtime.session.manifest.totalBytes,
        currentFileName: null,
        speedBytesPerSecond: 0,
        detail: "Transfer complete through relay.",
        updatedAt: nowIso(),
      },
    });
    stopRelayPolling(runtime);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Relay upload failed.";
    failSendSession(runtime, message);
    throw error;
  } finally {
    await deactivateKeepAwake(LOCAL_TRANSFER_KEEP_AWAKE_TAG).catch(() => {});
  }
}

function handleSenderOfferAccepted(runtime: SendRuntime, receiverName: string) {
  if (runtime.session.status === "completed" || runtime.session.status === "failed") {
    return;
  }

  const controlSocket = runtime.controlSocket;
  runtime.controlSocket = undefined;

  withSendSessionUpdate(runtime, {
    status: "connecting",
    peerDeviceName: receiverName,
    awaitingReceiverResponse: false,
    progress: {
      ...runtime.session.progress,
      phase: "connecting",
      detail:
        runtime.session.previewMode && runtime.target.method === "preview"
          ? `${receiverName} accepted. Preparing transfer.`
          : hasDirectSendPath(runtime)
            ? `${receiverName} accepted. Waiting for them to connect.`
            : runtime.session.relay
              ? `${receiverName} accepted. Preparing relay transfer.`
              : "Receiver accepted the transfer.",
      updatedAt: nowIso(),
    },
  });

  controlSocket?.destroy();

  if (runtime.session.previewMode && runtime.target.method === "preview") {
    return;
  }

  if (!hasDirectSendPath(runtime)) {
    if (runtime.session.relay) {
      void uploadFilesToRelay(runtime).catch(() => {});
      return;
    }

    failSendSession(runtime, "Unable to prepare this transfer.");
    return;
  }

  clearSenderConnectTimer(runtime);
  runtime.connectTimer = setTimeout(() => {
    if (runtime.didConnectDirectly || runtime.session.status === "completed" || runtime.session.status === "failed") {
      return;
    }

    if (runtime.session.relay) {
      void uploadFilesToRelay(runtime).catch(() => {});
      return;
    }

    failSendSession(runtime, `${receiverName} could not connect to this transfer.`);
  }, DIRECT_CONNECT_TIMEOUT_MS);
}

function handleSenderOfferRejected(runtime: SendRuntime, detail: string) {
  failSendSession(runtime, detail);
}

async function syncRelaySenderState(runtime: SendRuntime) {
  if (!runtime.session.relay) {
    return;
  }

  try {
    const state = await getRelaySenderState(runtime.session.relay);
    const receiverName = getPeerName(state.receiverDeviceName ?? runtime.session.peerDeviceName ?? undefined);

    if (state.status === "accepted" && runtime.session.awaitingReceiverResponse) {
      handleSenderOfferAccepted(runtime, receiverName);
      return;
    }

    if (state.status === "rejected" && runtime.session.awaitingReceiverResponse) {
      handleSenderOfferRejected(runtime, "Transfer declined.");
      return;
    }

    if (state.status === "expired" && runtime.session.status !== "completed" && runtime.session.status !== "failed") {
      failSendSession(runtime, "This relay transfer expired.");
    }
  } catch (error) {
    console.warn("Unable to refresh relay sender state", error);
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

async function notifySenderAccepted(runtime: ReceiveRuntime, offer: IncomingTransferOffer) {
  if (runtime.pendingOfferSocket) {
    const socket = runtime.pendingOfferSocket;
    runtime.pendingOfferSocket = undefined;

    await writeSocket(
      socket,
      encodeJsonFrame({
        kind: "accepted",
        receiverDeviceName: runtime.session.discoveryRecord.deviceName,
      }),
    ).finally(() => {
      socket.destroy();
    });

    return true;
  }

  const senderRuntime = activeSendRuntimes.get(offer.id);
  if (!senderRuntime) {
    return false;
  }

  handleSenderOfferAccepted(senderRuntime, runtime.session.discoveryRecord.deviceName);
  return true;
}

async function notifySenderRejected(runtime: ReceiveRuntime, offer: IncomingTransferOffer, detail: string) {
  if (runtime.pendingOfferSocket) {
    const socket = runtime.pendingOfferSocket;
    runtime.pendingOfferSocket = undefined;

    await writeSocket(
      socket,
      encodeJsonFrame({
        kind: "rejected",
        message: detail,
      }),
    ).catch(() => {});

    socket.destroy();
    return true;
  }

  const senderRuntime = activeSendRuntimes.get(offer.id);
  if (!senderRuntime) {
    return false;
  }

  handleSenderOfferRejected(senderRuntime, detail);
  return true;
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

  runtime.pendingOfferSocket = socket;

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
      const outputFile = createTransferOutputFile(getReceivedFilesDirectory(), file.name, file.mimeType);
      const sourceFile = new File(file.uri);
      sourceFile.copy(outputFile);

      bytesTransferred += file.sizeBytes;
      receivedFiles.push({
        id: Crypto.randomUUID(),
        transferId: offer.id,
        name: file.name,
        uri: outputFile.uri,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        receivedAt: nowIso(),
      });

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

function canAttemptDirectTransfer(offer: IncomingTransferOffer, tcpSocket: TcpSocketLike | null) {
  return Boolean(tcpSocket && offer.sender.port > 0 && offer.sender.host !== "0.0.0.0" && offer.sender.token.trim());
}

async function receiveRelayTransfer({
  offer,
  onProgress,
}: {
  offer: IncomingTransferOffer;
  onProgress?: (progress: TransferProgress) => void;
}) {
  if (!offer.sender.relay) {
    throw new Error("Relay access is not available for this transfer.");
  }

  await activateKeepAwakeAsync(LOCAL_TRANSFER_KEEP_AWAKE_TAG).catch(() => {});

  try {
    let state = await getRelayReceiverState(offer.sender.relay);

    while (!["ready", "completed"].includes(state.status)) {
      if (state.status === "rejected") {
        throw new Error("Transfer declined.");
      }

      if (state.status === "expired") {
        throw new Error("This relay transfer expired before it could start.");
      }

      onProgress?.({
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
      });

      await sleep(RELAY_POLL_INTERVAL_MS);
      state = await getRelayReceiverState(offer.sender.relay);
    }

    const receivedFiles: ReceivedFileRecord[] = [];
    let bytesTransferred = 0;

    for (const file of state.files) {
      const outputFile = createTransferOutputReference(getReceivedFilesDirectory(), file.name);
      const startedAt = Date.now();

      onProgress?.({
        phase: "transferring",
        totalBytes: offer.totalBytes,
        bytesTransferred,
        currentFileName: file.name,
        speedBytesPerSecond: 0,
        detail: "Downloading files through relay.",
        updatedAt: nowIso(),
      });

      await downloadRelayTransferFile({
        relay: offer.sender.relay,
        fileId: file.id,
        destination: outputFile,
      });

      bytesTransferred += file.sizeBytes;
      const elapsedMilliseconds = Math.max(Date.now() - startedAt, 1);
      const speedBytesPerSecond = Math.round((file.sizeBytes / elapsedMilliseconds) * 1000);

      receivedFiles.push({
        id: Crypto.randomUUID(),
        transferId: offer.id,
        name: file.name,
        uri: outputFile.uri,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        receivedAt: nowIso(),
      });

      onProgress?.({
        phase: "transferring",
        totalBytes: offer.totalBytes,
        bytesTransferred,
        currentFileName: file.name,
        speedBytesPerSecond,
        detail: "Downloading files through relay.",
        updatedAt: nowIso(),
      });
    }

    await completeRelayTransferSession(offer.sender.relay).catch(() => {});

    return {
      receivedFiles,
      bytesTransferred,
      detail: "Transfer complete through relay.",
    } satisfies TransferResult;
  } finally {
    await deactivateKeepAwake(LOCAL_TRANSFER_KEEP_AWAKE_TAG).catch(() => {});
  }
}

async function receiveDirectTransfer({
  offer,
  deviceName,
  tcpSocket,
  onProgress,
}: {
  offer: IncomingTransferOffer;
  deviceName: string;
  tcpSocket: TcpSocketLike;
  onProgress?: (progress: TransferProgress) => void;
}) {
  const socket = tcpSocket.connectTLS({
    host: offer.sender.host,
    port: offer.sender.port,
    ca: LOCAL_TRANSFER_CERTIFICATE_ASSET,
    tlsCheckValidity: false,
    interface: "wifi",
  });

  await activateKeepAwakeAsync(LOCAL_TRANSFER_KEEP_AWAKE_TAG).catch(() => {});

  return await new Promise<TransferResult>((resolve, reject) => {
    const directory = getReceivedFilesDirectory();
    const receivedFiles: ReceivedFileRecord[] = [];
    let outputHandle: ReturnType<File["open"]> | null = null;
    let outputFile: File | null = null;
    let currentFileMetadata: { fileId: string; fileName: string; mimeType: string; sizeBytes: number } | null = null;
    let bytesTransferred = 0;
    let windowStartedAt = Date.now();
    let windowBytesTransferred = 0;
    let didResolve = false;
    let didReceiveDirectFrame = false;
    let handshakeTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      fail(new DirectTransferFallbackError("Unable to connect over local WiFi."));
    }, DIRECT_CONNECT_TIMEOUT_MS);

    function clearHandshakeTimer() {
      if (!handshakeTimer) {
        return;
      }

      clearTimeout(handshakeTimer);
      handshakeTimer = null;
    }

    function finish(result: TransferResult) {
      if (didResolve) {
        return;
      }

      didResolve = true;
      clearHandshakeTimer();
      outputHandle?.close();
      outputHandle = null;
      socket.destroy();
      releaseKeepAwakeSoon();
      resolve(result);
    }

    function fail(error: Error) {
      if (didResolve) {
        return;
      }

      didResolve = true;
      clearHandshakeTimer();
      outputHandle?.close();
      outputHandle = null;
      socket.destroy();
      releaseKeepAwakeSoon();
      reject(error);
    }

    const parser = createFrameParser((frame) => {
      try {
        if (frame.type === "json") {
          didReceiveDirectFrame = true;
          clearHandshakeTimer();

          const message = decodeJsonFrame<
            | { kind: "manifest"; manifest: TransferManifest }
            | { kind: "file-start"; fileId: string; fileName: string; mimeType: string; sizeBytes: number }
            | { kind: "file-end"; fileId: string }
            | { kind: "complete" }
            | { kind: "error"; message: string }
          >(frame.payload);

          if (message.kind === "manifest") {
            onProgress?.({
              phase: "transferring",
              totalBytes: message.manifest.totalBytes,
              bytesTransferred,
              currentFileName: null,
              speedBytesPerSecond: 0,
              detail: "Connected. Preparing files.",
              updatedAt: nowIso(),
            });
            return;
          }

          if (message.kind === "file-start") {
            currentFileMetadata = message;
            outputFile = createTransferOutputFile(directory, message.fileName, message.mimeType);
            outputHandle = outputFile.open();
            onProgress?.({
              phase: "transferring",
              totalBytes: offer.totalBytes,
              bytesTransferred,
              currentFileName: message.fileName,
              speedBytesPerSecond: 0,
              detail: "Receiving file data.",
              updatedAt: nowIso(),
            });
            return;
          }

          if (message.kind === "file-end" && outputFile && currentFileMetadata) {
            outputHandle?.close();
            outputHandle = null;
            receivedFiles.push({
              id: Crypto.randomUUID(),
              transferId: offer.id,
              name: currentFileMetadata.fileName,
              uri: outputFile.uri,
              mimeType: currentFileMetadata.mimeType,
              sizeBytes: currentFileMetadata.sizeBytes,
              receivedAt: nowIso(),
            });
            currentFileMetadata = null;
            outputFile = null;
            return;
          }

          if (message.kind === "complete") {
            finish({
              receivedFiles,
              bytesTransferred,
              detail: "Transfer complete.",
            });
            return;
          }

          if (message.kind === "error") {
            fail(new Error(message.message));
          }

          return;
        }

        if (!outputHandle || !currentFileMetadata) {
          return;
        }

        const chunkBytes = Buffer.from(frame.payload);
        outputHandle.writeBytes(chunkBytes);
        bytesTransferred += chunkBytes.byteLength;
        windowBytesTransferred += chunkBytes.byteLength;

        const elapsedMilliseconds = Date.now() - windowStartedAt;
        const speedBytesPerSecond =
          elapsedMilliseconds > 0 ? Math.round((windowBytesTransferred / elapsedMilliseconds) * 1000) : 0;

        if (elapsedMilliseconds >= 1000) {
          windowStartedAt = Date.now();
          windowBytesTransferred = 0;
        }

        onProgress?.({
          phase: "transferring",
          totalBytes: offer.totalBytes,
          bytesTransferred,
          currentFileName: currentFileMetadata.fileName,
          speedBytesPerSecond,
          detail: "Receiving file data.",
          updatedAt: nowIso(),
        });
      } catch (error) {
        fail(error instanceof Error ? error : new Error("Unable to decode transfer payload."));
      }
    });

    socket.on("secureConnect", () => {
      void writeSocket(
        socket,
        encodeJsonFrame({
          kind: "hello",
          sessionId: offer.sender.sessionId,
          transferToken: offer.sender.token,
          deviceName,
        }),
      ).catch((error) => {
        fail(
          error instanceof Error
            ? new DirectTransferFallbackError(error.message)
            : new DirectTransferFallbackError("Unable to start transfer session."),
        );
      });
    });
    socket.on("data", (chunk) => {
      parser(chunk as Uint8Array | Buffer | string);
    });
    socket.on("error", (error) => {
      const baseError = error instanceof Error ? error : new Error("Transfer connection failed.");
      fail(didReceiveDirectFrame ? baseError : new DirectTransferFallbackError(baseError.message));
    });
    socket.on("close", () => {
      if (!didResolve) {
        fail(
          didReceiveDirectFrame
            ? new Error("The transfer ended before all files finished downloading.")
            : new DirectTransferFallbackError("Unable to reach the sender over local WiFi."),
        );
      }
    });
  });
}

async function runReceiveTransfer(runtime: ReceiveRuntime) {
  const offer = runtime.session.incomingOffer;
  if (!offer) {
    throw new Error("That transfer request is no longer available.");
  }

  const tcpSocket = await loadTcpSocket();
  const canUsePreview = runtime.session.previewMode && activeSendRuntimes.has(offer.id);
  const canUseDirect = canAttemptDirectTransfer(offer, tcpSocket);

  if (offer.sender.relay) {
    try {
      await acceptRelayTransferSession({
        relay: offer.sender.relay,
        receiverDeviceName: runtime.session.discoveryRecord.deviceName,
      });
    } catch (error) {
      if (!canUsePreview && !canUseDirect) {
        throw error;
      }

      console.warn("Unable to accept relay transfer for fallback", error);
    }
  }

  const didNotifySender = await notifySenderAccepted(runtime, offer);
  if (!didNotifySender) {
    if (offer.sender.relay) {
      await declineRelayTransferSession(offer.sender.relay).catch(() => {});
    }
    throw new Error("Sender is no longer available.");
  }

  withReceiveSessionUpdate(runtime, {
    status: "connecting",
    peerDeviceName: offer.senderDeviceName,
    progress: {
      phase: "connecting",
      totalBytes: offer.totalBytes,
      bytesTransferred: 0,
      currentFileName: null,
      speedBytesPerSecond: 0,
      detail: "Connecting to the sender.",
      updatedAt: nowIso(),
    },
  });

  if (canUsePreview) {
    const senderRuntime = activeSendRuntimes.get(offer.id);
    if (!senderRuntime) {
      throw new Error("Sender is no longer available.");
    }

    return runPreviewTransfer(senderRuntime, runtime);
  }

  if (canUseDirect) {
    try {
      return await receiveDirectTransfer({
        offer,
        deviceName: runtime.session.discoveryRecord.deviceName,
        tcpSocket: tcpSocket as TcpSocketLike,
        onProgress: (progress) => {
          withReceiveSessionUpdate(runtime, {
            status: progress.phase === "transferring" ? "transferring" : "connecting",
            progress,
          });
        },
      });
    } catch (error) {
      if (offer.sender.relay && error instanceof DirectTransferFallbackError) {
        withReceiveSessionUpdate(runtime, {
          status: "connecting",
          progress: {
            phase: "connecting",
            totalBytes: offer.totalBytes,
            bytesTransferred: 0,
            currentFileName: null,
            speedBytesPerSecond: 0,
            detail: "Direct transfer unavailable. Switching to relay.",
            updatedAt: nowIso(),
          },
        });

        return receiveRelayTransfer({
          offer,
          onProgress: (progress) => {
            withReceiveSessionUpdate(runtime, {
              status: progress.phase === "transferring" ? "transferring" : "connecting",
              progress,
            });
          },
        });
      }

      throw error;
    }
  }

  if (offer.sender.relay) {
    return receiveRelayTransfer({
      offer,
      onProgress: (progress) => {
        withReceiveSessionUpdate(runtime, {
          status: progress.phase === "transferring" ? "transferring" : "connecting",
          progress,
        });
      },
    });
  }

  throw new Error("This sender is not reachable over local WiFi.");
}

function mapResolvedService(service: ZeroconfService) {
  const sessionId = service.txt?.sessionId;
  const receiverToken = service.txt?.receiverToken;
  const host = service.addresses?.find((address) => address.includes(".")) ?? service.host ?? "0.0.0.0";

  if (!sessionId || !receiverToken) {
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

  const parser = createFrameParser((frame) => {
    if (frame.type !== "json") {
      return;
    }

    const message = decodeJsonFrame<
      | { kind: "offer-received" }
      | { kind: "accepted"; receiverDeviceName?: string }
      | { kind: "rejected"; message: string }
      | { kind: "busy"; message: string }
      | { kind: "error"; message: string }
    >(frame.payload);

    if (message.kind === "offer-received") {
      return;
    }

    if (message.kind === "accepted") {
      handleSenderOfferAccepted(runtime, getPeerName(message.receiverDeviceName ?? target.deviceName));
      return;
    }

    handleSenderOfferRejected(
      runtime,
      message.kind === "busy" ? message.message || "That receiver is busy right now." : message.message,
    );
  });

  socket.on("secureConnect", () => {
    void writeSocket(
      socket,
      encodeJsonFrame({
        kind: "offer",
        receiverSessionId: target.sessionId,
        receiverToken: target.token,
        offer,
      }),
    ).catch((error) => {
      handleSenderOfferRejected(runtime, error instanceof Error ? error.message : "Unable to reach that receiver.");
    });
  });
  socket.on("data", (chunk) => {
    parser(chunk as Uint8Array | Buffer | string);
  });
  socket.on("error", (error) => {
    if (runtime.session.awaitingReceiverResponse) {
      handleSenderOfferRejected(runtime, error instanceof Error ? error.message : "Unable to reach that receiver.");
    }
  });
  socket.on("close", () => {
    if (runtime.controlSocket === socket) {
      runtime.controlSocket = undefined;
    }

    if (runtime.session.awaitingReceiverResponse) {
      handleSenderOfferRejected(runtime, "That receiver is no longer available.");
    }
  });
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
  const transferToken = Crypto.randomUUID().replace(/-/g, "");
  const deviceIp = safeDeviceIp(await Network.getIpAddressAsync().catch(() => null));
  const tcpSocket = await loadTcpSocket();
  const previewTarget = target.method === "preview" && activeReceiveRuntimes.has(target.sessionId);
  let relay: RelayCredentials | null = null;

  if (!tcpSocket && !previewTarget) {
    throw new Error("Nearby transfer is unavailable on this build.");
  }

  try {
    relay = await createRelayTransferSession({
      senderDeviceName: deviceName,
      files,
    });
  } catch (error) {
    console.warn("Unable to provision relay fallback for transfer session", error);
  }

  let resolvedPort = 0;
  let server: TransferServer | null = null;

  if (tcpSocket) {
    server = tcpSocket.createTLSServer(
      {
        keystore: LOCAL_TRANSFER_KEYSTORE_ASSET,
      },
      (socket: TransferSocket) => {
        let didReceiveHello = false;
        const parser = createFrameParser((frame) => {
          if (frame.type !== "json") {
            return;
          }

          const message = decodeJsonFrame<{
            kind: string;
            sessionId?: string;
            transferToken?: string;
          }>(frame.payload);

          if (message.kind === "hello" && message.sessionId === sessionId && message.transferToken === transferToken) {
            didReceiveHello = true;

            if (runtime.relayUploadStarted) {
              void writeSocket(
                socket,
                encodeJsonFrame({
                  kind: "error",
                  message: "Transfer has switched to relay.",
                }),
              )
                .catch(() => {})
                .finally(() => {
                  socket.destroy();
                });
              return;
            }

            if (runtime.didConnectDirectly || runtime.session.status === "transferring") {
              void writeSocket(
                socket,
                encodeJsonFrame({
                  kind: "error",
                  message: "Another receiver is already connected.",
                }),
              )
                .catch(() => {})
                .finally(() => {
                  socket.destroy();
                });
              return;
            }

            runtime.didConnectDirectly = true;
            void streamFilesToSocket(runtime, socket);
            return;
          }

          void writeSocket(
            socket,
            encodeJsonFrame({
              kind: "error",
              message: "Unable to validate transfer session.",
            }),
          ).catch(() => {});
        });

        socket.on("data", (chunk) => {
          parser(chunk as Uint8Array | Buffer | string);
        });
        socket.on("error", (error) => {
          if (!didReceiveHello) {
            console.warn("Sender data socket error before handshake", error);
          }
        });
      },
    );

    const dataServer = server;
    await new Promise<void>((resolve, reject) => {
      const handleError = (error: Error) => {
        reject(error);
      };

      dataServer.once("error", handleError);
      dataServer.listen({ port: 0, host: "0.0.0.0", reuseAddress: true }, () => {
        dataServer.off("error", handleError);
        resolve();
      });
    }).catch((error) => {
      console.error("Failed to start local transfer server", error);
    });

    resolvedPort = dataServer.address()?.port ?? 0;
  }

  const manifest = createTransferManifest({
    files,
    deviceName,
    sessionId,
    transferToken,
    host: deviceIp,
    port: resolvedPort,
    isPremium,
  });

  const runtime: SendRuntime = {
    session: createInitialSendSession(manifest, target, previewTarget, relay),
    files,
    target,
    updateSession,
    relayUploadStarted: false,
    didConnectDirectly: false,
    ...(resolvedPort && server
      ? {
          server: {
            close() {
              server?.close();
            },
          },
        }
      : {}),
  };

  activeSendRuntimes.set(sessionId, runtime);
  startRelayPolling(runtime);
  updateSession?.(runtime.session);

  const offer = createIncomingTransferOffer(manifest, relay);

  if (!resolvedPort && !relay && !previewTarget) {
    failSendSession(runtime, "Unable to prepare this transfer.");
    return runtime.session;
  }

  if (previewTarget) {
    const receiverRuntime = activeReceiveRuntimes.get(target.sessionId);
    if (!receiverRuntime || !registerIncomingOffer(receiverRuntime, offer)) {
      handleSenderOfferRejected(runtime, "That receiver is busy right now.");
      return runtime.session;
    }

    return runtime.session;
  }

  if (!tcpSocket || target.port <= 0) {
    failSendSession(runtime, "That receiver is no longer available.");
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

  runtime.controlSocket?.destroy();
  clearSenderConnectTimer(runtime);
  stopRelayPolling(runtime);
  runtime.server?.close();
  activeSendRuntimes.delete(sessionId);

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

  if (
    runtime.session.relay &&
    (runtime.session.status !== "completed" || runtime.session.progress.detail !== "Transfer complete through relay.")
  ) {
    await deleteRelayTransferSession(runtime.session.relay).catch((error) => {
      console.warn("Unable to delete relay transfer session", error);
    });
  }
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
  const deviceIp = safeDeviceIp(await Network.getIpAddressAsync().catch(() => null));
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
        const parser = createFrameParser((frame) => {
          if (frame.type !== "json") {
            return;
          }

          const message = decodeJsonFrame<{
            kind: string;
            receiverSessionId?: string;
            receiverToken?: string;
            offer?: IncomingTransferOffer;
          }>(frame.payload);

          if (
            message.kind !== "offer" ||
            message.receiverSessionId !== sessionId ||
            message.receiverToken !== receiverToken ||
            !message.offer
          ) {
            void writeSocket(
              socket,
              encodeJsonFrame({
                kind: "error",
                message: "Unable to validate receiver.",
              }),
            )
              .catch(() => {})
              .finally(() => {
                socket.destroy();
              });
            return;
          }

          const runtime = activeReceiveRuntimes.get(sessionId);
          if (!runtime || !registerIncomingOffer(runtime, message.offer, socket)) {
            void writeSocket(
              socket,
              encodeJsonFrame({
                kind: "busy",
                message: "That receiver is busy right now.",
              }),
            )
              .catch(() => {})
              .finally(() => {
                socket.destroy();
              });
            return;
          }

          registeredOfferId = message.offer.id;
          void writeSocket(socket, encodeJsonFrame({ kind: "offer-received" })).catch(() => {});
        });

        socket.on("data", (chunk) => {
          parser(chunk as Uint8Array | Buffer | string);
        });
        socket.on("error", () => {
          const runtime = activeReceiveRuntimes.get(sessionId);
          if (
            runtime &&
            runtime.pendingOfferSocket === socket &&
            runtime.session.status === "waiting" &&
            runtime.session.incomingOffer?.id === registeredOfferId
          ) {
            resetReceiveToDiscoverable(runtime);
          }
        });
        socket.on("close", () => {
          const runtime = activeReceiveRuntimes.get(sessionId);
          if (
            runtime &&
            runtime.pendingOfferSocket === socket &&
            runtime.session.status === "waiting" &&
            runtime.session.incomingOffer?.id === registeredOfferId
          ) {
            resetReceiveToDiscoverable(runtime);
          }
        });
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
    host: deviceIp,
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
    host: deviceIp,
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

  if (runtime.session.status === "waiting" && runtime.session.incomingOffer) {
    if (runtime.session.incomingOffer.sender.relay) {
      await declineRelayTransferSession(runtime.session.incomingOffer.sender.relay).catch(() => {});
    }
    await notifySenderRejected(runtime, runtime.session.incomingOffer, "Receiver is no longer available.").catch(
      () => {},
    );
  }

  runtime.pendingOfferSocket?.destroy();
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
