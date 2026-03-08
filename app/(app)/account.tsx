import { Redirect } from "expo-router";
import React, { useMemo, useState } from "react";
import { Text } from "react-native";
import { NativeProfileEditor } from "@/components/native-ui";
import { ScreenShell, SectionCard, StatusRow } from "@/components/ui";
import { isAccentTheme, type AccentTheme } from "@/lib/accent-theme";
import { useSession } from "@/lib/auth-client";
import { useUpdateViewerProfile, useViewer } from "@/hooks/queries";

interface ProfileDraft {
  displayName: string;
  bio: string;
  accentTheme: AccentTheme;
  emailUpdatesEnabled: boolean;
}

export default function AccountScreen() {
  const { data: session } = useSession();
  const viewerQuery = useViewer(Boolean(session?.user));
  const updateMutation = useUpdateViewerProfile();
  const [draft, setDraft] = useState<ProfileDraft | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const resolvedProfile = useMemo<ProfileDraft>(() => {
    const profile = viewerQuery.data?.profile;

    return {
      displayName: draft?.displayName ?? profile?.displayName ?? viewerQuery.data?.user.name ?? "",
      bio: draft?.bio ?? profile?.bio ?? "",
      accentTheme: draft?.accentTheme ?? profile?.accentTheme ?? "blue",
      emailUpdatesEnabled: draft?.emailUpdatesEnabled ?? profile?.emailUpdatesEnabled ?? false,
    };
  }, [draft, viewerQuery.data]);

  const formKey = useMemo(() => {
    const profile = viewerQuery.data?.profile;
    return `${viewerQuery.data?.user.id ?? "anon"}-${profile?.displayName ?? ""}-${profile?.bio ?? ""}-${profile?.accentTheme ?? "blue"}-${profile?.emailUpdatesEnabled ?? false}`;
  }, [viewerQuery.data]);

  if (!session?.user) {
    return <Redirect href={"/settings"} />;
  }

  function updateDraft(patch: Partial<ProfileDraft>) {
    setDraft((current) => ({
      displayName: current?.displayName ?? resolvedProfile.displayName,
      bio: current?.bio ?? resolvedProfile.bio,
      accentTheme: current?.accentTheme ?? resolvedProfile.accentTheme,
      emailUpdatesEnabled: current?.emailUpdatesEnabled ?? resolvedProfile.emailUpdatesEnabled,
      ...patch,
    }));
  }

  async function handleSubmit() {
    setNotice(null);

    await updateMutation.mutateAsync({
      displayName: resolvedProfile.displayName.trim() ? resolvedProfile.displayName.trim() : null,
      bio: resolvedProfile.bio.trim() ? resolvedProfile.bio.trim() : null,
      accentTheme: isAccentTheme(resolvedProfile.accentTheme) ? resolvedProfile.accentTheme : "blue",
      emailUpdatesEnabled: resolvedProfile.emailUpdatesEnabled,
    });

    setDraft(null);
    setNotice("Profile saved.");
  }

  return (
    <ScreenShell
      title={"Edit Account"}
      subtitle={
        "This screen demonstrates a minimal cloud-backed form that persists generic profile fields through tRPC and Drizzle."
      }
    >
      <SectionCard title={"Session"} description={"The server-owned profile sits beside the Better Auth session."}>
        <StatusRow label={"User"} value={session.user.email ?? session.user.id} tone={"success"} />
        <StatusRow
          label={"Viewer Query"}
          value={viewerQuery.isLoading ? "Loading..." : viewerQuery.data ? "Ready" : "Unavailable"}
          tone={viewerQuery.data ? "success" : "warning"}
        />
      </SectionCard>

      <NativeProfileEditor
        formKey={formKey}
        displayName={resolvedProfile.displayName}
        bio={resolvedProfile.bio}
        accentTheme={resolvedProfile.accentTheme}
        emailUpdatesEnabled={resolvedProfile.emailUpdatesEnabled}
        isSaving={updateMutation.isPending}
        saveLabel={updateMutation.isPending ? "Saving..." : "Save Profile"}
        onDisplayNameChange={(value) => {
          updateDraft({ displayName: value });
        }}
        onBioChange={(value) => {
          updateDraft({ bio: value });
        }}
        onAccentThemeChange={(value) => {
          updateDraft({ accentTheme: value });
        }}
        onEmailUpdatesEnabledChange={(value) => {
          updateDraft({ emailUpdatesEnabled: value });
        }}
        onSubmit={() => {
          void handleSubmit();
        }}
      />

      {notice ? (
        <Text
          selectable
          style={{
            borderRadius: 18,
            backgroundColor: "rgba(22, 163, 74, 0.08)",
            borderWidth: 1,
            borderColor: "rgba(22, 163, 74, 0.14)",
            paddingHorizontal: 14,
            paddingVertical: 12,
            color: "#166534",
            fontSize: 14,
            lineHeight: 20,
          }}
        >
          {notice}
        </Text>
      ) : null}

      {updateMutation.error ? (
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
          {updateMutation.error.message}
        </Text>
      ) : null}
    </ScreenShell>
  );
}
