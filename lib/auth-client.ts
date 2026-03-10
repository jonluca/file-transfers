import { expoClient } from "@better-auth/expo/client";
import * as AppleAuthentication from "expo-apple-authentication";
import * as SecureStore from "expo-secure-store";
import { createAuthClient } from "better-auth/react";
import { PRODUCTION_API_URL } from "@/lib/api-config";

const AUTH_STORAGE_PREFIX = "file-transfers-auth";
const AUTH_CALLBACK_URL = "filetransfers://auth-callback";

export const authClient = createAuthClient({
  baseURL: PRODUCTION_API_URL,
  plugins: [
    expoClient({
      scheme: "filetransfers",
      storagePrefix: AUTH_STORAGE_PREFIX,
      storage: {
        getItem: (key) => SecureStore.getItem(key) ?? null,
        setItem: (key, value) => {
          SecureStore.setItem(key, value);
        },
      },
    }),
  ],
});

export const { signIn, signOut, useSession } = authClient;

export async function refreshAuthSession() {
  await authClient.$store.atoms.session.get().refetch();
}

export async function signInWithApple() {
  const credential = await AppleAuthentication.signInAsync({
    requestedScopes: [
      AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
      AppleAuthentication.AppleAuthenticationScope.EMAIL,
    ],
  });

  if (!credential.identityToken) {
    throw new Error("Apple did not return an identity token.");
  }

  const result = await signIn.social({
    provider: "apple",
    idToken: {
      token: credential.identityToken,
    },
  });

  if (!result.error) {
    await refreshAuthSession();
  }

  return result;
}

export async function signInWithGoogle() {
  const result = await signIn.social({
    provider: "google",
    callbackURL: AUTH_CALLBACK_URL,
  });

  if (!result.error) {
    await refreshAuthSession();
  }

  return result;
}

export function isAppleSignInCanceled(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ERR_REQUEST_CANCELED";
}

export function getSocialSignInErrorMessage(error: unknown) {
  if (typeof error === "object" && error !== null) {
    const candidate = error as {
      status?: number;
      message?: string | null;
    };

    if (candidate.status === 404) {
      return "The selected sign-in provider is not configured on the backend yet.";
    }

    if (candidate.message) {
      return candidate.message;
    }
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Unable to sign in right now.";
}
