export interface DirectTransferNativeFile {
  id: string;
  uri: string;
  mimeType: string;
  sizeBytes: number;
}

export interface DirectTransferNativePayloadServerInfo {
  port: number;
}

export interface DirectTransferNativePayloadMetric {
  sessionId: string;
  fileId: string;
  bytesServed: number;
  fileReadDurationMs: number;
  responseCopyDurationMs: number;
  totalDurationMs: number;
  usedNativeServer: boolean;
}

export interface DirectTransferNativePayloadSessionOptions {
  files: DirectTransferNativeFile[];
  maxBytesPerSecond: number | null;
  sessionId: string;
  token: string;
}

export interface DirectTransferNativeRangeDownloadOptions {
  chunkBytes: number;
  destinationUri: string;
  headers: Record<string, string>;
  maxBytesPerSecond: number | null;
  maxConcurrentChunks: number;
  taskId: string;
  totalBytes: number;
  url: string;
}

export interface DirectTransferNativeRangeDownloadProgress {
  bytesTransferred: number;
  diskWriteDurationMs: number;
  requestDurationMs: number;
  startedAtMs: number;
  taskId: string;
  totalBytes: number;
  usedNative: boolean;
}

export interface DirectTransferNativeRangeDownloadResult extends DirectTransferNativeRangeDownloadProgress {
  completedAtMs: number;
}

export interface DirectTransferNativeExportFileToDownloadsOptions {
  fileName: string;
  mimeType: string;
  sourceUri: string;
}

export interface DirectTransferNativeExportFileToDownloadsResult {
  uri: string;
}

export interface DirectTransferNativeModuleType {
  cancelRangeDownload(taskId: string): Promise<void>;
  collectPayloadMetrics(sessionId: string): Promise<DirectTransferNativePayloadMetric[]>;
  ensurePayloadServerStarted(): Promise<DirectTransferNativePayloadServerInfo>;
  exportFileToDownloads(
    options: DirectTransferNativeExportFileToDownloadsOptions,
  ): Promise<DirectTransferNativeExportFileToDownloadsResult>;
  getRangeDownloadProgress(taskId: string): Promise<DirectTransferNativeRangeDownloadProgress | null>;
  registerPayloadSession(options: DirectTransferNativePayloadSessionOptions): Promise<void>;
  shareFileUri(uri: string, mimeType: string): Promise<void>;
  startRangeDownload(
    options: DirectTransferNativeRangeDownloadOptions,
  ): Promise<DirectTransferNativeRangeDownloadResult>;
  stopPayloadServer(): Promise<void>;
  unregisterPayloadSession(sessionId: string): Promise<void>;
}
