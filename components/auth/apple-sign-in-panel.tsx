import * as AppleAuthentication from "expo-apple-authentication";
import React, { useEffect, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { useSession } from "@/lib/auth-client";
import { useAppleSignIn } from "@/hooks/use-apple-sign-in";

export function AppleSignInPanel({ onSuccess }: { onSuccess?: () => void }) {
  const { data: session } = useSession();
  const { errorMessage, isSigningIn, triggerAppleSignIn } = useAppleSignIn({ onSuccess });
  const [isAvailable, setIsAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    let isMounted = true;

    void AppleAuthentication.isAvailableAsync()
      .then((value) => {
        if (isMounted) {
          setIsAvailable(value);
        }
      })
      .catch((error) => {
        console.error(error);
        if (isMounted) {
          setIsAvailable(false);
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  return (
    <View style={{ gap: 12 }}>
      {session?.user ? (
        <View
          style={{
            borderRadius: 22,
            backgroundColor: "rgba(37, 99, 235, 0.08)",
            borderWidth: 1,
            borderColor: "rgba(37, 99, 235, 0.14)",
            padding: 16,
            gap: 6,
          }}
        >
          <Text selectable style={{ fontSize: 17, fontWeight: "700", color: "#0f172a" }}>
            Signed in with Apple
          </Text>
          <Text selectable style={{ fontSize: 14, lineHeight: 21, color: "#475569" }}>
            {session.user.email ?? "Your session is active and ready for profile sync."}
          </Text>
        </View>
      ) : isAvailable === null ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <ActivityIndicator color={"#2563eb"} />
          <Text selectable style={{ fontSize: 14, color: "#475569" }}>
            Checking Apple sign-in availability...
          </Text>
        </View>
      ) : isAvailable ? (
        <View style={{ gap: 10 }}>
          <View pointerEvents={isSigningIn ? "none" : "auto"} style={{ opacity: isSigningIn ? 0.6 : 1 }}>
            <AppleAuthentication.AppleAuthenticationButton
              buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
              buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
              cornerRadius={18}
              onPress={() => {
                void triggerAppleSignIn();
              }}
              style={{ width: "100%", height: 54 }}
            />
          </View>
          {isSigningIn ? (
            <Text selectable style={{ fontSize: 13, color: "#64748b" }}>
              Finishing Apple sign-in...
            </Text>
          ) : null}
        </View>
      ) : (
        <View
          style={{
            borderRadius: 22,
            backgroundColor: "rgba(217, 119, 6, 0.08)",
            borderWidth: 1,
            borderColor: "rgba(217, 119, 6, 0.14)",
            padding: 16,
            gap: 6,
          }}
        >
          <Text selectable style={{ fontSize: 17, fontWeight: "700", color: "#92400e" }}>
            Apple sign-in unavailable
          </Text>
          <Text selectable style={{ fontSize: 14, lineHeight: 21, color: "#92400e" }}>
            Apple sign-in requires an Apple device or a development build configured with the Apple Authentication
            capability.
          </Text>
        </View>
      )}

      {errorMessage ? (
        <Text
          selectable
          style={{
            borderRadius: 18,
            backgroundColor: "rgba(220, 38, 38, 0.08)",
            borderWidth: 1,
            borderColor: "rgba(220, 38, 38, 0.14)",
            paddingHorizontal: 14,
            paddingVertical: 12,
            color: "#991b1b",
            fontSize: 14,
            lineHeight: 20,
          }}
        >
          {errorMessage}
        </Text>
      ) : null}
    </View>
  );
}
