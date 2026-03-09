import { DEFAULT_DIRECT_TRANSFER_CHUNK_BYTES } from "./constants";

export function resolveDirectByteRange(
  rangeHeader: string | null,
  fileSize: number,
  chunkBytes = DEFAULT_DIRECT_TRANSFER_CHUNK_BYTES,
) {
  if (!rangeHeader) {
    if (fileSize > chunkBytes) {
      return {
        error: `Range header is required for files larger than ${chunkBytes} bytes.`,
      } as const;
    }

    return {
      start: 0,
      end: Math.max(fileSize - 1, 0),
      partial: false,
    } as const;
  }

  const match = /^bytes=(\d+)-(\d+)$/i.exec(rangeHeader.trim());
  if (!match) {
    return {
      error: "Invalid Range header.",
    } as const;
  }

  const start = Number(match[1]);
  const end = Number(match[2]);

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= fileSize) {
    return {
      error: "Requested range is not satisfiable.",
    } as const;
  }

  return {
    start,
    end: Math.min(end, fileSize - 1),
    partial: true,
  } as const;
}
