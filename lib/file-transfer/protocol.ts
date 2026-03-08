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

function toUint8Array(chunk: Uint8Array | Buffer | string) {
  if (typeof chunk === "string") {
    const encoded = Buffer.from(chunk, "utf8");
    return new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength);
  }

  return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

function concatUint8Arrays(left: Uint8Array, right: Uint8Array) {
  const merged = new Uint8Array(left.byteLength + right.byteLength);
  merged.set(left, 0);
  merged.set(right, left.byteLength);
  return merged;
}

export function createFrameParser(onFrame: (frame: TransferFrame) => void) {
  let buffered = new Uint8Array(0);

  return (chunk: Uint8Array | Buffer | string) => {
    buffered = concatUint8Arrays(buffered, toUint8Array(chunk));

    while (buffered.length >= 5) {
      const header = new DataView(buffered.buffer, buffered.byteOffset, 5);
      const typeId = header.getUint8(0);
      const payloadLength = header.getUint32(1, false);
      const frameLength = 5 + payloadLength;

      if (buffered.length < frameLength) {
        return;
      }

      const payload = buffered.slice(5, frameLength);
      buffered = buffered.slice(frameLength);
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
