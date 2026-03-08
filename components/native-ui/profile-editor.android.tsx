import React from "react";
import { Button, Column, Divider, Host, Picker, Switch, Text, TextInput } from "@expo/ui/jetpack-compose";
import { fillMaxWidth, paddingAll } from "@expo/ui/jetpack-compose/modifiers";
import { ACCENT_OPTIONS } from "@/lib/accent-theme";
import type { NativeProfileEditorProps } from "@/components/native-ui/types";

export function NativeProfileEditor({
  formKey,
  displayName,
  bio,
  accentTheme,
  emailUpdatesEnabled,
  isSaving,
  saveLabel,
  onDisplayNameChange,
  onBioChange,
  onAccentThemeChange,
  onEmailUpdatesEnabledChange,
  onSubmit,
}: NativeProfileEditorProps) {
  const selectedIndex = ACCENT_OPTIONS.findIndex((option) => option.value === accentTheme);

  return (
    <Host
      key={formKey}
      matchContents={{ vertical: true }}
      style={{
        width: "100%",
        minHeight: 480,
        borderRadius: 26,
        overflow: "hidden",
      }}
    >
      <Column modifiers={[fillMaxWidth(), paddingAll(18)]} verticalArrangement={{ spacedBy: 16 }}>
        <Text style={{ typography: "titleLarge", fontWeight: "700" }}>Profile</Text>
        <Text style={{ typography: "labelLarge" }}>Display Name</Text>
        <TextInput defaultValue={displayName} onChangeText={onDisplayNameChange} modifiers={[fillMaxWidth()]} />
        <Text style={{ typography: "labelLarge" }}>Bio</Text>
        <TextInput
          defaultValue={bio}
          multiline
          numberOfLines={4}
          onChangeText={onBioChange}
          modifiers={[fillMaxWidth()]}
        />

        <Divider />

        <Text style={{ typography: "titleLarge", fontWeight: "700" }}>Preferences</Text>
        <Text style={{ typography: "labelLarge" }}>Accent Theme</Text>
        <Picker
          options={ACCENT_OPTIONS.map((option) => option.label)}
          selectedIndex={selectedIndex}
          variant={"segmented"}
          onOptionSelected={({ nativeEvent }) => {
            const selectedOption = ACCENT_OPTIONS[nativeEvent.index];
            if (selectedOption) {
              onAccentThemeChange(selectedOption.value);
            }
          }}
          modifiers={[fillMaxWidth()]}
        />
        <Switch
          value={emailUpdatesEnabled}
          label={"Email product updates"}
          onValueChange={onEmailUpdatesEnabledChange}
        />
        <Button variant={"elevated"} onPress={onSubmit} disabled={isSaving}>
          {saveLabel}
        </Button>
      </Column>
    </Host>
  );
}
