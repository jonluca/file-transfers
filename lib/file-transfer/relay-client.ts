import { File } from "expo-file-system";
import { getApiBaseUrl } from "@/lib/api-config";
import type { RelayAccess, RelayCredentials, SelectedTransferFile } from "./types";

export interface RelaySessionState {
  id: string;
  receiverDeviceName: string | null;
  status: "waiting_receiver" | "accepted" | "uploading" | "ready" | "rejected" | "completed" | "expired";
  fileCount: number;
  totalBytes: number;
  files: Array<{
    id: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
    uploaded: boolean;
  }>;
  expiresAt: string;
}

function getRelayUrl(path: string) {
  return `${getApiBaseUrl()}${path}`;
}

async function parseRelayResponse<T>(response: Response) {
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? `Relay request failed with status ${response.status}.`);
  }

  return (await response.json()) as T;
}

function relayHeaders(token: string) {
  return {
    "content-type": "application/json",
    "x-relay-token": token,
  };
}

export async function createRelayTransferSession({
  senderDeviceName,
  files,
}: {
  senderDeviceName: string;
  files: SelectedTransferFile[];
}) {
  const response = await fetch(getRelayUrl("/relay/sessions"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      senderDeviceName,
      files: files.map((file) => ({
        id: file.id,
        name: file.name,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
      })),
    }),
  });

  const payload = await parseRelayResponse<{
    session: RelaySessionState;
    senderToken: string;
    receiverToken: string;
  }>(response);

  return {
    sessionId: payload.session.id,
    senderToken: payload.senderToken,
    receiverToken: payload.receiverToken,
    expiresAt: payload.session.expiresAt,
  } satisfies RelayCredentials;
}

export async function getRelaySenderState(relay: RelayCredentials) {
  const response = await fetch(getRelayUrl(`/relay/sessions/${relay.sessionId}/sender`), {
    headers: {
      "x-relay-token": relay.senderToken,
    },
  });

  return parseRelayResponse<RelaySessionState>(response);
}

export async function getRelayReceiverState(relay: RelayAccess) {
  const response = await fetch(getRelayUrl(`/relay/sessions/${relay.sessionId}/receiver`), {
    headers: {
      "x-relay-token": relay.receiverToken,
    },
  });

  return parseRelayResponse<RelaySessionState>(response);
}

export async function acceptRelayTransferSession({
  relay,
  receiverDeviceName,
}: {
  relay: RelayAccess;
  receiverDeviceName: string;
}) {
  const response = await fetch(getRelayUrl(`/relay/sessions/${relay.sessionId}/accept`), {
    method: "POST",
    headers: relayHeaders(relay.receiverToken),
    body: JSON.stringify({
      receiverDeviceName,
    }),
  });

  return parseRelayResponse<RelaySessionState>(response);
}

export async function declineRelayTransferSession(relay: RelayAccess) {
  const response = await fetch(getRelayUrl(`/relay/sessions/${relay.sessionId}/decline`), {
    method: "POST",
    headers: {
      "x-relay-token": relay.receiverToken,
    },
  });

  return parseRelayResponse<RelaySessionState>(response);
}

export async function uploadRelayTransferFile({
  relay,
  file,
}: {
  relay: RelayCredentials;
  file: SelectedTransferFile;
}) {
  const uploadFile = new File(file.uri);
  const response = await fetch(getRelayUrl(`/relay/sessions/${relay.sessionId}/files/${file.id}`), {
    method: "PUT",
    headers: {
      "content-type": file.mimeType,
      "x-relay-token": relay.senderToken,
    },
    body: uploadFile,
  });

  return parseRelayResponse<RelaySessionState>(response);
}

export async function downloadRelayTransferFile({
  relay,
  fileId,
  destination,
}: {
  relay: RelayAccess;
  fileId: string;
  destination: File;
}) {
  return File.downloadFileAsync(getRelayUrl(`/relay/sessions/${relay.sessionId}/files/${fileId}`), destination, {
    headers: {
      "x-relay-token": relay.receiverToken,
    },
    idempotent: true,
  });
}

export async function completeRelayTransferSession(relay: RelayAccess) {
  const response = await fetch(getRelayUrl(`/relay/sessions/${relay.sessionId}/complete`), {
    method: "POST",
    headers: {
      "x-relay-token": relay.receiverToken,
    },
  });

  return parseRelayResponse<RelaySessionState>(response);
}

export async function deleteRelayTransferSession(relay: RelayCredentials) {
  const response = await fetch(getRelayUrl(`/relay/sessions/${relay.sessionId}`), {
    method: "DELETE",
    headers: {
      "x-relay-token": relay.senderToken,
    },
  });

  if (response.status === 204) {
    return;
  }

  await parseRelayResponse<RelaySessionState>(response);
}
