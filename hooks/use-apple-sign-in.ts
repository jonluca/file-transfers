import * as AppleAuthentication from "expo-apple-authentication";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { getAppleSignInErrorMessage, isAppleSignInCanceled, signInWithApple } from "@/lib/auth-client";

interface UseAppleSignInOptions {
  onSuccess?: () => void;
}

export function useAppleSignIn({ onSuccess }: UseAppleSignInOptions = {}) {
  const queryClient = useQueryClient();
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
        setErrorMessage(getAppleSignInErrorMessage(result.error));
        return false;
      }

      await queryClient.invalidateQueries({ queryKey: ["cloud"] });
      onSuccess?.();
      return true;
    } catch (error) {
      if (!isAppleSignInCanceled(error)) {
        setErrorMessage(getAppleSignInErrorMessage(error));
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
