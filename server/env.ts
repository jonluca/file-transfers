import { env } from "cloudflare:workers";

function requireEnv(name: string) {
  const value = env[name as keyof Cloudflare.Env];

  if (typeof value !== "string" || !value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function optionalEnv(name: string) {
  const raw = env[name as keyof Cloudflare.Env];
  const value = typeof raw === "string" ? raw.trim() : "";
  return value || null;
}

function parseOrigins(value: string | undefined) {
  return (
    value
      ?.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean) ?? []
  );
}

const port = Number(env.PORT ?? 3001);
const nodeEnv = env.NODE_ENV ?? "development";
const defaultLocalBaseUrl = `http://127.0.0.1:${port}`;
const defaultHostedFilesBaseUrl =
  env.HOSTED_FILES_BASE_URL ??
  (nodeEnv === "development" ? (env.BETTER_AUTH_URL ?? defaultLocalBaseUrl) : "https://filetransfersapp.com");
const r2AccountId = optionalEnv("R2_ACCOUNT_ID");

export const serverEnv = {
  nodeEnv,
  isDevelopment: nodeEnv === "development",
  port,
  betterAuthSecret: requireEnv("BETTER_AUTH_SECRET"),
  betterAuthUrl: env.BETTER_AUTH_URL ?? defaultLocalBaseUrl,
  trustedOrigins: parseOrigins(env.BETTER_AUTH_TRUSTED_ORIGINS),
  appleClientId: optionalEnv("APPLE_CLIENT_ID"),
  appleAppBundleIdentifier: optionalEnv("APPLE_APP_BUNDLE_IDENTIFIER"),
  appleTeamId: optionalEnv("APPLE_TEAM_ID"),
  appleKeyId: optionalEnv("APPLE_KEY_ID"),
  applePrivateKey: optionalEnv("APPLE_PRIVATE_KEY"),
  appleClientSecret: optionalEnv("APPLE_CLIENT_SECRET"),
  googleClientId: optionalEnv("GOOGLE_CLIENT_ID"),
  googleClientSecret: optionalEnv("GOOGLE_CLIENT_SECRET"),
  revenueCatWebhookSecret: optionalEnv("REVENUECAT_WEBHOOK_SECRET"),
  hostedFilesBaseUrl: defaultHostedFilesBaseUrl,
  r2AccountId,
  r2Bucket: optionalEnv("R2_BUCKET"),
  r2Endpoint: optionalEnv("R2_ENDPOINT") ?? (r2AccountId ? `https://${r2AccountId}.r2.cloudflarestorage.com` : null),
  r2AccessKeyId: optionalEnv("R2_ACCESS_KEY_ID"),
  r2SecretAccessKey: optionalEnv("R2_SECRET_ACCESS_KEY"),
};
