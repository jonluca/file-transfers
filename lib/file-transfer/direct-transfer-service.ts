import * as Crypto from "expo-crypto";
import { File, type Directory } from "expo-file-system";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import Zeroconf, { ImplType, type ZeroconfService } from "react-native-zeroconf";
import {
  DIRECT_TOKEN_HEADER,
  buildDirectSessionUrl,
  createDiscoveryQrPayload,
  createDiscoveryRecord,
  createServiceName,
  mapResolvedNearbyService,
  nowIso,
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
const PEER_REQUEST_TIMEOUT_MS = 8000;
const PROGRESS_UPDATE_INTERVAL_MS = 250;
const PROGRESS_UPDATE_BYTES = 128 * 1024;
const ZEROCONF_IMPL_TYPE = ImplType.DNSSD;

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
    completeSendSession(runtime, event.detail ?? "Transfer complete.");
    return;
  }

  if (event.kind === "rejected") {
    failSendSession(runtime, event.message || "Transfer declined.");
    return;
  }

  failSendSession(runtime, event.message || "Transfer stopped.");
}

async function handleReceiverEvent(runtime: ReceiveRuntime, event: SenderToReceiverEvent) {
  const detail = event.message || "Sender stopped the transfer.";

  if (runtime.session.status === "waiting") {
    resetReceiveToDiscoverable(runtime, detail);
    return;
  }

  failReceiveSession(runtime, detail);
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

  if (target.port <= 0 || !target.token.trim()) {
    throw new Error("That receiver is no longer available.");
  }

  const validatedTargetHost = resolveDiscoveryHost(target);
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
    session: createInitialSendSession(manifest, resolvedTarget),
    target: resolvedTarget,
    updateSession,
    offerDelivered: false,
    stopping: false,
  };

  activeSendRuntimes.set(sessionId, runtime);
  updateSession?.(runtime.session);

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
      createDiscoveryRecord({
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
  runtime.activeDownloadAbortController?.abort();

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
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "The transfer could not be completed.";

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

  function emitCurrentRecords() {
    onUpdate(
      Array.from(currentRecords.values()).sort((left, right) => right.advertisedAt.localeCompare(left.advertisedAt)),
    );
  }

  const zeroconf = new Zeroconf();
  zeroconf.on("resolved", (service: ZeroconfService) => {
    const nextRecord = mapResolvedNearbyService(service);
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
  return parseDirectDiscoveryQrPayload(value);
}
