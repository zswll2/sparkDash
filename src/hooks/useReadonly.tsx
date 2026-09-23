import { createContext, useContext } from "react";

/**
 * Read-only mode, published by the server (`GET /api/health` → `readonly`) and
 * read through this context.
 *
 * The server refuses every state-changing request in this mode; the UI uses the
 * flag to disable controls so nothing looks clickable-but-dead. Treat it as a
 * display hint only — a component that forgets it still gets a 403 (and the API
 * client reports the real reason).
 */
const ReadonlyContext = createContext(false);

export const ReadonlyProvider = ReadonlyContext.Provider;

export function useReadonly(): boolean {
  return useContext(ReadonlyContext);
}
