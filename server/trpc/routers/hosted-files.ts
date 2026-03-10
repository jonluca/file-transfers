import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createHostedShareToken } from "../../hosted-share-token";
import { hostedFile, subscriptionMembership } from "../../db/schema";
import { serverEnv } from "../../env";
import type { TRPCContext } from "../context";
import {
  buildHostedStorageKey,
  createUploadTarget,
  deleteStoredFile,
  getUploadedFileSizeBytes,
} from "../../storage/hosted-storage";
import { protectedProcedure, router } from "../trpc";

const MAX_HOSTED_FILE_SIZE_BYTES = 10 * 1024 * 1024 * 1024;
const MAX_ACTIVE_STORAGE_BYTES = 100 * 1024 * 1024 * 1024;
const DEFAULT_EXPIRY_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;
const LISTABLE_HOSTED_FILE_STATUSES = ["pending_upload", "active", "expired"] as const;
type HostedFileStatus = "pending_upload" | "active" | "expired" | "deleted";

export function getHostedFileEffectiveStatus(
  value: typeof hostedFile.$inferSelect,
  now = new Date(),
): HostedFileStatus {
  if (value.status === "deleted") {
    return "deleted";
  }

  if (value.status === "expired" || value.expiresAt <= now) {
    return "expired";
  }

  return value.status as "pending_upload" | "active";
}

function mapHostedFile(value: typeof hostedFile.$inferSelect): {
  id: string;
  slug: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  downloadUrl: string;
  downloadPageUrl: string;
  requiresPasscode: boolean;
  status: HostedFileStatus;
  expiresAt: string;
  createdAt: string;
} {
  const status = getHostedFileEffectiveStatus(value);

  return {
    id: value.id,
    slug: value.slug,
    fileName: value.fileName,
    mimeType: value.mimeType,
    sizeBytes: value.sizeBytes,
    downloadUrl: `${serverEnv.hostedFilesBaseUrl.replace(/\/+$/, "")}/h/${value.slug}/download`,
    downloadPageUrl: `${serverEnv.hostedFilesBaseUrl.replace(/\/+$/, "")}/h/${value.slug}`,
    requiresPasscode: value.requiresPasscode,
    status,
    expiresAt: value.expiresAt.toISOString(),
    createdAt: value.createdAt.toISOString(),
  };
}

function assertValidPasscode(passcode: string | null) {
  if (!passcode) {
    return;
  }

  if (!/^\d{6}$/.test(passcode)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "Hosted link passcodes must be 6 digits.",
    });
  }
}

function createPasscodeDigest(passcode: string | null) {
  if (!passcode) {
    return {
      requiresPasscode: false,
      passcodeSalt: null,
      passcodeHash: null,
    };
  }

  const passcodeSalt = randomBytes(16).toString("hex");
  const passcodeHash = createHash("sha256").update(`${passcodeSalt}:${passcode}`).digest("hex");

  return {
    requiresPasscode: true,
    passcodeSalt,
    passcodeHash,
  };
}

export function verifyHostedFilePasscode(
  value: typeof hostedFile.$inferSelect,
  submittedPasscode: string | null | undefined,
) {
  if (!value.requiresPasscode) {
    return true;
  }

  if (!submittedPasscode || !value.passcodeHash || !value.passcodeSalt) {
    return false;
  }

  const submittedHash = createHash("sha256").update(`${value.passcodeSalt}:${submittedPasscode}`).digest("hex");

  return submittedHash === value.passcodeHash;
}

async function requirePremium(ctx: TRPCContext & { session: NonNullable<TRPCContext["session"]> }) {
  const membership = await ctx.db.query.subscriptionMembership.findFirst({
    where: eq(subscriptionMembership.userId, ctx.session.user.id),
  });

  if (!membership?.isPremium || (membership.expiresAt && membership.expiresAt <= new Date())) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Premium is required for hosted files.",
    });
  }
}

async function markHostedFilesExpired(
  ctx: TRPCContext & { session: NonNullable<TRPCContext["session"]> },
  rows: Array<typeof hostedFile.$inferSelect>,
) {
  const now = new Date();
  const expiredIds = rows
    .filter((row) => row.status !== "expired" && row.status !== "deleted" && row.expiresAt <= now)
    .map((row) => row.id);

  if (expiredIds.length === 0) {
    return rows;
  }

  await ctx.db
    .update(hostedFile)
    .set({
      status: "expired",
      updatedAt: now,
    })
    .where(and(eq(hostedFile.ownerUserId, ctx.session.user.id), inArray(hostedFile.id, expiredIds)));

  return rows.map((row) => (expiredIds.includes(row.id) ? { ...row, status: "expired", updatedAt: now } : row));
}

export const hostedFilesRouter = router({
  listMine: protectedProcedure.query(async ({ ctx }) => {
    const rows = await ctx.db.query.hostedFile.findMany({
      where: and(
        eq(hostedFile.ownerUserId, ctx.session.user.id),
        inArray(hostedFile.status, LISTABLE_HOSTED_FILE_STATUSES),
      ),
      orderBy: [desc(hostedFile.createdAt)],
    });

    const normalizedRows = await markHostedFilesExpired(ctx, rows);
    return normalizedRows.map(mapHostedFile);
  }),
  createUpload: protectedProcedure
    .input(
      z.object({
        fileName: z.string().min(1).max(255),
        mimeType: z.string().min(1).max(255),
        sizeBytes: z.number().int().positive().max(MAX_HOSTED_FILE_SIZE_BYTES),
        passcode: z
          .string()
          .regex(/^\d{6}$/)
          .nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requirePremium(ctx);
      assertValidPasscode(input.passcode);

      const [{ usedBytes }] = await ctx.db
        .select({
          usedBytes: sql<number>`coalesce(sum(${hostedFile.sizeBytes}), 0)`,
        })
        .from(hostedFile)
        .where(
          and(
            eq(hostedFile.ownerUserId, ctx.session.user.id),
            inArray(hostedFile.status, ["pending_upload", "active"]),
          ),
        );

      if ((usedBytes ?? 0) + input.sizeBytes > MAX_ACTIVE_STORAGE_BYTES) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This upload would exceed the current 100 GB hosted storage limit.",
        });
      }

      const id = randomBytes(16).toString("hex");
      const slug = randomBytes(6).toString("hex");
      const uploadToken = randomBytes(16).toString("hex");
      const storageKey = buildHostedStorageKey({
        ownerUserId: ctx.session.user.id,
        slug,
        fileName: input.fileName,
      });
      const passcodeDigest = createPasscodeDigest(input.passcode);
      const now = new Date();
      const expiresAt = new Date(now.getTime() + DEFAULT_EXPIRY_MILLISECONDS);
      const uploadTarget = await createUploadTarget({
        storageKey,
        mimeType: input.mimeType,
      });

      const [created] = await ctx.db
        .insert(hostedFile)
        .values({
          id,
          ownerUserId: ctx.session.user.id,
          slug,
          storageKey,
          uploadToken,
          fileName: input.fileName,
          mimeType: input.mimeType,
          sizeBytes: input.sizeBytes,
          requiresPasscode: passcodeDigest.requiresPasscode,
          passcodeSalt: passcodeDigest.passcodeSalt,
          passcodeHash: passcodeDigest.passcodeHash,
          status: "pending_upload",
          expiresAt,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      return {
        hostedFile: mapHostedFile(created),
        uploadMethod: uploadTarget.uploadMethod,
        uploadUrl:
          uploadTarget.provider === "local"
            ? `${uploadTarget.uploadUrl}/${created.id}/${uploadToken}`
            : uploadTarget.uploadUrl,
        uploadHeaders: uploadTarget.uploadHeaders,
      };
    }),
  completeUpload: protectedProcedure
    .input(
      z.object({
        hostedFileId: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requirePremium(ctx);

      const row = await ctx.db.query.hostedFile.findFirst({
        where: and(eq(hostedFile.id, input.hostedFileId), eq(hostedFile.ownerUserId, ctx.session.user.id)),
      });

      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Hosted file not found.",
        });
      }

      const uploadedSizeBytes = await getUploadedFileSizeBytes(row.storageKey);
      if (uploadedSizeBytes === null) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "The upload has not finished yet.",
        });
      }

      if (uploadedSizeBytes !== row.sizeBytes) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            uploadedSizeBytes === 0 && row.sizeBytes > 0
              ? "The upload completed without any file data. Please try again."
              : "The uploaded file size did not match the selected file. Please try again.",
        });
      }

      const [updated] = await ctx.db
        .update(hostedFile)
        .set({
          status: "active",
          updatedAt: new Date(),
        })
        .where(eq(hostedFile.id, row.id))
        .returning();

      return mapHostedFile(updated);
    }),
  createShareLink: protectedProcedure
    .input(
      z.object({
        hostedFileId: z.string().min(1),
        passcode: z
          .string()
          .regex(/^\d{6}$/)
          .nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await requirePremium(ctx);
      assertValidPasscode(input.passcode);

      const row = await ctx.db.query.hostedFile.findFirst({
        where: and(eq(hostedFile.id, input.hostedFileId), eq(hostedFile.ownerUserId, ctx.session.user.id)),
      });

      if (!row || row.status === "deleted") {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Hosted file not found.",
        });
      }

      const effectiveStatus = getHostedFileEffectiveStatus(row);
      if (effectiveStatus === "expired") {
        if (row.status !== "expired") {
          await ctx.db
            .update(hostedFile)
            .set({
              status: "expired",
              updatedAt: new Date(),
            })
            .where(eq(hostedFile.id, row.id));
        }

        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This hosted file has expired.",
        });
      }

      if (effectiveStatus !== "active") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Finish uploading this hosted file before sharing it.",
        });
      }

      const passcodeDigest = createPasscodeDigest(input.passcode);
      const [updated] = await ctx.db
        .update(hostedFile)
        .set({
          requiresPasscode: passcodeDigest.requiresPasscode,
          passcodeSalt: passcodeDigest.passcodeSalt,
          passcodeHash: passcodeDigest.passcodeHash,
          updatedAt: new Date(),
        })
        .where(eq(hostedFile.id, row.id))
        .returning();

      const token = await createHostedShareToken({
        hostedFileId: updated.id,
        expiresAt: updated.expiresAt,
      });

      return {
        hostedFile: mapHostedFile(updated),
        shareUrl: `${serverEnv.hostedFilesBaseUrl.replace(/\/+$/, "")}/s/${token}`,
      };
    }),
  delete: protectedProcedure
    .input(
      z.object({
        hostedFileId: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.query.hostedFile.findFirst({
        where: and(eq(hostedFile.id, input.hostedFileId), eq(hostedFile.ownerUserId, ctx.session.user.id)),
      });

      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Hosted file not found.",
        });
      }

      await deleteStoredFile(row.storageKey);

      await ctx.db
        .update(hostedFile)
        .set({
          status: "deleted",
          updatedAt: new Date(),
        })
        .where(eq(hostedFile.id, row.id));

      return {
        success: true,
      };
    }),
});
