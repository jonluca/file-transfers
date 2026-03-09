import * as Crypto from "expo-crypto";
import { File } from "expo-file-system";
import * as Network from "expo-network";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { ConfigServer, type HttpRequest, type HttpResponse, type ServerConfig } from "react-native-nitro-http-server";
import { LOCAL_HTTP_SERVER_PORT, LOCAL_HTTP_SHARE_KEEP_AWAKE_TAG } from "./constants";
import { createAttachmentContentDisposition } from "./content-disposition";
import {
  DIRECT_TOKEN_HEADER,
  createDiscoveryRecord,
  createNearbyDiscoveryResponse,
  buildDirectSessionBaseUrl,
  buildDirectSessionUrl,
  isPrivateIpv4Address,
  normalizeIpv4Address,
  nowIso,
} from "./direct-transfer-protocol";
import { resolveDirectByteRange } from "./direct-transfer-range";
import { formatBytes } from "./files";
import { assertSelectedFilesTransferAllowed, type TransferPolicy } from "./transfer-policy";
import type {
  DirectPeerAccess,
  DiscoveryRecord,
  DownloadableTransferManifest,
  HttpShareStatus,
  IncomingTransferOffer,
  SelectedTransferFile,
  TransferManifestFile,
} from "./types";

export interface LocalHttpSession {
  id: string;
  status: HttpShareStatus;
  deviceName: string;
  shareUrl: string;
  manifestUrl: string;
  qrValue: string;
  files: TransferManifestFile[];
  totalBytes: number;
  startedAt: string;
  detail: string | null;
}

type LocalHttpSessionUpdate = (session: LocalHttpSession) => void;

interface DirectOfferDecision {
  accepted: boolean;
  message?: string;
  statusCode?: number;
}

interface RegisterDirectReceiveSessionOptions {
  sessionId: string;
  token: string;
  deviceName: string;
  serviceName: string | null;
  canAcceptOffer?: () => boolean;
  onOffer: (offer: IncomingTransferOffer) => Promise<DirectOfferDecision> | DirectOfferDecision;
  onEvent: (event: unknown) => Promise<void> | void;
  onInterrupted?: (detail: string) => Promise<void> | void;
}

interface RegisterDirectSendSessionOptions {
  sessionId: string;
  token: string;
  deviceName: string;
  startedAt: string;
  files: SelectedTransferFile[];
  transferPolicy: TransferPolicy;
  onEvent: (event: unknown) => Promise<void> | void;
  onInterrupted?: (detail: string) => Promise<void> | void;
}

interface HostedShareFile {
  source: SelectedTransferFile;
  downloadPath: string;
}

interface BrowserShareRuntime {
  session: LocalHttpSession;
  filesById: Map<string, HostedShareFile>;
  transferPolicy: TransferPolicy;
  updateSession?: LocalHttpSessionUpdate;
  finalizing: boolean;
  onFinalized?: (session: LocalHttpSession) => void;
}

interface DirectReceiveRuntime {
  discoveryRecord: DiscoveryRecord;
  canAcceptOffer?: RegisterDirectReceiveSessionOptions["canAcceptOffer"];
  onOffer: RegisterDirectReceiveSessionOptions["onOffer"];
  onEvent: RegisterDirectReceiveSessionOptions["onEvent"];
  onInterrupted?: RegisterDirectReceiveSessionOptions["onInterrupted"];
}

interface DirectSendRuntime {
  sessionId: string;
  token: string;
  deviceName: string;
  startedAt: string;
  files: SelectedTransferFile[];
  filesById: Map<string, HostedShareFile>;
  transferPolicy: TransferPolicy;
  onEvent: RegisterDirectSendSessionOptions["onEvent"];
  onInterrupted?: RegisterDirectSendSessionOptions["onInterrupted"];
}

interface SharedHttpRuntime {
  server: ConfigServer | null;
  publicHost: string;
  browserSession: BrowserShareRuntime | null;
  directReceivers: Map<string, DirectReceiveRuntime>;
  directSenders: Map<string, DirectSendRuntime>;
}

const CACHE_CONTROL_HEADER = "no-store";
const BROWSER_STATIC_FILES_PREFIX = "/__browser-files";
const DIRECT_STATIC_FILES_PREFIX = "/__direct-files";

let activeRuntime: SharedHttpRuntime | null = null;

async function getLanShareHost() {
  const ipAddress = normalizeIpv4Address(await Network.getIpAddressAsync().catch(() => null));
  if (!ipAddress || !isPrivateIpv4Address(ipAddress)) {
    throw new Error("Connect this device to local WiFi before starting a local transfer.");
  }

  return ipAddress;
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function encodeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toTransferManifestFile(file: SelectedTransferFile): TransferManifestFile {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
  };
}

function decodeUriValue(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function throttleTransferBytes({
  bytesTransferred,
  maxBytesPerSecond,
  startedAt,
}: {
  bytesTransferred: number;
  maxBytesPerSecond: number | null;
  startedAt: number;
}) {
  if (!maxBytesPerSecond || bytesTransferred <= 0) {
    return;
  }

  const minimumDurationMs = Math.ceil((bytesTransferred / maxBytesPerSecond) * 1000);
  const elapsedMs = Date.now() - startedAt;
  const remainingMs = minimumDurationMs - elapsedMs;
  if (remainingMs > 0) {
    await sleep(remainingMs);
  }
}

function createHostedFileRoute({ file, mountPath }: { file: SelectedTransferFile; mountPath: string }) {
  const sourceFile = new File(file.uri);
  const sourceInfo = sourceFile.info();

  if (!sourceInfo.exists) {
    throw new Error(`The file "${file.name}" is no longer available on this device.`);
  }

  const diskFileName = decodeUriValue(sourceFile.name);

  return {
    source: file,
    downloadPath: `${mountPath}/${encodeURIComponent(diskFileName)}`,
  } satisfies HostedShareFile;
}

function buildBrowserHostedFiles(sessionId: string, files: SelectedTransferFile[]) {
  return files.map((file) =>
    createHostedFileRoute({
      file,
      mountPath: `${BROWSER_STATIC_FILES_PREFIX}/${encodeURIComponent(sessionId)}/${encodeURIComponent(file.id)}`,
    }),
  );
}

function buildDirectHostedFiles({
  sessionId,
  token,
  files,
}: {
  sessionId: string;
  token: string;
  files: SelectedTransferFile[];
}) {
  return files.map((file) =>
    createHostedFileRoute({
      file,
      mountPath: `${DIRECT_STATIC_FILES_PREFIX}/${encodeURIComponent(sessionId)}/${encodeURIComponent(token)}/${encodeURIComponent(file.id)}`,
    }),
  );
}

function createDefaultHeaders(contentType: string, contentLength?: number) {
  return {
    "Cache-Control": CACHE_CONTROL_HEADER,
    "Content-Type": contentType,
    ...(typeof contentLength === "number" ? { "Content-Length": String(contentLength) } : {}),
  };
}

function createTextResponse({
  statusCode,
  body,
  contentType,
  method,
  headers,
}: {
  statusCode: number;
  body: string;
  contentType: string;
  method: string;
  headers?: Record<string, string>;
}) {
  return {
    statusCode,
    headers: {
      ...createDefaultHeaders(contentType, byteLength(body)),
      ...headers,
    },
    ...(method === "HEAD" ? {} : { body }),
  } satisfies HttpResponse;
}

function createJsonResponse({
  statusCode,
  body,
  method,
  headers,
}: {
  statusCode: number;
  body: unknown;
  method: string;
  headers?: Record<string, string>;
}) {
  return createTextResponse({
    statusCode,
    body: JSON.stringify(body),
    contentType: "application/json; charset=utf-8",
    method,
    headers,
  });
}

function createEmptyResponse({
  statusCode,
  method,
  headers,
}: {
  statusCode: number;
  method: string;
  headers?: Record<string, string>;
}) {
  return {
    statusCode,
    headers: {
      "Cache-Control": CACHE_CONTROL_HEADER,
      ...headers,
    },
    ...(method === "HEAD" ? {} : { body: "" }),
  } satisfies HttpResponse;
}

function getRequestPath(path: string) {
  return (path.split("?")[0] ?? "/").trim() || "/";
}

function readRequestBody(request: HttpRequest) {
  if (typeof request.body === "string") {
    return request.body;
  }

  if (request.binaryBody) {
    return new TextDecoder().decode(request.binaryBody);
  }

  return "";
}

function parseJsonBody<T>(request: HttpRequest) {
  const body = readRequestBody(request);
  if (!body.trim()) {
    throw new Error("Missing JSON request body.");
  }

  return JSON.parse(body) as T;
}

function getRequestHeader(request: HttpRequest, headerName: string) {
  const needle = headerName.toLowerCase();
  for (const [key, value] of Object.entries(request.headers)) {
    if (key.toLowerCase() === needle) {
      return value;
    }
  }

  return null;
}

function ensureDirectToken(request: HttpRequest, token: string) {
  const provided = getRequestHeader(request, DIRECT_TOKEN_HEADER);
  if (!provided || provided !== token) {
    throw new Error("Unauthorized direct transfer request.");
  }
}

function withBrowserSessionUpdate(browserSession: BrowserShareRuntime, patch: Partial<LocalHttpSession>) {
  browserSession.session = {
    ...browserSession.session,
    ...patch,
    files: patch.files ?? browserSession.session.files,
  };
  browserSession.updateSession?.({ ...browserSession.session });
}

function createBrowserShareUrl(publicHost: string) {
  return `http://${publicHost}:${LOCAL_HTTP_SERVER_PORT}/`;
}

function createBrowserShareSession({
  sessionId,
  deviceName,
  files,
  publicHost,
}: {
  sessionId: string;
  deviceName: string;
  files: SelectedTransferFile[];
  publicHost: string;
}) {
  const shareUrl = createBrowserShareUrl(publicHost);

  return {
    id: sessionId,
    status: "sharing",
    deviceName,
    shareUrl,
    manifestUrl: `${shareUrl}manifest.json`,
    qrValue: shareUrl,
    files: files.map(toTransferManifestFile),
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    startedAt: nowIso(),
    detail: "Preparing files for browser sharing.",
  } satisfies LocalHttpSession;
}

function createBrowserHtmlPage(session: LocalHttpSession, hostedFiles: HostedShareFile[]) {
  const fileItems = hostedFiles
    .map(
      (hostedFile) => `<li class="file-row">
          <a href="${encodeHtml(`${session.shareUrl}${hostedFile.downloadPath.slice(1)}`)}" download="${encodeHtml(hostedFile.source.name)}">${encodeHtml(hostedFile.source.name)}</a>
          <span>${encodeHtml(formatBytes(hostedFile.source.sizeBytes))}</span>
        </li>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${encodeHtml(session.deviceName)} file share</title>
    <style>
      body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f7fb; color: #0f172a; }
      main { max-width: 640px; margin: 0 auto; padding: 32px 20px 48px; }
      .card { background: #ffffff; border: 1px solid rgba(15, 23, 42, 0.08); border-radius: 24px; box-shadow: 0 18px 44px rgba(15, 23, 42, 0.08); padding: 24px; }
      .eyebrow { display: inline-flex; border-radius: 999px; background: rgba(15, 23, 42, 0.06); padding: 6px 10px; font-size: 12px; font-weight: 700; }
      h1 { margin: 16px 0 10px; font-size: 30px; line-height: 1.1; }
      p { color: #475569; line-height: 1.6; margin: 0 0 16px; }
      .meta { display: grid; gap: 10px; margin: 18px 0 24px; }
      .meta-row { display: flex; justify-content: space-between; gap: 16px; font-size: 14px; }
      .meta-row span:first-child { color: #64748b; }
      ul { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
      .file-row { display: flex; justify-content: space-between; gap: 16px; background: #f8fafc; border-radius: 14px; padding: 14px 16px; }
      .file-row a { color: #0f172a; font-weight: 600; text-decoration: none; word-break: break-word; }
      .file-row span { color: #64748b; white-space: nowrap; }
    </style>
  </head>
  <body>
    <main>
      <section class="card">
        <div class="eyebrow">Local browser share</div>
        <h1>${encodeHtml(session.deviceName)}</h1>
        <p>Open this page from another device on the same WiFi network to download the selected files.</p>
        <div class="meta">
          <div class="meta-row"><span>Files</span><span>${session.files.length}</span></div>
          <div class="meta-row"><span>Total size</span><span>${encodeHtml(formatBytes(session.totalBytes))}</span></div>
          <div class="meta-row"><span>Share URL</span><span>${encodeHtml(session.shareUrl)}</span></div>
        </div>
        <ul>${fileItems}</ul>
      </section>
    </main>
  </body>
</html>`;
}

function createBrowserManifest(publicHost: string, browserSession: BrowserShareRuntime) {
  const hostedFiles = Array.from(browserSession.filesById.values());

  return {
    version: 1,
    kind: "local-http-share",
    sessionId: browserSession.session.id,
    deviceName: browserSession.session.deviceName,
    startedAt: browserSession.session.startedAt,
    shareUrl: browserSession.session.shareUrl,
    totalBytes: browserSession.session.totalBytes,
    files: hostedFiles.map((hostedFile) => ({
      id: hostedFile.source.id,
      name: hostedFile.source.name,
      mimeType: hostedFile.source.mimeType,
      sizeBytes: hostedFile.source.sizeBytes,
      downloadUrl: `${createBrowserShareUrl(publicHost)}${hostedFile.downloadPath.slice(1)}`,
    })),
  } satisfies DownloadableTransferManifest;
}

function createDirectManifest(runtime: SharedHttpRuntime, sendSession: DirectSendRuntime) {
  const directBaseUrl = {
    sessionId: sendSession.sessionId,
    host: runtime.publicHost,
    port: LOCAL_HTTP_SERVER_PORT,
  };

  return {
    version: 1,
    kind: "direct-http-transfer",
    sessionId: sendSession.sessionId,
    deviceName: sendSession.deviceName,
    startedAt: sendSession.startedAt,
    shareUrl: buildDirectSessionBaseUrl(directBaseUrl),
    totalBytes: sendSession.files.reduce((sum, file) => sum + file.sizeBytes, 0),
    files: sendSession.files.map((file) => {
      const hostedFile = sendSession.filesById.get(file.id);
      if (!hostedFile) {
        throw new Error(`The file "${file.name}" is no longer available on this device.`);
      }

      return {
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        downloadUrl: buildDirectSessionUrl(
          directBaseUrl,
          `/files/${encodeURIComponent(file.id)}/${encodeURIComponent(file.name)}`,
        ),
      };
    }),
  } satisfies DownloadableTransferManifest;
}

function createBinaryResponse({
  statusCode,
  body,
  method,
  headers,
}: {
  statusCode: number;
  body: Uint8Array;
  method: string;
  headers: Record<string, string>;
}) {
  const responseBody =
    body.byteOffset === 0 && body.byteLength === body.buffer.byteLength && body.buffer instanceof ArrayBuffer
      ? body.buffer
      : (body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer);

  if (method === "HEAD") {
    return {
      statusCode,
      headers,
    } satisfies HttpResponse;
  }

  return {
    statusCode,
    headers,
    body: responseBody,
  } satisfies HttpResponse;
}

async function createFileDownloadResponse({
  file,
  request,
  method,
  attachmentFileName,
  maxBytesPerSecond,
}: {
  attachmentFileName?: string;
  file: SelectedTransferFile;
  maxBytesPerSecond: number | null;
  request: HttpRequest;
  method: string;
}): Promise<HttpResponse> {
  const sourceFile = new File(file.uri);
  const sourceInfo = sourceFile.info();

  if (!sourceInfo.exists) {
    return createTextResponse({
      statusCode: 410,
      body: "The selected file is no longer available on this device.",
      contentType: "text/plain; charset=utf-8",
      method,
    });
  }

  const fileSize = sourceInfo.size ?? file.sizeBytes;
  const range = resolveDirectByteRange(getRequestHeader(request, "Range"), fileSize);
  if ("error" in range) {
    const errorMessage = range.error ?? "Invalid Range header.";
    return createTextResponse({
      statusCode: errorMessage === "Requested range is not satisfiable." ? 416 : 400,
      body: errorMessage,
      contentType: "text/plain; charset=utf-8",
      method,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes */${fileSize}`,
      },
    });
  }

  const contentLength = fileSize === 0 ? 0 : range.end - range.start + 1;
  const headers = {
    ...createDefaultHeaders(file.mimeType || "application/octet-stream", contentLength),
    "Accept-Ranges": "bytes",
    ...(attachmentFileName ? { "Content-Disposition": createAttachmentContentDisposition(attachmentFileName) } : {}),
    ...(range.partial && fileSize > 0 ? { "Content-Range": `bytes ${range.start}-${range.end}/${fileSize}` } : {}),
  };

  if (contentLength === 0) {
    return createBinaryResponse({
      statusCode: range.partial ? 206 : 200,
      body: new Uint8Array(0),
      method,
      headers,
    });
  }

  if (method === "HEAD") {
    return createBinaryResponse({
      statusCode: range.partial ? 206 : 200,
      body: new Uint8Array(0),
      method,
      headers,
    });
  }

  const startedAt = Date.now();
  const handle = sourceFile.open();

  try {
    handle.offset = range.start;
    const bytes = handle.readBytes(contentLength);

    await throttleTransferBytes({
      bytesTransferred: bytes.byteLength,
      maxBytesPerSecond,
      startedAt,
    });

    return createBinaryResponse({
      statusCode: range.partial ? 206 : 200,
      body: bytes,
      method,
      headers,
    });
  } finally {
    handle.close();
  }
}

function createServerConfig() {
  return {
    mounts: [],
  } satisfies ServerConfig;
}

async function startRuntimeServer(runtime: SharedHttpRuntime) {
  const server = new ConfigServer();
  const started = await server.start(
    LOCAL_HTTP_SERVER_PORT,
    (request) => handleRequest(runtime, request),
    createServerConfig(),
    runtime.publicHost,
  );

  if (!started) {
    throw new Error(`Unable to start the local HTTP server on port ${LOCAL_HTTP_SERVER_PORT}.`);
  }

  runtime.server = server;
}

async function stopRuntimeServer(runtime: SharedHttpRuntime) {
  if (!runtime.server) {
    return;
  }

  await runtime.server.stop().catch(() => {});
  runtime.server = null;
}

async function refreshRuntimeServer(runtime: SharedHttpRuntime) {
  await stopRuntimeServer(runtime);
  await startRuntimeServer(runtime);
}

async function finalizeBrowserSession({
  runtime,
  status,
  detail,
}: {
  runtime: SharedHttpRuntime;
  status: LocalHttpSession["status"];
  detail: string;
}) {
  const browserSession = runtime.browserSession;
  if (!browserSession || browserSession.finalizing) {
    return;
  }

  browserSession.finalizing = true;
  withBrowserSessionUpdate(browserSession, {
    status,
    detail,
  });
  runtime.browserSession = null;
  await deactivateKeepAwake(LOCAL_HTTP_SHARE_KEEP_AWAKE_TAG).catch(() => {});
  browserSession.onFinalized?.({ ...browserSession.session });
}

async function interruptDirectSessions(runtime: SharedHttpRuntime, detail: string) {
  if (runtime.directReceivers.size === 0 && runtime.directSenders.size === 0) {
    return;
  }

  const callbacks = [
    ...Array.from(runtime.directReceivers.values(), (value) => value.onInterrupted),
    ...Array.from(runtime.directSenders.values(), (value) => value.onInterrupted),
  ].filter((value): value is NonNullable<typeof value> => Boolean(value));

  runtime.directReceivers.clear();
  runtime.directSenders.clear();

  await Promise.allSettled(callbacks.map((callback) => callback(detail)));
}

async function stopSharedRuntime(runtime: SharedHttpRuntime) {
  if (activeRuntime !== runtime) {
    return;
  }

  activeRuntime = null;
  await stopRuntimeServer(runtime);
}

async function maybeStopIdleRuntime(runtime: SharedHttpRuntime) {
  if (runtime.browserSession || runtime.directReceivers.size > 0 || runtime.directSenders.size > 0) {
    return;
  }

  await stopSharedRuntime(runtime);
}

async function ensureRuntime(kind: "browser" | "direct") {
  const publicHost = await getLanShareHost();

  if (activeRuntime && activeRuntime.publicHost !== publicHost) {
    await finalizeBrowserSession({
      runtime: activeRuntime,
      status: "stopped",
      detail: "Local HTTP service restarted because the WiFi address changed.",
    });
    await interruptDirectSessions(activeRuntime, "Local transfer stopped because the WiFi address changed.");
    await stopSharedRuntime(activeRuntime);
  }

  if (!activeRuntime) {
    const runtime: SharedHttpRuntime = {
      server: null,
      publicHost,
      browserSession: null,
      directReceivers: new Map(),
      directSenders: new Map(),
    };

    await startRuntimeServer(runtime);
    activeRuntime = runtime;
  }

  if (kind === "browser") {
    await interruptDirectSessions(activeRuntime, "Local transfer stopped because browser sharing started.");
  } else if (activeRuntime.browserSession) {
    await finalizeBrowserSession({
      runtime: activeRuntime,
      status: "stopped",
      detail: "Browser sharing stopped because a local transfer started.",
    });
    await refreshRuntimeServer(activeRuntime);
  }

  return activeRuntime;
}

function toDirectPeerAccess(sessionId: string, token: string, publicHost: string): DirectPeerAccess {
  return {
    sessionId,
    host: publicHost,
    port: LOCAL_HTTP_SERVER_PORT,
    token,
  };
}

function findBrowserHostedFile(browserSession: BrowserShareRuntime, path: string) {
  for (const hostedFile of browserSession.filesById.values()) {
    if (hostedFile.downloadPath === path) {
      return hostedFile;
    }
  }

  return null;
}

async function handleBrowserShareRequest(runtime: SharedHttpRuntime, request: HttpRequest) {
  const browserSession = runtime.browserSession;
  if (!browserSession) {
    return null;
  }

  const method = request.method.toUpperCase();
  const path = getRequestPath(request.path);

  if (!["GET", "HEAD"].includes(method)) {
    return null;
  }

  if (path === "/") {
    return createTextResponse({
      statusCode: 200,
      body: createBrowserHtmlPage(browserSession.session, Array.from(browserSession.filesById.values())),
      contentType: "text/html; charset=utf-8",
      method,
    });
  }

  if (path === "/manifest.json") {
    return createJsonResponse({
      statusCode: 200,
      body: createBrowserManifest(runtime.publicHost, browserSession),
      method,
    });
  }

  const hostedFile = findBrowserHostedFile(browserSession, path);
  if (hostedFile) {
    return createFileDownloadResponse({
      file: hostedFile.source,
      request,
      method,
      attachmentFileName: hostedFile.source.name,
      maxBytesPerSecond: browserSession.transferPolicy.maxBytesPerSecond,
    });
  }

  return null;
}

async function handleDirectRequest(runtime: SharedHttpRuntime, request: HttpRequest) {
  const method = request.method.toUpperCase();
  const pathSegments = getRequestPath(request.path).split("/").filter(Boolean);

  if (pathSegments[0] !== "direct") {
    return null;
  }

  if (pathSegments[1] === "discovery" && ["GET", "HEAD"].includes(method)) {
    return createJsonResponse({
      statusCode: 200,
      body: createNearbyDiscoveryResponse(
        Array.from(runtime.directReceivers.values())
          .filter((value) => value.canAcceptOffer?.() ?? true)
          .map((value) => value.discoveryRecord),
      ),
      method,
    });
  }

  if (pathSegments[1] !== "sessions" || !pathSegments[2]) {
    return null;
  }

  const sessionId = decodeURIComponent(pathSegments[2]);
  const directReceiver = runtime.directReceivers.get(sessionId) ?? null;
  const directSender = runtime.directSenders.get(sessionId) ?? null;

  if (!directReceiver && !directSender) {
    return createTextResponse({
      statusCode: 404,
      body: "Direct transfer session not found.",
      contentType: "text/plain; charset=utf-8",
      method,
    });
  }

  try {
    if (pathSegments[3] === "offers" && method === "POST" && directReceiver) {
      ensureDirectToken(request, directReceiver.discoveryRecord.token);
      const payload = parseJsonBody<{ offer: IncomingTransferOffer }>(request);
      const decision = await directReceiver.onOffer(payload.offer);

      if (!decision.accepted) {
        return createJsonResponse({
          statusCode: decision.statusCode ?? 409,
          body: {
            error: decision.message ?? "That receiver is busy right now.",
          },
          method,
        });
      }

      return createJsonResponse({
        statusCode: 200,
        body: {
          ok: true,
        },
        method,
      });
    }

    if (pathSegments[3] === "events" && method === "POST") {
      const handler = directReceiver?.onEvent ?? directSender?.onEvent;
      const token = directReceiver?.discoveryRecord.token ?? directSender?.token;

      if (!handler || !token) {
        throw new Error("Direct transfer session not found.");
      }

      ensureDirectToken(request, token);
      const payload = parseJsonBody<{ event: unknown }>(request);
      await handler(payload.event);

      return createJsonResponse({
        statusCode: 200,
        body: {
          ok: true,
        },
        method,
      });
    }

    if (pathSegments[3] === "manifest" && ["GET", "HEAD"].includes(method) && directSender) {
      ensureDirectToken(request, directSender.token);
      return createJsonResponse({
        statusCode: 200,
        body: createDirectManifest(runtime, directSender),
        method,
      });
    }

    if (pathSegments[3] === "files" && pathSegments[4] && ["GET", "HEAD"].includes(method) && directSender) {
      ensureDirectToken(request, directSender.token);
      const fileId = decodeURIComponent(pathSegments[4]);
      const hostedFile = directSender.filesById.get(fileId);
      if (!hostedFile) {
        return createTextResponse({
          statusCode: 404,
          body: "File not found.",
          contentType: "text/plain; charset=utf-8",
          method,
        });
      }

      return createFileDownloadResponse({
        file: hostedFile.source,
        maxBytesPerSecond: directSender.transferPolicy.maxBytesPerSecond,
        request,
        method,
      });
    }

    return createEmptyResponse({
      statusCode: 405,
      method,
      headers: {
        Allow: "GET, HEAD, POST",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to handle direct transfer request.";
    const statusCode =
      message === "Unauthorized direct transfer request."
        ? 401
        : message === "Direct transfer session not found."
          ? 404
          : 400;

    return createJsonResponse({
      statusCode,
      body: {
        error: message,
      },
      method,
    });
  }
}

async function handleRequest(runtime: SharedHttpRuntime, request: HttpRequest) {
  const browserResponse = await handleBrowserShareRequest(runtime, request);
  if (browserResponse) {
    return browserResponse;
  }

  const directResponse = await handleDirectRequest(runtime, request);
  if (directResponse) {
    return directResponse;
  }

  return createTextResponse({
    statusCode: 404,
    body: "Not found.",
    contentType: "text/plain; charset=utf-8",
    method: request.method.toUpperCase(),
  });
}

function validateSelectedFiles(files: SelectedTransferFile[], emptyFilesMessage: string) {
  if (files.length === 0) {
    throw new Error(emptyFilesMessage);
  }

  for (const file of files) {
    const sourceFile = new File(file.uri);
    const sourceInfo = sourceFile.info();
    if (!sourceInfo.exists) {
      throw new Error(`The file "${file.name}" is no longer available on this device.`);
    }
  }
}

export async function startLocalHttpSession({
  sessionId = Crypto.randomUUID(),
  files,
  deviceName,
  isPremium,
  updateSession,
  onFinalized,
}: {
  sessionId?: string;
  files: SelectedTransferFile[];
  deviceName: string;
  isPremium: boolean;
  updateSession?: LocalHttpSessionUpdate;
  onFinalized?: (session: LocalHttpSession) => void;
}) {
  validateSelectedFiles(files, "Pick at least one file to start browser sharing.");
  const transferPolicy = assertSelectedFilesTransferAllowed(files, isPremium, "share");

  const runtime = await ensureRuntime("browser");
  if (runtime.browserSession) {
    await finalizeBrowserSession({
      runtime,
      status: "stopped",
      detail: "Browser sharing stopped.",
    });
  }

  const browserSession: BrowserShareRuntime = {
    session: createBrowserShareSession({
      sessionId,
      deviceName,
      files,
      publicHost: runtime.publicHost,
    }),
    filesById: new Map(
      buildBrowserHostedFiles(sessionId, files).map((hostedFile) => [hostedFile.source.id, hostedFile]),
    ),
    transferPolicy,
    updateSession,
    finalizing: false,
    onFinalized,
  };

  runtime.browserSession = browserSession;
  try {
    await refreshRuntimeServer(runtime);
  } catch (error) {
    runtime.browserSession = null;
    throw error;
  }
  await activateKeepAwakeAsync(LOCAL_HTTP_SHARE_KEEP_AWAKE_TAG).catch(() => {});

  withBrowserSessionUpdate(browserSession, {
    status: "sharing",
    detail: "Browser sharing is active on local WiFi.",
  });

  updateSession?.({ ...browserSession.session });
  return browserSession.session;
}

export async function stopLocalHttpSession(sessionId: string, detail = "Browser sharing stopped.") {
  const runtime = activeRuntime;
  if (!runtime?.browserSession || runtime.browserSession.session.id !== sessionId) {
    return;
  }

  await finalizeBrowserSession({
    runtime,
    status: "stopped",
    detail,
  });
  if (runtime.directReceivers.size > 0 || runtime.directSenders.size > 0) {
    await refreshRuntimeServer(runtime);
    return;
  }

  await maybeStopIdleRuntime(runtime);
}

export async function registerDirectReceiveSession({
  sessionId,
  token,
  deviceName,
  serviceName,
  canAcceptOffer,
  onOffer,
  onEvent,
  onInterrupted,
}: RegisterDirectReceiveSessionOptions) {
  const runtime = await ensureRuntime("direct");
  runtime.directReceivers.set(sessionId, {
    discoveryRecord: createDiscoveryRecord({
      sessionId,
      method: "nearby",
      deviceName,
      host: runtime.publicHost,
      port: LOCAL_HTTP_SERVER_PORT,
      token,
      serviceName,
    }),
    canAcceptOffer,
    onOffer,
    onEvent,
    onInterrupted,
  });

  return toDirectPeerAccess(sessionId, token, runtime.publicHost);
}

export async function unregisterDirectReceiveSession(sessionId: string) {
  const runtime = activeRuntime;
  if (!runtime) {
    return;
  }

  runtime.directReceivers.delete(sessionId);
  await maybeStopIdleRuntime(runtime);
}

export async function updateDirectReceiveServiceName(sessionId: string, serviceName: string | null) {
  const runtime = activeRuntime;
  const receiver = runtime?.directReceivers.get(sessionId);
  if (!runtime || !receiver) {
    return;
  }

  runtime.directReceivers.set(sessionId, {
    ...receiver,
    discoveryRecord: {
      ...receiver.discoveryRecord,
      serviceName,
    },
  });
}

export async function registerDirectSendSession({
  sessionId,
  token,
  deviceName,
  startedAt,
  files,
  transferPolicy,
  onEvent,
  onInterrupted,
}: RegisterDirectSendSessionOptions) {
  validateSelectedFiles(files, "Pick at least one file to start a local transfer.");

  const runtime = await ensureRuntime("direct");
  runtime.directSenders.set(sessionId, {
    sessionId,
    token,
    deviceName,
    startedAt,
    files,
    filesById: new Map(
      buildDirectHostedFiles({ sessionId, token, files }).map((hostedFile) => [hostedFile.source.id, hostedFile]),
    ),
    transferPolicy,
    onEvent,
    onInterrupted,
  });
  try {
    await refreshRuntimeServer(runtime);
  } catch (error) {
    runtime.directSenders.delete(sessionId);
    await maybeStopIdleRuntime(runtime);
    throw error;
  }

  return toDirectPeerAccess(sessionId, token, runtime.publicHost);
}

export async function unregisterDirectSendSession(sessionId: string) {
  const runtime = activeRuntime;
  if (!runtime) {
    return;
  }

  runtime.directSenders.delete(sessionId);
  if (runtime.browserSession || runtime.directReceivers.size > 0 || runtime.directSenders.size > 0) {
    await refreshRuntimeServer(runtime);
    return;
  }

  await maybeStopIdleRuntime(runtime);
}
