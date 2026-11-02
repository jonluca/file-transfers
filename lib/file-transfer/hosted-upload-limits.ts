import { z } from "zod";

// R2 single-part uploads accept at most 5 GiB. Larger hosted files require
// a multipart protocol; the current app uploads each file with one PUT.
export const MAX_HOSTED_FILE_SIZE_BYTES = 5 * 1024 * 1024 * 1024;
export const HOSTED_FILE_SIZE_LIMIT_LABEL = "5 GiB";
export const HOSTED_FILE_SIZE_LIMIT_MESSAGE = `Hosted files must be ${HOSTED_FILE_SIZE_LIMIT_LABEL} or smaller. Choose a smaller file or use a local transfer.`;

export const hostedUploadSizeSchema = z.number().int().positive().max(MAX_HOSTED_FILE_SIZE_BYTES, {
  message: HOSTED_FILE_SIZE_LIMIT_MESSAGE,
});

export function getHostedUploadSizeError(files: readonly { sizeBytes: number }[]): string | null {
  for (const file of files) {
    const result = hostedUploadSizeSchema.safeParse(file.sizeBytes);
    if (!result.success) {
      return result.error.issues[0]?.message ?? HOSTED_FILE_SIZE_LIMIT_MESSAGE;
    }
  }
  return null;
}
