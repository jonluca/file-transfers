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

export const serverEnv = {
  nodeEnv,
  isDevelopment: nodeEnv === "development",
  port,
  databaseUrl: requireEnv("DATABASE_URL"),
  betterAuthSecret: requireEnv("BETTER_AUTH_SECRET"),
  betterAuthUrl: process.env.BETTER_AUTH_URL ?? `http://127.0.0.1:${port}`,
  trustedOrigins: parseOrigins(process.env.BETTER_AUTH_TRUSTED_ORIGINS),
  appleClientId: optionalEnv("APPLE_CLIENT_ID"),
  appleAppBundleIdentifier: optionalEnv("APPLE_APP_BUNDLE_IDENTIFIER"),
  appleTeamId: optionalEnv("APPLE_TEAM_ID"),
  appleKeyId: optionalEnv("APPLE_KEY_ID"),
  applePrivateKey: optionalEnv("APPLE_PRIVATE_KEY"),
  appleClientSecret: optionalEnv("APPLE_CLIENT_SECRET"),
};
