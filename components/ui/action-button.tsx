import React from "react";
import { Pressable, Text } from "react-native";

type Tone = "primary" | "secondary" | "danger";

const toneStyles: Record<Tone, { backgroundColor: string; borderColor: string; textColor: string }> = {
  primary: {
    backgroundColor: "#0f172a",
    borderColor: "#0f172a",
    textColor: "#ffffff",
  },
  secondary: {
    backgroundColor: "#ffffff",
    borderColor: "rgba(15, 23, 42, 0.12)",
    textColor: "#0f172a",
  },
  danger: {
    backgroundColor: "#ffffff",
    borderColor: "rgba(220, 38, 38, 0.18)",
    textColor: "#b91c1c",
  },
};

interface ActionButtonProps {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: Tone;
}

export function ActionButton({ label, onPress, disabled = false, tone = "primary" }: ActionButtonProps) {
  const styles = toneStyles[tone];

  return (
    <Pressable
      disabled={disabled}
      onPress={onPress}
      style={{
        borderRadius: 18,
        borderWidth: 1,
        borderColor: styles.borderColor,
        backgroundColor: styles.backgroundColor,
        paddingHorizontal: 16,
        paddingVertical: 14,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      <Text
        selectable
        style={{
          color: styles.textColor,
          fontSize: 15,
          fontWeight: "700",
          textAlign: "center",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
