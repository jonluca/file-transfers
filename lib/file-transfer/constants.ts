import localTransferCertificateAsset from "../../assets/tls/local-transfer-cert.pem";
import localTransferKeystoreAsset from "../../assets/tls/local-transfer-keystore.p12";

export const LOCAL_TRANSFER_SERVICE_TYPE = "filetransfer";
export const LOCAL_TRANSFER_SERVICE_PROTOCOL = "tcp";
export const LOCAL_TRANSFER_SERVICE_DOMAIN = "local.";
export const LOCAL_TRANSFER_SPEED_LIMIT_BYTES_PER_SECOND = 5 * 1024 * 1024;
export const LOCAL_TRANSFER_CHUNK_SIZE_BYTES = 64 * 1024;
export const LOCAL_TRANSFER_CERT_FINGERPRINT =
  "C4:0E:71:1C:CA:FD:B7:E4:05:96:0C:92:79:81:E7:71:C5:43:2B:3A:1D:0C:6F:FA:4F:6C:D5:E8:B0:BC:35:6B";
export const LOCAL_TRANSFER_KEEP_AWAKE_TAG = "file-transfers-active";
export const LOCAL_HTTP_SHARE_KEEP_AWAKE_TAG = "file-transfers-http-share";
export const LOCAL_TRANSFER_CERTIFICATE_ASSET = localTransferCertificateAsset;
export const LOCAL_TRANSFER_KEYSTORE_ASSET = localTransferKeystoreAsset;
export const RECEIVED_FILES_DIRECTORY_NAME = "received";
export const HOSTED_FILE_DEFAULT_EXPIRY_DAYS = 7;
export const PREMIUM_ENTITLEMENT_ID = "premium";
