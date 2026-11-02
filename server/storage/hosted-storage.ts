import { env } from "cloudflare:workers";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createAttachmentContentDisposition } from "../../lib/file-transfer/content-disposition";
import { serverEnv } from "../env";

const PRESIGNED_URL_TTL_SECONDS = 60 * 10;

function getR2Client() {
  if (!serverEnv.r2Bucket || !serverEnv.r2Endpoint || !serverEnv.r2AccessKeyId || !serverEnv.r2SecretAccessKey) {
    throw new Error("Hosted file storage is not configured");
  }

  return new S3Client({
    region: "auto",
    // Large transfers go directly to R2, outside the Worker request-body limit.
    endpoint: serverEnv.r2Endpoint,
    credentials: {
      accessKeyId: serverEnv.r2AccessKeyId,
      secretAccessKey: serverEnv.r2SecretAccessKey,
    },
    requestChecksumCalculation: "WHEN_REQUIRED",
  });
}

function sanitizeStorageSegment(value: string) {
  const cleaned = value.trim().replace(/[\\/]+/g, "_");
  return cleaned.length > 0 ? cleaned : "file";
}

export function buildHostedStorageKey({
  ownerUserId,
  slug,
  fileName,
}: {
  ownerUserId: string;
  slug: string;
  fileName: string;
}) {
  return `${sanitizeStorageSegment(ownerUserId)}/${sanitizeStorageSegment(slug)}/${sanitizeStorageSegment(fileName)}`;
}

export async function createUploadTarget({ storageKey, mimeType }: { storageKey: string; mimeType: string }) {
  // Local Wrangler uses its emulated R2 binding and needs no production credentials.
  if (serverEnv.isDevelopment) {
    return {
      uploadMethod: "PUT" as const,
      uploadUrl: `${serverEnv.hostedFilesBaseUrl.replace(/\/+$/, "")}/uploads`,
      uploadHeaders: { "content-type": mimeType },
      provider: "local" as const,
    };
  }

  const uploadUrl = await getSignedUrl(
    getR2Client(),
    new PutObjectCommand({
      Bucket: serverEnv.r2Bucket!,
      Key: storageKey,
      ContentType: mimeType,
    }),
    { expiresIn: PRESIGNED_URL_TTL_SECONDS },
  );

  return {
    uploadMethod: "PUT" as const,
    uploadUrl,
    uploadHeaders: { "content-type": mimeType },
    provider: "r2" as const,
  };
}

export async function storeUploadedFile({
  storageKey,
  body,
  mimeType,
}: {
  storageKey: string;
  body: ReadableStream<Uint8Array>;
  mimeType: string;
}) {
  await env.HOSTED_FILES.put(storageKey, body, { httpMetadata: { contentType: mimeType } });
}

export async function getUploadedFileSizeBytes(storageKey: string) {
  const result = await env.HOSTED_FILES.head(storageKey);
  return result?.size ?? null;
}

export async function deleteStoredFile(storageKey: string) {
  await env.HOSTED_FILES.delete(storageKey);
}

export async function createDownloadLink({
  storageKey,
  fileName,
  mimeType,
}: {
  storageKey: string;
  fileName: string;
  mimeType: string;
}) {
  if (serverEnv.isDevelopment) {
    return null;
  }

  return getSignedUrl(
    getR2Client(),
    new GetObjectCommand({
      Bucket: serverEnv.r2Bucket!,
      Key: storageKey,
      ResponseContentDisposition: createAttachmentContentDisposition(fileName),
      ResponseContentType: mimeType,
    }),
    { expiresIn: PRESIGNED_URL_TTL_SECONDS },
  );
}

export async function readDevelopmentStoredFile(storageKey: string) {
  if (!serverEnv.isDevelopment) {
    throw new Error("Local downloads are only available in development");
  }

  return env.HOSTED_FILES.get(storageKey);
}
