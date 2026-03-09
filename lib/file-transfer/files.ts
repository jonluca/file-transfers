import * as DocumentPicker from "expo-document-picker";
import * as Sharing from "expo-sharing";
import * as IntentLauncher from "expo-intent-launcher";
import * as Linking from "expo-linking";
import { Directory, File, Paths } from "expo-file-system";
import * as Crypto from "expo-crypto";
import type { DocumentPickerAsset } from "expo-document-picker";
import { PermissionsAndroid, Platform } from "react-native";
import DirectTransferNative from "@/modules/direct-transfer-native";
import type { ReceivedFileRecord, SelectedTransferFile } from "./types";
import { RECEIVED_FILES_DIRECTORY_NAME, RECEIVED_FILES_STAGING_DIRECTORY_NAME } from "./constants";

const ALWAYS_PLACEHOLDER_FILE_BASENAMES = new Set(["unknown", "untitled"]);
const MAYBE_PLACEHOLDER_FILE_BASENAMES = new Set(["document", "file"]);
const ANDROID_GRANT_READ_URI_PERMISSION_FLAG = 1;
const LEGACY_ANDROID_DOWNLOADS_PERMISSION = PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE;
const MIME_TYPE_EXTENSION_OVERRIDES: Record<string, string> = {
  "application/json": "json",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "text/csv": "csv",
  "text/plain": "txt",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

function normalizeMimeType(value: string | null | undefined) {
  return value?.trim() ? value : "application/octet-stream";
}

function normalizeCandidateFileName(value: string | null | undefined) {
  return value?.trim() || null;
}

function decodeUriFileName(uri: string) {
  const cleanUri = uri.split(/[?#]/, 1)[0] ?? uri;
  const decodedUri = (() => {
    try {
      return decodeURIComponent(cleanUri);
    } catch {
      return cleanUri;
    }
  })();

  const lastPathSegment = decodedUri.replace(/\/+$/g, "").split("/").pop()?.trim() ?? "";
  if (!lastPathSegment) {
    return null;
  }

  const scopedName = lastPathSegment.split(":").pop()?.trim() ?? lastPathSegment;
  return scopedName || null;
}

function getFileExtension(name: string) {
  const lastDotIndex = name.lastIndexOf(".");
  return lastDotIndex > 0 && lastDotIndex < name.length - 1 ? name.slice(lastDotIndex + 1).toLowerCase() : null;
}

function getFileBasename(name: string) {
  const extension = getFileExtension(name);
  return extension
    ? name
        .slice(0, -extension.length - 1)
        .trim()
        .toLowerCase()
    : name.trim().toLowerCase();
}

function isOpaqueIdentifierFileName(name: string) {
  const basename = getFileBasename(name);
  return /^\d+$/.test(basename) || /^[0-9a-f-]{16,}$/i.test(basename);
}

function isPlaceholderFileName(name: string) {
  const basename = getFileBasename(name);
  if (ALWAYS_PLACEHOLDER_FILE_BASENAMES.has(basename)) {
    return true;
  }

  return MAYBE_PLACEHOLDER_FILE_BASENAMES.has(basename) && !getFileExtension(name);
}

function getExtensionFromMimeType(mimeType: string) {
  const normalized = mimeType.trim().toLowerCase().split(";", 1)[0] ?? "";
  if (!normalized) {
    return null;
  }

  const override = MIME_TYPE_EXTENSION_OVERRIDES[normalized];
  if (override) {
    return override;
  }

  const subtype = normalized.split("/")[1]?.trim();
  if (!subtype) {
    return null;
  }

  const candidate = subtype
    .replace(/^x-/, "")
    .replace(/\+xml$/, "")
    .replace(/\+json$/, "")
    .replace(/[^\w.-]+/g, "");

  return candidate || null;
}

function buildFallbackFileName(asset: DocumentPickerAsset) {
  const extension = getExtensionFromMimeType(normalizeMimeType(asset.mimeType));
  return extension ? `file.${extension}` : "file";
}

function resolveSelectedFileName(asset: DocumentPickerAsset) {
  const candidates = [asset.name, asset.file?.name, decodeUriFileName(asset.uri)]
    .map(normalizeCandidateFileName)
    .filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (!isPlaceholderFileName(candidate) && !isOpaqueIdentifierFileName(candidate)) {
      return candidate;
    }
  }

  return buildFallbackFileName(asset);
}

function createSelectedFile(asset: DocumentPickerAsset): SelectedTransferFile {
  return {
    id: Crypto.randomUUID(),
    name: resolveSelectedFileName(asset),
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

export function getReceivedFilesStagingDirectory() {
  const directory = new Directory(Paths.cache, RECEIVED_FILES_STAGING_DIRECTORY_NAME);
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

function sanitizeFileName(name: string) {
  return name.replace(/[^\w.\-() ]+/g, "_");
}

function splitFileName(name: string) {
  const sanitizedName = sanitizeFileName(name).trim() || "file";
  const extensionIndex = sanitizedName.lastIndexOf(".");

  if (extensionIndex <= 0) {
    return {
      basename: sanitizedName,
      extension: "",
    };
  }

  return {
    basename: sanitizedName.slice(0, extensionIndex),
    extension: sanitizedName.slice(extensionIndex),
  };
}

function buildUniqueFileName(directory: Directory, fileName: string) {
  const { basename, extension } = splitFileName(fileName);
  let index = 0;

  while (true) {
    const suffix = index === 0 ? "" : ` (${index})`;
    const candidate = `${basename}${suffix}${extension}`;
    if (!new File(directory, candidate).exists) {
      return candidate;
    }
    index += 1;
  }
}

function isContentUri(uri: string) {
  return uri.startsWith("content://");
}

async function ensureLegacyAndroidDownloadsPermissionAsync() {
  if (Platform.OS !== "android" || typeof Platform.Version !== "number" || Platform.Version >= 29) {
    return true;
  }

  if (await PermissionsAndroid.check(LEGACY_ANDROID_DOWNLOADS_PERMISSION)) {
    return true;
  }

  const status = await PermissionsAndroid.request(LEGACY_ANDROID_DOWNLOADS_PERMISSION, {
    title: "Save files to Downloads",
    message: "Allow File Share to save received files in your Downloads folder.",
    buttonPositive: "Allow",
    buttonNegative: "Not now",
  });

  return status === PermissionsAndroid.RESULTS.GRANTED;
}

export async function moveReceivedFileToDefaultLocationAsync({
  transferId,
  sourceFile,
  fileName,
  mimeType,
  sizeBytes,
}: {
  transferId: string;
  sourceFile: File;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}) {
  const receivedAt = new Date().toISOString();
  const normalizedMimeType = normalizeMimeType(mimeType);

  if (
    Platform.OS === "android" &&
    typeof DirectTransferNative?.exportFileToDownloads === "function" &&
    (await ensureLegacyAndroidDownloadsPermissionAsync())
  ) {
    try {
      const exportResult = await DirectTransferNative.exportFileToDownloads({
        sourceUri: sourceFile.uri,
        fileName: sanitizeFileName(fileName),
        mimeType: normalizedMimeType,
      });

      try {
        if (sourceFile.exists) {
          sourceFile.delete();
        }
      } catch {
        // Best-effort staging cleanup after the public copy succeeds.
      }

      return {
        record: {
          id: Crypto.randomUUID(),
          transferId,
          name: fileName,
          uri: exportResult.uri,
          mimeType: normalizedMimeType,
          sizeBytes,
          receivedAt,
        } satisfies ReceivedFileRecord,
        savedLocationLabel: "Downloads",
      };
    } catch (error) {
      console.warn("Unable to export received file to Downloads", error);
    }
  }

  const directory = getReceivedFilesDirectory();
  const destination = new File(directory, buildUniqueFileName(directory, fileName));
  sourceFile.move(destination);

  return {
    record: {
      id: Crypto.randomUUID(),
      transferId,
      name: fileName,
      uri: destination.uri,
      mimeType: normalizedMimeType,
      sizeBytes,
      receivedAt,
    } satisfies ReceivedFileRecord,
    savedLocationLabel: Platform.OS === "android" ? "Files" : "Downloads",
  };
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
  const directory = getReceivedFilesDirectory();
  const sourceFile = new File(sourceFileUri);
  const destination = new File(directory, buildUniqueFileName(directory, fileName));
  sourceFile.copy(destination);
  const receivedAt = new Date().toISOString();

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

export async function openReceivedFileAsync(file: Pick<ReceivedFileRecord, "uri" | "mimeType">) {
  if (Platform.OS !== "android") {
    await Linking.openURL(file.uri);
    return;
  }

  const contentUri = isContentUri(file.uri) ? file.uri : new File(file.uri).contentUri;

  await IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
    data: contentUri,
    flags: ANDROID_GRANT_READ_URI_PERMISSION_FLAG,
    type: file.mimeType,
  });
}

export async function shareReceivedFileAsync(file: Pick<ReceivedFileRecord, "uri" | "mimeType">) {
  if (Platform.OS === "android" && isContentUri(file.uri) && typeof DirectTransferNative?.shareFileUri === "function") {
    await DirectTransferNative.shareFileUri(file.uri, file.mimeType);
    return true;
  }

  const isAvailable = await Sharing.isAvailableAsync();
  if (!isAvailable) {
    return false;
  }

  await Sharing.shareAsync(file.uri, {
    mimeType: file.mimeType,
  });
  return true;
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
