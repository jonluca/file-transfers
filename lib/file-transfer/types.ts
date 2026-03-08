export type TransferDirection = "send" | "receive";
export type TransferStatus =
  | "idle"
  | "discoverable"
  | "connecting"
  | "waiting"
  | "transferring"
  | "paused"
  | "completed"
  | "failed"
  | "canceled";

export type HttpShareStatus = "sharing" | "stopped" | "failed";

export interface SelectedTransferFile {
  id: string;
  name: string;
  uri: string;
  mimeType: string;
  sizeBytes: number;
}

export interface TransferManifestFile {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
}

export interface TransferManifest {
  sessionId: string;
  deviceName: string;
  files: TransferManifestFile[];
  fileCount: number;
  totalBytes: number;
  isPremiumSender: boolean;
  createdAt: string;
}

export interface DownloadableTransferFile extends TransferManifestFile {
  downloadUrl: string;
}

export interface DownloadableTransferManifest {
  version: 1;
  kind: "local-http-share" | "direct-http-transfer";
  sessionId: string;
  deviceName: string;
  startedAt: string;
  shareUrl: string;
  totalBytes: number;
  files: DownloadableTransferFile[];
}

export interface DiscoveryRecord {
  sessionId: string;
  method: "nearby" | "qr" | "preview";
  deviceName: string;
  host: string;
  port: number;
  token: string;
  advertisedAt: string;
  serviceName: string | null;
}

export interface TransferProgress {
  phase: TransferStatus;
  totalBytes: number;
  bytesTransferred: number;
  currentFileName: string | null;
  speedBytesPerSecond: number;
  detail: string | null;
  updatedAt: string;
}

export interface TransferSession {
  id: string;
  direction: TransferDirection;
  status: TransferStatus;
  manifest: TransferManifest;
  previewMode: boolean;
  peerDeviceName: string | null;
  awaitingReceiverResponse: boolean;
  relay: RelayCredentials | null;
  progress: TransferProgress;
}

export interface DirectPeerAccess {
  sessionId: string;
  host: string;
  port: number;
  token: string;
}

export interface SenderTransferAccess {
  sessionId: string;
  direct: DirectPeerAccess;
  relay: RelayAccess | null;
}

export interface IncomingTransferOffer {
  id: string;
  senderDeviceName: string;
  fileCount: number;
  totalBytes: number;
  sender: SenderTransferAccess;
  createdAt: string;
}

export interface ReceiveSession {
  id: string;
  status: TransferStatus;
  discoveryRecord: DiscoveryRecord;
  qrPayload: string | null;
  previewMode: boolean;
  incomingOffer: IncomingTransferOffer | null;
  peerDeviceName: string | null;
  receivedFiles: ReceivedFileRecord[];
  progress: TransferProgress;
}

export interface ReceivedFileRecord {
  id: string;
  transferId: string;
  name: string;
  uri: string;
  mimeType: string;
  sizeBytes: number;
  receivedAt: string;
}

export interface TransferHistoryEntry {
  id: string;
  direction: TransferDirection;
  status: Exclude<TransferStatus, "idle">;
  deviceName: string;
  fileCount: number;
  totalBytes: number;
  bytesTransferred: number;
  files: ReceivedFileRecord[];
  createdAt: string;
  updatedAt: string;
  detail: string | null;
}

export interface HttpShareSession {
  id: string;
  status: HttpShareStatus;
  deviceName: string;
  shareUrl: string;
  manifestUrl: string;
  qrValue: string;
  files: TransferManifestFile[];
  totalBytes: number;
  startedAt: string;
  detail: string | null;
}

export interface HostedFile {
  id: string;
  slug: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  downloadUrl: string;
  downloadPageUrl: string;
  requiresPasscode: boolean;
  status: "pending_upload" | "active" | "expired" | "deleted";
  expiresAt: string;
  createdAt: string;
}

export interface EntitlementStatus {
  isAuthenticated: boolean;
  isPremium: boolean;
  source: "anonymous" | "preview" | "client_sync" | "webhook";
  managementUrl: string | null;
  expiresAt: string | null;
}

export interface HostedUploadDraft {
  file: SelectedTransferFile;
  passcode: string | null;
}

export interface RelayAccess {
  sessionId: string;
  receiverToken: string;
  expiresAt: string;
}

export interface RelayCredentials extends RelayAccess {
  senderToken: string;
}
