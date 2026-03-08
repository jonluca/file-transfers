import { createPrivateKey } from "crypto";
import { expo } from "@better-auth/expo";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { betterAuth } from "better-auth";
import { SignJWT } from "jose";
import { db } from "./db/client";
import { authSchema } from "./db/schema";
import { serverEnv } from "./env";

const APPLE_CLIENT_SECRET_TTL_SECONDS = 86400 * 180;
const appleClientSecretCache = new Map<string, string>();

const defaultTrustedOrigins = new Set(["mobileboilerplate://", "https://appleid.apple.com"]);
defaultTrustedOrigins.add(new URL(serverEnv.betterAuthUrl).origin);

if (serverEnv.isDevelopment) {
  defaultTrustedOrigins.add(`http://localhost:${serverEnv.port}`);
}

for (const origin of serverEnv.trustedOrigins) {
  defaultTrustedOrigins.add(origin);
}

async function getAppleClientSecret() {
  if (serverEnv.appleClientSecret) {
    return serverEnv.appleClientSecret;
  }

  if (!serverEnv.appleClientId || !serverEnv.appleTeamId || !serverEnv.appleKeyId || !serverEnv.applePrivateKey) {
    return null;
  }

  const cacheKey = new Date().toISOString().slice(0, 10);
  const cachedSecret = appleClientSecretCache.get(cacheKey);
  if (cachedSecret) {
    return cachedSecret;
  }

  const privateKeyPem = Buffer.from(serverEnv.applePrivateKey, "base64").toString("utf-8");
  const appleKey = createPrivateKey(privateKeyPem.replace(/\\n/g, "\n"));
  const expirationTime = Math.ceil(Date.now() / 1000) + APPLE_CLIENT_SECRET_TTL_SECONDS;

  const clientSecret = await new SignJWT({})
    .setAudience("https://appleid.apple.com")
    .setIssuer(serverEnv.appleTeamId)
    .setIssuedAt()
    .setExpirationTime(expirationTime)
    .setSubject(serverEnv.appleClientId)
    .setProtectedHeader({ alg: "ES256", kid: serverEnv.appleKeyId })
    .sign(appleKey);

  appleClientSecretCache.set(cacheKey, clientSecret);
  return clientSecret;
}

async function appleProvider() {
  const clientSecret = await getAppleClientSecret();

  return {
    clientId: serverEnv.appleClientId!,
    ...(clientSecret ? { clientSecret } : {}),
    ...(serverEnv.appleAppBundleIdentifier ? { appBundleIdentifier: serverEnv.appleAppBundleIdentifier } : {}),
  };
}

const socialProviders = serverEnv.appleClientId
  ? {
      apple: appleProvider,
    }
  : {};

export const auth = betterAuth({
  secret: serverEnv.betterAuthSecret,
  baseURL: serverEnv.betterAuthUrl,
  trustedOrigins: Array.from(defaultTrustedOrigins),
  advanced: {
    useSecureCookies: false,
  },
  emailAndPassword: {
    enabled: false,
  },
  socialProviders,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: authSchema,
    usePlural: false,
  }),
  plugins: [expo()],
});
