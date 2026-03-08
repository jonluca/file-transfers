import React from "react";
import { Button, Form, Host, Picker, Section, Text as SwiftText, TextField, Toggle } from "@expo/ui/swift-ui";
import { buttonStyle, controlSize, disabled, pickerStyle, tag, textFieldStyle } from "@expo/ui/swift-ui/modifiers";
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
  return (
    <Host
      key={formKey}
      matchContents={{ vertical: true }}
      style={{
        width: "100%",
        minHeight: 500,
        borderRadius: 26,
        overflow: "hidden",
      }}
    >
      <Form>
        <Section title={"Profile"}>
          <TextField
            defaultValue={displayName}
            placeholder={"Display name"}
            onChangeText={onDisplayNameChange}
            modifiers={[textFieldStyle("roundedBorder")]}
          />
          <TextField
            defaultValue={bio}
            placeholder={"A short description for your account"}
            multiline
            numberOfLines={4}
            onChangeText={onBioChange}
            modifiers={[textFieldStyle("roundedBorder")]}
          />
        </Section>

        <Section title={"Preferences"}>
          <Picker
            label={"Accent Theme"}
            selection={accentTheme}
            onSelectionChange={(value) => {
              if (typeof value === "string") {
                onAccentThemeChange(value);
              }
            }}
            modifiers={[pickerStyle("segmented")]}
          >
            {ACCENT_OPTIONS.map((option) => (
              <SwiftText key={option.value} modifiers={[tag(option.value)]}>
                {option.label}
              </SwiftText>
            ))}
          </Picker>
          <Toggle
            isOn={emailUpdatesEnabled}
            label={"Email product updates"}
            onIsOnChange={onEmailUpdatesEnabledChange}
          />
        </Section>

        <Section footer={<SwiftText>Your profile persists to the Hono + tRPC backend.</SwiftText>}>
          <Button
            label={saveLabel}
            onPress={onSubmit}
            modifiers={[buttonStyle("borderedProminent"), controlSize("large"), disabled(isSaving)]}
          />
        </Section>
      </Form>
    </Host>
  );
}
