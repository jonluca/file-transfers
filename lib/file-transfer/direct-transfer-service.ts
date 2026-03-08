import { Buffer } from "buffer";
import * as Crypto from "expo-crypto";
import { File, type Directory } from "expo-file-system";
import * as Network from "expo-network";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import type { ZeroconfService } from "react-native-zeroconf";
import {
  approveRelayTransferSession,
  completeRelayTransferSession,
  createRelayTransferSession,
  deleteRelayTransferSession,
  downloadRelayTransferFile,
  getRelayReceiverState,
  getRelaySenderState,
  joinRelayTransferSession,
  rejectRelayTransferSession,
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
  RelayAccess,
  RelayCredentials,
  ReceivedFileRecord,
  SelectedTransferFile,
  TransferManifest,
  TransferProgress,
  TransferSession,
} from "./types";

type RuntimeUpdate = (session: TransferSession) => void;

interface SendRuntime {
  session: TransferSession;
  files: SelectedTransferFile[];
  updateSession?: RuntimeUpdate;
  pendingSocket?: TransferSocket;
  relayPollTimer?: ReturnType<typeof setInterval>;
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

const activeSendRuntimes = new Map<string, SendRuntime>();
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

function withSessionUpdate(runtime: SendRuntime, patch: Partial<TransferSession>) {
  runtime.session = {
    ...runtime.session,
    ...patch,
    progress: patch.progress ?? runtime.session.progress,
  };
  runtime.updateSession?.(runtime.session);
}

function clearPendingApproval(runtime: SendRuntime, detail = "Waiting for a nearby device to connect.") {
  runtime.pendingSocket = undefined;
  withSessionUpdate(runtime, {
    status: "discoverable",
    peerDeviceName: null,
    awaitingApproval: false,
    progress: {
      ...runtime.session.progress,
      phase: "discoverable",
      currentFileName: null,
      speedBytesPerSecond: 0,
      detail,
      updatedAt: nowIso(),
    },
  });
}

async function loadTcpSocket() {
  try {
    const module = (await import("react-native-tcp-socket")) as unknown as { default?: TcpSocketLike };
    return (module.default ?? module) as TcpSocketLike;
  } catch (error) {
    console.warn("react-native-tcp-socket unavailable, falling back to preview mode", error);
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
    console.warn("react-native-zeroconf unavailable, using preview discovery only", error);
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

function createDiscoveryRecord(
  manifest: TransferManifest,
  method: DiscoveryRecord["method"],
  serviceName: string | null,
  relay: RelayAccess | null,
) {
  return {
    sessionId: manifest.sessionId,
    method,
    deviceName: manifest.deviceName,
    host: manifest.advertisedHost,
    port: manifest.advertisedPort,
    token: manifest.transferToken,
    fileCount: manifest.fileCount,
    totalBytes: manifest.totalBytes,
    certificateFingerprint: manifest.certificateFingerprint,
    advertisedAt: manifest.createdAt,
    isPremiumSender: manifest.isPremiumSender,
    serviceName,
    relay,
  } satisfies DiscoveryRecord;
}

function buildQrPayload(record: DiscoveryRecord) {
  return JSON.stringify({
    version: 1,
    sessionId: record.sessionId,
    host: record.host,
    port: record.port,
    token: record.token,
    deviceName: record.deviceName,
    fileCount: record.fileCount,
    totalBytes: record.totalBytes,
    certificateFingerprint: record.certificateFingerprint,
    advertisedAt: record.advertisedAt,
    isPremiumSender: record.isPremiumSender,
    relay: record.relay,
  });
}

function createServiceName(deviceName: string, sessionId: string) {
  return `${deviceName.trim().slice(0, 24)}-${sessionId.slice(0, 6)}`;
}

function createInitialSendSession(
  manifest: TransferManifest,
  previewMode: boolean,
  relay: RelayCredentials | null,
): TransferSession {
  const discoveryRecord = createDiscoveryRecord(
    manifest,
    previewMode ? "preview" : "nearby",
    null,
    toRelayAccess(relay),
  );

  return {
    id: manifest.sessionId,
    direction: "send",
    status: "discoverable",
    manifest,
    discoveryRecord,
    qrPayload: buildQrPayload(createDiscoveryRecord(manifest, "qr", null, toRelayAccess(relay))),
    previewMode,
    peerDeviceName: null,
    awaitingApproval: false,
    relay,
    progress: createProgress(manifest.totalBytes, "discoverable", "Waiting for a nearby device to connect."),
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

async function streamFilesToSocket(runtime: SendRuntime, socket: TransferSocket) {
  const speedLimit = runtime.session.manifest.isPremiumSender ? null : LOCAL_TRANSFER_SPEED_LIMIT_BYTES_PER_SECOND;
  let bytesTransferred = 0;
  let windowBytesTransferred = 0;
  let windowStartedAt = Date.now();

  await activateKeepAwakeAsync(LOCAL_TRANSFER_KEEP_AWAKE_TAG).catch(() => {});
  stopRelayPolling(runtime);

  try {
    withSessionUpdate(runtime, {
      status: "transferring",
      awaitingApproval: false,
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

          withSessionUpdate(runtime, {
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

    withSessionUpdate(runtime, {
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

    withSessionUpdate(runtime, {
      status: "failed",
      progress: {
        ...runtime.session.progress,
        phase: "failed",
        detail: message,
        updatedAt: nowIso(),
      },
    });
  } finally {
    await deactivateKeepAwake(LOCAL_TRANSFER_KEEP_AWAKE_TAG).catch(() => {});
    socket.destroy();
  }
}

function registerPreviewRuntime(runtime: SendRuntime) {
  activeSendRuntimes.set(runtime.session.id, runtime);
}

function getReceiverName(value: string | undefined) {
  return value?.trim() ? value.trim().slice(0, 40) : "Nearby device";
}

function stopRelayPolling(runtime: SendRuntime) {
  if (!runtime.relayPollTimer) {
    return;
  }

  clearInterval(runtime.relayPollTimer);
  runtime.relayPollTimer = undefined;
}

async function syncRelaySenderState(runtime: SendRuntime) {
  if (!runtime.session.relay) {
    return;
  }

  try {
    const state = await getRelaySenderState(runtime.session.relay);

    if (state.status === "waiting_approval" && !runtime.pendingSocket) {
      const receiverName = getReceiverName(state.receiverDeviceName ?? undefined);
      withSessionUpdate(runtime, {
        status: "waiting",
        peerDeviceName: receiverName,
        awaitingApproval: true,
        progress: {
          ...runtime.session.progress,
          phase: "waiting",
          detail: `${receiverName} wants to receive your files through relay.`,
          updatedAt: nowIso(),
        },
      });
      return;
    }

    if (state.status === "rejected" && runtime.session.awaitingApproval && !runtime.pendingSocket) {
      clearPendingApproval(runtime, "Transfer declined. Waiting for a nearby device to connect.");
      return;
    }

    if (state.status === "waiting_receiver" && runtime.session.awaitingApproval && !runtime.pendingSocket) {
      clearPendingApproval(runtime);
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

async function uploadFilesToRelay(runtime: SendRuntime) {
  if (!runtime.session.relay) {
    throw new Error("Relay session is not available.");
  }

  await activateKeepAwakeAsync(LOCAL_TRANSFER_KEEP_AWAKE_TAG).catch(() => {});

  let bytesTransferred = 0;

  try {
    withSessionUpdate(runtime, {
      status: "transferring",
      awaitingApproval: false,
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

      withSessionUpdate(runtime, {
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

    withSessionUpdate(runtime, {
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
    withSessionUpdate(runtime, {
      status: "failed",
      awaitingApproval: false,
      progress: {
        ...runtime.session.progress,
        phase: "failed",
        detail: message,
        updatedAt: nowIso(),
      },
    });
    stopRelayPolling(runtime);
    throw error;
  } finally {
    await deactivateKeepAwake(LOCAL_TRANSFER_KEEP_AWAKE_TAG).catch(() => {});
  }
}

export async function startHostingTransfer({
  files,
  deviceName,
  isPremium,
  updateSession,
}: {
  files: SelectedTransferFile[];
  deviceName: string;
  isPremium: boolean;
  updateSession?: RuntimeUpdate;
}) {
  const sessionId = Crypto.randomUUID();
  const transferToken = Crypto.randomUUID().replace(/-/g, "");
  const deviceIp = safeDeviceIp(await Network.getIpAddressAsync().catch(() => null));
  let relay: RelayCredentials | null = null;

  try {
    relay = await createRelayTransferSession({
      senderDeviceName: deviceName,
      files,
    });
  } catch (error) {
    console.warn("Unable to provision relay fallback for transfer session", error);
  }

  const provisionalManifest = createTransferManifest({
    files,
    deviceName,
    sessionId,
    transferToken,
    host: deviceIp,
    port: 0,
    isPremium,
  });
  const runtime: SendRuntime = {
    session: createInitialSendSession(provisionalManifest, true, relay),
    files,
    updateSession,
  };

  registerPreviewRuntime(runtime);

  const tcpSocket = await loadTcpSocket();
  const zeroconfModule = await loadZeroconf();

  if (!tcpSocket) {
    startRelayPolling(runtime);
    updateSession?.(runtime.session);
    return runtime.session;
  }

  const server = tcpSocket.createTLSServer(
    {
      keystore: LOCAL_TRANSFER_KEYSTORE_ASSET,
    },
    (socket: TransferSocket) => {
      const parser = createFrameParser((frame) => {
        if (frame.type !== "json") {
          return;
        }

        const message = decodeJsonFrame<{
          kind: string;
          sessionId?: string;
          transferToken?: string;
          deviceName?: string;
        }>(frame.payload);

        if (
          message.kind === "hello" &&
          message.sessionId === runtime.session.manifest.sessionId &&
          message.transferToken === runtime.session.manifest.transferToken
        ) {
          if (runtime.pendingSocket || runtime.session.awaitingApproval || runtime.session.status === "transferring") {
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

          const receiverName = getReceiverName(message.deviceName);
          runtime.pendingSocket = socket;

          withSessionUpdate(runtime, {
            status: "waiting",
            peerDeviceName: receiverName,
            awaitingApproval: true,
            progress: {
              ...runtime.session.progress,
              phase: "waiting",
              detail: `${receiverName} wants to receive your files.`,
              updatedAt: nowIso(),
            },
          });

          void writeSocket(
            socket,
            encodeJsonFrame({
              kind: "approval-required",
            }),
          ).catch(() => {});
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
        if (runtime.pendingSocket === socket && runtime.session.awaitingApproval) {
          clearPendingApproval(runtime, "Receiver request ended before you responded.");
          return;
        }

        withSessionUpdate(runtime, {
          status: "failed",
          awaitingApproval: false,
          progress: {
            ...runtime.session.progress,
            phase: "failed",
            detail: error instanceof Error ? error.message : "Transfer connection failed.",
            updatedAt: nowIso(),
          },
        });
      });
      socket.on("close", () => {
        if (runtime.pendingSocket === socket && runtime.session.awaitingApproval) {
          clearPendingApproval(runtime, "Receiver request ended before you responded.");
        }
      });
    },
  );

  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error) => {
      reject(error);
    };

    server.once("error", handleError);
    server.listen({ port: 0, host: "0.0.0.0", reuseAddress: true }, () => {
      server.off("error", handleError);
      resolve();
    });
  }).catch((error) => {
    console.error("Failed to start local transfer server", error);
  });

  const address = server.address();
  const resolvedPort = address?.port ?? 0;

  if (!resolvedPort) {
    startRelayPolling(runtime);
    updateSession?.(runtime.session);
    return runtime.session;
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

  runtime.session = createInitialSendSession(manifest, false, relay);
  runtime.server = {
    close() {
      server.close();
    },
  };

  let serviceName: string | null = null;

  if (zeroconfModule) {
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
        transferToken,
        deviceName,
        fileCount: String(manifest.fileCount),
        totalBytes: String(manifest.totalBytes),
        certificateFingerprint: manifest.certificateFingerprint,
        premium: manifest.isPremiumSender ? "1" : "0",
        ...(relay
          ? {
              relaySessionId: relay.sessionId,
              relayReceiverToken: relay.receiverToken,
              relayExpiresAt: relay.expiresAt,
            }
          : {}),
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

  runtime.session = {
    ...runtime.session,
    discoveryRecord: createDiscoveryRecord(
      manifest,
      zeroconfModule ? "nearby" : "qr",
      serviceName,
      toRelayAccess(relay),
    ),
    qrPayload: buildQrPayload(createDiscoveryRecord(manifest, "qr", serviceName, toRelayAccess(relay))),
    previewMode: false,
  };
  activeSendRuntimes.set(sessionId, runtime);
  startRelayPolling(runtime);
  updateSession?.(runtime.session);
  return runtime.session;
}

export async function stopHostingTransfer(sessionId: string) {
  const runtime = activeSendRuntimes.get(sessionId);

  if (!runtime) {
    return;
  }

  runtime.pendingSocket?.destroy();
  stopRelayPolling(runtime);
  runtime.zeroconf?.publisher.stop();
  runtime.server?.close();
  activeSendRuntimes.delete(sessionId);

  if (
    runtime.session.relay &&
    (runtime.session.status !== "completed" || runtime.session.progress.detail !== "Transfer complete through relay.")
  ) {
    await deleteRelayTransferSession(runtime.session.relay).catch((error) => {
      console.warn("Unable to delete relay transfer session", error);
    });
  }
}

export async function approveTransferRequest(sessionId: string) {
  const runtime = activeSendRuntimes.get(sessionId);

  if (!runtime || !runtime.session.awaitingApproval) {
    return false;
  }

  if (runtime.pendingSocket) {
    const socket = runtime.pendingSocket;
    runtime.pendingSocket = undefined;

    try {
      await writeSocket(
        socket,
        encodeJsonFrame({
          kind: "approved",
        }),
      );
    } catch (error) {
      clearPendingApproval(runtime, error instanceof Error ? error.message : "Unable to approve the transfer.");
      socket.destroy();
      return false;
    }

    void streamFilesToSocket(runtime, socket);
    return true;
  }

  if (!runtime.session.relay) {
    return false;
  }

  try {
    await approveRelayTransferSession(runtime.session.relay);
    void uploadFilesToRelay(runtime).catch(() => {});
    return true;
  } catch (error) {
    withSessionUpdate(runtime, {
      status: "failed",
      awaitingApproval: false,
      progress: {
        ...runtime.session.progress,
        phase: "failed",
        detail: error instanceof Error ? error.message : "Unable to approve the relay transfer.",
        updatedAt: nowIso(),
      },
    });
    return false;
  }
}

export async function rejectTransferRequest(sessionId: string) {
  const runtime = activeSendRuntimes.get(sessionId);

  if (!runtime || !runtime.session.awaitingApproval) {
    return false;
  }

  if (runtime.pendingSocket) {
    const socket = runtime.pendingSocket;

    await writeSocket(
      socket,
      encodeJsonFrame({
        kind: "rejected",
        message: "Transfer declined.",
      }),
    ).catch(() => {});
    socket.destroy();
    clearPendingApproval(runtime);
    return true;
  }

  if (!runtime.session.relay) {
    return false;
  }

  try {
    await rejectRelayTransferSession(runtime.session.relay);
    clearPendingApproval(runtime, "Transfer declined. Waiting for a nearby device to connect.");
    return true;
  } catch (error) {
    withSessionUpdate(runtime, {
      status: "failed",
      awaitingApproval: false,
      progress: {
        ...runtime.session.progress,
        phase: "failed",
        detail: error instanceof Error ? error.message : "Unable to reject the relay transfer.",
        updatedAt: nowIso(),
      },
    });
    return false;
  }
}

function mapResolvedService(service: ZeroconfService) {
  const sessionId = service.txt?.sessionId;
  const transferToken = service.txt?.transferToken;
  const relay =
    service.txt?.relaySessionId && service.txt?.relayReceiverToken && service.txt?.relayExpiresAt
      ? ({
          sessionId: service.txt.relaySessionId,
          receiverToken: service.txt.relayReceiverToken,
          expiresAt: service.txt.relayExpiresAt,
        } satisfies RelayAccess)
      : null;
  const host = service.addresses?.find((address) => address.includes(".")) ?? service.host ?? "0.0.0.0";

  if (!sessionId || (!transferToken && !relay)) {
    return null;
  }

  return {
    sessionId,
    method: "nearby",
    deviceName: service.txt?.deviceName ?? service.name,
    host,
    port: service.port ?? 0,
    token: transferToken ?? "",
    fileCount: Number(service.txt?.fileCount ?? "0"),
    totalBytes: Number(service.txt?.totalBytes ?? "0"),
    certificateFingerprint: service.txt?.certificateFingerprint ?? LOCAL_TRANSFER_CERT_FINGERPRINT,
    advertisedAt: nowIso(),
    isPremiumSender: service.txt?.premium === "1",
    serviceName: service.name,
    relay,
  } satisfies DiscoveryRecord;
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
    for (const runtime of activeSendRuntimes.values()) {
      currentRecords.set(
        runtime.session.id,
        runtime.session.discoveryRecord ??
          createDiscoveryRecord(runtime.session.manifest, "preview", null, toRelayAccess(runtime.session.relay)),
      );
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
    fileCount: number;
    totalBytes: number;
    certificateFingerprint: string;
    advertisedAt: string;
    isPremiumSender: boolean;
    relay?: RelayAccess | null;
  };

  return {
    sessionId: parsed.sessionId,
    method: "qr",
    deviceName: parsed.deviceName,
    host: parsed.host,
    port: parsed.port,
    token: parsed.token,
    fileCount: parsed.fileCount,
    totalBytes: parsed.totalBytes,
    certificateFingerprint: parsed.certificateFingerprint,
    advertisedAt: parsed.advertisedAt,
    isPremiumSender: parsed.isPremiumSender,
    serviceName: null,
    relay: parsed.relay ?? null,
  } satisfies DiscoveryRecord;
}

async function receivePreviewTransfer(record: DiscoveryRecord) {
  const runtime = activeSendRuntimes.get(record.sessionId);
  if (!runtime) {
    throw new Error("That transfer is no longer available.");
  }

  const receivedFiles: ReceivedFileRecord[] = [];
  let bytesTransferred = 0;

  await activateKeepAwakeAsync(LOCAL_TRANSFER_KEEP_AWAKE_TAG).catch(() => {});

  try {
    for (const file of runtime.files) {
      const outputFile = createTransferOutputFile(getReceivedFilesDirectory(), file.name, file.mimeType);
      const sourceFile = new File(file.uri);
      sourceFile.copy(outputFile);

      bytesTransferred += file.sizeBytes;
      receivedFiles.push({
        id: Crypto.randomUUID(),
        transferId: record.sessionId,
        name: file.name,
        uri: outputFile.uri,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        receivedAt: nowIso(),
      });

      await sleep(120);
    }
  } finally {
    await deactivateKeepAwake(LOCAL_TRANSFER_KEEP_AWAKE_TAG).catch(() => {});
  }

  return {
    receivedFiles,
    bytesTransferred,
  };
}

function canAttemptDirectTransfer(record: DiscoveryRecord, tcpSocket: TcpSocketLike | null) {
  return Boolean(tcpSocket && record.port > 0 && record.host !== "0.0.0.0" && record.token.trim());
}

async function receiveRelayTransfer({
  record,
  deviceName,
  onProgress,
}: {
  record: DiscoveryRecord;
  deviceName: string;
  onProgress?: (progress: TransferProgress) => void;
}) {
  if (!record.relay) {
    throw new Error("Relay access is not available for this transfer.");
  }

  await activateKeepAwakeAsync(LOCAL_TRANSFER_KEEP_AWAKE_TAG).catch(() => {});

  try {
    let state = await joinRelayTransferSession({
      relay: record.relay,
      receiverDeviceName: deviceName,
    });

    while (!["ready", "completed"].includes(state.status)) {
      if (state.status === "rejected") {
        throw new Error("Transfer declined.");
      }

      if (state.status === "expired") {
        throw new Error("This relay transfer expired before it could start.");
      }

      onProgress?.({
        phase: state.status === "waiting_approval" ? "waiting" : "connecting",
        totalBytes: record.totalBytes,
        bytesTransferred: 0,
        currentFileName: null,
        speedBytesPerSecond: 0,
        detail:
          state.status === "waiting_approval"
            ? "Waiting for the sender to approve this transfer."
            : "Connecting through relay.",
        updatedAt: nowIso(),
      });

      await sleep(RELAY_POLL_INTERVAL_MS);
      state = await getRelayReceiverState(record.relay);
    }

    const receivedFiles: ReceivedFileRecord[] = [];
    let bytesTransferred = 0;

    for (const file of state.files) {
      const outputFile = createTransferOutputReference(getReceivedFilesDirectory(), file.name);
      const startedAt = Date.now();

      onProgress?.({
        phase: "transferring",
        totalBytes: record.totalBytes,
        bytesTransferred,
        currentFileName: file.name,
        speedBytesPerSecond: 0,
        detail: "Downloading files through relay.",
        updatedAt: nowIso(),
      });

      await downloadRelayTransferFile({
        relay: record.relay,
        fileId: file.id,
        destination: outputFile,
      });

      bytesTransferred += file.sizeBytes;
      const elapsedMilliseconds = Math.max(Date.now() - startedAt, 1);
      const speedBytesPerSecond = Math.round((file.sizeBytes / elapsedMilliseconds) * 1000);

      receivedFiles.push({
        id: Crypto.randomUUID(),
        transferId: record.sessionId,
        name: file.name,
        uri: outputFile.uri,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        receivedAt: nowIso(),
      });

      onProgress?.({
        phase: "transferring",
        totalBytes: record.totalBytes,
        bytesTransferred,
        currentFileName: file.name,
        speedBytesPerSecond,
        detail: "Downloading files through relay.",
        updatedAt: nowIso(),
      });
    }

    await completeRelayTransferSession(record.relay).catch(() => {});

    return {
      receivedFiles,
      bytesTransferred,
      detail: "Transfer complete through relay.",
    };
  } finally {
    await deactivateKeepAwake(LOCAL_TRANSFER_KEEP_AWAKE_TAG).catch(() => {});
  }
}

async function receiveDirectTransfer({
  record,
  deviceName,
  tcpSocket,
  onProgress,
}: {
  record: DiscoveryRecord;
  deviceName: string;
  tcpSocket: TcpSocketLike;
  onProgress?: (progress: TransferProgress) => void;
}) {
  const socket = tcpSocket.connectTLS({
    host: record.host,
    port: record.port,
    ca: LOCAL_TRANSFER_CERTIFICATE_ASSET,
    tlsCheckValidity: false,
    interface: "wifi",
  });

  await activateKeepAwakeAsync(LOCAL_TRANSFER_KEEP_AWAKE_TAG).catch(() => {});

  return await new Promise<{
    receivedFiles: ReceivedFileRecord[];
    bytesTransferred: number;
    detail: string | null;
  }>((resolve, reject) => {
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

    function finish(result: { receivedFiles: ReceivedFileRecord[]; bytesTransferred: number; detail: string | null }) {
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
            | { kind: "approval-required" }
            | { kind: "approved" }
            | { kind: "rejected"; message: string }
            | { kind: "file-start"; fileId: string; fileName: string; mimeType: string; sizeBytes: number }
            | { kind: "file-end"; fileId: string }
            | { kind: "complete" }
            | { kind: "error"; message: string }
          >(frame.payload);

          if (message.kind === "approval-required") {
            onProgress?.({
              phase: "waiting",
              totalBytes: record.totalBytes,
              bytesTransferred,
              currentFileName: null,
              speedBytesPerSecond: 0,
              detail: "Waiting for the sender to approve this transfer.",
              updatedAt: nowIso(),
            });
            return;
          }

          if (message.kind === "approved") {
            onProgress?.({
              phase: "connecting",
              totalBytes: record.totalBytes,
              bytesTransferred,
              currentFileName: null,
              speedBytesPerSecond: 0,
              detail: "Sender approved the transfer.",
              updatedAt: nowIso(),
            });
            return;
          }

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
              totalBytes: record.totalBytes,
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
              transferId: record.sessionId,
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

          if (message.kind === "rejected") {
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
          totalBytes: record.totalBytes,
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
          sessionId: record.sessionId,
          transferToken: record.token,
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

export async function receiveTransfer({
  record,
  deviceName,
  onProgress,
}: {
  record: DiscoveryRecord;
  deviceName: string;
  onProgress?: (progress: TransferProgress) => void;
}) {
  const previewRuntime = activeSendRuntimes.get(record.sessionId);
  const tcpSocket = await loadTcpSocket();

  if (record.method === "preview" && previewRuntime) {
    const previewResult = await receivePreviewTransfer(record);

    return {
      receivedFiles: previewResult.receivedFiles,
      bytesTransferred: previewResult.bytesTransferred,
      detail: "Transfer complete.",
    };
  }

  if (canAttemptDirectTransfer(record, tcpSocket)) {
    try {
      return await receiveDirectTransfer({
        record,
        deviceName,
        tcpSocket: tcpSocket as TcpSocketLike,
        onProgress,
      });
    } catch (error) {
      if (record.relay && error instanceof DirectTransferFallbackError) {
        onProgress?.({
          phase: "connecting",
          totalBytes: record.totalBytes,
          bytesTransferred: 0,
          currentFileName: null,
          speedBytesPerSecond: 0,
          detail: "Direct transfer unavailable. Switching to relay.",
          updatedAt: nowIso(),
        });

        return receiveRelayTransfer({
          record,
          deviceName,
          onProgress,
        });
      }

      throw error;
    }
  }

  if (record.relay) {
    return receiveRelayTransfer({
      record,
      deviceName,
      onProgress,
    });
  }

  if (record.method === "preview") {
    if (!previewRuntime) {
      throw new Error("That transfer preview is no longer available.");
    }

    const previewResult = await receivePreviewTransfer(record);

    return {
      receivedFiles: previewResult.receivedFiles,
      bytesTransferred: previewResult.bytesTransferred,
      detail: "Transfer complete.",
    };
  }

  if (!tcpSocket) {
    throw new Error("Local WiFi transfer is not available on this device.");
  }

  throw new Error("This transfer is not reachable over local WiFi.");
}
