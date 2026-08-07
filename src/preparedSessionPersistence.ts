/**
 * Disk persistence for the prepared-session (warm session) pool.
 *
 * The backend keeps sessions on disk indefinitely, so the *backend*
 * session can outlive this process. This module lets the adapter
 * remember which session ids it had prepared, in the same directory as
 * the request/response logs, so that after a WebSocket reconnect (either
 * a same-process transport blip or a full container restart) the adapter
 * can attempt to reclaim those sessions via `session/resume` instead of
 * always creating and re-warming brand-new ones.
 */

import fs from "fs";
import path from "path";
import { getLogDirectory } from "./logger";

export type PersistedPreparedSession = {
  sessionId: string;
  createdAt: number;
};

const FILE_NAME = "prepared-session-pool.json";

function resolveFilePath(): string {
  return path.join(getLogDirectory(), FILE_NAME);
}

/**
 * Load the last known prepared-session pool contents from disk.
 * Returns an empty array if the file is missing, unreadable, or malformed -
 * callers should always be prepared to fall back to creating fresh sessions.
 */
export function loadPersistedPreparedSessions(): PersistedPreparedSession[] {
  try {
    const filePath = resolveFilePath();
    if (!fs.existsSync(filePath)) {
      return [];
    }

    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter(
      (entry): entry is PersistedPreparedSession =>
        Boolean(entry)
        && typeof entry === "object"
        && typeof (entry as Record<string, unknown>).sessionId === "string"
        && typeof (entry as Record<string, unknown>).createdAt === "number"
    );
  } catch (error) {
    console.warn(`Failed to load persisted prepared-session pool: ${error}`);
    return [];
  }
}

/**
 * Persist the current prepared-session pool contents to disk so a future
 * process restart or reconnect can attempt to reclaim them.
 */
export function savePersistedPreparedSessions(entries: PersistedPreparedSession[]): void {
  try {
    const filePath = resolveFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(entries), "utf8");
  } catch (error) {
    console.warn(`Failed to persist prepared-session pool: ${error}`);
  }
}
