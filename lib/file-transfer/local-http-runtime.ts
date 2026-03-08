import * as Crypto from "expo-crypto";
import { File } from "expo-file-system";
import * as Network from "expo-network";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { HttpServer, type HttpRequest, type HttpResponse } from "react-native-nitro-http-server";
import { LOCAL_HTTP_SERVER_PORT, LOCAL_HTTP_SHARE_KEEP_AWAKE_TAG } from "./constants";
import { formatBytes } from "./files";
import type {
  DirectPeerAccess,
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
  updateSession?: LocalHttpSessionUpdate;
  finalizing: boolean;
  onFinalized?: (session: LocalHttpSession) => void;
}

interface DirectReceiveRuntime {
  sessionId: string;
  token: string;
  deviceName: string;
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
  onEvent: RegisterDirectSendSessionOptions["onEvent"];
  onInterrupted?: RegisterDirectSendSessionOptions["onInterrupted"];
}

interface SharedHttpRuntime {
  server: HttpServer;
  publicHost: string;
  browserSession: BrowserShareRuntime | null;
  directReceivers: Map<string, DirectReceiveRuntime>;
  directSenders: Map<string, DirectSendRuntime>;
}

const CACHE_CONTROL_HEADER = "no-store";
const DIRECT_TOKEN_HEADER = "x-direct-token";

let activeRuntime: SharedHttpRuntime | null = null;

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

function sanitizeFileName(value: string) {
  const sanitized = value.replace(/[^\w.\-() ]+/g, "_").trim();
  return sanitized || "file";
}

function encodeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function encodeHeaderFilename(value: string) {
  const safe = value.replace(/["\\\r\n]/g, "_");
  return `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(value)}`;
}

function toTransferManifestFile(file: SelectedTransferFile): TransferManifestFile {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
  };
}

function buildHostedFiles(files: SelectedTransferFile[]) {
  return files.map((file) => ({
    source: file,
    downloadPath: `/files/${encodeURIComponent(file.id)}/${encodeURIComponent(sanitizeFileName(file.name))}`,
  })) satisfies HostedShareFile[];
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

function createDirectFilePath(sessionId: string, file: SelectedTransferFile) {
  return `/direct/sessions/${encodeURIComponent(sessionId)}/files/${encodeURIComponent(file.id)}/${encodeURIComponent(sanitizeFileName(file.name))}`;
}

function createDirectManifest(runtime: SharedHttpRuntime, sendSession: DirectSendRuntime) {
  return {
    version: 1,
    kind: "direct-http-transfer",
    sessionId: sendSession.sessionId,
    deviceName: sendSession.deviceName,
    startedAt: sendSession.startedAt,
    shareUrl: `http://${runtime.publicHost}:${LOCAL_HTTP_SERVER_PORT}/direct/sessions/${sendSession.sessionId}/`,
    totalBytes: sendSession.files.reduce((sum, file) => sum + file.sizeBytes, 0),
    files: sendSession.files.map((file) => ({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      downloadUrl: `http://${runtime.publicHost}:${LOCAL_HTTP_SERVER_PORT}${createDirectFilePath(sendSession.sessionId, file)}`,
    })),
  } satisfies DownloadableTransferManifest;
}

async function createFileResponse({
  file,
  method,
}: {
  file: SelectedTransferFile;
  method: string;
}) {
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

  const contentLength = sourceInfo.size ?? file.sizeBytes;
  const headers = {
    ...createDefaultHeaders(file.mimeType || "application/octet-stream", contentLength),
    "Content-Disposition": encodeHeaderFilename(file.name),
  };

  if (method === "HEAD") {
    return {
      statusCode: 200,
      headers,
    } satisfies HttpResponse;
  }

  const bytes = await sourceFile.bytes();
  const body =
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

  return {
    statusCode: 200,
    headers,
    body,
  } satisfies HttpResponse;
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
  await runtime.server.stop().catch(() => {});
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
      server: new HttpServer(),
      publicHost,
      browserSession: null,
      directReceivers: new Map(),
      directSenders: new Map(),
    };

    const started = await runtime.server.start(
      LOCAL_HTTP_SERVER_PORT,
      (request) => handleRequest(runtime, request),
      publicHost,
    );

    if (!started) {
      throw new Error(`Unable to start the local HTTP server on port ${LOCAL_HTTP_SERVER_PORT}.`);
    }

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

function handleBrowserShareRequest(runtime: SharedHttpRuntime, request: HttpRequest) {
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

  const pathSegments = path.split("/").filter(Boolean);
  if (pathSegments[0] === "files" && pathSegments[1]) {
    const fileId = decodeURIComponent(pathSegments[1]);
    const hostedFile = browserSession.filesById.get(fileId);
    if (!hostedFile) {
      return createTextResponse({
        statusCode: 404,
        body: "File not found.",
        contentType: "text/plain; charset=utf-8",
        method,
      });
    }

    return createFileResponse({
      file: hostedFile.source,
      method,
    });
  }

  return null;
}

async function handleDirectRequest(runtime: SharedHttpRuntime, request: HttpRequest) {
  const method = request.method.toUpperCase();
  const pathSegments = getRequestPath(request.path).split("/").filter(Boolean);

  if (pathSegments[0] !== "direct" || pathSegments[1] !== "sessions" || !pathSegments[2]) {
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
      ensureDirectToken(request, directReceiver.token);
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
      const token = directReceiver?.token ?? directSender?.token;

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

      return createFileResponse({
        file: hostedFile.source,
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
  const browserResponse = handleBrowserShareRequest(runtime, request);
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
  updateSession,
  onFinalized,
}: {
  sessionId?: string;
  files: SelectedTransferFile[];
  deviceName: string;
  updateSession?: LocalHttpSessionUpdate;
  onFinalized?: (session: LocalHttpSession) => void;
}) {
  validateSelectedFiles(files, "Pick at least one file to start browser sharing.");

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
    filesById: new Map(buildHostedFiles(files).map((hostedFile) => [hostedFile.source.id, hostedFile])),
    updateSession,
    finalizing: false,
    onFinalized,
  };

  runtime.browserSession = browserSession;
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
  await maybeStopIdleRuntime(runtime);
}

export async function registerDirectReceiveSession({
  sessionId,
  token,
  deviceName,
  onOffer,
  onEvent,
  onInterrupted,
}: RegisterDirectReceiveSessionOptions) {
  const runtime = await ensureRuntime("direct");
  runtime.directReceivers.set(sessionId, {
    sessionId,
    token,
    deviceName,
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

export async function registerDirectSendSession({
  sessionId,
  token,
  deviceName,
  startedAt,
  files,
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
    filesById: new Map(buildHostedFiles(files).map((hostedFile) => [hostedFile.source.id, hostedFile])),
    onEvent,
    onInterrupted,
  });

  return toDirectPeerAccess(sessionId, token, runtime.publicHost);
}

export async function unregisterDirectSendSession(sessionId: string) {
  const runtime = activeRuntime;
  if (!runtime) {
    return;
  }

  runtime.directSenders.delete(sessionId);
  await maybeStopIdleRuntime(runtime);
}
