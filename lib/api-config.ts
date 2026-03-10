import Constants from "expo-constants";

const DEV_API_PORT = 3001;
export const PRODUCTION_API_URL = "https://filetransfersapp.com";

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function normalizeUrl(value: string | null | undefined) {
  return value?.trim() ? trimTrailingSlash(value.trim()) : null;
}

function parseUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0" || hostname === "::1";
}

function isPrivateIpv4Host(hostname: string) {
  return (
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}

function getHostFromCandidate(candidate: string | null | undefined) {
  if (!candidate?.trim()) {
    return null;
  }

  const normalized = candidate.includes("://") ? candidate : `http://${candidate}`;
  const parsed = parseUrl(normalized);
  if (!parsed?.hostname || isLoopbackHost(parsed.hostname)) {
    return null;
  }

  return parsed.hostname;
}

function getCurrentDevHost() {
  return getHostFromCandidate(Constants.expoConfig?.hostUri);
}

export function getApiBaseUrl() {
  if (!__DEV__) {
    return PRODUCTION_API_URL;
  }

  const configuredUrl = normalizeUrl(process.env.EXPO_PUBLIC_API_URL);
  const devHost = getCurrentDevHost();

  if (configuredUrl) {
    if (!devHost) {
      return configuredUrl;
    }

    const parsedConfiguredUrl = parseUrl(configuredUrl);
    if (!parsedConfiguredUrl) {
      return configuredUrl;
    }

    if (isLoopbackHost(parsedConfiguredUrl.hostname)) {
      return `http://${devHost}:${parsedConfiguredUrl.port || DEV_API_PORT}`;
    }

    const isLikelyStaleLocalDevUrl =
      parsedConfiguredUrl.protocol === "http:" &&
      (parsedConfiguredUrl.port === "" || parsedConfiguredUrl.port === String(DEV_API_PORT)) &&
      isPrivateIpv4Host(parsedConfiguredUrl.hostname) &&
      parsedConfiguredUrl.hostname !== devHost;

    if (isLikelyStaleLocalDevUrl) {
      return `http://${devHost}:${parsedConfiguredUrl.port || DEV_API_PORT}`;
    }

    return configuredUrl;
  }

  if (devHost) {
    return `http://${devHost}:${DEV_API_PORT}`;
  }

  return PRODUCTION_API_URL;
}
