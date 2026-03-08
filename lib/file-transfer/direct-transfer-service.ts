import { Buffer } from "buffer";
import * as Crypto from "expo-crypto";
import { File, type Directory } from "expo-file-system";
import * as Network from "expo-network";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import type { ZeroconfService } from "react-native-zeroconf";
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

function createDiscoveryRecord(
  manifest: TransferManifest,
  method: DiscoveryRecord["method"],
  serviceName: string | null,
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
  });
}

function createServiceName(deviceName: string, sessionId: string) {
  return `${deviceName.trim().slice(0, 24)}-${sessionId.slice(0, 6)}`;
}

function createInitialSendSession(manifest: TransferManifest, previewMode: boolean): TransferSession {
  const discoveryRecord = createDiscoveryRecord(manifest, previewMode ? "preview" : "nearby", null);

  return {
    id: manifest.sessionId,
    direction: "send",
    status: "discoverable",
    manifest,
    discoveryRecord,
    qrPayload: buildQrPayload(createDiscoveryRecord(manifest, "qr", null)),
    previewMode,
    peerDeviceName: null,
    awaitingApproval: false,
    progress: createProgress(manifest.totalBytes, "discoverable", "Waiting for a nearby device to connect."),
  };
}

function createTransferOutputFile(directory: Directory, fileName: string, mimeType: string) {
  const safeName = fileName.replace(/[^\w.\-() ]+/g, "_");
  const targetName = `${Date.now()}-${safeName}`;
  return directory.createFile(targetName, mimeType);
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
    session: createInitialSendSession(provisionalManifest, true),
    files,
    updateSession,
  };

  registerPreviewRuntime(runtime);

  const tcpSocket = await loadTcpSocket();
  const zeroconfModule = await loadZeroconf();

  if (!tcpSocket || !zeroconfModule) {
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

  runtime.session = createInitialSendSession(manifest, false);
  runtime.server = {
    close() {
      server.close();
    },
  };

  const serviceName = createServiceName(deviceName, sessionId);
  const zeroconf = new zeroconfModule.Zeroconf();
  zeroconf.publishService(
    LOCAL_TRANSFER_SERVICE_TYPE,
    LOCAL_TRANSFER_SERVICE_PROTOCOL,
    LOCAL_TRANSFER_SERVICE_DOMAIN,
    serviceName,
    resolvedPort,
    {
      sessionId,
      transferToken,
      deviceName,
      fileCount: String(manifest.fileCount),
      totalBytes: String(manifest.totalBytes),
      certificateFingerprint: manifest.certificateFingerprint,
      premium: manifest.isPremiumSender ? "1" : "0",
    },
    zeroconfModule.ImplType.DNSSD,
  );

  runtime.zeroconf = {
    publisher: {
      stop() {
        zeroconf.unpublishService(serviceName, zeroconfModule.ImplType.DNSSD);
        zeroconf.removeDeviceListeners();
      },
    },
  };

  runtime.session = {
    ...runtime.session,
    discoveryRecord: createDiscoveryRecord(manifest, "nearby", serviceName),
    qrPayload: buildQrPayload(createDiscoveryRecord(manifest, "qr", serviceName)),
    previewMode: false,
  };
  activeSendRuntimes.set(sessionId, runtime);
  updateSession?.(runtime.session);
  return runtime.session;
}

export async function stopHostingTransfer(sessionId: string) {
  const runtime = activeSendRuntimes.get(sessionId);

  if (!runtime) {
    return;
  }

  runtime.pendingSocket?.destroy();
  runtime.zeroconf?.publisher.stop();
  runtime.server?.close();
  activeSendRuntimes.delete(sessionId);
}

export async function approveTransferRequest(sessionId: string) {
  const runtime = activeSendRuntimes.get(sessionId);

  if (!runtime?.pendingSocket || !runtime.session.awaitingApproval) {
    return false;
  }

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

export async function rejectTransferRequest(sessionId: string) {
  const runtime = activeSendRuntimes.get(sessionId);

  if (!runtime?.pendingSocket || !runtime.session.awaitingApproval) {
    return false;
  }

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

function mapResolvedService(service: ZeroconfService) {
  const sessionId = service.txt?.sessionId;
  const transferToken = service.txt?.transferToken;
  const host = service.addresses?.find((address) => address.includes(".")) ?? service.host ?? null;

  if (!sessionId || !transferToken || !host) {
    return null;
  }

  return {
    sessionId,
    method: "nearby",
    deviceName: service.txt?.deviceName ?? service.name,
    host,
    port: service.port,
    token: transferToken,
    fileCount: Number(service.txt?.fileCount ?? "0"),
    totalBytes: Number(service.txt?.totalBytes ?? "0"),
    certificateFingerprint: service.txt?.certificateFingerprint ?? LOCAL_TRANSFER_CERT_FINGERPRINT,
    advertisedAt: nowIso(),
    isPremiumSender: service.txt?.premium === "1",
    serviceName: service.name,
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
        runtime.session.discoveryRecord ?? createDiscoveryRecord(runtime.session.manifest, "preview", null),
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

  if (record.method === "preview" || !tcpSocket) {
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

    function finish(result: { receivedFiles: ReceivedFileRecord[]; bytesTransferred: number; detail: string | null }) {
      if (didResolve) {
        return;
      }

      didResolve = true;
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
      outputHandle?.close();
      outputHandle = null;
      socket.destroy();
      releaseKeepAwakeSoon();
      reject(error);
    }

    const parser = createFrameParser((frame) => {
      try {
        if (frame.type === "json") {
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
        fail(error instanceof Error ? error : new Error("Unable to start transfer session."));
      });
    });
    socket.on("data", (chunk) => {
      parser(chunk as Uint8Array | Buffer | string);
    });
    socket.on("error", (error) => {
      fail(error instanceof Error ? error : new Error("Transfer connection failed."));
    });
    socket.on("close", () => {
      if (!didResolve) {
        fail(new Error("The transfer ended before all files finished downloading."));
      }
    });
  });
}
