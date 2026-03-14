import "dotenv/config";
import { and, eq, sql } from "drizzle-orm";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import privacyPolicyText from "./legal/privacy.txt?raw";
import { LandingPage } from "./landing-page";
import termsOfServiceText from "./legal/terms.txt?raw";
import deletionPolicyText from "./legal/deletion.txt?raw";
import { auth } from "./auth";
import { db } from "./db/client";
import { hostedFile, subscriptionMembership } from "./db/schema";
import { serverEnv } from "./env";
import { verifyHostedShareToken } from "./hosted-share-token";
import { createAttachmentContentDisposition } from "../lib/file-transfer/content-disposition";
import { PREMIUM_ENTITLEMENT_ALIASES } from "@/lib/subscriptions";
import { createDownloadLink, readLocalStoredFile, storeUploadedFile } from "./storage/hosted-storage";
import { getHostedFileEffectiveStatus, verifyHostedFilePasscode } from "./trpc/routers/hosted-files";
import { createTRPCContext } from "./trpc/context";
import { appRouter } from "./trpc/router";

const app = new Hono();

function renderDocument(markup: string) {
  return `<!doctype html>${markup}`;
}

function hostedDownloadPageHtml({
  fileName,
  sizeBytes,
  expiresAt,
  pagePath,
  downloadPath,
  requiresPasscode,
  errorMessage,
  passcode,
}: {
  fileName: string;
  sizeBytes: number;
  expiresAt: string;
  pagePath: string;
  downloadPath: string;
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
            ? `<form method="get" action="${pagePath}">
                <label for="passcode">Passcode</label>
                <input id="passcode" class="input" inputmode="numeric" pattern="[0-9]*" maxlength="6" name="passcode" value="${encodedPasscode}" placeholder="Enter 6-digit passcode" />
                <button class="button" type="submit">Unlock download</button>
              </form>`
            : `<a class="button" href="${downloadPath}">Download file</a>`
        }
        ${requiresPasscode && passcode && !errorMessage ? `<a class="button" style="margin-top:12px;" href="${downloadPath}?passcode=${encodedPasscode}">Download file</a>` : ""}
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

async function markHostedFileExpiredIfNeeded(record: typeof hostedFile.$inferSelect) {
  if (
    record.status === "deleted" ||
    getHostedFileEffectiveStatus(record) !== "expired" ||
    record.status === "expired"
  ) {
    return;
  }

  await db
    .update(hostedFile)
    .set({
      status: "expired",
      updatedAt: new Date(),
    })
    .where(eq(hostedFile.id, record.id));
}

async function getHostedFileByShareToken(token: string) {
  const verification = await verifyHostedShareToken(token);
  if (!verification.hostedFileId) {
    return {
      record: null,
      status: verification.status === "expired" ? "expired" : "missing",
    } as const;
  }

  const record = await db.query.hostedFile.findFirst({
    where: eq(hostedFile.id, verification.hostedFileId),
  });

  if (!record || record.status === "deleted") {
    return {
      record: null,
      status: "missing",
    } as const;
  }

  const effectiveStatus = getHostedFileEffectiveStatus(record);
  if (effectiveStatus === "expired" || verification.status === "expired") {
    await markHostedFileExpiredIfNeeded(record);
    return {
      record,
      status: "expired",
    } as const;
  }

  if (effectiveStatus !== "active") {
    return {
      record,
      status: "missing",
    } as const;
  }

  return {
    record,
    status: "active",
  } as const;
}

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: (origin) => origin ?? serverEnv.betterAuthUrl,
    allowHeaders: ["Content-Type", "Authorization", "Cookie"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
  }),
);

app.get("/", (c) => c.html(renderDocument(renderToStaticMarkup(createElement(LandingPage)))));

app.get("/status", (c) =>
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

app.get("/privacy.txt", (c) => c.text(privacyPolicyText));

app.get("/terms.txt", (c) => c.text(termsOfServiceText));
app.get("/deletion.txt", (c) => c.text(deletionPolicyText));

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

app.get("/h/:slug", async (c) => {
  const record = await getHostedFileBySlug(c.req.param("slug"));

  if (!record || record.status === "deleted") {
    return c.html(
      hostedDownloadPageHtml({
        fileName: "Hosted file unavailable",
        sizeBytes: 0,
        expiresAt: new Date().toISOString(),
        pagePath: `/h/${c.req.param("slug")}`,
        downloadPath: `/h/${c.req.param("slug")}/download`,
        requiresPasscode: false,
        errorMessage: "This hosted file no longer exists.",
      }),
      404,
    );
  }

  if (getHostedFileEffectiveStatus(record) === "expired") {
    await markHostedFileExpiredIfNeeded(record);
    return c.html(
      hostedDownloadPageHtml({
        fileName: record.fileName,
        sizeBytes: record.sizeBytes,
        expiresAt: record.expiresAt.toISOString(),
        pagePath: `/h/${record.slug}`,
        downloadPath: `/h/${record.slug}/download`,
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
      pagePath: `/h/${record.slug}`,
      downloadPath: `/h/${record.slug}/download`,
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

  if (getHostedFileEffectiveStatus(record) === "expired") {
    await markHostedFileExpiredIfNeeded(record);
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
  c.header("content-disposition", createAttachmentContentDisposition(record.fileName));
  return c.body(contents);
});

app.get("/s/:token", async (c) => {
  const token = c.req.param("token");
  const result = await getHostedFileByShareToken(token);

  if (!result.record || result.status === "missing") {
    return c.html(
      hostedDownloadPageHtml({
        fileName: "Hosted file unavailable",
        sizeBytes: 0,
        expiresAt: new Date().toISOString(),
        pagePath: `/s/${token}`,
        downloadPath: `/s/${token}/download`,
        requiresPasscode: false,
        errorMessage: "This hosted file no longer exists.",
      }),
      404,
    );
  }

  if (result.status === "expired") {
    return c.html(
      hostedDownloadPageHtml({
        fileName: result.record.fileName,
        sizeBytes: result.record.sizeBytes,
        expiresAt: result.record.expiresAt.toISOString(),
        pagePath: `/s/${token}`,
        downloadPath: `/s/${token}/download`,
        requiresPasscode: result.record.requiresPasscode,
        errorMessage: "This hosted file has expired.",
      }),
      410,
    );
  }

  const passcode = c.req.query("passcode");
  const passcodeIsValid = verifyHostedFilePasscode(result.record, passcode);

  return c.html(
    hostedDownloadPageHtml({
      fileName: result.record.fileName,
      sizeBytes: result.record.sizeBytes,
      expiresAt: result.record.expiresAt.toISOString(),
      pagePath: `/s/${token}`,
      downloadPath: `/s/${token}/download`,
      requiresPasscode: result.record.requiresPasscode,
      errorMessage:
        result.record.requiresPasscode && passcode && !passcodeIsValid ? "That passcode is incorrect." : null,
      passcode: passcode ?? null,
    }),
  );
});

app.get("/s/:token/download", async (c) => {
  const result = await getHostedFileByShareToken(c.req.param("token"));

  if (!result.record || result.status === "missing") {
    return c.json({ error: "Hosted file not found." }, 404);
  }

  if (result.status === "expired") {
    return c.json({ error: "Hosted file expired." }, 410);
  }

  const passcode = c.req.query("passcode");
  if (!verifyHostedFilePasscode(result.record, passcode)) {
    return c.json({ error: "Invalid passcode." }, 403);
  }

  const redirectUrl = await createDownloadLink({
    storageKey: result.record.storageKey,
    fileName: result.record.fileName,
    mimeType: result.record.mimeType,
  });

  await db
    .update(hostedFile)
    .set({
      downloadCount: sql`${hostedFile.downloadCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(hostedFile.id, result.record.id));

  if (redirectUrl) {
    return c.redirect(redirectUrl, 302);
  }

  const contents = await readLocalStoredFile(result.record.storageKey);
  c.header("content-type", result.record.mimeType);
  c.header("content-disposition", createAttachmentContentDisposition(result.record.fileName));
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

  const isPremium = Boolean(
    event.entitlement_ids?.some((entitlementId) =>
      PREMIUM_ENTITLEMENT_ALIASES.some((candidateEntitlementId) => candidateEntitlementId === entitlementId),
    ),
  );
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
