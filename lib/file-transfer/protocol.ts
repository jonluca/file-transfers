import { Buffer } from "buffer";

export type TransferFrameType = "json" | "chunk";

export interface TransferFrame {
  type: TransferFrameType;
  payload: Uint8Array;
}

const FRAME_TYPE_JSON = 1;
const FRAME_TYPE_CHUNK = 2;

function getFrameTypeId(type: TransferFrameType) {
  return type === "json" ? FRAME_TYPE_JSON : FRAME_TYPE_CHUNK;
}

function getFrameType(typeId: number): TransferFrameType {
  return typeId === FRAME_TYPE_CHUNK ? "chunk" : "json";
}

export function encodeJsonFrame(value: unknown) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  return encodeFrame("json", payload);
}

export function encodeChunkFrame(value: Uint8Array) {
  return encodeFrame("chunk", value);
}

export function encodeFrame(type: TransferFrameType, payload: Uint8Array) {
  const frame = Buffer.alloc(5 + payload.byteLength);
  frame.writeUInt8(getFrameTypeId(type), 0);
  frame.writeUInt32BE(payload.byteLength, 1);
  Buffer.from(payload).copy(frame, 5);
  return frame;
}

export function createFrameParser(onFrame: (frame: TransferFrame) => void) {
  let buffered = Buffer.alloc(0);

  return (chunk: Uint8Array | Buffer | string) => {
    const nextChunk =
      typeof chunk === "string"
        ? Buffer.from(chunk, "utf8")
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    buffered = Buffer.concat([buffered, nextChunk]);

    while (buffered.length >= 5) {
      const typeId = buffered.readUInt8(0);
      const payloadLength = buffered.readUInt32BE(1);
      const frameLength = 5 + payloadLength;

      if (buffered.length < frameLength) {
        return;
      }

      const payload = buffered.subarray(5, frameLength);
      buffered = buffered.subarray(frameLength);
      onFrame({
        type: getFrameType(typeId),
        payload,
      });
    }
  };
}

export function decodeJsonFrame<T>(payload: Uint8Array) {
  return JSON.parse(Buffer.from(payload).toString("utf8")) as T;
}
