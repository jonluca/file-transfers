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

export interface SelectedTransferFile {
  id: string;
  name: string;
  uri: string;
  mimeType: string;
  sizeBytes: number;
}

export interface TransferManifest {
  sessionId: string;
  deviceName: string;
  files: SelectedTransferFile[];
  fileCount: number;
  totalBytes: number;
  transferToken: string;
  advertisedHost: string;
  advertisedPort: number;
  certificateFingerprint: string;
  isPremiumSender: boolean;
  createdAt: string;
}

export interface DiscoveryRecord {
  sessionId: string;
  method: "nearby" | "qr" | "preview";
  deviceName: string;
  host: string;
  port: number;
  token: string;
  fileCount: number;
  totalBytes: number;
  certificateFingerprint: string;
  advertisedAt: string;
  isPremiumSender: boolean;
  serviceName: string | null;
  relay: RelayAccess | null;
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
  discoveryRecord?: DiscoveryRecord;
  qrPayload: string;
  previewMode: boolean;
  peerDeviceName: string | null;
  awaitingApproval: boolean;
  relay: RelayCredentials | null;
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
