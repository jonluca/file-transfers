import { Buffer } from "buffer";
import * as Crypto from "expo-crypto";
import { File } from "expo-file-system";
import * as Network from "expo-network";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { LOCAL_HTTP_SHARE_KEEP_AWAKE_TAG, LOCAL_TRANSFER_CHUNK_SIZE_BYTES } from "./constants";
import { formatBytes } from "./files";
import type { HttpShareSession, SelectedTransferFile } from "./types";

type HttpShareSessionUpdate = (session: HttpShareSession) => void;

interface TransferSocket {
  destroy(): void;
  end(data?: Uint8Array | Buffer | string): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  off?(event: string, handler: (...args: unknown[]) => void): void;
  setNoDelay?(noDelay?: boolean): void;
  writableNeedDrain?: boolean;
  write(buffer: Uint8Array | Buffer | string, cb?: (error?: Error) => void): boolean;
}

interface TransferServer {
  on?(event: string, handler: (...args: unknown[]) => void): void;
  once?(event: string, handler: (...args: unknown[]) => void): void;
  off?(event: string, handler: (...args: unknown[]) => void): void;
  listen(options: { port: number; host: string; reuseAddress: boolean }, callback: () => void): void;
  close(callback?: (error?: Error) => void): void;
  address(): { port?: number } | null;
}

interface TcpSocketLike {
  createServer: (
    options?: unknown,
    connectionListener?: (socket: TransferSocket) => void,
  ) => TransferServer;
}

interface HttpShareRuntime {
  session: HttpShareSession;
  server: TransferServer;
  sockets: Set<TransferSocket>;
  stopped: boolean;
  updateSession?: HttpShareSessionUpdate;
}

interface ParsedHttpRequest {
  method: string;
  path: string;
}

const MAX_HEADER_BYTES = 16 * 1024;
const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  400: "Bad Request",
  404: "Not Found",
  405: "Method Not Allowed",
  410: "Gone",
  500: "Internal Server Error",
};

let activeRuntime: HttpShareRuntime | null = null;

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
    throw new Error("Connect this device to local WiFi before starting browser sharing.");
  }

  return ipAddress;
}

async function loadTcpSocket() {
  try {
    const module = (await import("react-native-tcp-socket")) as unknown as { default?: TcpSocketLike };
    return (module.default ?? module) as TcpSocketLike;
  } catch (error) {
    console.warn("react-native-tcp-socket unavailable for local browser sharing", error);
    throw new Error("Local browser sharing is unavailable on this build.", {
      cause: error,
    });
  }
}

function withSessionUpdate(runtime: HttpShareRuntime, patch: Partial<HttpShareSession>) {
  runtime.session = {
    ...runtime.session,
    ...patch,
    files: patch.files ?? runtime.session.files,
  };
  runtime.updateSession?.({ ...runtime.session });
}

function encodeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toBuffer(value: Uint8Array | Buffer | string) {
  if (typeof value === "string") {
    return Buffer.from(value, "utf8");
  }

  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

async function waitForDrain(socket: TransferSocket) {
  if (!socket.writableNeedDrain) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const handleDrain = () => {
      cleanup();
      resolve();
    };
    const handleError = (error?: unknown) => {
      cleanup();
      reject(error instanceof Error ? error : new Error("Socket write failed."));
    };
    const handleClose = () => {
      cleanup();
      reject(new Error("Socket closed before the response finished."));
    };
    const cleanup = () => {
      socket.off?.("drain", handleDrain);
      socket.off?.("error", handleError);
      socket.off?.("close", handleClose);
    };

    socket.on("drain", handleDrain);
    socket.on("error", handleError);
    socket.on("close", handleClose);
  });
}

async function writeSocketSafe(socket: TransferSocket, payload: Uint8Array | Buffer | string) {
  await new Promise<void>((resolve, reject) => {
    let callbackCompleted = false;
    let drainCompleted = false;
    const didFlush = socket.write(payload, (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }

      callbackCompleted = true;

      if (didFlush) {
        resolve();
      } else if (drainCompleted) {
        resolve();
      }
    });

    if (!didFlush) {
      void waitForDrain(socket)
        .then(() => {
          drainCompleted = true;

          if (callbackCompleted) {
            resolve();
          }
        })
        .catch(reject);
    }
  });
}

function getStatusText(statusCode: number) {
  return STATUS_TEXT[statusCode] ?? "OK";
}

function buildResponseHead(statusCode: number, headers: Record<string, string>) {
  const baseHeaders = {
    Connection: "close",
    "Cache-Control": "no-store",
    ...headers,
  };
  const headerLines = Object.entries(baseHeaders).map(([key, value]) => `${key}: ${value}`);
  return `HTTP/1.1 ${statusCode} ${getStatusText(statusCode)}\r\n${headerLines.join("\r\n")}\r\n\r\n`;
}

async function sendBufferResponse({
  socket,
  statusCode,
  body,
  contentType,
}: {
  socket: TransferSocket;
  statusCode: number;
  body: Uint8Array | Buffer | string;
  contentType: string;
}) {
  const payload = toBuffer(body);
  const response = Buffer.concat([
    Buffer.from(
      buildResponseHead(statusCode, {
        "Content-Type": contentType,
        "Content-Length": String(payload.byteLength),
      }),
      "utf8",
    ),
    payload,
  ]);

  await writeSocketSafe(socket, response);
  socket.end();
}

function sanitizeDownloadFileName(value: string) {
  return value.replace(/[^\w.\-() ]+/g, "_");
}

function buildContentDisposition(fileName: string) {
  return `attachment; filename="${sanitizeDownloadFileName(fileName)}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function getDownloadUrl(session: HttpShareSession, file: SelectedTransferFile) {
  return `${session.shareUrl}files/${encodeURIComponent(file.id)}`;
}

function createHtmlPage(session: HttpShareSession) {
  const fileItems = session.files
    .map(
      (file) => `<li class="file-row">
          <a href="${encodeHtml(getDownloadUrl(session, file))}">${encodeHtml(file.name)}</a>
          <span>${encodeHtml(formatBytes(file.sizeBytes))}</span>
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

function createManifest(session: HttpShareSession) {
  return JSON.stringify({
    version: 1,
    kind: "local-http-share",
    sessionId: session.id,
    deviceName: session.deviceName,
    startedAt: session.startedAt,
    shareUrl: session.shareUrl,
    totalBytes: session.totalBytes,
    files: session.files.map((file) => ({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      downloadUrl: getDownloadUrl(session, file),
    })),
  });
}

function parseRequest(requestBuffer: Buffer) {
  const requestText = requestBuffer.toString("utf8");
  const lines = requestText.split("\r\n");
  const requestLine = lines[0]?.trim();
  if (!requestLine) {
    return null;
  }

  const [method, target, version] = requestLine.split(/\s+/);
  if (!method || !target || !version || (version !== "HTTP/1.1" && version !== "HTTP/1.0")) {
    return null;
  }

  for (const line of lines.slice(1)) {
    if (!line) {
      continue;
    }

    if (!line.includes(":")) {
      return null;
    }
  }

  try {
    const url = new URL(target, "http://local-share.invalid");
    return {
      method: method.toUpperCase(),
      path: url.pathname,
    } satisfies ParsedHttpRequest;
  } catch {
    return null;
  }
}

function getSelectedFile(session: HttpShareSession, fileId: string) {
  return session.files.find((file) => file.id === fileId) ?? null;
}

function noteRequest(runtime: HttpShareRuntime) {
  withSessionUpdate(runtime, {
    requestCount: runtime.session.requestCount + 1,
    lastRequestAt: nowIso(),
  });
}

async function sendFileResponse({
  runtime,
  socket,
  request,
  file,
}: {
  runtime: HttpShareRuntime;
  socket: TransferSocket;
  request: ParsedHttpRequest;
  file: SelectedTransferFile;
}) {
  const sourceFile = new File(file.uri);
  let info: ReturnType<typeof sourceFile.info>;

  try {
    info = sourceFile.info();
  } catch {
    await sendBufferResponse({
      socket,
      statusCode: 410,
      body: "This file is no longer available on the device.",
      contentType: "text/plain; charset=utf-8",
    });
    return;
  }

  if (!info.exists) {
    await sendBufferResponse({
      socket,
      statusCode: 410,
      body: "This file is no longer available on the device.",
      contentType: "text/plain; charset=utf-8",
    });
    return;
  }

  const sizeBytes = info.size ?? file.sizeBytes;
  const header = buildResponseHead(200, {
    "Content-Type": file.mimeType || "application/octet-stream",
    "Content-Length": String(sizeBytes),
    "Content-Disposition": buildContentDisposition(file.name),
  });

  await writeSocketSafe(socket, header);

  if (request.method === "HEAD") {
    socket.end();
    return;
  }

  const handle = sourceFile.open();

  try {
    while (!runtime.stopped && handle.offset !== null && handle.offset < (handle.size ?? sizeBytes)) {
      const nextChunk = handle.readBytes(LOCAL_TRANSFER_CHUNK_SIZE_BYTES);
      if (nextChunk.byteLength === 0) {
        break;
      }

      await writeSocketSafe(socket, nextChunk);
    }
  } finally {
    handle.close();
  }

  socket.end();
}

async function routeRequest(runtime: HttpShareRuntime, socket: TransferSocket, request: ParsedHttpRequest) {
  noteRequest(runtime);

  if (request.method !== "GET" && request.method !== "HEAD") {
    await sendBufferResponse({
      socket,
      statusCode: 405,
      body: "Only GET and HEAD are supported.",
      contentType: "text/plain; charset=utf-8",
    });
    return;
  }

  if (request.path === "/") {
    const body = createHtmlPage(runtime.session);
    if (request.method === "HEAD") {
      await writeSocketSafe(
        socket,
        buildResponseHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Length": String(Buffer.byteLength(body, "utf8")),
        }),
      );
      socket.end();
    } else {
      await sendBufferResponse({
        socket,
        statusCode: 200,
        body,
        contentType: "text/html; charset=utf-8",
      });
    }
    return;
  }

  if (request.path === "/manifest.json") {
    const body = createManifest(runtime.session);
    if (request.method === "HEAD") {
      await writeSocketSafe(
        socket,
        buildResponseHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": String(Buffer.byteLength(body, "utf8")),
        }),
      );
      socket.end();
    } else {
      await sendBufferResponse({
        socket,
        statusCode: 200,
        body,
        contentType: "application/json; charset=utf-8",
      });
    }
    return;
  }

  const fileMatch = /^\/files\/([^/]+)$/.exec(request.path);
  if (!fileMatch) {
    await sendBufferResponse({
      socket,
      statusCode: 404,
      body: "Not found.",
      contentType: "text/plain; charset=utf-8",
    });
    return;
  }

  const fileId = decodeURIComponent(fileMatch[1] ?? "");
  const file = getSelectedFile(runtime.session, fileId);
  if (!file) {
    await sendBufferResponse({
      socket,
      statusCode: 404,
      body: "File not found.",
      contentType: "text/plain; charset=utf-8",
    });
    return;
  }

  await sendFileResponse({
    runtime,
    socket,
    request,
    file,
  });
}

async function handleSocket(runtime: HttpShareRuntime, socket: TransferSocket) {
  if (runtime.stopped) {
    socket.destroy();
    return;
  }

  runtime.sockets.add(socket);
  socket.setNoDelay?.(true);

  let buffered = Buffer.alloc(0);
  let responded = false;

  const cleanup = () => {
    runtime.sockets.delete(socket);
  };

  socket.on("close", cleanup);
  socket.on("error", cleanup);
  socket.on("data", (chunk) => {
    if (responded || runtime.stopped) {
      return;
    }

    buffered = Buffer.concat([buffered, toBuffer(chunk as Uint8Array | Buffer | string)]);

    const headerEndIndex = buffered.indexOf("\r\n\r\n");
    if (headerEndIndex === -1) {
      if (buffered.byteLength > MAX_HEADER_BYTES) {
        responded = true;
        void sendBufferResponse({
          socket,
          statusCode: 400,
          body: "Request headers are too large.",
          contentType: "text/plain; charset=utf-8",
        }).catch(() => {
          socket.destroy();
        });
      }
      return;
    }

    responded = true;
    const request = parseRequest(buffered.subarray(0, headerEndIndex));
    if (!request) {
      void sendBufferResponse({
        socket,
        statusCode: 400,
        body: "Malformed request.",
        contentType: "text/plain; charset=utf-8",
      }).catch(() => {
        socket.destroy();
      });
      return;
    }

    void routeRequest(runtime, socket, request).catch((error) => {
      if (runtime.stopped) {
        return;
      }

      console.warn("Local browser share request failed", error);
      void (async () => {
        try {
          await sendBufferResponse({
            socket,
            statusCode: 500,
            body: "Unable to handle that request.",
            contentType: "text/plain; charset=utf-8",
          });
        } catch {
          socket.destroy();
        }
      })();
    });
  });
}

function closeServer(server: TransferServer) {
  return new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

async function stopRuntime(runtime: HttpShareRuntime, status: HttpShareSession["status"], detail: string) {
  if (runtime.stopped) {
    return;
  }

  runtime.stopped = true;
  if (activeRuntime?.session.id === runtime.session.id) {
    activeRuntime = null;
  }

  withSessionUpdate(runtime, {
    status,
    detail,
  });

  for (const socket of runtime.sockets) {
    socket.destroy();
  }
  runtime.sockets.clear();

  await closeServer(runtime.server).catch(() => {});
  await deactivateKeepAwake(LOCAL_HTTP_SHARE_KEEP_AWAKE_TAG).catch(() => {});
}

function createInitialSession({
  sessionId,
  deviceName,
  files,
  host,
  port,
}: {
  sessionId: string;
  deviceName: string;
  files: SelectedTransferFile[];
  host: string;
  port: number;
}) {
  const shareUrl = `http://${host}:${port}/`;

  return {
    id: sessionId,
    status: "sharing",
    deviceName,
    shareUrl,
    manifestUrl: `${shareUrl}manifest.json`,
    qrValue: shareUrl,
    files,
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    startedAt: nowIso(),
    requestCount: 0,
    lastRequestAt: null,
    detail: "Browser sharing is active on local WiFi.",
  } satisfies HttpShareSession;
}

export async function startHttpShareSession({
  files,
  deviceName,
  updateSession,
}: {
  files: SelectedTransferFile[];
  deviceName: string;
  updateSession?: HttpShareSessionUpdate;
}) {
  if (files.length === 0) {
    throw new Error("Pick at least one file to start browser sharing.");
  }

  if (activeRuntime) {
    await stopRuntime(activeRuntime, "stopped", "Browser sharing stopped.");
  }

  const [tcpSocket, host] = await Promise.all([loadTcpSocket(), getLanShareHost()]);
  const sessionId = Crypto.randomUUID();

  let server: TransferServer | null = null;
  let runtime: HttpShareRuntime | null = null;

  try {
    server = tcpSocket.createServer(undefined, (socket) => {
      if (!runtime) {
        socket.destroy();
        return;
      }

      void handleSocket(runtime, socket);
    });
    const listeningServer = server;

    await new Promise<void>((resolve, reject) => {
      const handleError = (error?: unknown) => {
        listeningServer.off?.("error", handleError);
        reject(error instanceof Error ? error : new Error("Unable to start the browser sharing server."));
      };

      listeningServer.once?.("error", handleError);
      listeningServer.listen({ port: 0, host: "0.0.0.0", reuseAddress: true }, () => {
        listeningServer.off?.("error", handleError);
        resolve();
      });
    });

    const port = listeningServer.address()?.port ?? 0;
    if (port <= 0) {
      throw new Error("Unable to start the browser sharing server.");
    }

    runtime = {
      session: createInitialSession({
        sessionId,
        deviceName,
        files,
        host,
        port,
      }),
      server,
      sockets: new Set<TransferSocket>(),
      stopped: false,
      updateSession,
    };

    server.on?.("error", (error) => {
      if (!runtime || runtime.stopped) {
        return;
      }

      void stopRuntime(runtime, "failed", error instanceof Error ? error.message : "Browser sharing failed.");
    });

    activeRuntime = runtime;
    await activateKeepAwakeAsync(LOCAL_HTTP_SHARE_KEEP_AWAKE_TAG).catch(() => {});
    updateSession?.({ ...runtime.session });
    return runtime.session;
  } catch (error) {
    if (server && !runtime) {
      await closeServer(server).catch(() => {});
    }

    if (runtime) {
      await stopRuntime(runtime, "failed", error instanceof Error ? error.message : "Browser sharing failed.");
    }

    throw error;
  }
}

export async function stopHttpShareSession(sessionId: string) {
  if (!activeRuntime || activeRuntime.session.id !== sessionId) {
    return;
  }

  await stopRuntime(activeRuntime, "stopped", "Browser sharing stopped.");
}
