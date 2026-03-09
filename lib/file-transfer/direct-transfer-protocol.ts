import type { DirectPeerAccess, DiscoveryRecord } from "./types";

export interface ResolvedNearbyService {
  name?: string | null;
  host?: string | null;
  port?: number | null;
  addresses?: Array<string | null | undefined> | null;
  txt?: Record<string, string | null | undefined> | null;
}

export interface NearbyDiscoveryResponse {
  version: 1;
  receivers: DiscoveryRecord[];
}

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

export function createServiceName(stableId: string) {
  return `ft-${stableId.trim().slice(0, 12).toLowerCase()}`;
}

export function createDiscoveryRecord({
  sessionId,
  method,
  deviceName,
  host,
  port,
  serviceName,
  advertisedAt,
}: {
  sessionId: string;
  method: DiscoveryRecord["method"];
  deviceName: string;
  host: string;
  port: number;
  serviceName: string | null;
  advertisedAt?: string;
}) {
  return {
    sessionId,
    method,
    deviceName,
    host,
    port,
    advertisedAt: advertisedAt ?? nowIso(),
    serviceName,
  } satisfies DiscoveryRecord;
}

export function buildNearbyDiscoveryUrl(host: string, port: number) {
  return `http://${host}:${port}/direct/discovery`;
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
    deviceName: record.deviceName,
    advertisedAt: record.advertisedAt,
  });
}

export function parseDiscoveryQrPayload(value: string) {
  const parsed = JSON.parse(value) as {
    sessionId?: string;
    host?: string;
    port?: number;
    deviceName?: string;
    advertisedAt?: string;
  };

  const host = getUsableLanHost(parsed.host);
  if (!parsed.sessionId || !host || !parsed.port || !parsed.deviceName || !parsed.advertisedAt) {
    throw new Error("That QR code does not contain a valid receiver.");
  }

  return {
    sessionId: parsed.sessionId,
    method: "qr",
    deviceName: parsed.deviceName,
    host,
    port: parsed.port,
    advertisedAt: parsed.advertisedAt,
    serviceName: null,
  } satisfies DiscoveryRecord;
}

export function createNearbyDiscoveryResponse(records: DiscoveryRecord[]): NearbyDiscoveryResponse {
  return {
    version: 1,
    receivers: records
      .filter((record) => record.method === "nearby")
      .map((record) => ({
        ...record,
        method: "nearby",
      })),
  };
}

export function parseNearbyDiscoveryResponse(value: unknown) {
  const parsed = value as {
    version?: number;
    receivers?: Array<Partial<DiscoveryRecord> | null | undefined>;
  };

  if (parsed.version !== 1 || !Array.isArray(parsed.receivers)) {
    throw new Error("That nearby discovery response is not valid.");
  }

  return parsed.receivers.map((receiver) => {
    const host = getUsableNearbyHost(receiver?.host);
    const sessionId = receiver?.sessionId;
    const deviceName = receiver?.deviceName;
    const port = typeof receiver?.port === "number" ? receiver.port : 0;
    const advertisedAt = receiver?.advertisedAt;

    if (!sessionId || !deviceName || !host || port <= 0 || !advertisedAt) {
      throw new Error("That nearby discovery response is missing receiver details.");
    }

    return createDiscoveryRecord({
      sessionId,
      method: "nearby",
      deviceName,
      host,
      port,
      serviceName: receiver?.serviceName ?? null,
      advertisedAt,
    });
  });
}

export function mapResolvedNearbyService(service: ResolvedNearbyService) {
  const sessionId = service.txt?.sessionId;
  const host =
    service.addresses?.map((address) => getUsableLanHost(address)).find((address) => Boolean(address)) ??
    getUsableNearbyHost(service.host);

  if (!sessionId || !host) {
    return null;
  }

  return createDiscoveryRecord({
    sessionId,
    method: "nearby",
    deviceName: service.txt?.deviceName ?? service.name ?? "Nearby device",
    host,
    port: service.port ?? 0,
    serviceName: service.name ?? null,
  });
}
