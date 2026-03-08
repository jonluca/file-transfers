import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { getSocialSignInErrorMessage, signInWithGoogle } from "@/lib/auth-client";

interface UseGoogleSignInOptions {
  onSuccess?: () => void;
}

export function useGoogleSignIn({ onSuccess }: UseGoogleSignInOptions = {}) {
  const queryClient = useQueryClient();
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

      await queryClient.invalidateQueries({ queryKey: ["cloud"] });
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
