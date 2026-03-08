import { Link } from "expo-router";
import React from "react";
import { Pressable, Switch, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { AppleSignInPanel } from "@/components/auth";
import { EmptyState, ScreenShell, SectionCard, StatusRow } from "@/components/ui";
import { cloudQueryKeys, useViewer } from "@/hooks/queries";
import { signOut, useSession } from "@/lib/auth-client";
import {
  useAppStore,
  useEnableExperimentalUi,
  useEnableHaptics,
  usePreferredAccent,
  useUseCompactCards,
} from "@/store";

function PreferenceSwitch({
  title,
  description,
  value,
  onValueChange,
}: {
  title: string;
  description: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
}) {
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        paddingVertical: 6,
      }}
    >
      <View style={{ flex: 1, gap: 4 }}>
        <Text selectable style={{ fontSize: 16, fontWeight: "600", color: "#0f172a" }}>
          {title}
        </Text>
        <Text selectable style={{ fontSize: 13, lineHeight: 20, color: "#64748b" }}>
          {description}
        </Text>
      </View>
      <Switch value={value} onValueChange={onValueChange} />
    </View>
  );
}

export default function SettingsScreen() {
  const { data: session } = useSession();
  const queryClient = useQueryClient();
  const viewerQuery = useViewer(Boolean(session?.user));
  const preferredAccent = usePreferredAccent();
  const enableHaptics = useEnableHaptics();
  const useCompactCards = useUseCompactCards();
  const enableExperimentalUi = useEnableExperimentalUi();
  const setEnableHaptics = useAppStore((state) => state.setEnableHaptics);
  const setUseCompactCards = useAppStore((state) => state.setUseCompactCards);
  const setEnableExperimentalUi = useAppStore((state) => state.setEnableExperimentalUi);
  const resetPreferences = useAppStore((state) => state.resetPreferences);

  async function handleSignOut() {
    await signOut();
    queryClient.removeQueries({ queryKey: cloudQueryKeys.viewer });
  }

  return (
    <ScreenShell
      title={session?.user ? "Account" : "Settings"}
      subtitle={
        session?.user
          ? "This tab switches to an account-aware view once a session exists, mirroring Palate's session-aware settings/profile entry point."
          : "Local preferences live alongside an optional Apple sign-in entry point."
      }
    >
      <SectionCard
        title={"Device Preferences"}
        description={"These settings persist locally through Zustand and expo-sqlite/kv-store."}
      >
        <StatusRow label={"Preferred Accent"} value={preferredAccent} />
        <PreferenceSwitch
          title={"Enable haptics"}
          description={"Keep space for lightweight tactile feedback in downstream product flows."}
          value={enableHaptics}
          onValueChange={setEnableHaptics}
        />
        <PreferenceSwitch
          title={"Use compact cards"}
          description={"Useful when you want dense review surfaces or dashboard-like screens."}
          value={useCompactCards}
          onValueChange={setUseCompactCards}
        />
        <PreferenceSwitch
          title={"Experimental UI"}
          description={"Generic feature flag to prove the starter's local preference pattern."}
          value={enableExperimentalUi}
          onValueChange={setEnableExperimentalUi}
        />
        <Pressable
          onPress={resetPreferences}
          style={{
            marginTop: 6,
            alignSelf: "flex-start",
            borderRadius: 999,
            borderWidth: 1,
            borderColor: "rgba(15, 23, 42, 0.12)",
            paddingHorizontal: 14,
            paddingVertical: 10,
          }}
        >
          <Text selectable style={{ fontSize: 14, fontWeight: "600", color: "#334155" }}>
            Reset local preferences
          </Text>
        </Pressable>
      </SectionCard>

      {session?.user ? (
        <SectionCard
          title={"Cloud Account"}
          description={
            "The backend keeps a small generic profile record alongside the Better Auth user/session tables."
          }
        >
          <StatusRow label={"Signed In"} value={session.user.email ?? "Apple account"} tone={"success"} />
          <StatusRow
            label={"Viewer Profile"}
            value={
              viewerQuery.isLoading
                ? "Loading..."
                : (viewerQuery.data?.profile.displayName ?? viewerQuery.data?.user.name ?? "Needs setup")
            }
          />
          <Link href={"/account"} asChild>
            <Pressable
              style={{
                borderRadius: 999,
                backgroundColor: "#2563eb",
                paddingHorizontal: 16,
                paddingVertical: 12,
                alignSelf: "flex-start",
              }}
            >
              <Text selectable style={{ color: "#ffffff", fontWeight: "700" }}>
                Open account editor
              </Text>
            </Pressable>
          </Link>
          <Pressable
            onPress={() => {
              void handleSignOut();
            }}
            style={{
              borderRadius: 999,
              borderWidth: 1,
              borderColor: "rgba(220, 38, 38, 0.18)",
              paddingHorizontal: 16,
              paddingVertical: 12,
              alignSelf: "flex-start",
            }}
          >
            <Text selectable style={{ color: "#b91c1c", fontWeight: "700" }}>
              Sign out
            </Text>
          </Pressable>
        </SectionCard>
      ) : (
        <SectionCard
          title={"Apple Sign-In"}
          description={
            "The shell is fully usable without auth, but the account editor and viewer APIs are guarded behind a session."
          }
        >
          <AppleSignInPanel />
        </SectionCard>
      )}

      {!session?.user ? (
        <EmptyState
          title={"Local-first by default"}
          description={
            "This boilerplate keeps the app shell useful before auth is configured. Add Apple provider credentials when you want cloud-backed profiles."
          }
        />
      ) : null}
    </ScreenShell>
  );
}
