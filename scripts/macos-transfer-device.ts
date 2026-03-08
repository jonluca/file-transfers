import { spawn } from "node:child_process";
import { randomBytes, randomUUID, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream, type WriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import tls, { type TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createFrameParser, decodeJsonFrame, encodeChunkFrame, encodeJsonFrame } from "../lib/file-transfer/protocol";
import type {
  DiscoveryRecord,
  IncomingTransferOffer,
  RelayAccess,
  RelayCredentials,
  SelectedTransferFile,
  SenderTransferAccess,
  TransferManifest,
  TransferProgress,
} from "../lib/file-transfer/types";

type TransportMode = "auto" | "direct" | "relay";

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

interface ExtractedTlsMaterial {
  key: Buffer;
  cert: Buffer;
  fingerprint: string;
  cleanup(): Promise<void>;
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

interface ReceivedFileOutput {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  outputPath: string;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCAL_TRANSFER_CERT_PATH = path.resolve(REPO_ROOT, "assets/tls/local-transfer-cert.pem");
const LOCAL_TRANSFER_P12_PATH = path.resolve(REPO_ROOT, "assets/tls/local-transfer-keystore.p12");
const LOCAL_TRANSFER_SERVICE_TYPE = "_filetransfer._tcp";
const LOCAL_TRANSFER_SERVICE_DOMAIN = "local.";
const LOCAL_TRANSFER_CHUNK_SIZE_BYTES = 64 * 1024;
const DIRECT_CONNECT_TIMEOUT_MS = 8000;
const RELAY_POLL_INTERVAL_MS = 1500;
const DEFAULT_API_URL = "http://127.0.0.1:3001";
const DEFAULT_DISCOVER_TIMEOUT_MS = 5000;
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

class DirectTransferFallbackError extends Error {}

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

function safeDeviceIp(value: string | null | undefined) {
  if (!value || value === "0.0.0.0" || value === "::1" || value === "127.0.0.1") {
    return "127.0.0.1";
  }

  return value;
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

function createTransferManifest({
  files,
  deviceName,
  sessionId,
  transferToken,
  host,
  port,
  fingerprint,
  isPremium,
}: {
  files: SelectedTransferFile[];
  deviceName: string;
  sessionId: string;
  transferToken: string;
  host: string;
  port: number;
  fingerprint: string;
  isPremium: boolean;
}) {
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
    certificateFingerprint: fingerprint,
    isPremiumSender: isPremium,
    createdAt: nowIso(),
  } satisfies TransferManifest;
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

function createDiscoveryRecord({
  sessionId,
  method,
  deviceName,
  host,
  port,
  token,
  fingerprint,
  serviceName,
}: {
  sessionId: string;
  method: DiscoveryRecord["method"];
  deviceName: string;
  host: string;
  port: number;
  token: string;
  fingerprint: string;
  serviceName: string | null;
}) {
  return {
    sessionId,
    method,
    deviceName,
    host,
    port,
    token,
    certificateFingerprint: fingerprint,
    advertisedAt: nowIso(),
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
    certificateFingerprint: record.certificateFingerprint,
    advertisedAt: record.advertisedAt,
  });
}

function createServiceName(deviceName: string, sessionId: string) {
  return `${deviceName.trim().slice(0, 24)}-${sessionId.slice(0, 6)}`;
}

function randomToken() {
  return randomBytes(16).toString("hex");
}

function formatBytes(bytes: number) {
  if (bytes >= 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(2)} KB`;
  }

  return `${bytes} B`;
}

function logLine(message: string) {
  console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
}

function safeName(value: string) {
  return value.replace(/[^\w.\-() ]+/g, "_");
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

async function runCommand(command: string, args: string[]) {
  return await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} failed with code ${code}: ${stderr || stdout}`));
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

async function loadTlsMaterial(): Promise<ExtractedTlsMaterial> {
  const certText = await readFile(LOCAL_TRANSFER_CERT_PATH, "utf8");
  const certificate = new X509Certificate(certText);
  const tempDirectory = await mkdtemp(path.join(tmpdir(), "file-transfers-macos-device-"));
  const keyPath = path.join(tempDirectory, "local-transfer-key.pem");

  await runCommand("openssl", [
    "pkcs12",
    "-legacy",
    "-in",
    LOCAL_TRANSFER_P12_PATH,
    "-nocerts",
    "-nodes",
    "-passin",
    "pass:",
    "-out",
    keyPath,
  ]);

  const keyText = await readFile(keyPath, "utf8");
  const keyPem = keyText
    .split(/\r?\n/)
    .filter(
      (line) =>
        !line.startsWith("Bag Attributes") && !line.startsWith("Key Attributes:") && !line.startsWith("localKeyID"),
    )
    .join("\n")
    .trim();

  return {
    key: Buffer.from(`${keyPem}\n`, "utf8"),
    cert: Buffer.from(certText, "utf8"),
    fingerprint: certificate.fingerprint256,
    async cleanup() {
      await rm(tempDirectory, { force: true, recursive: true }).catch(() => {});
    },
  };
}

async function writeSocket(socket: Pick<TLSSocket, "write">, payload: Uint8Array | Buffer | string) {
  await new Promise<void>((resolve, reject) => {
    socket.write(payload, (error?: Error | null) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function writeStreamChunk(stream: WriteStream, chunk: Buffer) {
  if (stream.write(chunk)) {
    return;
  }

  await once(stream, "drain");
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
          certificateFingerprint: txt.certificateFingerprint ?? "",
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
        certificateFingerprint?: string;
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
    certificateFingerprint: parsed.certificateFingerprint ?? "",
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

async function downloadRelayTransferFile(apiUrl: string, relay: RelayAccess, fileId: string, destination: string) {
  const response = await fetch(relayUrl(apiUrl, `/relay/sessions/${relay.sessionId}/files/${fileId}`), {
    headers: {
      "x-relay-token": relay.receiverToken,
    },
  });

  if (!response.ok) {
    await parseRelayResponse<RelaySessionState>(response);
    return;
  }

  if (!response.body) {
    throw new Error("Relay response body was empty.");
  }

  const payload = await response.arrayBuffer();
  await writeFile(destination, Buffer.from(payload));
}

async function streamFilesToSocket(
  manifest: TransferManifest,
  files: SelectedTransferFile[],
  socket: TLSSocket,
  onProgress?: (progress: TransferProgress) => void,
) {
  let bytesTransferred = 0;
  let windowBytesTransferred = 0;
  let windowStartedAt = Date.now();

  try {
    await writeSocket(socket, encodeJsonFrame({ kind: "manifest", manifest }));

    for (const file of files) {
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

      const stream = createReadStream(file.uri, {
        highWaterMark: LOCAL_TRANSFER_CHUNK_SIZE_BYTES,
      });

      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        await writeSocket(socket, encodeChunkFrame(buffer));
        bytesTransferred += buffer.byteLength;
        windowBytesTransferred += buffer.byteLength;

        const elapsedMilliseconds = Date.now() - windowStartedAt;
        const speedBytesPerSecond =
          elapsedMilliseconds > 0 ? Math.round((windowBytesTransferred / elapsedMilliseconds) * 1000) : 0;

        if (elapsedMilliseconds >= 1000) {
          windowStartedAt = Date.now();
          windowBytesTransferred = 0;
        }

        onProgress?.({
          phase: "transferring",
          totalBytes: manifest.totalBytes,
          bytesTransferred,
          currentFileName: file.name,
          speedBytesPerSecond,
          detail: "Sending files over local WiFi.",
          updatedAt: nowIso(),
        });
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
  } catch (error) {
    await writeSocket(
      socket,
      encodeJsonFrame({
        kind: "error",
        message: error instanceof Error ? error.message : "Transfer failed.",
      }),
    ).catch(() => {});
    throw error;
  } finally {
    socket.destroy();
  }
}

async function receiveDirectTransfer({
  offer,
  deviceName,
  outputDir,
  tlsMaterial,
  onProgress,
}: {
  offer: IncomingTransferOffer;
  deviceName: string;
  outputDir: string;
  tlsMaterial: ExtractedTlsMaterial;
  onProgress?: (progress: TransferProgress) => void;
}) {
  await ensureDirectory(outputDir);

  const socket = tls.connect({
    host: offer.sender.host,
    port: offer.sender.port,
    ca: tlsMaterial.cert,
    rejectUnauthorized: false,
    checkServerIdentity: () => undefined,
  });

  return await new Promise<{ receivedFiles: ReceivedFileOutput[]; bytesTransferred: number; detail: string }>(
    (resolve, reject) => {
      const receivedFiles: ReceivedFileOutput[] = [];
      let currentStream: ReturnType<typeof createWriteStream> | null = null;
      let currentPath: string | null = null;
      let currentFileMetadata: { fileId: string; fileName: string; mimeType: string; sizeBytes: number } | null = null;
      let bytesTransferred = 0;
      let windowBytesTransferred = 0;
      let windowStartedAt = Date.now();
      let didReceiveFrame = false;
      let didResolve = false;

      const handshakeTimer = setTimeout(() => {
        fail(new DirectTransferFallbackError("Unable to connect over local WiFi."));
      }, DIRECT_CONNECT_TIMEOUT_MS);

      function clearHandshakeTimer() {
        clearTimeout(handshakeTimer);
      }

      function finish(result: { receivedFiles: ReceivedFileOutput[]; bytesTransferred: number; detail: string }) {
        if (didResolve) {
          return;
        }

        didResolve = true;
        clearHandshakeTimer();
        currentStream?.end();
        socket.destroy();
        resolve(result);
      }

      function fail(error: Error) {
        if (didResolve) {
          return;
        }

        didResolve = true;
        clearHandshakeTimer();
        currentStream?.destroy();
        socket.destroy();
        reject(error);
      }

      const parser = createFrameParser((frame) => {
        try {
          if (frame.type === "json") {
            didReceiveFrame = true;
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
              currentPath = createOutputPath(outputDir, message.fileName);
              currentStream = createWriteStream(currentPath);
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

            if (message.kind === "file-end" && currentStream && currentPath && currentFileMetadata) {
              currentStream.end();
              receivedFiles.push({
                id: currentFileMetadata.fileId,
                name: currentFileMetadata.fileName,
                mimeType: currentFileMetadata.mimeType,
                sizeBytes: currentFileMetadata.sizeBytes,
                outputPath: currentPath,
              });
              currentStream = null;
              currentPath = null;
              currentFileMetadata = null;
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

          if (!currentStream || !currentFileMetadata) {
            return;
          }

          const chunk = Buffer.from(frame.payload);
          void writeStreamChunk(currentStream, chunk);
          bytesTransferred += chunk.byteLength;
          windowBytesTransferred += chunk.byteLength;

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
        parser(chunk as Uint8Array);
      });
      socket.on("error", (error) => {
        const baseError = error instanceof Error ? error : new Error("Transfer connection failed.");
        fail(didReceiveFrame ? baseError : new DirectTransferFallbackError(baseError.message));
      });
      socket.on("close", () => {
        if (didResolve) {
          return;
        }

        fail(
          didReceiveFrame
            ? new Error("The transfer ended before all files finished downloading.")
            : new DirectTransferFallbackError("Unable to reach the sender over local WiFi."),
        );
      });
    },
  );
}

async function receiveRelayTransfer({
  apiUrl,
  offer,
  outputDir,
  onProgress,
}: {
  apiUrl: string;
  offer: IncomingTransferOffer;
  outputDir: string;
  onProgress?: (progress: TransferProgress) => void;
}) {
  if (!offer.sender.relay) {
    throw new Error("Relay access is not available for this transfer.");
  }

  await ensureDirectory(outputDir);

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

    onProgress?.({
      phase: "transferring",
      totalBytes: offer.totalBytes,
      bytesTransferred,
      currentFileName: file.name,
      speedBytesPerSecond: 0,
      detail: "Downloading files through relay.",
      updatedAt: nowIso(),
    });

    await downloadRelayTransferFile(apiUrl, offer.sender.relay, file.id, outputPath);

    bytesTransferred += file.sizeBytes;
    const elapsedMilliseconds = Math.max(Date.now() - startedAt, 1);
    const speedBytesPerSecond = Math.round((file.sizeBytes / elapsedMilliseconds) * 1000);

    receivedFiles.push({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      outputPath,
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
      `certificateFingerprint=${discoveryRecord.certificateFingerprint}`,
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

  return {
    bytesTransferred,
    detail: "Transfer complete through relay.",
  };
}

async function sendOfferOverControlSocket({
  target,
  offer,
  tlsMaterial,
}: {
  target: DiscoveryRecord;
  offer: IncomingTransferOffer;
  tlsMaterial: ExtractedTlsMaterial;
}) {
  const deferred = createDeferred<{ receiverDeviceName: string }>();
  const socket = tls.connect({
    host: target.host,
    port: target.port,
    ca: tlsMaterial.cert,
    rejectUnauthorized: false,
    checkServerIdentity: () => undefined,
  });

  let resolved = false;

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

    if (resolved) {
      return;
    }

    resolved = true;

    if (message.kind === "accepted") {
      deferred.resolve({
        receiverDeviceName: message.receiverDeviceName?.trim() || target.deviceName,
      });
      socket.destroy();
      return;
    }

    deferred.reject(new Error(message.message || "Receiver rejected the transfer."));
    socket.destroy();
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
      if (resolved) {
        return;
      }

      resolved = true;
      deferred.reject(error instanceof Error ? error : new Error("Unable to reach that receiver."));
      socket.destroy();
    });
  });
  socket.on("data", (chunk) => {
    parser(chunk as Uint8Array);
  });
  socket.on("error", (error) => {
    if (resolved) {
      return;
    }

    resolved = true;
    deferred.reject(error instanceof Error ? error : new Error("Unable to reach that receiver."));
  });
  socket.on("close", () => {
    if (resolved) {
      return;
    }

    resolved = true;
    deferred.reject(new Error("That receiver is no longer available."));
  });

  return deferred.promise;
}

async function runReceiveCommand(options: ReceiveCommandOptions) {
  const tlsMaterial = await loadTlsMaterial();
  const sessionId = randomUUID();
  const receiverToken = randomToken();
  const host = safeDeviceIp(getPreferredLanAddress());
  const serviceName = createServiceName(options.deviceName, sessionId);
  let resolveShutdown!: () => void;

  const shutdownPromise = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });

  const controlServer = tls.createServer(
    {
      key: tlsMaterial.key,
      cert: tlsMaterial.cert,
      requestCert: false,
      rejectUnauthorized: false,
    },
    (socket) => {
      void handleOfferSocket(socket);
    },
  );

  await new Promise<void>((resolve, reject) => {
    controlServer.once("error", reject);
    controlServer.listen(0, "0.0.0.0", () => {
      controlServer.off("error", reject);
      resolve();
    });
  });

  const controlAddress = controlServer.address();
  const port = typeof controlAddress === "object" && controlAddress ? controlAddress.port : 0;
  if (!port) {
    throw new Error("Unable to allocate a receiver control port.");
  }

  const discoveryRecord = createDiscoveryRecord({
    sessionId,
    method: "nearby",
    deviceName: options.deviceName,
    host,
    port,
    token: receiverToken,
    fingerprint: tlsMaterial.fingerprint,
    serviceName: options.nearby ? serviceName : null,
  });
  const qrPayload = buildQrPayload({
    ...discoveryRecord,
    method: "qr",
    serviceName: null,
  });

  const state: ReceiveServiceState = {
    mode: "receive",
    deviceName: options.deviceName,
    transport: options.transport,
    apiUrl: options.apiUrl,
    outputDir: options.outputDir,
    startedAt: nowIso(),
    discoveryRecord,
    qrPayload,
    nearbyAdvertising: false,
    currentStatus: "discoverable",
    currentOffer: null,
    progress: createProgress(0, "discoverable", "Ready to receive files."),
    lastTransfer: null,
  };

  let nearbyAdvertisement: { stop(): void } | null = null;
  let isBusy = false;

  function emitProgress(progress: TransferProgress) {
    state.progress = progress;
    if (progress.phase === "waiting") {
      state.currentStatus = "waiting";
    } else if (progress.phase === "connecting") {
      state.currentStatus = "connecting";
    } else if (progress.phase === "transferring") {
      state.currentStatus = "transferring";
    } else {
      state.currentStatus = "discoverable";
    }
    void writeStateFile(options.stateFile, state);
  }

  function resetToDiscoverable() {
    state.currentOffer = null;
    state.currentStatus = "discoverable";
    state.progress = createProgress(0, "discoverable", "Ready to receive files.");
    isBusy = false;
    void writeStateFile(options.stateFile, state);
  }

  async function handleOfferSocket(socket: TLSSocket) {
    let handled = false;

    const parser = createFrameParser((frame) => {
      if (frame.type !== "json" || handled) {
        return;
      }

      handled = true;

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

      if (isBusy) {
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

      void processIncomingOffer(socket, message.offer);
    });

    socket.on("data", (chunk) => {
      parser(chunk as Uint8Array);
    });
    socket.on("error", () => {});
  }

  async function processIncomingOffer(socket: TLSSocket, offer: IncomingTransferOffer) {
    isBusy = true;
    state.currentOffer = offer;
    emitProgress({
      phase: "waiting",
      totalBytes: offer.totalBytes,
      bytesTransferred: 0,
      currentFileName: null,
      speedBytesPerSecond: 0,
      detail: `${offer.senderDeviceName} wants to send ${offer.fileCount} file${offer.fileCount === 1 ? "" : "s"}.`,
      updatedAt: nowIso(),
    });

    logLine(
      `Incoming offer from ${offer.senderDeviceName}: ${offer.fileCount} file(s), ${formatBytes(offer.totalBytes)}.`,
    );

    await writeSocket(socket, encodeJsonFrame({ kind: "offer-received" }));

    if (options.acceptDelayMs > 0) {
      await sleep(options.acceptDelayMs);
    }

    if (offer.sender.relay) {
      await acceptRelayTransferSession(options.apiUrl, offer.sender.relay, options.deviceName);
    }

    await writeSocket(
      socket,
      encodeJsonFrame({
        kind: "accepted",
        receiverDeviceName: options.deviceName,
      }),
    ).finally(() => {
      socket.destroy();
    });

    emitProgress({
      phase: "connecting",
      totalBytes: offer.totalBytes,
      bytesTransferred: 0,
      currentFileName: null,
      speedBytesPerSecond: 0,
      detail: "Connecting to the sender.",
      updatedAt: nowIso(),
    });

    const transferStartedAt = nowIso();

    try {
      const result =
        options.transport === "relay"
          ? await receiveRelayTransfer({
              apiUrl: options.apiUrl,
              offer,
              outputDir: options.outputDir,
              onProgress: emitProgress,
            })
          : await receiveWithPreferredTransport(offer);

      state.lastTransfer = {
        startedAt: transferStartedAt,
        completedAt: nowIso(),
        outcome: "completed",
        detail: result.detail,
        bytesTransferred: result.bytesTransferred,
        fileCount: result.receivedFiles.length,
        files: result.receivedFiles,
      };

      logLine(
        `Received ${result.receivedFiles.length} file(s) from ${offer.senderDeviceName}. ${formatBytes(result.bytesTransferred)} transferred.`,
      );
    } catch (error) {
      if (offer.sender.relay) {
        await declineRelayTransferSession(options.apiUrl, offer.sender.relay).catch(() => {});
      }

      state.lastTransfer = {
        startedAt: transferStartedAt,
        completedAt: nowIso(),
        outcome: "failed",
        detail: error instanceof Error ? error.message : "The transfer could not be completed.",
        bytesTransferred: state.progress.bytesTransferred,
        fileCount: 0,
        files: [],
      };
      logLine(`Transfer failed: ${state.lastTransfer.detail}`);
    } finally {
      await writeStateFile(options.stateFile, state);
      resetToDiscoverable();

      if (options.once) {
        resolveShutdown();
      }
    }
  }

  async function receiveWithPreferredTransport(offer: IncomingTransferOffer) {
    const canAttemptDirect =
      offer.sender.port > 0 &&
      offer.sender.host !== "0.0.0.0" &&
      offer.sender.token.trim() &&
      options.transport !== "relay";

    if (canAttemptDirect) {
      try {
        return await receiveDirectTransfer({
          offer,
          deviceName: options.deviceName,
          outputDir: options.outputDir,
          tlsMaterial,
          onProgress: emitProgress,
        });
      } catch (error) {
        if (offer.sender.relay && options.transport === "auto" && error instanceof DirectTransferFallbackError) {
          emitProgress({
            phase: "connecting",
            totalBytes: offer.totalBytes,
            bytesTransferred: 0,
            currentFileName: null,
            speedBytesPerSecond: 0,
            detail: "Direct transfer unavailable. Switching to relay.",
            updatedAt: nowIso(),
          });

          return receiveRelayTransfer({
            apiUrl: options.apiUrl,
            offer,
            outputDir: options.outputDir,
            onProgress: emitProgress,
          });
        }

        throw error;
      }
    }

    if (offer.sender.relay) {
      return receiveRelayTransfer({
        apiUrl: options.apiUrl,
        offer,
        outputDir: options.outputDir,
        onProgress: emitProgress,
      });
    }

    throw new Error("This sender is not reachable over local WiFi.");
  }

  if (options.nearby) {
    nearbyAdvertisement = await startNearbyAdvertisement({
      serviceName,
      port,
      discoveryRecord,
    });
    state.nearbyAdvertising = true;
  }

  await writeStateFile(options.stateFile, state);

  logLine(`Receiver service started as "${options.deviceName}".`);
  logLine(`Nearby discovery: ${options.nearby ? "enabled" : "disabled"}`);
  logLine(`Session: ${state.discoveryRecord.sessionId}`);
  logLine(`Control port: ${state.discoveryRecord.port}`);
  logLine(`Discovery payload: ${state.qrPayload}`);
  if (options.stateFile) {
    logLine(`State file: ${options.stateFile}`);
  }

  const signalHandler = () => resolveShutdown();
  process.on("SIGINT", signalHandler);
  process.on("SIGTERM", signalHandler);

  await shutdownPromise;

  nearbyAdvertisement?.stop();
  controlServer.close();
  await tlsMaterial.cleanup();
}

async function runSendCommand(options: SendCommandOptions) {
  const files = await buildSelectedFiles(options.filePaths);
  const target = await resolveTargetRecord(options);
  const tlsMaterial = await loadTlsMaterial();
  const sessionId = randomUUID();
  const transferToken = randomToken();
  const deviceIp = safeDeviceIp(getPreferredLanAddress());
  const shouldUseRelay = options.transport !== "direct";
  const shouldUseDirect = options.transport !== "relay";
  const relay = shouldUseRelay ? await createRelayTransferSession(options.apiUrl, options.deviceName, files) : null;
  const startedAt = nowIso();

  let relayUsed = false;
  let relayShouldDelete = false;
  let directServer: tls.Server | null = null;
  let directPort = 0;
  let relayUploadStarted = false;

  const manifest = createTransferManifest({
    files,
    deviceName: options.deviceName,
    sessionId,
    transferToken,
    host: deviceIp,
    port: 0,
    fingerprint: tlsMaterial.fingerprint,
    isPremium: false,
  });

  const state = {
    mode: "send",
    apiUrl: options.apiUrl,
    deviceName: options.deviceName,
    transport: options.transport,
    startedAt,
    target,
    relay,
    status: "waiting" as "waiting" | "connecting" | "transferring" | "completed" | "failed",
    progress: createProgress(manifest.totalBytes, "waiting", `Waiting for ${target.deviceName} to accept.`),
  };

  function emitProgress(progress: TransferProgress) {
    state.progress = progress;
    if (progress.phase === "connecting") {
      state.status = "connecting";
    } else if (progress.phase === "transferring") {
      state.status = "transferring";
    } else if (progress.phase === "completed") {
      state.status = "completed";
    } else if (progress.phase === "failed") {
      state.status = "failed";
    }
    void writeStateFile(options.stateFile, state);
  }

  const directTransferDeferred = createDeferred<void>();
  let didConnectDirectly = false;

  if (shouldUseDirect) {
    directServer = tls.createServer(
      {
        key: tlsMaterial.key,
        cert: tlsMaterial.cert,
        requestCert: false,
        rejectUnauthorized: false,
      },
      (socket) => {
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

            if (relayUploadStarted) {
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

            if (didConnectDirectly) {
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

            didConnectDirectly = true;
            void streamFilesToSocket(manifestWithPort(), files, socket, emitProgress)
              .then(() => {
                emitProgress({
                  phase: "completed",
                  totalBytes: manifest.totalBytes,
                  bytesTransferred: manifest.totalBytes,
                  currentFileName: null,
                  speedBytesPerSecond: 0,
                  detail: "Transfer complete.",
                  updatedAt: nowIso(),
                });
                directTransferDeferred.resolve();
              })
              .catch((error) => {
                directTransferDeferred.reject(error);
              });
            return;
          }

          void writeSocket(
            socket,
            encodeJsonFrame({
              kind: "error",
              message: "Unable to validate transfer session.",
            }),
          )
            .catch(() => {})
            .finally(() => {
              socket.destroy();
            });
        });

        socket.on("data", (chunk) => {
          parser(chunk as Uint8Array);
        });
        socket.on("error", (error) => {
          if (!didReceiveHello) {
            directTransferDeferred.reject(error instanceof Error ? error : new Error("Sender data socket error."));
          }
        });
      },
    );

    await new Promise<void>((resolve, reject) => {
      directServer?.once("error", reject);
      directServer?.listen(0, "0.0.0.0", () => {
        directServer?.off("error", reject);
        resolve();
      });
    });

    const directAddress = directServer.address();
    directPort = typeof directAddress === "object" && directAddress ? Number(directAddress.port) : 0;

    if (!directPort) {
      throw new Error("Unable to allocate a sender data port.");
    }
  }

  function manifestWithPort() {
    return {
      ...manifest,
      advertisedPort: directPort,
    };
  }

  const offer = createIncomingTransferOffer(manifestWithPort(), relay);

  await writeStateFile(options.stateFile, state);

  logLine(`Sending ${files.length} file(s) to ${target.deviceName} (${target.host}:${target.port}).`);
  logLine(`Transport mode: ${options.transport}`);
  if (relay) {
    logLine(`Relay fallback provisioned: ${relay.sessionId}`);
  }

  try {
    const { receiverDeviceName } = await sendOfferOverControlSocket({
      target,
      offer,
      tlsMaterial,
    });

    emitProgress({
      phase: "connecting",
      totalBytes: manifest.totalBytes,
      bytesTransferred: 0,
      currentFileName: null,
      speedBytesPerSecond: 0,
      detail: shouldUseDirect
        ? `${receiverDeviceName} accepted. Waiting for them to connect.`
        : `${receiverDeviceName} accepted. Preparing relay transfer.`,
      updatedAt: nowIso(),
    });

    if (shouldUseDirect && directServer) {
      try {
        await Promise.race([
          directTransferDeferred.promise,
          sleep(DIRECT_CONNECT_TIMEOUT_MS).then(() => {
            throw new DirectTransferFallbackError("Receiver could not connect to this transfer.");
          }),
        ]);

        relayShouldDelete = Boolean(relay);
        return;
      } catch (error) {
        if (!(error instanceof DirectTransferFallbackError) || !relay) {
          throw error;
        }

        emitProgress({
          phase: "connecting",
          totalBytes: manifest.totalBytes,
          bytesTransferred: 0,
          currentFileName: null,
          speedBytesPerSecond: 0,
          detail: "Direct transfer unavailable. Switching to relay.",
          updatedAt: nowIso(),
        });
      }
    }

    if (!relay) {
      throw new Error("Relay fallback is not available for this transfer.");
    }

    relayUsed = true;
    relayUploadStarted = true;
    const result = await uploadFilesToRelay({
      apiUrl: options.apiUrl,
      relay,
      files,
      totalBytes: manifest.totalBytes,
      onProgress: emitProgress,
    });

    emitProgress({
      phase: "completed",
      totalBytes: manifest.totalBytes,
      bytesTransferred: result.bytesTransferred,
      currentFileName: null,
      speedBytesPerSecond: 0,
      detail: result.detail,
      updatedAt: nowIso(),
    });
  } catch (error) {
    emitProgress({
      phase: "failed",
      totalBytes: manifest.totalBytes,
      bytesTransferred: state.progress.bytesTransferred,
      currentFileName: null,
      speedBytesPerSecond: 0,
      detail: error instanceof Error ? error.message : "Transfer failed.",
      updatedAt: nowIso(),
    });
    throw error;
  } finally {
    directServer?.close();

    if (relay && (relayShouldDelete || (!relayUsed && state.status !== "completed"))) {
      await deleteRelayTransferSession(options.apiUrl, relay).catch(() => {});
    }

    await writeStateFile(options.stateFile, state);
    await tlsMaterial.cleanup();
  }
}

function renderLaunchAgentPlist(options: LaunchAgentOptions) {
  const tsxPath = path.resolve(REPO_ROOT, "node_modules/.bin/tsx");
  const scriptPath = path.resolve(REPO_ROOT, "scripts/macos-transfer-device.ts");
  const logDirectory = path.join(homedir(), "Library/Logs/file-transfers");
  const stdoutPath = path.join(logDirectory, "macos-device.out.log");
  const stderrPath = path.join(logDirectory, "macos-device.err.log");
  const args = [
    tsxPath,
    scriptPath,
    "receive",
    "--name",
    options.deviceName,
    "--output-dir",
    options.outputDir,
    "--api-url",
    options.apiUrl,
    "--accept-delay-ms",
    String(options.acceptDelayMs),
    "--transport",
    options.transport,
  ];

  if (options.stateFile) {
    args.push("--state-file", options.stateFile);
  }

  if (!options.nearby) {
    args.push("--no-nearby");
  }

  const escapedArgs = args.map((value) => `    <string>${escapeXml(value)}</string>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${escapeXml(options.label)}</string>
    <key>ProgramArguments</key>
    <array>
${escapedArgs}
    </array>
    <key>WorkingDirectory</key>
    <string>${escapeXml(REPO_ROOT)}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${escapeXml(stdoutPath)}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(stderrPath)}</string>
  </dict>
</plist>`;
}

function escapeXml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function printUsage() {
  console.log(`macos-transfer-device

Usage:
  pnpm macos:device receive [options]
  pnpm macos:device send --file <path> [--file <path> ...] [target options]
  pnpm macos:device discover [options]
  pnpm macos:device print-launch-agent [options]

Shared options:
  --api-url <url>              Relay/backend base URL (default: ${DEFAULT_API_URL})
  --name <device name>         Friendly device name

Receive options:
  --output-dir <path>          Directory for downloaded files
  --state-file <path>          Optional JSON state output
  --accept-delay-ms <ms>       Delay before auto-accepting an offer
  --transport <auto|direct|relay>
  --no-nearby                  Disable Bonjour advertisement
  --once                       Exit after the first completed or failed transfer

Send options:
  --file <path>                File to send (repeatable)
  --target-qr <json>           Raw QR/discovery JSON payload
  --target-file <path>         File containing discovery JSON or receiver state JSON
  --target-name <name>         Nearby device/service name to discover with dns-sd
  --target-session-id <id>     Nearby receiver session ID to discover with dns-sd
  --discover-timeout-ms <ms>   Bonjour discovery timeout
  --transport <auto|direct|relay>
  --state-file <path>          Optional JSON state output

Discover options:
  --timeout-ms <ms>            Bonjour discovery timeout
  --json                       Emit JSON instead of a text table

print-launch-agent options:
  --label <launchd label>      LaunchAgent label
  --output-dir <path>          Directory for received files
  --state-file <path>          Optional JSON state output
  --accept-delay-ms <ms>       Delay before auto-accepting an offer
  --transport <auto|direct|relay>
  --no-nearby                  Disable Bonjour advertisement
`);
}

async function main() {
  const parsed = parseArgs({
    allowPositionals: true,
    options: {
      "accept-delay-ms": { type: "string" },
      "api-url": { type: "string" },
      "discover-timeout-ms": { type: "string" },
      file: { type: "string", multiple: true },
      help: { type: "boolean" },
      json: { type: "boolean" },
      label: { type: "string" },
      name: { type: "string" },
      nearby: { type: "boolean" },
      "no-nearby": { type: "boolean" },
      once: { type: "boolean" },
      "output-dir": { type: "string" },
      "state-file": { type: "string" },
      "target-file": { type: "string" },
      "target-name": { type: "string" },
      "target-qr": { type: "string" },
      "target-session-id": { type: "string" },
      timeout: { type: "string" },
      "timeout-ms": { type: "string" },
      transport: { type: "string" },
      verbose: { type: "boolean" },
    },
  });

  const command = parsed.positionals[0];
  if (!command || parsed.values.help) {
    printUsage();
    return;
  }

  const apiUrl = trimTrailingSlash(parsed.values["api-url"] ?? process.env.EXPO_PUBLIC_API_URL ?? DEFAULT_API_URL);
  const deviceName = parsed.values.name?.trim() || "Mac Debug Device";
  const transport = (parsed.values.transport ?? "auto") as TransportMode;

  if (!["auto", "direct", "relay"].includes(transport)) {
    throw new Error(`Unsupported transport mode: ${transport}`);
  }

  if (command === "receive") {
    const outputDir = path.resolve(process.cwd(), parsed.values["output-dir"] ?? "tmp/macos-device-received");
    await runReceiveCommand({
      apiUrl,
      deviceName,
      outputDir,
      stateFile: parsed.values["state-file"] ? path.resolve(process.cwd(), parsed.values["state-file"]) : null,
      acceptDelayMs: Number(parsed.values["accept-delay-ms"] ?? 0),
      transport,
      nearby: !parsed.values["no-nearby"],
      once: Boolean(parsed.values.once),
      verbose: Boolean(parsed.values.verbose),
    });
    return;
  }

  if (command === "send") {
    if (!parsed.values.file?.length) {
      throw new Error("At least one --file path is required.");
    }

    await runSendCommand({
      apiUrl,
      deviceName,
      transport,
      filePaths: parsed.values.file,
      targetQr: parsed.values["target-qr"] ?? null,
      targetFile: parsed.values["target-file"] ?? null,
      targetName: parsed.values["target-name"] ?? null,
      targetSessionId: parsed.values["target-session-id"] ?? null,
      discoverTimeoutMs: Number(parsed.values["discover-timeout-ms"] ?? DEFAULT_DISCOVER_TIMEOUT_MS),
      stateFile: parsed.values["state-file"] ? path.resolve(process.cwd(), parsed.values["state-file"]) : null,
      verbose: Boolean(parsed.values.verbose),
    });
    return;
  }

  if (command === "discover") {
    const timeoutMs = Number(parsed.values["timeout-ms"] ?? parsed.values.timeout ?? DEFAULT_DISCOVER_TIMEOUT_MS);
    const records = await discoverNearbyReceivers(timeoutMs);

    if (parsed.values.json) {
      console.log(JSON.stringify(records, null, 2));
      return;
    }

    if (!records.length) {
      console.log("No nearby receivers found.");
      return;
    }

    for (const record of records) {
      console.log(
        `${record.deviceName}\n  session=${record.sessionId}\n  service=${record.serviceName ?? "-"}\n  host=${record.host}:${record.port}`,
      );
    }
    return;
  }

  if (command === "print-launch-agent") {
    console.log(
      renderLaunchAgentPlist({
        apiUrl,
        deviceName,
        outputDir: path.resolve(process.cwd(), parsed.values["output-dir"] ?? "tmp/macos-device-received"),
        stateFile: parsed.values["state-file"] ? path.resolve(process.cwd(), parsed.values["state-file"]) : null,
        acceptDelayMs: Number(parsed.values["accept-delay-ms"] ?? 0),
        transport,
        nearby: !parsed.values["no-nearby"],
        label: parsed.values.label ?? "com.filetransfers.macos-device",
      }),
    );
    return;
  }

  printUsage();
  process.exitCode = 1;
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
