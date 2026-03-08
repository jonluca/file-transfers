const LOCAL_API_URL = "https://filetransfersapp.com";

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

export function getApiBaseUrl() {
  const configuredUrl = process.env.EXPO_PUBLIC_API_URL?.trim();

  if (configuredUrl) {
    return trimTrailingSlash(configuredUrl);
  }

  return LOCAL_API_URL;
}
