import { createHash } from "node:crypto";
import { errors as joseErrors, jwtVerify, SignJWT } from "jose";
import { serverEnv } from "./env";

const HOSTED_SHARE_TOKEN_AUDIENCE = "file-transfers-hosted-share";
const HOSTED_SHARE_TOKEN_SECRET = createHash("sha256").update(`hosted-share:${serverEnv.betterAuthSecret}`).digest();

function readHostedFileIdFromToken(token: string) {
  try {
    const [, payloadSegment] = token.split(".");
    if (!payloadSegment) {
      return null;
    }

    const parsed = JSON.parse(Buffer.from(payloadSegment, "base64url").toString("utf8")) as {
      sub?: string;
    };

    return typeof parsed.sub === "string" && parsed.sub.length > 0 ? parsed.sub : null;
  } catch {
    return null;
  }
}

export async function createHostedShareToken({ hostedFileId, expiresAt }: { hostedFileId: string; expiresAt: Date }) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setAudience(HOSTED_SHARE_TOKEN_AUDIENCE)
    .setSubject(hostedFileId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(HOSTED_SHARE_TOKEN_SECRET);
}

export async function verifyHostedShareToken(token: string) {
  try {
    const { payload } = await jwtVerify(token, HOSTED_SHARE_TOKEN_SECRET, {
      audience: HOSTED_SHARE_TOKEN_AUDIENCE,
    });

    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      return {
        hostedFileId: null,
        status: "invalid" as const,
      };
    }

    return {
      hostedFileId: payload.sub,
      status: "valid" as const,
    };
  } catch (error) {
    if (error instanceof joseErrors.JWTExpired) {
      return {
        hostedFileId: readHostedFileIdFromToken(token),
        status: "expired" as const,
      };
    }

    return {
      hostedFileId: null,
      status: "invalid" as const,
    };
  }
}
