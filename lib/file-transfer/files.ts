import * as DocumentPicker from "expo-document-picker";
import { Directory, File, Paths } from "expo-file-system";
import * as Crypto from "expo-crypto";
import type { DocumentPickerAsset } from "expo-document-picker";
import type { ReceivedFileRecord, SelectedTransferFile } from "./types";
import { RECEIVED_FILES_DIRECTORY_NAME } from "./constants";

function normalizeMimeType(value: string | null | undefined) {
  return value?.trim() ? value : "application/octet-stream";
}

function createSelectedFile(asset: DocumentPickerAsset): SelectedTransferFile {
  return {
    id: Crypto.randomUUID(),
    name: asset.name,
    uri: asset.uri,
    mimeType: normalizeMimeType(asset.mimeType),
    sizeBytes: asset.size ?? 0,
  };
}

export async function pickTransferFiles() {
  const result = await DocumentPicker.getDocumentAsync({
    multiple: true,
    copyToCacheDirectory: true,
  });

  if (result.canceled) {
    return [];
  }

  return result.assets.map(createSelectedFile);
}

export function getReceivedFilesDirectory() {
  const directory = new Directory(Paths.document, RECEIVED_FILES_DIRECTORY_NAME);
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

function sanitizeFileName(name: string) {
  return name.replace(/[^\w.\-() ]+/g, "_");
}

export function createReceivedFileRecord({
  transferId,
  sourceFileUri,
  fileName,
  mimeType,
  sizeBytes,
}: {
  transferId: string;
  sourceFileUri: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}): ReceivedFileRecord {
  const receivedAt = new Date().toISOString();
  const targetName = `${receivedAt.replace(/[:.]/g, "-")}-${sanitizeFileName(fileName)}`;
  const directory = getReceivedFilesDirectory();
  const sourceFile = new File(sourceFileUri);
  const destination = directory.createFile(targetName, mimeType);
  sourceFile.copy(destination);

  return {
    id: Crypto.randomUUID(),
    transferId,
    name: fileName,
    uri: destination.uri,
    mimeType,
    sizeBytes,
    receivedAt,
  };
}

export function formatBytes(value: number) {
  if (value < 1024) {
    return `${value} B`;
  }

  const units = ["KB", "MB", "GB", "TB"];
  let current = value / 1024;
  let unitIndex = 0;

  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }

  return `${current.toFixed(current >= 100 ? 0 : 1)} ${units[unitIndex]}`;
}

export function formatRelativeFilesSummary(files: SelectedTransferFile[]) {
  const totalBytes = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  return `${files.length} file${files.length === 1 ? "" : "s"} • ${formatBytes(totalBytes)}`;
}
