import {
  startLocalHttpSession,
  stopLocalHttpSession,
  type LocalHttpSession,
} from "./local-http-runtime";
import type { HttpShareSession, SelectedTransferFile } from "./types";

type HttpShareSessionUpdate = (session: HttpShareSession) => void;

function toHttpShareSession(session: LocalHttpSession): HttpShareSession {
  return {
    id: session.id,
    status: session.status,
    deviceName: session.deviceName,
    shareUrl: session.shareUrl,
    manifestUrl: session.manifestUrl,
    qrValue: session.qrValue,
    files: session.files,
    totalBytes: session.totalBytes,
    startedAt: session.startedAt,
    detail: session.detail,
  };
}

export async function startHttpShareSession({
  files,
  deviceName,
  updateSession,
}: {
  files: SelectedTransferFile[];
  deviceName: string;
  updateSession?: HttpShareSessionUpdate;
}) {
  const session = await startLocalHttpSession({
    files,
    deviceName,
    updateSession: updateSession
      ? (nextSession) => {
          updateSession(toHttpShareSession(nextSession));
        }
      : undefined,
  });

  return toHttpShareSession(session);
}

export async function stopHttpShareSession(sessionId: string) {
  await stopLocalHttpSession(sessionId, "Browser sharing stopped.");
}
