import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getHostedUploadSizeError,
  HOSTED_FILE_SIZE_LIMIT_LABEL,
  HOSTED_FILE_SIZE_LIMIT_MESSAGE,
  hostedUploadSizeSchema,
  MAX_HOSTED_FILE_SIZE_BYTES,
} from "./hosted-upload-limits";

test("single-PUT hosted uploads accept exactly 5 GiB and reject one extra byte", () => {
  assert.equal(MAX_HOSTED_FILE_SIZE_BYTES, 5_368_709_120);
  assert.equal(HOSTED_FILE_SIZE_LIMIT_LABEL, "5 GiB");
  for (const bytes of [1, 5_000_000_000, MAX_HOSTED_FILE_SIZE_BYTES]) {
    assert.equal(hostedUploadSizeSchema.safeParse(bytes).success, true);
  }
  for (const bytes of [MAX_HOSTED_FILE_SIZE_BYTES + 1, 10 * 1024 ** 3]) {
    const result = hostedUploadSizeSchema.safeParse(bytes);
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.error.issues[0]?.message, HOSTED_FILE_SIZE_LIMIT_MESSAGE);
    }
  }
});

test("mobile preflight validates every file without imposing a combined-selection limit", () => {
  assert.equal(
    getHostedUploadSizeError([{ sizeBytes: MAX_HOSTED_FILE_SIZE_BYTES }, { sizeBytes: MAX_HOSTED_FILE_SIZE_BYTES }]),
    null,
  );
  assert.equal(
    getHostedUploadSizeError([{ sizeBytes: 1 }, { sizeBytes: MAX_HOSTED_FILE_SIZE_BYTES + 1 }]),
    HOSTED_FILE_SIZE_LIMIT_MESSAGE,
  );
  for (const bytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(hostedUploadSizeSchema.safeParse(bytes).success, false);
    assert.notEqual(getHostedUploadSizeError([{ sizeBytes: bytes }]), null);
  }
});
