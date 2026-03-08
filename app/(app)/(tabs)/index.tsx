import { Link } from "expo-router";
import React from "react";
import { Pressable, Text, View } from "react-native";
import { EmptyState, ScreenShell, SectionCard, StatusRow } from "@/components/ui";
import { ACCENT_COLORS } from "@/lib/accent-theme";
import { useSession } from "@/lib/auth-client";
import { useServerHealth, useViewer } from "@/hooks/queries";
import { usePreferredAccent } from "@/store";

function LinkCard({
  href,
  eyebrow,
  title,
  description,
  accentColor,
}: {
  href: "/ui" | "/settings" | "/account";
  eyebrow: string;
  title: string;
  description: string;
  accentColor: string;
}) {
  return (
    <Link href={href} asChild>
      <Pressable
        style={{
          borderRadius: 24,
          borderWidth: 1,
          borderColor: "rgba(15, 23, 42, 0.08)",
          backgroundColor: "#ffffff",
          padding: 18,
          gap: 8,
          boxShadow: "0 18px 40px rgba(15, 23, 42, 0.05)",
        }}
      >
        <View
          style={{
            alignSelf: "flex-start",
            borderRadius: 999,
            backgroundColor: `${accentColor}1a`,
            paddingHorizontal: 10,
            paddingVertical: 6,
          }}
        >
          <Text selectable style={{ fontSize: 12, fontWeight: "700", color: accentColor, letterSpacing: 0.4 }}>
            {eyebrow}
          </Text>
        </View>
        <Text selectable style={{ fontSize: 18, fontWeight: "700", color: "#0f172a" }}>
          {title}
        </Text>
        <Text selectable style={{ fontSize: 14, lineHeight: 21, color: "#64748b" }}>
          {description}
        </Text>
      </Pressable>
    </Link>
  );
}

export default function HomeScreen() {
  const accent = usePreferredAccent();
  const accentColor = ACCENT_COLORS[accent];
  const { data: session } = useSession();
  const healthQuery = useServerHealth();
  const viewerQuery = useViewer(Boolean(session?.user));

  return (
    <ScreenShell
      title={"Starter Shell"}
      subtitle={
        "This home tab demonstrates the reusable Palate architecture: native tabs, shared providers, persisted preferences, live backend connectivity, and session-aware account flows."
      }
    >
      <SectionCard
        title={"Architecture"}
        description={"The app shell stays generic while the libraries and organization mirror Palate's stack."}
      >
        <StatusRow label={"Expo Router"} value={"Native Tabs + Stack"} tone={"success"} />
        <StatusRow label={"Backend"} value={"Hono + tRPC"} tone={"success"} />
        <StatusRow
          label={"Auth"}
          value={session?.user ? "Apple session active" : "Apple sign-in ready"}
          tone={"success"}
        />
        <StatusRow label={"State"} value={"Zustand + Query"} tone={"success"} />
      </SectionCard>

      <SectionCard
        title={"Server Status"}
        description={
          "The health card proves the mobile app is talking to the Hono server through the shared API contract."
        }
      >
        <StatusRow
          label={"Health Endpoint"}
          value={healthQuery.data?.status ?? (healthQuery.isLoading ? "Checking..." : "Unavailable")}
          tone={healthQuery.data?.status === "ok" ? "success" : "warning"}
        />
        <StatusRow
          label={"Server Time"}
          value={
            healthQuery.data?.serverTime
              ? new Date(healthQuery.data.serverTime).toLocaleTimeString()
              : healthQuery.isLoading
                ? "Waiting..."
                : "Unknown"
          }
        />
        <StatusRow
          label={"Viewer Query"}
          value={
            session?.user
              ? viewerQuery.data
                ? "Hydrated"
                : viewerQuery.isLoading
                  ? "Loading..."
                  : "Pending"
              : "Signed out"
          }
          tone={session?.user && viewerQuery.data ? "success" : "default"}
        />
      </SectionCard>

      <View style={{ gap: 12 }}>
        <LinkCard
          href={"/ui"}
          eyebrow={"Native Controls"}
          title={"Open the @expo/ui showcase"}
          description={"Inspect the SwiftUI and Jetpack Compose bridges behind one shared component contract."}
          accentColor={accentColor}
        />
        <LinkCard
          href={session?.user ? "/account" : "/settings"}
          eyebrow={session?.user ? "Profile" : "Authentication"}
          title={session?.user ? "Edit your cloud-backed account" : "Configure settings and Apple sign-in"}
          description={
            session?.user
              ? "The account screen persists profile fields to Postgres through Better Auth and tRPC."
              : "The settings tab combines persisted local preferences with optional Apple sign-in."
          }
          accentColor={accentColor}
        />
      </View>

      {!session?.user ? (
        <EmptyState
          title={"Session-aware routing is active"}
          description={
            "Stay anonymous and test the shell locally, or sign in with Apple from Settings to unlock the account editor and viewer query."
          }
        />
      ) : null}
    </ScreenShell>
  );
}
