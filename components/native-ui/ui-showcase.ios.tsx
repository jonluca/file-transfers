import React from "react";
import { Button, Form, Host, Picker, Section, Slider, Text as SwiftText, TextField, Toggle } from "@expo/ui/swift-ui";
import { buttonStyle, controlSize, pickerStyle, tag, textFieldStyle } from "@expo/ui/swift-ui/modifiers";
import { ACCENT_OPTIONS } from "@/lib/accent-theme";
import type { NativeUiShowcaseProps } from "@/components/native-ui/types";

export function NativeUiShowcase({
  accentTheme,
  notes,
  alertsEnabled,
  betaEnabled,
  intensity,
  onAccentThemeChange,
  onNotesChange,
  onAlertsEnabledChange,
  onBetaEnabledChange,
  onIntensityChange,
  onPrimaryAction,
  onSecondaryAction,
}: NativeUiShowcaseProps) {
  return (
    <Host
      matchContents={{ vertical: true }}
      style={{
        width: "100%",
        minHeight: 560,
        borderRadius: 26,
        overflow: "hidden",
      }}
    >
      <Form>
        <Section
          title={"Buttons"}
          footer={<SwiftText>These buttons are rendered by SwiftUI, not React Native.</SwiftText>}
        >
          <Button
            label={"Run Primary Action"}
            onPress={onPrimaryAction}
            modifiers={[buttonStyle("borderedProminent"), controlSize("large")]}
          />
          <Button label={"Open Secondary Flow"} onPress={onSecondaryAction} modifiers={[buttonStyle("bordered")]} />
        </Section>

        <Section title={"Inputs"} footer={<SwiftText>The text fields stay local to the screen state.</SwiftText>}>
          <TextField
            defaultValue={notes}
            placeholder={"Short notes for this demo surface"}
            multiline
            numberOfLines={4}
            onChangeText={onNotesChange}
            modifiers={[textFieldStyle("roundedBorder")]}
          />
        </Section>

        <Section title={"Controls"}>
          <Toggle isOn={alertsEnabled} label={"Release alerts"} onIsOnChange={onAlertsEnabledChange} />
          <Toggle isOn={betaEnabled} label={"Experimental surfaces"} onIsOnChange={onBetaEnabledChange} />
          <Slider
            label={<SwiftText>Confidence Threshold</SwiftText>}
            value={intensity}
            min={0}
            max={100}
            step={1}
            minimumValueLabel={<SwiftText>0</SwiftText>}
            maximumValueLabel={<SwiftText>100</SwiftText>}
            onValueChange={onIntensityChange}
          />
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
        </Section>

        <Section title={"State Snapshot"}>
          <SwiftText>Theme: {accentTheme}</SwiftText>
          <SwiftText>Alerts: {alertsEnabled ? "On" : "Off"}</SwiftText>
          <SwiftText>Beta UI: {betaEnabled ? "On" : "Off"}</SwiftText>
          <SwiftText>Threshold: {Math.round(intensity)}%</SwiftText>
        </Section>
      </Form>
    </Host>
  );
}
