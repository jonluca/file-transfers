import "dotenv/config";

function requireEnv(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function optionalEnv(name: string) {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function parseOrigins(value: string | undefined) {
  return (
    value
      ?.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean) ?? []
  );
}

const port = Number(process.env.PORT ?? 3001);
const nodeEnv = process.env.NODE_ENV ?? "development";
const defaultLocalBaseUrl = `http://127.0.0.1:${port}`;
const defaultHostedFilesBaseUrl =
  process.env.HOSTED_FILES_BASE_URL ??
  (nodeEnv === "development"
    ? (process.env.BETTER_AUTH_URL ?? defaultLocalBaseUrl)
    : "https://storage.filetransfersapp.com");
const r2AccountId = optionalEnv("R2_ACCOUNT_ID");

export const serverEnv = {
  nodeEnv,
  isDevelopment: nodeEnv === "development",
  port,
  databaseUrl: requireEnv("DATABASE_URL"),
  betterAuthSecret: requireEnv("BETTER_AUTH_SECRET"),
  betterAuthUrl: process.env.BETTER_AUTH_URL ?? defaultLocalBaseUrl,
  trustedOrigins: parseOrigins(process.env.BETTER_AUTH_TRUSTED_ORIGINS),
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
  hostedFilesLocalDirectory: process.env.HOSTED_FILES_LOCAL_DIRECTORY ?? "server/storage/hosted-files",
  r2AccountId,
  r2Bucket: optionalEnv("R2_BUCKET"),
  r2Endpoint: optionalEnv("R2_ENDPOINT") ?? (r2AccountId ? `https://${r2AccountId}.r2.cloudflarestorage.com` : null),
  r2AccessKeyId: optionalEnv("R2_ACCESS_KEY_ID"),
  r2SecretAccessKey: optionalEnv("R2_SECRET_ACCESS_KEY"),
};
