import "dotenv/config";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type {
  DirectPeerAccess,
  DiscoveryRecord,
  DownloadableTransferManifest,
  IncomingTransferOffer,
  RelayAccess,
  RelayCredentials,
  SelectedTransferFile,
  SenderTransferAccess,
  TransferManifest,
  TransferManifestFile,
  TransferProgress,
} from "../lib/file-transfer/types";

type TransportMode = "auto" | "direct" | "relay";

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

interface RelaySessionState {
  id: string;
  receiverDeviceName: string | null;
  status: "waiting_receiver" | "accepted" | "uploading" | "ready" | "rejected" | "completed" | "expired";
  fileCount: number;
  totalBytes: number;
  files: Array<{
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    uploaded: boolean;
  }>;
  expiresAt: string;
}

interface ReceiveCommandOptions {
  apiUrl: string;
  deviceName: string;
  outputDir: string;
  stateFile: string | null;
  acceptDelayMs: number;
  transport: TransportMode;
  nearby: boolean;
  once: boolean;
  verbose: boolean;
}

interface SendCommandOptions {
  apiUrl: string;
  deviceName: string;
  transport: TransportMode;
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
  apiUrl: string;
  deviceName: string;
  outputDir: string;
  stateFile: string | null;
  acceptDelayMs: number;
  transport: TransportMode;
  nearby: boolean;
  label: string;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface ReceiveServiceState {
  mode: "receive";
  deviceName: string;
  transport: TransportMode;
  apiUrl: string;
  outputDir: string;
  startedAt: string;
  discoveryRecord: DiscoveryRecord;
  qrPayload: string;
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
    files: Array<{
      id: string;
      name: string;
      mimeType: string;
      sizeBytes: number;
      outputPath: string;
    }>;
  };
}

interface SendState {
  mode: "send";
  deviceName: string;
  transport: TransportMode;
  target: DiscoveryRecord;
  startedAt: string;
  progress: TransferProgress;
  relay: RelayAccess | null;
}

interface ReceivedFileOutput {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  outputPath: string;
}

interface DirectOfferResponse {
  accepted: boolean;
  message?: string;
  statusCode?: number;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_TRANSFER_SERVICE_TYPE = "_filetransfer._tcp";
const LOCAL_TRANSFER_SERVICE_DOMAIN = "local.";
const LOCAL_HTTP_SERVER_PORT = 41000;
const RELAY_POLL_INTERVAL_MS = 1500;
const REQUEST_TIMEOUT_MS = 8000;
const DEFAULT_API_URL = "http://127.0.0.1:3001";
const DEFAULT_DISCOVER_TIMEOUT_MS = 5000;
const DIRECT_TOKEN_HEADER = "x-direct-token";
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

function nowIso() {
  return new Date().toISOString();
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function randomToken() {
  return randomBytes(16).toString("hex");
}

function safeName(value: string) {
  return value.replace(/[^\w.\-() ]+/g, "_");
}

function logLine(message: string) {
  console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
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

function getPreferredLanAddress() {
  const interfaces = networkInterfaces();
  const preferred = ["en0", "bridge0", "en1", "en2"];

  for (const name of preferred) {
    const candidates = interfaces[name];
    const address = candidates?.find(
      (candidate) =>
        candidate.family === "IPv4" &&
        !candidate.internal &&
        !candidate.address.startsWith("169.254.") &&
        candidate.netmask !== "255.255.255.255",
    );

    if (address) {
      return address.address;
    }
  }

  for (const candidates of Object.values(interfaces)) {
    const address = candidates?.find(
      (candidate) =>
        candidate.family === "IPv4" &&
        !candidate.internal &&
        !candidate.address.startsWith("169.254.") &&
        candidate.netmask !== "255.255.255.255",
    );

    if (address) {
      return address.address;
    }
  }

  return "127.0.0.1";
}

function getUsableLanHost(value: string | null | undefined) {
  const normalized = normalizeIpv4Address(value);
  if (!normalized) {
    return null;
  }

  return isPrivateIpv4Address(normalized) ? normalized : null;
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

function createDiscoveryRecord({
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
  return JSON.stringify({
    version: 1,
    sessionId: record.sessionId,
    host: record.host,
    port: record.port,
    token: record.token,
    deviceName: record.deviceName,
    advertisedAt: record.advertisedAt,
  });
}

function createServiceName(deviceName: string, sessionId: string) {
  return `${deviceName.trim().slice(0, 24)}-${sessionId.slice(0, 6)}`;
}

function createOutputPath(directory: string, fileName: string) {
  return path.join(directory, `${Date.now()}-${safeName(fileName)}`);
}

function inferMimeType(filePath: string) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

async function ensureDirectory(directory: string) {
  await mkdir(directory, { recursive: true });
}

async function writeStateFile(stateFile: string | null, snapshot: unknown) {
  if (!stateFile) {
    return;
  }

  await ensureDirectory(path.dirname(stateFile));
  await writeFile(stateFile, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
}

async function buildSelectedFiles(filePaths: string[]) {
  const files: SelectedTransferFile[] = [];

  for (const inputPath of filePaths) {
    const absolutePath = path.resolve(process.cwd(), inputPath);
    const metadata = await stat(absolutePath);
    if (!metadata.isFile()) {
      throw new Error(`${absolutePath} is not a file.`);
    }

    files.push({
      id: randomUUID(),
      name: path.basename(absolutePath),
      uri: absolutePath,
      mimeType: inferMimeType(absolutePath),
      sizeBytes: metadata.size,
    });
  }

  return files;
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function getHeader(request: IncomingMessage, headerName: string) {
  const value = request.headers[headerName.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

function buildDirectSessionUrl(peer: Pick<DirectPeerAccess, "host" | "port" | "sessionId">, suffix: string) {
  return `http://${peer.host}:${peer.port}/direct/sessions/${encodeURIComponent(peer.sessionId)}${suffix}`;
}

function buildDirectSessionBaseUrl(peer: Pick<DirectPeerAccess, "host" | "port" | "sessionId">) {
  return `http://${peer.host}:${peer.port}/direct/sessions/${encodeURIComponent(peer.sessionId)}/`;
}

async function readJsonBody<T>(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf8");
  if (!body.trim()) {
    throw new Error("Missing JSON request body.");
  }

  return JSON.parse(body) as T;
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown) {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.byteLength),
  });
  response.end(payload);
}

function sendText(
  response: ServerResponse,
  statusCode: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
) {
  const payload = Buffer.from(body, "utf8");
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": contentType,
    "content-length": String(payload.byteLength),
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

        finish({
          sessionId: txt.sessionId,
          method: "nearby",
          deviceName: txt.deviceName ?? instanceName,
          host,
          port,
          token: txt.receiverToken,
          advertisedAt: nowIso(),
          serviceName: instanceName,
        });
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
      };

  if ("discoveryRecord" in parsed && parsed.discoveryRecord) {
    return parsed.discoveryRecord;
  }

  if (!parsed.sessionId || !parsed.host || typeof parsed.port !== "number" || !parsed.token || !parsed.deviceName) {
    throw new Error("Target payload is missing discovery fields.");
  }

  return {
    sessionId: parsed.sessionId,
    method: "method" in parsed && parsed.method ? parsed.method : "qr",
    deviceName: parsed.deviceName,
    host: parsed.host,
    port: parsed.port,
    token: parsed.token,
    advertisedAt: parsed.advertisedAt ?? nowIso(),
    serviceName: parsed.serviceName ?? null,
  } satisfies DiscoveryRecord;
}

async function resolveTargetRecord(
  options: Pick<SendCommandOptions, "targetQr" | "targetFile" | "targetName" | "targetSessionId" | "discoverTimeoutMs">,
) {
  if (options.targetQr) {
    return parseDiscoveryInput(options.targetQr);
  }

  if (options.targetFile) {
    return parseDiscoveryInput(await readFile(path.resolve(process.cwd(), options.targetFile), "utf8"));
  }

  const discovered = await discoverNearbyReceivers(options.discoverTimeoutMs);
  const matches = discovered.filter((record) => matchTarget(record, options.targetName, options.targetSessionId));

  if (matches.length === 1) {
    return matches[0];
  }

  if (!matches.length) {
    throw new Error("No nearby receiver matched the requested target.");
  }

  throw new Error(
    `Multiple nearby receivers matched: ${matches.map((record) => `${record.deviceName} (${record.sessionId})`).join(", ")}`,
  );
}

function relayUrl(apiUrl: string, route: string) {
  return `${trimTrailingSlash(apiUrl)}${route}`;
}

async function parseRelayResponse<T>(response: Response) {
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Relay request failed with status ${response.status}.`);
  }

  return (await response.json()) as T;
}

async function createRelayTransferSession(apiUrl: string, senderDeviceName: string, files: SelectedTransferFile[]) {
  const response = await fetch(relayUrl(apiUrl, "/relay/sessions"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      senderDeviceName,
      files: files.map((file) => ({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
      })),
    }),
  });

  const payload = await parseRelayResponse<{
    session: RelaySessionState;
    senderToken: string;
    receiverToken: string;
  }>(response);

  return {
    sessionId: payload.session.id,
    senderToken: payload.senderToken,
    receiverToken: payload.receiverToken,
    expiresAt: payload.session.expiresAt,
  } satisfies RelayCredentials;
}

async function getRelaySenderState(apiUrl: string, relay: RelayCredentials) {
  const response = await fetch(relayUrl(apiUrl, `/relay/sessions/${relay.sessionId}/sender`), {
    headers: {
      "x-relay-token": relay.senderToken,
    },
  });

  return parseRelayResponse<RelaySessionState>(response);
}

async function getRelayReceiverState(apiUrl: string, relay: RelayAccess) {
  const response = await fetch(relayUrl(apiUrl, `/relay/sessions/${relay.sessionId}/receiver`), {
    headers: {
      "x-relay-token": relay.receiverToken,
    },
  });

  return parseRelayResponse<RelaySessionState>(response);
}

async function acceptRelayTransferSession(apiUrl: string, relay: RelayAccess, receiverDeviceName: string) {
  const response = await fetch(relayUrl(apiUrl, `/relay/sessions/${relay.sessionId}/accept`), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-relay-token": relay.receiverToken,
    },
    body: JSON.stringify({
      receiverDeviceName,
    }),
  });

  return parseRelayResponse<RelaySessionState>(response);
}

async function declineRelayTransferSession(apiUrl: string, relay: RelayAccess) {
  const response = await fetch(relayUrl(apiUrl, `/relay/sessions/${relay.sessionId}/decline`), {
    method: "POST",
    headers: {
      "x-relay-token": relay.receiverToken,
    },
  });

  return parseRelayResponse<RelaySessionState>(response);
}

async function completeRelayTransferSession(apiUrl: string, relay: RelayAccess) {
  const response = await fetch(relayUrl(apiUrl, `/relay/sessions/${relay.sessionId}/complete`), {
    method: "POST",
    headers: {
      "x-relay-token": relay.receiverToken,
    },
  });

  return parseRelayResponse<RelaySessionState>(response);
}

async function deleteRelayTransferSession(apiUrl: string, relay: RelayCredentials) {
  const response = await fetch(relayUrl(apiUrl, `/relay/sessions/${relay.sessionId}`), {
    method: "DELETE",
    headers: {
      "x-relay-token": relay.senderToken,
    },
  });

  if (response.status === 204) {
    return;
  }

  await parseRelayResponse<RelaySessionState>(response);
}

async function uploadRelayTransferFile(apiUrl: string, relay: RelayCredentials, file: SelectedTransferFile) {
  const payload = await readFile(file.uri);
  const response = await fetch(relayUrl(apiUrl, `/relay/sessions/${relay.sessionId}/files/${file.id}`), {
    method: "PUT",
    headers: {
      "content-type": file.mimeType,
      "content-length": String(file.sizeBytes),
      "x-relay-token": relay.senderToken,
    },
    body: payload,
  });

  return parseRelayResponse<RelaySessionState>(response);
}

async function fetchRelayTransferFile(apiUrl: string, relay: RelayAccess, fileId: string) {
  const response = await fetch(relayUrl(apiUrl, `/relay/sessions/${relay.sessionId}/files/${fileId}`), {
    headers: {
      "x-relay-token": relay.receiverToken,
    },
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Relay download failed with status ${response.status}.`);
  }

  return response;
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

async function fetchDownloadableManifest({ peer, offer }: { peer: DirectPeerAccess; offer: IncomingTransferOffer }) {
  const response = await fetch(buildDirectSessionUrl(peer, "/manifest"), {
    headers: {
      [DIRECT_TOKEN_HEADER]: peer.token,
    },
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
  onBytes,
}: {
  response: Response;
  destination: string;
  onBytes: (value: number) => void;
}) {
  const stream = createWriteStream(destination);

  try {
    if (!response.body) {
      const payload = Buffer.from(await response.arrayBuffer());
      stream.write(payload);
      onBytes(payload.byteLength);
      return;
    }

    const reader = response.body.getReader();
    while (true) {
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
    stream.end();
  }
}

async function receiveDirectHttpTransfer({
  offer,
  outputDir,
  onProgress,
}: {
  offer: IncomingTransferOffer;
  outputDir: string;
  onProgress?: (progress: TransferProgress) => void;
}) {
  await ensureDirectory(outputDir);
  const manifest = await fetchDownloadableManifest({
    peer: offer.sender.direct,
    offer,
  });

  const receivedFiles: ReceivedFileOutput[] = [];
  let bytesTransferred = 0;

  for (const file of manifest.files) {
    const outputPath = createOutputPath(outputDir, file.name);
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
        [DIRECT_TOKEN_HEADER]: offer.sender.direct.token,
      },
    });

    if (!response.ok) {
      throw new Error(`Unable to download "${file.name}" (${response.status}).`);
    }

    await streamResponseToFile({
      response,
      destination: outputPath,
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

  return {
    receivedFiles,
    bytesTransferred,
    detail: "Transfer complete.",
  };
}

async function receiveRelayTransfer({
  apiUrl,
  offer,
  deviceName,
  outputDir,
  onProgress,
}: {
  apiUrl: string;
  offer: IncomingTransferOffer;
  deviceName: string;
  outputDir: string;
  onProgress?: (progress: TransferProgress) => void;
}) {
  if (!offer.sender.relay) {
    throw new Error("Relay access is not available for this transfer.");
  }

  await ensureDirectory(outputDir);
  await acceptRelayTransferSession(apiUrl, offer.sender.relay, deviceName);

  let state = await getRelayReceiverState(apiUrl, offer.sender.relay);

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
        state.status === "accepted" ? "Waiting for the sender to prepare relay transfer." : "Connecting through relay.",
      updatedAt: nowIso(),
    });

    await sleep(RELAY_POLL_INTERVAL_MS);
    state = await getRelayReceiverState(apiUrl, offer.sender.relay);
  }

  const receivedFiles: ReceivedFileOutput[] = [];
  let bytesTransferred = 0;

  for (const file of state.files) {
    const outputPath = createOutputPath(outputDir, file.name);
    const startedAt = Date.now();
    let fileBytesTransferred = 0;

    onProgress?.({
      phase: "transferring",
      totalBytes: offer.totalBytes,
      bytesTransferred,
      currentFileName: file.name,
      speedBytesPerSecond: 0,
      detail: "Downloading files through relay.",
      updatedAt: nowIso(),
    });

    const response = await fetchRelayTransferFile(apiUrl, offer.sender.relay, file.id);
    await streamResponseToFile({
      response,
      destination: outputPath,
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
          detail: "Downloading files through relay.",
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

  await completeRelayTransferSession(apiUrl, offer.sender.relay).catch(() => {});

  return {
    receivedFiles,
    bytesTransferred,
    detail: "Transfer complete through relay.",
  };
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

async function runReceiveCommand(options: ReceiveCommandOptions) {
  const sessionId = randomUUID();
  const receiverToken = randomToken();
  const host = getUsableLanHost(getPreferredLanAddress());
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
    transport: options.transport,
    apiUrl: options.apiUrl,
    outputDir: options.outputDir,
    startedAt: nowIso(),
    discoveryRecord,
    qrPayload: buildQrPayload({
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
  let nearbyAdvertisement: { stop(): void } | null = null;
  let shutdownRequested = false;
  let activeProcessPromise: Promise<void> | null = null;
  let pendingRelayReady = createDeferred<IncomingTransferOffer>();

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
    pendingRelayReady = createDeferred<IncomingTransferOffer>();
    void persistState();
  }

  async function notifySender(event: ReceiverToSenderEvent) {
    const offer = state.currentOffer;
    if (!offer) {
      return;
    }

    await postDirectEvent(offer.sender.direct, event);
  }

  function updateOfferRelay(relay: RelayAccess) {
    if (!state.currentOffer) {
      return null;
    }

    state.currentOffer = {
      ...state.currentOffer,
      sender: {
        ...state.currentOffer.sender,
        relay,
      },
    };
    void persistState();
    return state.currentOffer;
  }

  function createProgressReporter(mirrorToSender: boolean) {
    let lastSentAt = 0;
    let lastSentBytes = 0;

    return (progress: TransferProgress, force = false) => {
      updateProgress(progress);

      if (!mirrorToSender || !state.currentOffer) {
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

    try {
      let result: { receivedFiles: ReceivedFileOutput[]; bytesTransferred: number; detail: string };

      if (options.transport === "relay" && offer.sender.relay) {
        result = await receiveRelayTransfer({
          apiUrl: options.apiUrl,
          offer,
          deviceName: options.deviceName,
          outputDir: options.outputDir,
          onProgress: createProgressReporter(false),
        });
      } else if (options.transport === "relay") {
        await notifySender({
          kind: "direct-http-failed",
          message: "Direct transfer disabled for this receiver.",
        });
        const relayOffer = await pendingRelayReady.promise;
        result = await receiveRelayTransfer({
          apiUrl: options.apiUrl,
          offer: relayOffer,
          deviceName: options.deviceName,
          outputDir: options.outputDir,
          onProgress: createProgressReporter(false),
        });
      } else {
        try {
          result = await receiveDirectHttpTransfer({
            offer,
            outputDir: options.outputDir,
            onProgress: createProgressReporter(true),
          });
        } catch (error) {
          if (options.transport !== "auto" || !(error instanceof Error)) {
            throw error;
          }

          await notifySender({
            kind: "direct-http-failed",
            message: error.message,
          });
          const relayOffer = await pendingRelayReady.promise;
          result = await receiveRelayTransfer({
            apiUrl: options.apiUrl,
            offer: relayOffer,
            deviceName: options.deviceName,
            outputDir: options.outputDir,
            onProgress: createProgressReporter(false),
          });
        }
      }

      updateProgress({
        phase: "discoverable",
        totalBytes: 0,
        bytesTransferred: 0,
        currentFileName: null,
        speedBytesPerSecond: 0,
        detail: "Ready to receive files.",
        updatedAt: nowIso(),
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
      updateProgress({
        phase: "discoverable",
        totalBytes: 0,
        bytesTransferred: 0,
        currentFileName: null,
        speedBytesPerSecond: 0,
        detail: "Ready to receive files.",
        updatedAt: nowIso(),
      });
      await notifySender({
        kind: "failed",
        message: detail,
      }).catch(() => {});
      if (options.verbose) {
        logLine(`Receive failed: ${detail}`);
      }
    } finally {
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

    if (pathSegments[3] === "offers" && request.method === "POST") {
      if (isBusy) {
        sendJson(response, 409, {
          error: "That receiver is busy right now.",
        });
        return;
      }

      const payload = await readJsonBody<{ offer: IncomingTransferOffer }>(request);
      const decision: DirectOfferResponse = {
        accepted: true,
      };

      if (!decision.accepted) {
        sendJson(response, decision.statusCode ?? 409, {
          error: decision.message ?? "That receiver is busy right now.",
        });
        return;
      }

      sendJson(response, 200, {
        ok: true,
      });

      activeProcessPromise = handleIncomingOffer(payload.offer);
      void activeProcessPromise.finally(() => {
        activeProcessPromise = null;
      });
      return;
    }

    if (pathSegments[3] === "events" && request.method === "POST") {
      const payload = await readJsonBody<{ event: SenderToReceiverEvent }>(request);
      const event = payload.event;

      if (event.kind === "relay-ready") {
        const nextOffer = updateOfferRelay(event.relay);
        if (nextOffer) {
          pendingRelayReady.resolve(nextOffer);
        }
      } else if (event.kind === "relay-failed") {
        pendingRelayReady.reject(new Error(event.message || "Unable to prepare relay fallback."));
      } else if (event.kind === "failed" || event.kind === "canceled") {
        pendingRelayReady.reject(new Error(event.message || "Sender stopped the transfer."));
        if (options.verbose) {
          logLine(event.message || "Sender stopped the transfer.");
        }
        resetToDiscoverable();
      }

      sendJson(response, 200, {
        ok: true,
      });
      return;
    }

    sendEmpty(response, 405, {
      allow: "POST",
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
    if (state.currentOffer?.sender.relay) {
      await declineRelayTransferSession(options.apiUrl, state.currentOffer.sender.relay).catch(() => {});
    }
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
  const host = getUsableLanHost(getPreferredLanAddress());
  if (!host) {
    throw new Error("No usable local WiFi address was found on this Mac.");
  }

  if (target.port <= 0 || !target.token.trim()) {
    throw new Error("That receiver is no longer available.");
  }

  const sessionId = randomUUID();
  const manifest = createTransferManifest({
    files,
    deviceName: options.deviceName,
    sessionId,
    isPremium: true,
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
    transport: options.transport,
    target,
    startedAt: nowIso(),
    progress: createProgress(manifest.totalBytes, "waiting", `Waiting for ${target.deviceName} to accept.`),
    relay: null,
  };

  let relay: RelayCredentials | null = null;
  let relayUploadStarted = false;
  let relayPollTimer: ReturnType<typeof setInterval> | null = null;
  let settled = false;
  let receiverName = target.deviceName;
  const resultDeferred = createDeferred<{ detail: string }>();

  async function persistState() {
    await writeStateFile(options.stateFile, state);
  }

  function setProgress(progress: TransferProgress) {
    state.progress = progress;
    void persistState();
  }

  async function settleSuccess(detail: string) {
    if (settled) {
      return;
    }
    settled = true;
    if (relayPollTimer) {
      clearInterval(relayPollTimer);
      relayPollTimer = null;
    }
    resultDeferred.resolve({ detail });
  }

  async function settleFailure(error: Error) {
    if (settled) {
      return;
    }
    settled = true;
    if (relayPollTimer) {
      clearInterval(relayPollTimer);
      relayPollTimer = null;
    }
    resultDeferred.reject(error);
  }

  async function handleReceiverEvent(event: ReceiverToSenderEvent) {
    if (settled) {
      return;
    }

    if (event.kind === "accepted") {
      receiverName = event.receiverDeviceName || receiverName;
      setProgress({
        phase: "connecting",
        totalBytes: manifest.totalBytes,
        bytesTransferred: state.progress.bytesTransferred,
        currentFileName: null,
        speedBytesPerSecond: 0,
        detail: `Waiting for ${receiverName} to download files over local WiFi.`,
        updatedAt: nowIso(),
      });

      if (options.transport === "relay") {
        await provisionRelayFallback();
      }
      return;
    }

    if (event.kind === "progress") {
      setProgress(event.progress);
      return;
    }

    if (event.kind === "completed") {
      await settleSuccess(event.detail ?? "Transfer complete.");
      return;
    }

    if (event.kind === "direct-http-failed") {
      if (options.transport === "direct") {
        await settleFailure(new Error(event.message || "Direct transfer failed."));
        return;
      }

      await provisionRelayFallback();
      return;
    }

    await settleFailure(new Error(event.message || "Transfer stopped."));
  }

  async function syncRelaySenderState() {
    if (!relay || settled) {
      return;
    }

    try {
      const relayState = await getRelaySenderState(options.apiUrl, relay);

      if (relayState.status === "accepted" && !relayUploadStarted) {
        relayUploadStarted = true;
        await uploadFilesToRelay({
          apiUrl: options.apiUrl,
          relay,
          files,
          totalBytes: manifest.totalBytes,
          onProgress: (progress) => {
            setProgress(progress);
          },
        });
        setProgress({
          phase: "transferring",
          totalBytes: manifest.totalBytes,
          bytesTransferred: manifest.totalBytes,
          currentFileName: null,
          speedBytesPerSecond: 0,
          detail: "Waiting for the receiver to finish relay download.",
          updatedAt: nowIso(),
        });
        return;
      }

      if (relayState.status === "rejected") {
        await settleFailure(new Error("Relay transfer declined."));
        return;
      }

      if (relayState.status === "completed") {
        await settleSuccess("Transfer complete through relay.");
        return;
      }

      if (relayState.status === "expired") {
        await settleFailure(new Error("This relay transfer expired."));
      }
    } catch (error) {
      if (options.verbose) {
        logLine(`Unable to refresh relay state: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  async function uploadFilesToRelay({
    apiUrl,
    relay,
    files,
    totalBytes,
    onProgress,
  }: {
    apiUrl: string;
    relay: RelayCredentials;
    files: SelectedTransferFile[];
    totalBytes: number;
    onProgress?: (progress: TransferProgress) => void;
  }) {
    let bytesTransferred = 0;

    for (const file of files) {
      const startedAt = Date.now();
      await uploadRelayTransferFile(apiUrl, relay, file);
      bytesTransferred += file.sizeBytes;
      const elapsedMilliseconds = Math.max(Date.now() - startedAt, 1);
      const speedBytesPerSecond = Math.round((file.sizeBytes / elapsedMilliseconds) * 1000);

      onProgress?.({
        phase: "transferring",
        totalBytes,
        bytesTransferred,
        currentFileName: file.name,
        speedBytesPerSecond,
        detail: "Uploading files through relay.",
        updatedAt: nowIso(),
      });
    }
  }

  async function provisionRelayFallback() {
    if (relay) {
      await postDirectEvent(
        {
          sessionId: target.sessionId,
          host: target.host,
          port: target.port,
          token: target.token,
        },
        {
          kind: "relay-ready",
          relay: toRelayAccess(relay)!,
        },
      );
      return;
    }

    relay = await createRelayTransferSession(options.apiUrl, options.deviceName, files);
    state.relay = toRelayAccess(relay);
    await persistState();

    await postDirectEvent(
      {
        sessionId: target.sessionId,
        host: target.host,
        port: target.port,
        token: target.token,
      },
      {
        kind: "relay-ready",
        relay: toRelayAccess(relay)!,
      },
    );

    relayPollTimer = setInterval(() => {
      void syncRelaySenderState();
    }, RELAY_POLL_INTERVAL_MS);
    await syncRelaySenderState();
  }

  const directEnabled = options.transport !== "relay";
  const server = await startHttpServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${host}:${LOCAL_HTTP_SERVER_PORT}`);
    const pathSegments = url.pathname.split("/").filter(Boolean);

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

    if (pathSegments[3] === "events" && request.method === "POST") {
      const payload = await readJsonBody<{ event: ReceiverToSenderEvent }>(request);
      await handleReceiverEvent(payload.event);
      sendJson(response, 200, {
        ok: true,
      });
      return;
    }

    if (!directEnabled) {
      sendJson(response, 404, {
        error: "Direct transfer unavailable.",
      });
      return;
    }

    if (pathSegments[3] === "manifest" && request.method === "GET") {
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

    if (pathSegments[3] === "files" && pathSegments[4] && ["GET", "HEAD"].includes(request.method ?? "")) {
      const file = files.find((candidate) => candidate.id === decodeURIComponent(pathSegments[4] ?? ""));
      if (!file) {
        sendText(response, 404, "File not found.");
        return;
      }

      await sendFile(response, file, request.method ?? "GET");
      return;
    }

    sendEmpty(response, 405, {
      allow: "GET, HEAD, POST",
    });
  });

  const offer = createIncomingTransferOffer({
    manifest,
    direct,
    relay: null,
  });

  try {
    await persistState();
    await postIncomingOffer(target, offer);
    logLine(`Offer sent to ${target.deviceName}.`);
    const result = await resultDeferred.promise;
    logLine(result.detail);
  } finally {
    if (relayPollTimer) {
      clearInterval(relayPollTimer);
    }
    await closeServer(server).catch(() => {});
    if (relay) {
      await deleteRelayTransferSession(options.apiUrl, relay).catch(() => {});
    }
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
    "--transport",
    options.transport,
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
  --transport <auto|direct|relay>
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
  --transport <auto|direct|relay>
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
      transport: {
        type: "string",
      },
      nearby: {
        type: "boolean",
        default: true,
      },
      once: {
        type: "boolean",
        default: false,
      },
      verbose: {
        type: "boolean",
        default: false,
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
        default: false,
      },
      label: {
        type: "string",
      },
    },
  });

  if (command === "receive") {
    await runReceiveCommand({
      apiUrl: process.env.API_URL ?? DEFAULT_API_URL,
      deviceName: parsed.values.name ?? "Mac Debug Receiver",
      outputDir: parsed.values["output-dir"] ?? path.join(REPO_ROOT, "tmp/macos-device-received"),
      stateFile: parsed.values["state-file"] ?? null,
      acceptDelayMs: Number(parsed.values["accept-delay-ms"] ?? 0),
      transport: (parsed.values.transport ?? "auto") as TransportMode,
      nearby: parsed.values.nearby ?? true,
      once: parsed.values.once ?? false,
      verbose: parsed.values.verbose ?? false,
    });
    return;
  }

  if (command === "send") {
    const filePaths = parsed.values.file ?? [];
    if (!filePaths.length) {
      throw new Error("Provide at least one --file argument.");
    }

    await runSendCommand({
      apiUrl: process.env.API_URL ?? DEFAULT_API_URL,
      deviceName: parsed.values.name ?? "Mac Debug Sender",
      transport: (parsed.values.transport ?? "auto") as TransportMode,
      filePaths,
      targetQr: parsed.values["target-qr"] ?? null,
      targetFile: parsed.values["target-file"] ?? null,
      targetName: parsed.values["target-name"] ?? null,
      targetSessionId: parsed.values["target-session-id"] ?? null,
      discoverTimeoutMs: Number(parsed.values["discover-timeout-ms"] ?? DEFAULT_DISCOVER_TIMEOUT_MS),
      stateFile: parsed.values["state-file"] ?? null,
      verbose: parsed.values.verbose ?? false,
    });
    return;
  }

  if (command === "discover") {
    const records = await discoverNearbyReceivers(Number(parsed.values["timeout-ms"] ?? DEFAULT_DISCOVER_TIMEOUT_MS));
    if (parsed.values.json) {
      console.log(JSON.stringify(records, null, 2));
      return;
    }

    for (const record of records) {
      console.log(`${record.deviceName} ${record.host}:${record.port} ${record.sessionId}`);
    }
    return;
  }

  if (command === "print-launch-agent") {
    const plist = buildLaunchAgentPlist({
      apiUrl: process.env.API_URL ?? DEFAULT_API_URL,
      deviceName: parsed.values.name ?? "Mac Debug Receiver",
      outputDir: parsed.values["output-dir"] ?? path.join(REPO_ROOT, "tmp/macos-device-received"),
      stateFile: parsed.values["state-file"] ?? null,
      acceptDelayMs: Number(parsed.values["accept-delay-ms"] ?? 0),
      transport: (parsed.values.transport ?? "auto") as TransportMode,
      nearby: parsed.values.nearby ?? true,
      label: parsed.values.label ?? "com.filetransfers.macos-device",
    });
    console.log(plist);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
