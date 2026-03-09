function encodeContentDispositionFileName(value: string) {
  return encodeURIComponent(value).replaceAll("'", "%27").replaceAll("(", "%28").replaceAll(")", "%29");
}

function createAsciiFallbackFileName(value: string) {
  const fallback = value
    .replace(/[^\x20-\x7E]+/g, "_")
    .replace(/["\\]/g, "_")
    .trim();
  return fallback || "download";
}

export function createAttachmentContentDisposition(fileName: string) {
  return `attachment; filename="${createAsciiFallbackFileName(fileName)}"; filename*=UTF-8''${encodeContentDispositionFileName(fileName)}`;
}
