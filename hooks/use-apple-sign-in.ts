import * as AppleAuthentication from "expo-apple-authentication";
import { useState } from "react";
import { getSocialSignInErrorMessage, isAppleSignInCanceled, signInWithApple } from "@/lib/auth-client";
import { trpc } from "@/lib/trpc";

interface UseAppleSignInOptions {
  onSuccess?: () => void;
}

export function useAppleSignIn({ onSuccess }: UseAppleSignInOptions = {}) {
  const utils = trpc.useUtils();
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function triggerAppleSignIn() {
    if (isSigningIn) {
      return false;
    }

    setIsSigningIn(true);
    setErrorMessage(null);

    try {
      const isAvailable = await AppleAuthentication.isAvailableAsync();

      if (!isAvailable) {
        setErrorMessage("Apple sign-in is only available in an Apple build on a supported device.");
        return false;
      }

      const result = await signInWithApple();

      if (result.error) {
        setErrorMessage(getSocialSignInErrorMessage(result.error));
        return false;
      }

      await Promise.all([utils.entitlements.me.invalidate(), utils.hostedFiles.listMine.invalidate()]);
      onSuccess?.();
      return true;
    } catch (error) {
      if (!isAppleSignInCanceled(error)) {
        setErrorMessage(getSocialSignInErrorMessage(error));
      }

      return false;
    } finally {
      setIsSigningIn(false);
    }
  }

  return {
    errorMessage,
    isSigningIn,
    triggerAppleSignIn,
  };
}
