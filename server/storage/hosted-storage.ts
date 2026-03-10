import { readFile, mkdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createAttachmentContentDisposition } from "../../lib/file-transfer/content-disposition";
import { serverEnv } from "../env";

const localStorageRoot = path.resolve(process.cwd(), serverEnv.hostedFilesLocalDirectory);
const PRESIGNED_URL_TTL_SECONDS = 60 * 10;

function getR2Client() {
  if (!serverEnv.r2Bucket || !serverEnv.r2Endpoint || !serverEnv.r2AccessKeyId || !serverEnv.r2SecretAccessKey) {
    return null;
  }

  return new S3Client({
    region: "auto",
    // R2 presigned URLs must target the S3-compatible API endpoint instead of the public custom domain.
    endpoint: serverEnv.r2Endpoint,
    credentials: {
      accessKeyId: serverEnv.r2AccessKeyId,
      secretAccessKey: serverEnv.r2SecretAccessKey,
    },
  });
}

function getLocalFilePath(storageKey: string) {
  return path.resolve(localStorageRoot, storageKey);
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
  const r2Client = getR2Client();

  if (r2Client && serverEnv.r2Bucket) {
    const uploadUrl = await getSignedUrl(
      r2Client,
      new PutObjectCommand({
        Bucket: serverEnv.r2Bucket,
        Key: storageKey,
        ContentType: mimeType,
      }),
      { expiresIn: PRESIGNED_URL_TTL_SECONDS },
    );

    return {
      uploadMethod: "PUT" as const,
      uploadUrl,
      uploadHeaders: {
        "content-type": mimeType,
      },
      provider: "r2" as const,
    };
  }

  return {
    uploadMethod: "PUT" as const,
    uploadUrl: `${serverEnv.hostedFilesBaseUrl.replace(/\/+$/, "")}/uploads`,
    uploadHeaders: {
      "content-type": mimeType,
    },
    provider: "local" as const,
  };
}

export async function storeUploadedFile({
  storageKey,
  body,
  mimeType,
}: {
  storageKey: string;
  body: ArrayBuffer;
  mimeType: string;
}) {
  const r2Client = getR2Client();

  if (r2Client && serverEnv.r2Bucket) {
    await r2Client.send(
      new PutObjectCommand({
        Bucket: serverEnv.r2Bucket,
        Key: storageKey,
        ContentType: mimeType,
        Body: new Uint8Array(body),
      }),
    );
    return;
  }

  const absoluteFilePath = getLocalFilePath(storageKey);
  await mkdir(path.dirname(absoluteFilePath), { recursive: true });
  await writeFile(absoluteFilePath, new Uint8Array(body));
}

export async function getUploadedFileSizeBytes(storageKey: string) {
  const r2Client = getR2Client();

  if (r2Client && serverEnv.r2Bucket) {
    try {
      const result = await r2Client.send(
        new HeadObjectCommand({
          Bucket: serverEnv.r2Bucket,
          Key: storageKey,
        }),
      );
      return typeof result.ContentLength === "number" ? result.ContentLength : 0;
    } catch {
      return null;
    }
  }

  try {
    const fileInfo = await stat(getLocalFilePath(storageKey));
    return fileInfo.size;
  } catch {
    return null;
  }
}

export async function deleteStoredFile(storageKey: string) {
  const r2Client = getR2Client();

  if (r2Client && serverEnv.r2Bucket) {
    await r2Client.send(
      new DeleteObjectCommand({
        Bucket: serverEnv.r2Bucket,
        Key: storageKey,
      }),
    );
    return;
  }

  await unlink(getLocalFilePath(storageKey)).catch(() => {});
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
  const r2Client = getR2Client();

  if (r2Client && serverEnv.r2Bucket) {
    return getSignedUrl(
      r2Client,
      new GetObjectCommand({
        Bucket: serverEnv.r2Bucket,
        Key: storageKey,
        ResponseContentDisposition: createAttachmentContentDisposition(fileName),
        ResponseContentType: mimeType,
      }),
      { expiresIn: PRESIGNED_URL_TTL_SECONDS },
    );
  }

  return null;
}

export async function readLocalStoredFile(storageKey: string) {
  return readFile(getLocalFilePath(storageKey));
}
