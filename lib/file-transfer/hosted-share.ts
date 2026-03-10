import { Share } from "react-native";

export interface HostedShareItem {
  fileName: string;
  shareUrl: string;
}

export function normalizeHostedPasscode(value: string) {
  const trimmedValue = value.trim();
  if (!trimmedValue) {
    return null;
  }

  if (!/^\d{6}$/.test(trimmedValue)) {
    throw new Error("Hosted link passcodes must be 6 digits.");
  }

  return trimmedValue;
}

export function buildHostedShareMessage(items: HostedShareItem[], passcode: string | null) {
  const lines = items.flatMap((item, index) => [index === 0 ? "Hosted file links" : "", item.fileName, item.shareUrl]);

  if (passcode) {
    lines.push("", `Passcode: ${passcode}`);
  }

  return lines
    .filter((line, index, values) => {
      if (line.length > 0) {
        return true;
      }

      const previous = values[index - 1];
      const next = values[index + 1];
      return Boolean(previous && next);
    })
    .join("\n");
}

export async function shareHostedLinksAsync(items: HostedShareItem[], passcode: string | null) {
  if (items.length === 0) {
    throw new Error("Add at least one hosted file before sharing.");
  }

  const title = items.length === 1 ? (items[0]?.fileName ?? "Hosted file link") : `Hosted file links (${items.length})`;
  return Share.share({
    message: buildHostedShareMessage(items, passcode),
    title,
  });
}
