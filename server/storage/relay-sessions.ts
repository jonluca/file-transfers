import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { serverEnv } from "@/server/env";

const RELAY_SESSION_TTL_MS = 1000 * 60 * 30;

type RelaySessionStatus =
  | "waiting_receiver"
  | "waiting_approval"
  | "approved"
  | "uploading"
  | "ready"
  | "rejected"
  | "completed"
  | "expired";

interface RelaySessionFileRecord {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  storageName: string;
  uploadedAt: string | null;
}

export interface RelaySessionRecord {
  id: string;
  senderToken: string;
  receiverToken: string;
  senderDeviceName: string;
  receiverDeviceName: string | null;
  createdAt: string;
  expiresAt: string;
  status: RelaySessionStatus;
  fileCount: number;
  totalBytes: number;
  files: RelaySessionFileRecord[];
}

function getRelayRootDirectory() {
  return path.resolve(process.cwd(), serverEnv.relaySessionsLocalDirectory);
}

function getRelaySessionDirectory(sessionId: string) {
  return path.join(getRelayRootDirectory(), sessionId);
}

function getRelayMetadataPath(sessionId: string) {
  return path.join(getRelaySessionDirectory(sessionId), "session.json");
}

function getRelayFilesDirectory(sessionId: string) {
  return path.join(getRelaySessionDirectory(sessionId), "files");
}

function sanitizeFileName(name: string) {
  return name.replace(/[^\w.\-() ]+/g, "_");
}

function createToken() {
  return randomBytes(24).toString("hex");
}

async function ensureRelayDirectories(sessionId: string) {
  await mkdir(getRelayFilesDirectory(sessionId), { recursive: true });
}

async function writeRelayRecord(record: RelaySessionRecord) {
  await ensureRelayDirectories(record.id);
  await writeFile(getRelayMetadataPath(record.id), JSON.stringify(record, null, 2), "utf8");
}

async function expireRelaySession(record: RelaySessionRecord) {
  const expiredRecord: RelaySessionRecord = {
    ...record,
    status: "expired",
  };
  await writeRelayRecord(expiredRecord);
  return expiredRecord;
}

function relaySessionPublicState(record: RelaySessionRecord) {
  return {
    id: record.id,
    receiverDeviceName: record.receiverDeviceName,
    status: record.status,
    fileCount: record.fileCount,
    totalBytes: record.totalBytes,
    files: record.files.map((file) => ({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      uploaded: Boolean(file.uploadedAt),
    })),
    expiresAt: record.expiresAt,
  };
}

export async function createRelaySession({
  senderDeviceName,
  files,
}: {
  senderDeviceName: string;
  files: Array<{ id: string; name: string; mimeType: string; sizeBytes: number }>;
}) {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const record: RelaySessionRecord = {
    id,
    senderToken: createToken(),
    receiverToken: createToken(),
    senderDeviceName: senderDeviceName.trim().slice(0, 40) || "This device",
    receiverDeviceName: null,
    createdAt,
    expiresAt: new Date(Date.now() + RELAY_SESSION_TTL_MS).toISOString(),
    status: "waiting_receiver",
    fileCount: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0),
    files: files.map((file) => ({
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      sizeBytes: file.sizeBytes,
      storageName: `${file.id}-${sanitizeFileName(file.name)}`,
      uploadedAt: null,
    })),
  };

  await writeRelayRecord(record);

  return {
    session: relaySessionPublicState(record),
    senderToken: record.senderToken,
    receiverToken: record.receiverToken,
  };
}

export async function readRelaySession(sessionId: string) {
  try {
    const contents = await readFile(getRelayMetadataPath(sessionId), "utf8");
    const record = JSON.parse(contents) as RelaySessionRecord;

    if (new Date(record.expiresAt).getTime() <= Date.now() && record.status !== "expired") {
      return await expireRelaySession(record);
    }

    return record;
  } catch {
    return null;
  }
}

export async function getRelaySenderState(sessionId: string, senderToken: string) {
  const record = await readRelaySession(sessionId);
  if (!record || record.senderToken !== senderToken) {
    return null;
  }

  return relaySessionPublicState(record);
}

export async function getRelayReceiverState(sessionId: string, receiverToken: string) {
  const record = await readRelaySession(sessionId);
  if (!record || record.receiverToken !== receiverToken) {
    return null;
  }

  return relaySessionPublicState(record);
}

export async function joinRelaySession({
  sessionId,
  receiverToken,
  receiverDeviceName,
}: {
  sessionId: string;
  receiverToken: string;
  receiverDeviceName: string;
}) {
  const record = await readRelaySession(sessionId);
  if (!record || record.receiverToken !== receiverToken) {
    return null;
  }

  const nextStatus =
    record.status === "waiting_receiver" || record.status === "rejected"
      ? "waiting_approval"
      : record.status === "expired"
        ? "expired"
        : record.status;
  const updatedRecord: RelaySessionRecord = {
    ...record,
    receiverDeviceName: receiverDeviceName.trim().slice(0, 40) || "Nearby device",
    status: nextStatus,
  };

  await writeRelayRecord(updatedRecord);
  return relaySessionPublicState(updatedRecord);
}

export async function approveRelaySession({ sessionId, senderToken }: { sessionId: string; senderToken: string }) {
  const record = await readRelaySession(sessionId);
  if (!record || record.senderToken !== senderToken) {
    return null;
  }

  const updatedRecord: RelaySessionRecord = {
    ...record,
    status: record.status === "ready" ? "ready" : record.status === "uploading" ? "uploading" : "approved",
  };

  await writeRelayRecord(updatedRecord);
  return relaySessionPublicState(updatedRecord);
}

export async function rejectRelaySession({ sessionId, senderToken }: { sessionId: string; senderToken: string }) {
  const record = await readRelaySession(sessionId);
  if (!record || record.senderToken !== senderToken) {
    return null;
  }

  const updatedRecord: RelaySessionRecord = {
    ...record,
    status: "rejected",
  };

  await writeRelayRecord(updatedRecord);
  return relaySessionPublicState(updatedRecord);
}

export async function storeRelayFile({
  sessionId,
  senderToken,
  fileId,
  body,
}: {
  sessionId: string;
  senderToken: string;
  fileId: string;
  body: ArrayBuffer;
}) {
  const record = await readRelaySession(sessionId);
  if (!record || record.senderToken !== senderToken) {
    return null;
  }

  const targetFile = record.files.find((file) => file.id === fileId);
  if (!targetFile) {
    return null;
  }

  await ensureRelayDirectories(sessionId);
  await writeFile(path.join(getRelayFilesDirectory(sessionId), targetFile.storageName), Buffer.from(body));

  const updatedFiles = record.files.map((file) =>
    file.id === fileId
      ? {
          ...file,
          uploadedAt: new Date().toISOString(),
        }
      : file,
  );
  const allUploaded = updatedFiles.every((file) => Boolean(file.uploadedAt));
  const updatedRecord: RelaySessionRecord = {
    ...record,
    files: updatedFiles,
    status: allUploaded ? "ready" : "uploading",
  };

  await writeRelayRecord(updatedRecord);
  return relaySessionPublicState(updatedRecord);
}

export async function getRelayDownloadPath({
  sessionId,
  receiverToken,
  fileId,
}: {
  sessionId: string;
  receiverToken: string;
  fileId: string;
}) {
  const record = await readRelaySession(sessionId);
  if (!record || record.receiverToken !== receiverToken) {
    return null;
  }

  const file = record.files.find((candidate) => candidate.id === fileId);
  if (!file || !file.uploadedAt) {
    return null;
  }

  return {
    record,
    file,
    absolutePath: path.join(getRelayFilesDirectory(sessionId), file.storageName),
  };
}

export async function completeRelaySession({ sessionId, receiverToken }: { sessionId: string; receiverToken: string }) {
  const record = await readRelaySession(sessionId);
  if (!record || record.receiverToken !== receiverToken) {
    return null;
  }

  const updatedRecord: RelaySessionRecord = {
    ...record,
    status: "completed",
  };
  await writeRelayRecord(updatedRecord);
  return relaySessionPublicState(updatedRecord);
}

export async function deleteRelaySession(sessionId: string) {
  await rm(getRelaySessionDirectory(sessionId), { recursive: true, force: true });
}

export async function relayFileExists(sessionId: string, storageName: string) {
  try {
    await stat(path.join(getRelayFilesDirectory(sessionId), storageName));
    return true;
  } catch {
    return false;
  }
}
