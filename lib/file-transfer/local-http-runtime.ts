import * as Crypto from "expo-crypto";
import { File } from "expo-file-system";
import * as Network from "expo-network";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { HttpServer, type HttpRequest, type HttpResponse } from "react-native-nitro-http-server";
import { LOCAL_HTTP_SERVER_PORT, LOCAL_HTTP_SHARE_KEEP_AWAKE_TAG } from "./constants";
import { formatBytes } from "./files";
import type {
  DownloadableTransferManifest,
  HttpShareStatus,
  SelectedTransferFile,
  TransferManifestFile,
} from "./types";

export type LocalHttpSessionMode = "browser" | "direct";

export interface LocalHttpSession {
  id: string;
  mode: LocalHttpSessionMode;
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

interface HostedShareFile {
  source: SelectedTransferFile;
  downloadPath: string;
}

interface LocalHttpRequestContext {
  session: LocalHttpSession;
  manifestPath: string;
  filesById: Map<string, HostedShareFile>;
}

interface LocalHttpRuntime {
  session: LocalHttpSession;
  server: HttpServer;
  requestContext: LocalHttpRequestContext;
  keepAwakeTag: string;
  updateSession?: LocalHttpSessionUpdate;
  finalizing: boolean;
  onFinalized?: (session: LocalHttpSession) => void;
}

const CACHE_CONTROL_HEADER = "no-store";

let activeRuntime: LocalHttpRuntime | null = null;

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

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function withSessionUpdate(runtime: LocalHttpRuntime, patch: Partial<LocalHttpSession>) {
  runtime.session = {
    ...runtime.session,
    ...patch,
    files: patch.files ?? runtime.session.files,
  };
  runtime.requestContext = {
    ...runtime.requestContext,
    session: runtime.session,
  };
  runtime.updateSession?.({ ...runtime.session });
}

function normalizeRequestPath(path: string) {
  const cleanPath = path.split("?")[0] ?? "/";
  return cleanPath.trim() || "/";
}

function getDownloadPath(file: SelectedTransferFile) {
  return `/files/${encodeURIComponent(file.id)}/${encodeURIComponent(sanitizeFileName(file.name))}`;
}

function getDownloadUrl(session: LocalHttpSession, hostedFile: HostedShareFile) {
  return `${session.shareUrl}${hostedFile.downloadPath.slice(1)}`;
}

function createHtmlPage(session: LocalHttpSession, hostedFiles: HostedShareFile[]) {
  const fileItems = hostedFiles
    .map(
      (hostedFile) => `<li class="file-row">
          <a href="${encodeHtml(getDownloadUrl(session, hostedFile))}" download="${encodeHtml(hostedFile.source.name)}">${encodeHtml(hostedFile.source.name)}</a>
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

function createManifest({
  session,
  hostedFiles,
}: {
  session: LocalHttpSession;
  hostedFiles: HostedShareFile[];
}) {
  return {
    version: 1,
    kind: session.mode === "browser" ? "local-http-share" : "direct-http-transfer",
    sessionId: session.id,
    deviceName: session.deviceName,
    startedAt: session.startedAt,
    shareUrl: session.shareUrl,
    totalBytes: session.totalBytes,
    files: hostedFiles.map((hostedFile) => ({
      id: hostedFile.source.id,
      name: hostedFile.source.name,
      mimeType: hostedFile.source.mimeType,
      sizeBytes: hostedFile.source.sizeBytes,
      downloadUrl: getDownloadUrl(session, hostedFile),
    })),
  } satisfies DownloadableTransferManifest;
}

function createManifestPath(mode: LocalHttpSessionMode) {
  return mode === "browser" ? "/manifest.json" : `/manifest-${Crypto.randomUUID().replaceAll("-", "")}.json`;
}

function createInitialSession({
  sessionId,
  deviceName,
  files,
  mode,
  port,
  publicHost,
  manifestPath,
}: {
  sessionId: string;
  deviceName: string;
  files: SelectedTransferFile[];
  mode: LocalHttpSessionMode;
  port: number;
  publicHost: string;
  manifestPath: string;
}) {
  const shareUrl = `http://${publicHost}:${port}/`;

  return {
    id: sessionId,
    mode,
    status: "sharing",
    deviceName,
    shareUrl,
    manifestUrl: `${shareUrl}${manifestPath.slice(1)}`,
    qrValue: mode === "browser" ? shareUrl : `${shareUrl}${manifestPath.slice(1)}`,
    files: files.map(toTransferManifestFile),
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    startedAt: nowIso(),
    detail: mode === "browser" ? "Preparing files for browser sharing." : "Preparing files for local transfer.",
  } satisfies LocalHttpSession;
}

function validateSelectedFiles(files: SelectedTransferFile[]) {
  for (const file of files) {
    const sourceFile = new File(file.uri);
    const sourceInfo = sourceFile.info();
    if (!sourceInfo.exists) {
      throw new Error(`The file "${file.name}" is no longer available on this device.`);
    }
  }
}

function buildHostedFiles(files: SelectedTransferFile[]) {
  return files.map((file) => ({
    source: file,
    downloadPath: getDownloadPath(file),
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

function createRequestHandler(context: LocalHttpRequestContext) {
  const hostedFiles = Array.from(context.filesById.values());

  return async (request: HttpRequest) => {
    const method = request.method.toUpperCase();
    const path = normalizeRequestPath(request.path);

    if (!["GET", "HEAD"].includes(method)) {
      return createEmptyResponse({
        statusCode: 405,
        method,
        headers: {
          Allow: "GET, HEAD",
        },
      });
    }

    if (path === "/" && context.session.mode === "browser") {
      const body = createHtmlPage(context.session, hostedFiles);
      return createTextResponse({
        statusCode: 200,
        body,
        contentType: "text/html; charset=utf-8",
        method,
      });
    }

    if (path === context.manifestPath) {
      const body = JSON.stringify(
        createManifest({
          session: context.session,
          hostedFiles,
        }),
      );

      return createTextResponse({
        statusCode: 200,
        body,
        contentType: "application/json; charset=utf-8",
        method,
      });
    }

    const pathSegments = path.split("/").filter(Boolean);
    if (pathSegments[0] === "files" && pathSegments[1]) {
      const fileId = decodeURIComponent(pathSegments[1]);
      const hostedFile = context.filesById.get(fileId);
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

    return createTextResponse({
      statusCode: 404,
      body: "Not found.",
      contentType: "text/plain; charset=utf-8",
      method,
    });
  };
}

function getFailureDetail(error: unknown) {
  return error instanceof Error ? error.message : "Local transfer server failed.";
}

async function finalizeRuntime({
  runtime,
  status,
  detail,
  stopServer,
}: {
  runtime: LocalHttpRuntime;
  status: LocalHttpSession["status"];
  detail: string;
  stopServer: boolean;
}) {
  if (runtime.finalizing) {
    return;
  }

  runtime.finalizing = true;
  withSessionUpdate(runtime, {
    status,
    detail,
  });

  if (activeRuntime?.session.id === runtime.session.id) {
    activeRuntime = null;
  }

  if (stopServer) {
    await runtime.server.stop().catch(() => {});
  }

  await deactivateKeepAwake(runtime.keepAwakeTag).catch(() => {});
  runtime.onFinalized?.({ ...runtime.session });
}

async function startNitroHttpServer({
  publicHost,
  sessionId,
  deviceName,
  files,
  mode,
}: {
  publicHost: string;
  sessionId: string;
  deviceName: string;
  files: SelectedTransferFile[];
  mode: LocalHttpSessionMode;
}) {
  const manifestPath = createManifestPath(mode);
  const session = createInitialSession({
    sessionId,
    deviceName,
    files,
    mode,
    port: LOCAL_HTTP_SERVER_PORT,
    publicHost,
    manifestPath,
  });
  const hostedFiles = buildHostedFiles(files);
  const requestContext: LocalHttpRequestContext = {
    session,
    manifestPath,
    filesById: new Map(hostedFiles.map((hostedFile) => [hostedFile.source.id, hostedFile])),
  };
  const server = new HttpServer();

  try {
    const started = await server.start(
      LOCAL_HTTP_SERVER_PORT,
      createRequestHandler(requestContext),
      publicHost,
    );
    if (!started) {
      throw new Error(`Unable to start the local HTTP server on port ${LOCAL_HTTP_SERVER_PORT}.`);
    }

    return {
      session,
      server,
      requestContext,
    };
  } catch (error) {
    await server.stop().catch(() => {});
    if (error instanceof Error) {
      throw error;
    }

    throw new Error(`Unable to start the local HTTP server on port ${LOCAL_HTTP_SERVER_PORT}.`, {
      cause: error,
    });
  }
}

export async function startLocalHttpSession({
  sessionId = Crypto.randomUUID(),
  files,
  deviceName,
  mode,
  keepAwakeTag = LOCAL_HTTP_SHARE_KEEP_AWAKE_TAG,
  updateSession,
  onFinalized,
}: {
  sessionId?: string;
  files: SelectedTransferFile[];
  deviceName: string;
  mode: LocalHttpSessionMode;
  keepAwakeTag?: string;
  updateSession?: LocalHttpSessionUpdate;
  onFinalized?: (session: LocalHttpSession) => void;
}) {
  if (files.length === 0) {
    throw new Error(
      mode === "browser" ? "Pick at least one file to start browser sharing." : "Pick at least one file to start a local transfer.",
    );
  }

  if (activeRuntime) {
    await finalizeRuntime({
      runtime: activeRuntime,
      status: "stopped",
      detail: activeRuntime.session.mode === "browser" ? "Browser sharing stopped." : "Local transfer server stopped.",
      stopServer: true,
    });
  }

  validateSelectedFiles(files);
  const publicHost = await getLanShareHost();

  let runtime: LocalHttpRuntime | null = null;

  try {
    const startedRuntime = await startNitroHttpServer({
      publicHost,
      sessionId,
      deviceName,
      files,
      mode,
    });

    runtime = {
      session: startedRuntime.session,
      server: startedRuntime.server,
      requestContext: startedRuntime.requestContext,
      keepAwakeTag,
      updateSession,
      finalizing: false,
      onFinalized,
    };

    activeRuntime = runtime;
    await activateKeepAwakeAsync(keepAwakeTag).catch(() => {});

    withSessionUpdate(runtime, {
      status: "sharing",
      detail: mode === "browser" ? "Browser sharing is active on local WiFi." : "Local transfer server is active on local WiFi.",
    });

    updateSession?.({ ...runtime.session });
    return runtime.session;
  } catch (error) {
    if (runtime) {
      await finalizeRuntime({
        runtime,
        status: "failed",
        detail: getFailureDetail(error),
        stopServer: true,
      });
    } else {
      await deactivateKeepAwake(keepAwakeTag).catch(() => {});
    }

    throw error;
  }
}

export async function stopLocalHttpSession(sessionId: string, detail?: string) {
  if (!activeRuntime || activeRuntime.session.id !== sessionId) {
    return;
  }

  await finalizeRuntime({
    runtime: activeRuntime,
    status: "stopped",
    detail: detail ?? (activeRuntime.session.mode === "browser" ? "Browser sharing stopped." : "Local transfer server stopped."),
    stopServer: true,
  });
}
