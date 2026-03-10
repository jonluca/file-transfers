import { useState } from "react";
import { getSocialSignInErrorMessage, signInWithGoogle } from "@/lib/auth-client";
import { trpc } from "@/lib/trpc";

interface UseGoogleSignInOptions {
  onSuccess?: () => void;
}

export function useGoogleSignIn({ onSuccess }: UseGoogleSignInOptions = {}) {
  const utils = trpc.useUtils();
  const [isSigningIn, setIsSigningIn] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function triggerGoogleSignIn() {
    if (isSigningIn) {
      return false;
    }

    setIsSigningIn(true);
    setErrorMessage(null);

    try {
      const result = await signInWithGoogle();

      if (result.error) {
        setErrorMessage(getSocialSignInErrorMessage(result.error));
        return false;
      }

      await Promise.all([utils.entitlements.me.invalidate(), utils.hostedFiles.listMine.invalidate()]);
      onSuccess?.();
      return true;
    } catch (error) {
      setErrorMessage(getSocialSignInErrorMessage(error));
      return false;
    } finally {
      setIsSigningIn(false);
    }
  }

  return {
    errorMessage,
    isSigningIn,
    triggerGoogleSignIn,
  };
}
