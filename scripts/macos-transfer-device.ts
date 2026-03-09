import "dotenv/config";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  DIRECT_TOKEN_HEADER,
  buildDirectSessionBaseUrl,
  buildDirectSessionUrl,
  createDiscoveryQrPayload,
  createDiscoveryRecord,
  createServiceName,
  getUsableLanHost,
  mapResolvedNearbyService,
  nowIso,
  parseDiscoveryQrPayload,
  resolveDiscoveryHost,
} from "../lib/file-transfer/direct-transfer-protocol";
import type {
  DirectPeerAccess,
  DiscoveryRecord,
  DownloadableTransferManifest,
  IncomingTransferOffer,
  SelectedTransferFile,
  TransferManifest,
  TransferManifestFile,
  TransferProgress,
} from "../lib/file-transfer/types";

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

interface ReceiveCommandOptions {
  deviceName: string;
  outputDir: string;
  stateFile: string | null;
  acceptDelayMs: number;
  nearby: boolean;
  once: boolean;
  verbose: boolean;
}

interface SendCommandOptions {
  deviceName: string;
  filePaths: string[];
  targetQr: string | null;
  targetFile: string | null;
  targetName: string | null;
  targetSessionId: string | null;
  discoverTimeoutMs: number;
  stateFile: string | null;
  verbose: boolean;
}

interface LaunchAgentOptions {
  deviceName: string;
  outputDir: string;
  stateFile: string | null;
  acceptDelayMs: number;
  nearby: boolean;
  label: string;
}

interface ReceivedFileOutput {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  outputPath: string;
}

interface ReceiveServiceState {
  mode: "receive";
  deviceName: string;
  outputDir: string;
  startedAt: string;
  discoveryRecord: DiscoveryRecord;
  qrPayload: string | null;
  nearbyAdvertising: boolean;
  currentStatus: "discoverable" | "waiting" | "connecting" | "transferring";
  currentOffer: IncomingTransferOffer | null;
  progress: TransferProgress;
  lastTransfer: null | {
    startedAt: string;
    completedAt: string;
    outcome: "completed" | "failed";
    detail: string;
    bytesTransferred: number;
    fileCount: number;
    files: ReceivedFileOutput[];
  };
}

interface SendState {
  mode: "send";
  deviceName: string;
  target: DiscoveryRecord;
  startedAt: string;
  progress: TransferProgress;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_TRANSFER_SERVICE_TYPE = "_filetransfer._tcp";
const LOCAL_TRANSFER_SERVICE_DOMAIN = "local.";
const LOCAL_HTTP_SERVER_PORT = 41000;
const DEFAULT_DISCOVER_TIMEOUT_MS = 5000;
const REQUEST_TIMEOUT_MS = 8000;
const MIME_TYPES: Record<string, string> = {
  ".aac": "audio/aac",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".m4a": "audio/mp4",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".zip": "application/zip",
};

function randomToken() {
  return randomBytes(16).toString("hex");
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function safeName(value: string) {
  return value.replace(/[^\w.\-() ]+/g, "_");
}

function logLine(message: string) {
  console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
}

function createDeferred<T>(): Deferred<T> {
  let deferredResolve!: (value: T) => void;
  let deferredReject!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    deferredResolve = resolve;
    deferredReject = reject;
  });

  return {
    promise,
    resolve: deferredResolve,
    reject: deferredReject,
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

async function ensureDirectory(directoryPath: string) {
  await mkdir(directoryPath, { recursive: true });
}

function createOutputPath(outputDir: string, fileName: string) {
  return path.join(outputDir, `${Date.now()}-${safeName(fileName)}`);
}

async function writeStateFile(filePath: string | null, payload: unknown) {
  if (!filePath) {
    return;
  }

  await ensureDirectory(path.dirname(filePath));
  await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function getPreferredLanAddress() {
  const interfaces = networkInterfaces();

  for (const group of Object.values(interfaces)) {
    for (const address of group ?? []) {
      if (address.family !== "IPv4" || address.internal) {
        continue;
      }

      const host = getUsableLanHost(address.address);
      if (host) {
        return host;
      }
    }
  }

  return null;
}

function getHeader(request: IncomingMessage, name: string) {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

async function readRequestBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

async function readJsonBody<T>(request: IncomingMessage) {
  const payload = await readRequestBody(request);
  if (payload.byteLength === 0) {
    throw new Error("Missing JSON request body.");
  }

  return JSON.parse(payload.toString("utf8")) as T;
}

function sendText(response: ServerResponse, statusCode: number, body: string, headers?: Record<string, string>) {
  const payload = Buffer.from(body, "utf8");
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(payload.byteLength),
    ...headers,
  });
  response.end(payload);
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown, headers?: Record<string, string>) {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.byteLength),
    ...headers,
  });
  response.end(payload);
}

function sendEmpty(response: ServerResponse, statusCode: number, headers?: Record<string, string>) {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    ...headers,
  });
  response.end("");
}

function encodeHeaderFilename(value: string) {
  const safe = value.replace(/["\\\r\n]/g, "_");
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(value)}`;
}

async function sendFile(response: ServerResponse, file: SelectedTransferFile, method: string) {
  const metadata = await stat(file.uri).catch(() => null);
  if (!metadata?.isFile()) {
    sendText(response, 410, "The selected file is no longer available on this device.");
    return;
  }

  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": file.mimeType || "application/octet-stream",
    "content-length": String(metadata.size),
    "content-disposition": encodeHeaderFilename(file.name),
  });

  if (method === "HEAD") {
    response.end();
    return;
  }

  createReadStream(file.uri).pipe(response);
}

function inferMimeType(filePath: string) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

async function buildSelectedFiles(filePaths: string[]) {
  if (filePaths.length === 0) {
    throw new Error("Specify at least one file with --file.");
  }

  const selectedFiles: SelectedTransferFile[] = [];

  for (const filePath of filePaths) {
    const resolvedPath = path.resolve(filePath);
    const metadata = await stat(resolvedPath).catch(() => null);
    if (!metadata?.isFile()) {
      throw new Error(`File not found: ${resolvedPath}`);
    }

    selectedFiles.push({
      id: randomUUID(),
      name: path.basename(resolvedPath),
      uri: resolvedPath,
      mimeType: inferMimeType(resolvedPath),
      sizeBytes: metadata.size,
    });
  }

  return selectedFiles;
}

function matchTarget(record: DiscoveryRecord, name: string | null, sessionId: string | null) {
  if (sessionId && record.sessionId === sessionId) {
    return true;
  }

  if (!name) {
    return !sessionId;
  }

  const needle = name.trim().toLowerCase();
  return (
    record.deviceName.toLowerCase() === needle ||
    record.serviceName?.toLowerCase() === needle ||
    record.serviceName?.toLowerCase().startsWith(needle) === true
  );
}

function parseTxtLine(line: string) {
  const entries: Record<string, string> = {};
  const matcher = /(\w+)=([^=]+?)(?=\s+\w+=|$)/g;

  for (const match of line.matchAll(matcher)) {
    entries[match[1]] = match[2].trim().replace(/\\(.)/g, "$1");
  }

  return entries;
}

async function resolveBonjourService(instanceName: string, timeoutMs: number) {
  return await new Promise<DiscoveryRecord | null>((resolve) => {
    const child = spawn("dns-sd", ["-L", instanceName, LOCAL_TRANSFER_SERVICE_TYPE, LOCAL_TRANSFER_SERVICE_DOMAIN], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let buffered = "";
    let host: string | null = null;
    let port = 0;

    const timer = setTimeout(() => {
      child.kill("SIGINT");
      resolve(null);
    }, timeoutMs);

    function finish(record: DiscoveryRecord | null) {
      clearTimeout(timer);
      child.kill("SIGINT");
      resolve(record);
    }

    child.stdout.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";

      for (const line of lines) {
        const hostMatch = line.match(/ can be reached at ([^:]+):(\d+)/);
        if (hostMatch) {
          host = hostMatch[1].replace(/\.$/, "");
          port = Number(hostMatch[2]);
          continue;
        }

        const txt = parseTxtLine(line);
        if (!host || !port || !txt.sessionId || !txt.receiverToken) {
          continue;
        }

        finish(
          mapResolvedNearbyService({
            name: instanceName,
            host,
            port,
            txt,
          }),
        );
        return;
      }
    });

    child.on("error", () => {
      finish(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

async function discoverNearbyReceivers(timeoutMs: number) {
  return await new Promise<DiscoveryRecord[]>((resolve, reject) => {
    const child = spawn("dns-sd", ["-B", LOCAL_TRANSFER_SERVICE_TYPE, LOCAL_TRANSFER_SERVICE_DOMAIN], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const resolvedRecords = new Map<string, DiscoveryRecord>();
    const resolving = new Set<string>();
    let buffered = "";

    async function maybeResolveInstance(instanceName: string) {
      if (resolving.has(instanceName)) {
        return;
      }

      resolving.add(instanceName);
      const record = await resolveBonjourService(instanceName, Math.min(3000, timeoutMs));
      resolving.delete(instanceName);

      if (record) {
        resolvedRecords.set(record.sessionId, record);
      }
    }

    const timer = setTimeout(() => {
      child.kill("SIGINT");
      resolve(
        Array.from(resolvedRecords.values()).sort((left, right) => left.deviceName.localeCompare(right.deviceName)),
      );
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      buffered += chunk.toString("utf8");
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.includes(" Add ")) {
          continue;
        }

        const match = line.match(/_filetransfer\._tcp\.\s+(.+)$/);
        const instanceName = match?.[1]?.trim();
        if (!instanceName) {
          continue;
        }

        void maybeResolveInstance(instanceName);
      }
    });

    child.stderr.on("data", (chunk) => {
      const message = chunk.toString("utf8").trim();
      if (message) {
        reject(new Error(message));
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function parseDiscoveryInput(raw: string): DiscoveryRecord {
  try {
    return parseDiscoveryQrPayload(raw);
  } catch {
    // Fall through to broader JSON parsing.
  }

  const parsed = JSON.parse(raw) as
    | DiscoveryRecord
    | {
        discoveryRecord?: DiscoveryRecord;
        sessionId?: string;
        host?: string;
        port?: number;
        token?: string;
        deviceName?: string;
        advertisedAt?: string;
        serviceName?: string | null;
        method?: string;
      };

  if ("discoveryRecord" in parsed && parsed.discoveryRecord) {
    return {
      ...parsed.discoveryRecord,
      method: parsed.discoveryRecord.method === "nearby" ? "nearby" : "qr",
    };
  }

  if (!parsed.sessionId || !parsed.host || typeof parsed.port !== "number" || !parsed.token || !parsed.deviceName) {
    throw new Error("Target payload is missing discovery fields.");
  }

  return {
    sessionId: parsed.sessionId,
    method: parsed.method === "nearby" ? "nearby" : "qr",
    deviceName: parsed.deviceName,
    host: parsed.host,
    port: parsed.port,
    token: parsed.token,
    advertisedAt: parsed.advertisedAt ?? nowIso(),
    serviceName: parsed.serviceName ?? null,
  };
}

async function resolveTargetRecord(options: SendCommandOptions) {
  if (options.targetQr) {
    return parseDiscoveryQrPayload(options.targetQr);
  }

  if (options.targetFile) {
    return parseDiscoveryInput(await readFile(options.targetFile, "utf8"));
  }

  const records = await discoverNearbyReceivers(options.discoverTimeoutMs);
  const matched = records.filter((record) => matchTarget(record, options.targetName, options.targetSessionId));

  if (matched.length === 0) {
    throw new Error("No nearby receiver matched the requested target.");
  }

  if (matched.length > 1 && !options.targetName && !options.targetSessionId) {
    throw new Error("Multiple nearby receivers were found. Re-run with --target-name or --target-session-id.");
  }

  return matched[0]!;
}

async function startNearbyAdvertisement({
  serviceName,
  port,
  discoveryRecord,
}: {
  serviceName: string;
  port: number;
  discoveryRecord: DiscoveryRecord;
}) {
  const child = spawn(
    "dns-sd",
    [
      "-R",
      serviceName,
      LOCAL_TRANSFER_SERVICE_TYPE,
      LOCAL_TRANSFER_SERVICE_DOMAIN,
      String(port),
      `sessionId=${discoveryRecord.sessionId}`,
      `receiverToken=${discoveryRecord.token}`,
      `deviceName=${discoveryRecord.deviceName}`,
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  child.stderr.on("data", (chunk) => {
    const message = chunk.toString("utf8").trim();
    if (message) {
      logLine(`dns-sd stderr: ${message}`);
    }
  });

  await sleep(400);

  return {
    stop() {
      child.kill("SIGINT");
    },
  };
}

async function startHttpServer(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
  const server = createServer((request, response) => {
    void handler(request, response).catch((error) => {
      sendJson(response, 500, {
        error: error instanceof Error ? error.message : "Internal server error.",
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(LOCAL_HTTP_SERVER_PORT, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });

  return server;
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function postJsonWithTimeout({ url, token, body }: { url: string; token: string; body: unknown }) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

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
  destination: string;
  signal: AbortSignal;
  onBytes: (value: number) => void;
}) {
  const stream = createWriteStream(destination);

  try {
    if (!response.body) {
      const payload = Buffer.from(await response.arrayBuffer());
      if (signal.aborted) {
        throw new Error("Download canceled.");
      }
      stream.write(payload);
      onBytes(payload.byteLength);
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

      stream.write(Buffer.from(value));
      onBytes(value.byteLength);
    }
  } finally {
    await new Promise<void>((resolve) => {
      stream.end(() => resolve());
    });
  }
}

async function receiveDirectHttpTransfer({
  offer,
  outputDir,
  signal,
  onProgress,
}: {
  offer: IncomingTransferOffer;
  outputDir: string;
  signal: AbortSignal;
  onProgress?: (progress: TransferProgress) => void;
}) {
  await ensureDirectory(outputDir);
  const manifest = await fetchDownloadableManifest({
    peer: offer.sender,
    offer,
    signal,
  });

  const createdFiles: string[] = [];
  const receivedFiles: ReceivedFileOutput[] = [];
  let bytesTransferred = 0;

  try {
    for (const file of manifest.files) {
      const outputPath = createOutputPath(outputDir, file.name);
      createdFiles.push(outputPath);
      const startedAt = Date.now();
      let fileBytesTransferred = 0;

      onProgress?.({
        phase: "transferring",
        totalBytes: offer.totalBytes,
        bytesTransferred,
        currentFileName: file.name,
        speedBytesPerSecond: 0,
        detail: "Downloading files over local WiFi.",
        updatedAt: nowIso(),
      });

      const response = await fetch(file.downloadUrl, {
        headers: {
          [DIRECT_TOKEN_HEADER]: offer.sender.token,
        },
        signal,
      });

      if (!response.ok) {
        throw new Error(`Unable to download "${file.name}" (${response.status}).`);
      }

      await streamResponseToFile({
        response,
        destination: outputPath,
        signal,
        onBytes: (chunkBytes) => {
          fileBytesTransferred += chunkBytes;
          bytesTransferred += chunkBytes;
          const elapsedMilliseconds = Math.max(Date.now() - startedAt, 1);
          const speedBytesPerSecond = Math.round((fileBytesTransferred / elapsedMilliseconds) * 1000);

          onProgress?.({
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
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        outputPath,
      });
    }
  } catch (error) {
    for (const outputPath of createdFiles) {
      await stat(outputPath).then(() => unlink(outputPath)).catch(() => {});
    }

    if (error instanceof Error && error.message === "Download canceled.") {
      throw new Error("Transfer canceled.", {
        cause: error,
      });
    }

    throw error;
  }

  return {
    receivedFiles,
    bytesTransferred,
    detail: "Transfer complete.",
  };
}

async function runReceiveCommand(options: ReceiveCommandOptions) {
  const sessionId = randomUUID();
  const receiverToken = randomToken();
  const host = getPreferredLanAddress();
  if (!host) {
    throw new Error("No usable local WiFi address was found on this Mac.");
  }

  const discoveryRecord = createDiscoveryRecord({
    sessionId,
    method: options.nearby ? "nearby" : "qr",
    deviceName: options.deviceName,
    host,
    port: LOCAL_HTTP_SERVER_PORT,
    token: receiverToken,
    serviceName: options.nearby ? createServiceName(options.deviceName, sessionId) : null,
  });

  const state: ReceiveServiceState = {
    mode: "receive",
    deviceName: options.deviceName,
    outputDir: options.outputDir,
    startedAt: nowIso(),
    discoveryRecord,
    qrPayload: createDiscoveryQrPayload({
      ...discoveryRecord,
      method: "qr",
      serviceName: null,
    }),
    nearbyAdvertising: false,
    currentStatus: "discoverable",
    currentOffer: null,
    progress: createProgress(0, "discoverable", "Ready to receive files."),
    lastTransfer: null,
  };

  let isBusy = false;
  let shutdownRequested = false;
  let activeProcessPromise: Promise<void> | null = null;
  let activeDownloadAbortController: AbortController | null = null;
  let nearbyAdvertisement: { stop(): void } | null = null;

  async function persistState() {
    await writeStateFile(options.stateFile, state);
  }

  function updateProgress(progress: TransferProgress) {
    state.progress = progress;
    state.currentStatus =
      progress.phase === "waiting"
        ? "waiting"
        : progress.phase === "connecting"
          ? "connecting"
          : progress.phase === "transferring"
            ? "transferring"
            : "discoverable";
    void persistState();
  }

  function resetToDiscoverable(detail = "Ready to receive files.") {
    isBusy = false;
    state.currentOffer = null;
    state.currentStatus = "discoverable";
    state.progress = createProgress(0, "discoverable", detail);
    activeDownloadAbortController = null;
    void persistState();
  }

  async function notifySender(event: ReceiverToSenderEvent) {
    if (!state.currentOffer) {
      return;
    }

    await postDirectEvent(state.currentOffer.sender, event);
  }

  function createProgressReporter() {
    let lastSentAt = 0;
    let lastSentBytes = 0;

    return (progress: TransferProgress, force = false) => {
      updateProgress(progress);

      if (!state.currentOffer) {
        return;
      }

      const now = Date.now();
      const shouldSend =
        force ||
        progress.phase === "completed" ||
        progress.phase === "failed" ||
        progress.bytesTransferred === progress.totalBytes ||
        progress.bytesTransferred - lastSentBytes >= 128 * 1024 ||
        now - lastSentAt >= 250;

      if (!shouldSend) {
        return;
      }

      lastSentAt = now;
      lastSentBytes = progress.bytesTransferred;
      void notifySender({
        kind: "progress",
        progress,
      }).catch(() => {});
    };
  }

  async function handleIncomingOffer(offer: IncomingTransferOffer) {
    isBusy = true;
    state.currentOffer = offer;
    updateProgress({
      phase: "waiting",
      totalBytes: offer.totalBytes,
      bytesTransferred: 0,
      currentFileName: null,
      speedBytesPerSecond: 0,
      detail: `${offer.senderDeviceName} wants to send ${offer.fileCount} file${offer.fileCount === 1 ? "" : "s"}.`,
      updatedAt: nowIso(),
    });

    if (options.verbose) {
      logLine(
        `Incoming offer from ${offer.senderDeviceName}: ${offer.fileCount} file(s), ${Math.round(offer.totalBytes / 1024)} KB`,
      );
    }

    if (options.acceptDelayMs > 0) {
      await sleep(options.acceptDelayMs);
    }

    await notifySender({
      kind: "accepted",
      receiverDeviceName: options.deviceName,
    });

    activeDownloadAbortController = new AbortController();

    try {
      const result = await receiveDirectHttpTransfer({
        offer,
        outputDir: options.outputDir,
        signal: activeDownloadAbortController.signal,
        onProgress: createProgressReporter(),
      });

      state.lastTransfer = {
        startedAt: offer.createdAt,
        completedAt: nowIso(),
        outcome: "completed",
        detail: result.detail,
        bytesTransferred: result.bytesTransferred,
        fileCount: result.receivedFiles.length,
        files: result.receivedFiles,
      };

      await notifySender({
        kind: "completed",
        detail: result.detail,
      }).catch(() => {});

      if (options.verbose) {
        logLine(`Received ${result.receivedFiles.length} file(s) from ${offer.senderDeviceName}.`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "The transfer could not be completed.";
      state.lastTransfer = {
        startedAt: offer.createdAt,
        completedAt: nowIso(),
        outcome: "failed",
        detail,
        bytesTransferred: state.progress.bytesTransferred,
        fileCount: 0,
        files: [],
      };

      await notifySender({
        kind: "failed",
        message: detail,
      }).catch(() => {});

      if (options.verbose) {
        logLine(`Receive failed: ${detail}`);
      }
    } finally {
      activeDownloadAbortController = null;
      await persistState();
      if (options.once) {
        shutdownRequested = true;
      } else {
        resetToDiscoverable();
      }
    }
  }

  const server = await startHttpServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}:${LOCAL_HTTP_SERVER_PORT}`);
    const pathSegments = url.pathname.split("/").filter(Boolean);
    const method = request.method?.toUpperCase() ?? "GET";

    if (pathSegments[0] !== "direct" || pathSegments[1] !== "sessions" || pathSegments[2] !== sessionId) {
      sendText(response, 404, "Not found.");
      return;
    }

    if (getHeader(request, DIRECT_TOKEN_HEADER) !== receiverToken) {
      sendJson(response, 401, {
        error: "Unauthorized direct transfer request.",
      });
      return;
    }

    if (pathSegments[3] === "offers" && method === "POST") {
      if (isBusy) {
        sendJson(response, 409, {
          error: "That receiver is busy right now.",
        });
        return;
      }

      const payload = await readJsonBody<{ offer: IncomingTransferOffer }>(request);
      sendJson(response, 200, {
        ok: true,
      });

      activeProcessPromise = handleIncomingOffer(payload.offer);
      void activeProcessPromise.finally(() => {
        activeProcessPromise = null;
      });
      return;
    }

    if (pathSegments[3] === "events" && method === "POST") {
      const payload = await readJsonBody<{ event: SenderToReceiverEvent }>(request);
      const detail = payload.event.message || "Sender stopped the transfer.";

      if (state.currentStatus === "waiting") {
        resetToDiscoverable(detail);
      } else if (state.currentStatus === "connecting" || state.currentStatus === "transferring") {
        activeDownloadAbortController?.abort();
      }

      sendJson(response, 200, {
        ok: true,
      });
      return;
    }

    sendEmpty(response, 405, {
      Allow: "POST",
    });
  });

  if (options.nearby && discoveryRecord.serviceName) {
    nearbyAdvertisement = await startNearbyAdvertisement({
      serviceName: discoveryRecord.serviceName,
      port: LOCAL_HTTP_SERVER_PORT,
      discoveryRecord,
    });
    state.nearbyAdvertising = true;
  }

  await persistState();
  logLine(`Receiver listening on http://${host}:${LOCAL_HTTP_SERVER_PORT} (${discoveryRecord.sessionId})`);

  const shutdown = async () => {
    const offer = state.currentOffer;
    if (offer) {
      const event: ReceiverToSenderEvent =
        state.currentStatus === "waiting"
          ? {
              kind: "rejected",
              message: "Receiver is no longer available.",
            }
          : {
              kind: "canceled",
              message: "Receiver canceled the transfer.",
            };
      await postDirectEvent(offer.sender, event).catch(() => {});
    }

    activeDownloadAbortController?.abort();
    nearbyAdvertisement?.stop();
    await closeServer(server).catch(() => {});
  };

  process.once("SIGINT", () => {
    shutdownRequested = true;
  });
  process.once("SIGTERM", () => {
    shutdownRequested = true;
  });

  while (!shutdownRequested) {
    await sleep(250);
  }

  const activePromise = activeProcessPromise;
  if (activePromise) {
    try {
      await activePromise;
    } catch {
      // Ignore transfer errors while shutting down.
    }
  }

  await shutdown();
}

async function runSendCommand(options: SendCommandOptions) {
  const files = await buildSelectedFiles(options.filePaths);
  const target = await resolveTargetRecord(options);
  const host = getPreferredLanAddress();
  if (!host) {
    throw new Error("No usable local WiFi address was found on this Mac.");
  }

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

  const sessionId = randomUUID();
  const manifest = createTransferManifest({
    files,
    deviceName: options.deviceName,
    sessionId,
  });
  const direct: DirectPeerAccess = {
    sessionId,
    host,
    port: LOCAL_HTTP_SERVER_PORT,
    token: randomToken(),
  };
  const state: SendState = {
    mode: "send",
    deviceName: options.deviceName,
    target: resolvedTarget,
    startedAt: nowIso(),
    progress: createProgress(manifest.totalBytes, "waiting", `Waiting for ${resolvedTarget.deviceName} to accept.`),
  };

  let settled = false;
  let offerDelivered = false;
  const resultDeferred = createDeferred<string>();

  function settleSuccess(detail: string) {
    if (settled) {
      return;
    }
    settled = true;
    resultDeferred.resolve(detail);
  }

  function settleFailure(detail: string) {
    if (settled) {
      return;
    }
    settled = true;
    resultDeferred.reject(new Error(detail));
  }

  async function setProgress(progress: TransferProgress) {
    state.progress = progress;
    await writeStateFile(options.stateFile, state);
  }

  const server = await startHttpServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}:${LOCAL_HTTP_SERVER_PORT}`);
    const pathSegments = url.pathname.split("/").filter(Boolean);
    const method = request.method?.toUpperCase() ?? "GET";

    if (pathSegments[0] !== "direct" || pathSegments[1] !== "sessions" || pathSegments[2] !== sessionId) {
      sendText(response, 404, "Not found.");
      return;
    }

    if (getHeader(request, DIRECT_TOKEN_HEADER) !== direct.token) {
      sendJson(response, 401, {
        error: "Unauthorized direct transfer request.",
      });
      return;
    }

    if (pathSegments[3] === "events" && method === "POST") {
      const payload = await readJsonBody<{ event: ReceiverToSenderEvent }>(request);
      const event = payload.event;

      if (event.kind === "accepted") {
        const receiverName = event.receiverDeviceName.trim() ? event.receiverDeviceName : resolvedTarget.deviceName;
        await setProgress({
          phase: "connecting",
          totalBytes: manifest.totalBytes,
          bytesTransferred: state.progress.bytesTransferred,
          currentFileName: null,
          speedBytesPerSecond: 0,
          detail: `Waiting for ${receiverName} to download files over local WiFi.`,
          updatedAt: nowIso(),
        });
      } else if (event.kind === "progress") {
        await setProgress(event.progress);
      } else if (event.kind === "completed") {
        settleSuccess(event.detail ?? "Transfer complete.");
      } else if (event.kind === "rejected") {
        settleFailure(event.message || "Transfer declined.");
      } else {
        settleFailure(event.message || "Transfer stopped.");
      }

      sendJson(response, 200, {
        ok: true,
      });
      return;
    }

    if (pathSegments[3] === "manifest" && ["GET", "HEAD"].includes(method)) {
      const manifestPayload: DownloadableTransferManifest = {
        version: 1,
        kind: "direct-http-transfer",
        sessionId,
        deviceName: options.deviceName,
        startedAt: manifest.createdAt,
        shareUrl: buildDirectSessionBaseUrl(direct),
        totalBytes: manifest.totalBytes,
        files: files.map((file) => ({
          id: file.id,
          name: file.name,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          downloadUrl: buildDirectSessionUrl(
            direct,
            `/files/${encodeURIComponent(file.id)}/${encodeURIComponent(safeName(file.name))}`,
          ),
        })),
      };
      sendJson(response, 200, manifestPayload);
      return;
    }

    if (pathSegments[3] === "files" && pathSegments[4] && ["GET", "HEAD"].includes(method)) {
      const file = files.find((candidate) => candidate.id === decodeURIComponent(pathSegments[4] ?? ""));
      if (!file) {
        sendText(response, 404, "File not found.");
        return;
      }

      await sendFile(response, file, method);
      return;
    }

    sendEmpty(response, 405, {
      Allow: "GET, HEAD, POST",
    });
  });

  const shutdown = async () => {
    if (!settled && offerDelivered) {
      await postDirectEvent(
        {
          sessionId: resolvedTarget.sessionId,
          host: resolvedTarget.host,
          port: resolvedTarget.port,
          token: resolvedTarget.token,
        },
        {
          kind: "canceled",
          message: "Sender canceled the transfer.",
        },
      ).catch(() => {});
    }
    await closeServer(server).catch(() => {});
  };

  process.once("SIGINT", () => {
    settleFailure("Sender canceled the transfer.");
  });
  process.once("SIGTERM", () => {
    settleFailure("Sender canceled the transfer.");
  });

  try {
    await writeStateFile(options.stateFile, state);
    await postIncomingOffer(resolvedTarget, createIncomingTransferOffer({ manifest, direct }));
    offerDelivered = true;
    logLine(`Offer sent to ${resolvedTarget.deviceName}.`);
    const detail = await resultDeferred.promise;
    logLine(detail);
  } finally {
    await shutdown();
  }
}

function buildLaunchAgentPlist(options: LaunchAgentOptions) {
  const command = [
    "pnpm",
    "macos:device",
    "receive",
    "--name",
    options.deviceName,
    "--output-dir",
    options.outputDir,
    ...(options.stateFile ? ["--state-file", options.stateFile] : []),
    "--accept-delay-ms",
    String(options.acceptDelayMs),
    ...(options.nearby ? [] : ["--no-nearby"]),
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${options.label}</string>
    <key>WorkingDirectory</key>
    <string>${REPO_ROOT}</string>
    <key>ProgramArguments</key>
    <array>
${command.map((value) => `      <string>${value}</string>`).join("\n")}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${path.join(REPO_ROOT, "tmp/macos-device.stdout.log")}</string>
    <key>StandardErrorPath</key>
    <string>${path.join(REPO_ROOT, "tmp/macos-device.stderr.log")}</string>
  </dict>
</plist>`;
}

function printHelp() {
  console.log(`Usage:
  pnpm macos:device receive [options]
  pnpm macos:device send [options]
  pnpm macos:device discover [--timeout-ms <ms>] [--json]
  pnpm macos:device print-launch-agent [options]

Receive options:
  --name <device-name>
  --output-dir <dir>
  --state-file <path>
  --accept-delay-ms <ms>
  --no-nearby
  --once
  --verbose

Send options:
  --name <device-name>
  --file <path> (repeat)
  --target-name <device-or-service-name>
  --target-session-id <id>
  --target-file <path>
  --target-qr <json>
  --discover-timeout-ms <ms>
  --state-file <path>
  --verbose`);
}

async function main() {
  const [, , command, ...rest] = process.argv;
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  const parsed = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      name: {
        type: "string",
      },
      "output-dir": {
        type: "string",
      },
      "state-file": {
        type: "string",
      },
      "accept-delay-ms": {
        type: "string",
      },
      nearby: {
        type: "boolean",
      },
      "no-nearby": {
        type: "boolean",
      },
      once: {
        type: "boolean",
      },
      verbose: {
        type: "boolean",
      },
      file: {
        type: "string",
        multiple: true,
      },
      "target-name": {
        type: "string",
      },
      "target-session-id": {
        type: "string",
      },
      "target-file": {
        type: "string",
      },
      "target-qr": {
        type: "string",
      },
      "discover-timeout-ms": {
        type: "string",
      },
      "timeout-ms": {
        type: "string",
      },
      json: {
        type: "boolean",
      },
      label: {
        type: "string",
      },
    },
    strict: false,
  });

  const values = parsed.values;
  const readString = (value: string | boolean | undefined) => (typeof value === "string" ? value : null);
  const readStringList = (value: Array<string | boolean> | undefined) =>
    (value?.filter((entry): entry is string => typeof entry === "string") ?? []);
  const readBoolean = (value: string | boolean | undefined) => value === true;

  const nearby = readBoolean(values["no-nearby"]) ? false : !("nearby" in values) || readBoolean(values.nearby);

  if (command === "discover") {
    const timeoutMs = Number(readString(values["timeout-ms"]) ?? DEFAULT_DISCOVER_TIMEOUT_MS);
    const records = await discoverNearbyReceivers(timeoutMs);

    if (readBoolean(values.json)) {
      console.log(JSON.stringify(records, null, 2));
      return;
    }

    if (records.length === 0) {
      console.log("No nearby receivers found.");
      return;
    }

    for (const record of records) {
      console.log(`${record.deviceName}  ${record.host}:${record.port}  ${record.sessionId}`);
    }
    return;
  }

  if (command === "receive") {
    const deviceName = readString(values.name);
    const outputDir = readString(values["output-dir"]);
    if (!deviceName || !outputDir) {
      throw new Error("receive requires --name and --output-dir.");
    }

    await runReceiveCommand({
      deviceName,
      outputDir,
      stateFile: readString(values["state-file"]),
      acceptDelayMs: Number(readString(values["accept-delay-ms"]) ?? 0),
      nearby,
      once: readBoolean(values.once),
      verbose: readBoolean(values.verbose),
    });
    return;
  }

  if (command === "send") {
    const deviceName = readString(values.name);
    if (!deviceName) {
      throw new Error("send requires --name.");
    }

    await runSendCommand({
      deviceName,
      filePaths: readStringList(values.file),
      targetQr: readString(values["target-qr"]),
      targetFile: readString(values["target-file"]),
      targetName: readString(values["target-name"]),
      targetSessionId: readString(values["target-session-id"]),
      discoverTimeoutMs: Number(readString(values["discover-timeout-ms"]) ?? DEFAULT_DISCOVER_TIMEOUT_MS),
      stateFile: readString(values["state-file"]),
      verbose: readBoolean(values.verbose),
    });
    return;
  }

  if (command === "print-launch-agent") {
    const deviceName = readString(values.name);
    const outputDir = readString(values["output-dir"]);
    if (!deviceName || !outputDir) {
      throw new Error("print-launch-agent requires --name and --output-dir.");
    }

    console.log(
      buildLaunchAgentPlist({
        deviceName,
        outputDir,
        stateFile: readString(values["state-file"]),
        acceptDelayMs: Number(readString(values["accept-delay-ms"]) ?? 0),
        nearby,
        label: readString(values.label) ?? "com.filetransfers.macos-device",
      }),
    );
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
