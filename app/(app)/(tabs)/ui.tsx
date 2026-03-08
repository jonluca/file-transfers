import React, { useReducer } from "react";
import { Alert, Text, View } from "react-native";
import { NativeUiShowcase } from "@/components/native-ui";
import { ScreenShell, SectionCard, StatusRow } from "@/components/ui";
import type { AccentTheme } from "@/lib/accent-theme";

interface UiShowcaseState {
  accentTheme: AccentTheme;
  notes: string;
  alertsEnabled: boolean;
  betaEnabled: boolean;
  intensity: number;
}

type UiShowcaseAction =
  | { type: "setAccentTheme"; value: AccentTheme }
  | { type: "setNotes"; value: string }
  | { type: "setAlertsEnabled"; value: boolean }
  | { type: "setBetaEnabled"; value: boolean }
  | { type: "setIntensity"; value: number };

const initialState: UiShowcaseState = {
  accentTheme: "blue",
  notes: "Ship a small but complete shell first.",
  alertsEnabled: true,
  betaEnabled: true,
  intensity: 64,
};

function reducer(state: UiShowcaseState, action: UiShowcaseAction): UiShowcaseState {
  switch (action.type) {
    case "setAccentTheme":
      return { ...state, accentTheme: action.value };
    case "setNotes":
      return { ...state, notes: action.value };
    case "setAlertsEnabled":
      return { ...state, alertsEnabled: action.value };
    case "setBetaEnabled":
      return { ...state, betaEnabled: action.value };
    case "setIntensity":
      return { ...state, intensity: action.value };
    default:
      return state;
  }
}

export default function UiShowcaseScreen() {
  const [state, dispatch] = useReducer(reducer, initialState);

  return (
    <ScreenShell
      title={"Native UI"}
      subtitle={
        "The controls below come from @expo/ui. iOS renders SwiftUI primitives, Android renders Jetpack Compose primitives, and the screen consumes one shared prop contract."
      }
    >
      <SectionCard
        title={"What this proves"}
        description={"The showcase is intentionally product-neutral so this repo can be cloned as a boilerplate."}
      >
        <StatusRow label={"Buttons"} value={"Native"} tone={"success"} />
        <StatusRow label={"Text Fields"} value={"Native"} tone={"success"} />
        <StatusRow label={"Toggles + Sliders"} value={"Native"} tone={"success"} />
        <StatusRow label={"Picker"} value={state.accentTheme} />
      </SectionCard>

      <NativeUiShowcase
        accentTheme={state.accentTheme}
        notes={state.notes}
        alertsEnabled={state.alertsEnabled}
        betaEnabled={state.betaEnabled}
        intensity={state.intensity}
        onAccentThemeChange={(value) => {
          dispatch({ type: "setAccentTheme", value });
        }}
        onNotesChange={(value) => {
          dispatch({ type: "setNotes", value });
        }}
        onAlertsEnabledChange={(value) => {
          dispatch({ type: "setAlertsEnabled", value });
        }}
        onBetaEnabledChange={(value) => {
          dispatch({ type: "setBetaEnabled", value });
        }}
        onIntensityChange={(value) => {
          dispatch({ type: "setIntensity", value });
        }}
        onPrimaryAction={() => {
          Alert.alert("Primary action", "Swap this callback with your own product workflow.");
        }}
        onSecondaryAction={() => {
          Alert.alert("Secondary flow", "This starter leaves the business logic intentionally generic.");
        }}
      />

      <SectionCard title={"Live State"} description={"The native components feed straight back into React state."}>
        <View style={{ gap: 8 }}>
          <Text selectable style={{ fontSize: 14, color: "#334155" }}>
            Accent theme: {state.accentTheme}
          </Text>
          <Text selectable style={{ fontSize: 14, color: "#334155" }}>
            Threshold: {Math.round(state.intensity)}%
          </Text>
          <Text selectable style={{ fontSize: 14, color: "#334155" }}>
            Alerts: {state.alertsEnabled ? "enabled" : "disabled"}
          </Text>
          <Text selectable style={{ fontSize: 14, color: "#334155" }}>
            Notes: {state.notes}
          </Text>
        </View>
      </SectionCard>
    </ScreenShell>
  );
}
