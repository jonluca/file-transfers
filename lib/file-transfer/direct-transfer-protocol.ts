import type { DirectPeerAccess, DiscoveryRecord } from "./types";

export interface ResolvedNearbyService {
  name?: string | null;
  host?: string | null;
  port?: number | null;
  addresses?: Array<string | null | undefined> | null;
  txt?: Record<string, string | null | undefined> | null;
}

export const DIRECT_TOKEN_HEADER = "x-direct-token";

export function nowIso() {
  return new Date().toISOString();
}

export function normalizeIpv4Address(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const normalized =
    value
      .trim()
      .replace(/^\[|\]$/g, "")
      .replace(/^::ffff:/i, "")
      .split("%")[0] ?? "";

  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized) ? normalized : null;
}

export function isPrivateIpv4Address(value: string) {
  return (
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(value) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(value)
  );
}

export function getUsableLanHost(value: string | null | undefined) {
  const normalized = normalizeIpv4Address(value);
  if (!normalized) {
    return null;
  }

  return isPrivateIpv4Address(normalized) ? normalized : null;
}

export function normalizeMdnsHostname(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const normalized =
    value
      .trim()
      .replace(/^\[|\]$/g, "")
      .split("%")[0]
      ?.replace(/\.+$/, "") ?? "";

  if (!normalized || normalized.includes("://") || /\s/.test(normalized)) {
    return null;
  }

  return normalized.toLowerCase().endsWith(".local") ? normalized : null;
}

export function getUsableNearbyHost(value: string | null | undefined) {
  return getUsableLanHost(value) ?? normalizeMdnsHostname(value);
}

export function resolveDiscoveryHost(record: Pick<DiscoveryRecord, "host" | "method">) {
  return record.method === "nearby" ? getUsableNearbyHost(record.host) : getUsableLanHost(record.host);
}

export function createServiceName(deviceName: string, sessionId: string) {
  return `${deviceName.trim().slice(0, 24)}-${sessionId.slice(0, 6)}`;
}

export function createDiscoveryRecord({
  sessionId,
  method,
  deviceName,
  host,
  port,
  token,
  serviceName,
}: {
  sessionId: string;
  method: DiscoveryRecord["method"];
  deviceName: string;
  host: string;
  port: number;
  token: string;
  serviceName: string | null;
}) {
  return {
    sessionId,
    method,
    deviceName,
    host,
    port,
    token,
    advertisedAt: nowIso(),
    serviceName,
  } satisfies DiscoveryRecord;
}

export function buildDirectSessionBaseUrl(peer: Pick<DirectPeerAccess, "host" | "port" | "sessionId">) {
  return `http://${peer.host}:${peer.port}/direct/sessions/${encodeURIComponent(peer.sessionId)}/`;
}

export function buildDirectSessionUrl(peer: Pick<DirectPeerAccess, "host" | "port" | "sessionId">, suffix: string) {
  return `${buildDirectSessionBaseUrl(peer).replace(/\/$/, "")}${suffix}`;
}

export function createDiscoveryQrPayload(record: DiscoveryRecord) {
  const host = getUsableLanHost(record.host);
  if (!host || record.port <= 0) {
    return null;
  }

  return JSON.stringify({
    version: 1,
    sessionId: record.sessionId,
    host,
    port: record.port,
    token: record.token,
    deviceName: record.deviceName,
    advertisedAt: record.advertisedAt,
  });
}

export function parseDiscoveryQrPayload(value: string) {
  const parsed = JSON.parse(value) as {
    sessionId?: string;
    host?: string;
    port?: number;
    token?: string;
    deviceName?: string;
    advertisedAt?: string;
  };

  const host = getUsableLanHost(parsed.host);
  if (!parsed.sessionId || !host || !parsed.port || !parsed.token || !parsed.deviceName || !parsed.advertisedAt) {
    throw new Error("That QR code does not contain a valid receiver.");
  }

  return {
    sessionId: parsed.sessionId,
    method: "qr",
    deviceName: parsed.deviceName,
    host,
    port: parsed.port,
    token: parsed.token,
    advertisedAt: parsed.advertisedAt,
    serviceName: null,
  } satisfies DiscoveryRecord;
}

export function mapResolvedNearbyService(service: ResolvedNearbyService) {
  const sessionId = service.txt?.sessionId;
  const receiverToken = service.txt?.receiverToken;
  const host =
    service.addresses?.map((address) => getUsableLanHost(address)).find((address) => Boolean(address)) ??
    getUsableNearbyHost(service.host);

  if (!sessionId || !receiverToken || !host) {
    return null;
  }

  return createDiscoveryRecord({
    sessionId,
    method: "nearby",
    deviceName: service.txt?.deviceName ?? service.name ?? "Nearby device",
    host,
    port: service.port ?? 0,
    token: receiverToken,
    serviceName: service.name ?? null,
  });
}
