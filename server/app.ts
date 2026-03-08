import "dotenv/config";
import { readFile } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { auth } from "./auth";
import { db } from "./db/client";
import { hostedFile, subscriptionMembership } from "./db/schema";
import { serverEnv } from "./env";
import { createDownloadLink, readLocalStoredFile, storeUploadedFile } from "./storage/hosted-storage";
import {
  approveRelaySession,
  completeRelaySession,
  createRelaySession,
  deleteRelaySession,
  getRelayDownloadPath,
  getRelayReceiverState,
  getRelaySenderState,
  joinRelaySession,
  rejectRelaySession,
  storeRelayFile,
} from "./storage/relay-sessions";
import { verifyHostedFilePasscode } from "./trpc/routers/hosted-files";
import { createTRPCContext } from "./trpc/context";
import { appRouter } from "./trpc/router";

const app = new Hono();

function hostedDownloadPageHtml({
  fileName,
  sizeBytes,
  expiresAt,
  slug,
  requiresPasscode,
  errorMessage,
  passcode,
}: {
  fileName: string;
  sizeBytes: number;
  expiresAt: string;
  slug: string;
  requiresPasscode: boolean;
  errorMessage?: string | null;
  passcode?: string | null;
}) {
  const encodedPasscode = passcode ? encodeURIComponent(passcode) : "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${fileName}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f8fafc; color: #0f172a; margin: 0; }
      .wrap { max-width: 520px; margin: 0 auto; padding: 40px 20px; }
      .card { background: #fff; border-radius: 24px; border: 1px solid rgba(15,23,42,0.08); box-shadow: 0 18px 40px rgba(15,23,42,0.08); padding: 24px; }
      .eyebrow { display:inline-block; padding: 6px 10px; border-radius: 999px; background: rgba(15,23,42,0.06); font-size: 12px; font-weight: 700; }
      h1 { margin: 16px 0 12px; font-size: 28px; line-height: 1.1; }
      p { color: #475569; line-height: 1.6; }
      .meta { margin: 18px 0; display: grid; gap: 10px; }
      .meta-row { display:flex; justify-content:space-between; gap: 12px; font-size: 14px; }
      .meta-row span:first-child { color: #64748b; }
      .button { display:inline-flex; align-items:center; justify-content:center; width:100%; min-height: 52px; border-radius: 16px; background: #0f172a; color: #fff; font-weight: 700; text-decoration:none; border: 0; cursor: pointer; }
      .input { width:100%; border-radius: 14px; border:1px solid rgba(15,23,42,0.12); min-height: 48px; padding: 0 14px; font-size: 16px; box-sizing: border-box; margin: 12px 0; }
      .notice { margin-top: 16px; padding: 14px; border-radius: 16px; background: rgba(220,38,38,0.08); border: 1px solid rgba(220,38,38,0.16); color:#991b1b; }
    </style>
  </head>
  <body>
    <main class="wrap">
      <section class="card">
        <div class="eyebrow">Hosted file</div>
        <h1>${fileName}</h1>
        <p>Download this file directly in the browser. No app install or account is required.</p>
        <div class="meta">
          <div class="meta-row"><span>Size</span><span>${sizeBytes.toLocaleString()} bytes</span></div>
          <div class="meta-row"><span>Expires</span><span>${new Date(expiresAt).toLocaleString()}</span></div>
        </div>
        ${
          requiresPasscode
            ? `<form method="get" action="/h/${slug}">
                <label for="passcode">Passcode</label>
                <input id="passcode" class="input" inputmode="numeric" pattern="[0-9]*" maxlength="6" name="passcode" value="${encodedPasscode}" placeholder="Enter 6-digit passcode" />
                <button class="button" type="submit">Unlock download</button>
              </form>`
            : `<a class="button" href="/h/${slug}/download">Download file</a>`
        }
        ${requiresPasscode && passcode && !errorMessage ? `<a class="button" style="margin-top:12px;" href="/h/${slug}/download?passcode=${encodedPasscode}">Download file</a>` : ""}
        ${errorMessage ? `<div class="notice">${errorMessage}</div>` : ""}
      </section>
    </main>
  </body>
</html>`;
}

async function getHostedFileBySlug(slug: string) {
  return db.query.hostedFile.findFirst({
    where: eq(hostedFile.slug, slug),
  });
}

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: (origin) => origin ?? serverEnv.betterAuthUrl,
    allowHeaders: ["Content-Type", "Authorization", "Cookie", "X-Relay-Token"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
  }),
);

app.get("/", (c) =>
  c.json({
    name: "file-transfers",
    status: "ok",
  }),
);

app.get("/health", (c) =>
  c.json({
    status: "ok",
    serverTime: new Date().toISOString(),
  }),
);

app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.put("/uploads/:fileId/:uploadToken", async (c) => {
  const fileId = c.req.param("fileId");
  const uploadToken = c.req.param("uploadToken");

  const record = await db.query.hostedFile.findFirst({
    where: and(eq(hostedFile.id, fileId), eq(hostedFile.uploadToken, uploadToken)),
  });

  if (!record) {
    return c.json({ error: "Upload target not found." }, 404);
  }

  const payload = await c.req.arrayBuffer();
  await storeUploadedFile({
    storageKey: record.storageKey,
    body: payload,
    mimeType: record.mimeType,
  });

  return c.json({ success: true });
});

app.post("/relay/sessions", async (c) => {
  const payload = (await c.req.json()) as {
    senderDeviceName?: string;
    files?: Array<{ id: string; name: string; mimeType: string; sizeBytes: number }>;
  };

  const files = payload.files ?? [];
  if (!files.length) {
    return c.json({ error: "At least one file is required." }, 400);
  }

  const created = await createRelaySession({
    senderDeviceName: payload.senderDeviceName ?? "This device",
    files,
  });

  return c.json(created);
});

app.get("/relay/sessions/:sessionId/sender", async (c) => {
  const senderToken = c.req.header("x-relay-token");
  if (!senderToken) {
    return c.json({ error: "Missing relay token." }, 401);
  }

  const state = await getRelaySenderState(c.req.param("sessionId"), senderToken);
  if (!state) {
    return c.json({ error: "Relay session not found." }, 404);
  }

  return c.json(state);
});

app.get("/relay/sessions/:sessionId/receiver", async (c) => {
  const receiverToken = c.req.header("x-relay-token");
  if (!receiverToken) {
    return c.json({ error: "Missing relay token." }, 401);
  }

  const state = await getRelayReceiverState(c.req.param("sessionId"), receiverToken);
  if (!state) {
    return c.json({ error: "Relay session not found." }, 404);
  }

  return c.json(state);
});

app.post("/relay/sessions/:sessionId/join", async (c) => {
  const receiverToken = c.req.header("x-relay-token");
  if (!receiverToken) {
    return c.json({ error: "Missing relay token." }, 401);
  }

  const payload = (await c.req.json()) as {
    receiverDeviceName?: string;
  };

  const state = await joinRelaySession({
    sessionId: c.req.param("sessionId"),
    receiverToken,
    receiverDeviceName: payload.receiverDeviceName ?? "Nearby device",
  });
  if (!state) {
    return c.json({ error: "Relay session not found." }, 404);
  }

  return c.json(state);
});

app.post("/relay/sessions/:sessionId/approve", async (c) => {
  const senderToken = c.req.header("x-relay-token");
  if (!senderToken) {
    return c.json({ error: "Missing relay token." }, 401);
  }

  const state = await approveRelaySession({
    sessionId: c.req.param("sessionId"),
    senderToken,
  });
  if (!state) {
    return c.json({ error: "Relay session not found." }, 404);
  }

  return c.json(state);
});

app.post("/relay/sessions/:sessionId/reject", async (c) => {
  const senderToken = c.req.header("x-relay-token");
  if (!senderToken) {
    return c.json({ error: "Missing relay token." }, 401);
  }

  const state = await rejectRelaySession({
    sessionId: c.req.param("sessionId"),
    senderToken,
  });
  if (!state) {
    return c.json({ error: "Relay session not found." }, 404);
  }

  return c.json(state);
});

app.put("/relay/sessions/:sessionId/files/:fileId", async (c) => {
  const senderToken = c.req.header("x-relay-token");
  if (!senderToken) {
    return c.json({ error: "Missing relay token." }, 401);
  }

  const body = await c.req.arrayBuffer();
  const state = await storeRelayFile({
    sessionId: c.req.param("sessionId"),
    senderToken,
    fileId: c.req.param("fileId"),
    body,
  });
  if (!state) {
    return c.json({ error: "Relay session or file not found." }, 404);
  }

  return c.json(state);
});

app.get("/relay/sessions/:sessionId/files/:fileId", async (c) => {
  const receiverToken = c.req.header("x-relay-token");
  if (!receiverToken) {
    return c.json({ error: "Missing relay token." }, 401);
  }

  const result = await getRelayDownloadPath({
    sessionId: c.req.param("sessionId"),
    receiverToken,
    fileId: c.req.param("fileId"),
  });
  if (!result) {
    return c.json({ error: "Relay file not found." }, 404);
  }

  const contents = await readFile(result.absolutePath);
  c.header("content-type", result.file.mimeType);
  c.header("content-disposition", `attachment; filename="${result.file.name}"`);
  return c.body(contents);
});

app.post("/relay/sessions/:sessionId/complete", async (c) => {
  const receiverToken = c.req.header("x-relay-token");
  if (!receiverToken) {
    return c.json({ error: "Missing relay token." }, 401);
  }

  const state = await completeRelaySession({
    sessionId: c.req.param("sessionId"),
    receiverToken,
  });
  if (!state) {
    return c.json({ error: "Relay session not found." }, 404);
  }

  return c.json(state);
});

app.delete("/relay/sessions/:sessionId", async (c) => {
  const senderToken = c.req.header("x-relay-token");
  if (!senderToken) {
    return c.json({ error: "Missing relay token." }, 401);
  }

  const state = await getRelaySenderState(c.req.param("sessionId"), senderToken);
  if (!state) {
    return c.json({ error: "Relay session not found." }, 404);
  }

  await deleteRelaySession(c.req.param("sessionId"));
  return c.body(null, 204);
});

app.get("/h/:slug", async (c) => {
  const record = await getHostedFileBySlug(c.req.param("slug"));

  if (!record || record.status === "deleted") {
    return c.html(
      hostedDownloadPageHtml({
        fileName: "Hosted file unavailable",
        sizeBytes: 0,
        expiresAt: new Date().toISOString(),
        slug: c.req.param("slug"),
        requiresPasscode: false,
        errorMessage: "This hosted file no longer exists.",
      }),
      404,
    );
  }

  if (record.expiresAt <= new Date() || record.status === "expired") {
    return c.html(
      hostedDownloadPageHtml({
        fileName: record.fileName,
        sizeBytes: record.sizeBytes,
        expiresAt: record.expiresAt.toISOString(),
        slug: record.slug,
        requiresPasscode: record.requiresPasscode,
        errorMessage: "This hosted file has expired.",
      }),
      410,
    );
  }

  const passcode = c.req.query("passcode");
  const passcodeIsValid = verifyHostedFilePasscode(record, passcode);

  return c.html(
    hostedDownloadPageHtml({
      fileName: record.fileName,
      sizeBytes: record.sizeBytes,
      expiresAt: record.expiresAt.toISOString(),
      slug: record.slug,
      requiresPasscode: record.requiresPasscode,
      errorMessage: record.requiresPasscode && passcode && !passcodeIsValid ? "That passcode is incorrect." : null,
      passcode: passcode ?? null,
    }),
  );
});

app.get("/h/:slug/download", async (c) => {
  const record = await getHostedFileBySlug(c.req.param("slug"));

  if (!record || record.status === "deleted") {
    return c.json({ error: "Hosted file not found." }, 404);
  }

  if (record.expiresAt <= new Date() || record.status === "expired") {
    return c.json({ error: "Hosted file expired." }, 410);
  }

  const passcode = c.req.query("passcode");
  if (!verifyHostedFilePasscode(record, passcode)) {
    return c.json({ error: "Invalid passcode." }, 403);
  }

  const redirectUrl = await createDownloadLink({
    storageKey: record.storageKey,
    fileName: record.fileName,
    mimeType: record.mimeType,
  });

  await db
    .update(hostedFile)
    .set({
      downloadCount: sql`${hostedFile.downloadCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(hostedFile.id, record.id));

  if (redirectUrl) {
    return c.redirect(redirectUrl, 302);
  }

  const contents = await readLocalStoredFile(record.storageKey);
  c.header("content-type", record.mimeType);
  c.header("content-disposition", `attachment; filename="${record.fileName}"`);
  return c.body(contents);
});

app.post("/webhooks/revenuecat", async (c) => {
  const authorization = c.req.header("authorization");

  if (serverEnv.revenueCatWebhookSecret && authorization !== `Bearer ${serverEnv.revenueCatWebhookSecret}`) {
    return c.json({ error: "Unauthorized." }, 401);
  }

  const payload = await c.req.json();
  const event = (payload?.event ?? payload) as {
    app_user_id?: string;
    entitlement_ids?: string[];
    expiration_at_ms?: number | null;
    management_url?: string | null;
    type?: string | null;
  };

  if (!event.app_user_id) {
    return c.json({ error: "Missing app_user_id." }, 400);
  }

  const membership = await db.query.subscriptionMembership.findFirst({
    where: eq(subscriptionMembership.appUserId, event.app_user_id),
  });

  if (!membership) {
    return c.json({ ok: true, skipped: true });
  }

  const isPremium = Boolean(event.entitlement_ids?.includes("premium"));
  await db
    .update(subscriptionMembership)
    .set({
      isPremium,
      source: "webhook",
      expiresAt: event.expiration_at_ms ? new Date(event.expiration_at_ms) : null,
      managementUrl: event.management_url ?? null,
      lastSyncedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(subscriptionMembership.userId, membership.userId));

  return c.json({ ok: true });
});

app.all("/trpc/*", (c) =>
  fetchRequestHandler({
    endpoint: "/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext: createTRPCContext,
    onError({ error, path }) {
      console.error(`[trpc] ${path ?? "unknown"} failed`, error);
    },
  }),
);

export { app };
export default app;
