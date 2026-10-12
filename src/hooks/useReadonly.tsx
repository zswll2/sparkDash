import { createContext, useContext } from "react";
import type { ReadonlyState } from "../api/client";

/**
 * Read-only mode, published by the server (`GET /api/health`) and read through
 * these contexts.
 *
 * The server refuses every state-changing request in this mode; the UI uses the
 * flag to disable controls so nothing looks clickable-but-dead. Treat it as a
 * display hint only — a component that forgets it still gets a 403 (and the API
 * client reports the real reason).
 *
 * `useReadonly()` is the *effective* answer: true while this session may not
 * change anything. It is false when the server is not in read-only mode at all
 * AND when the operator unlocked this session from Settings — so a component
 * never has to know that unlocking exists.
 */
const ReadonlyContext = createContext(false);

export const ReadonlyProvider = ReadonlyContext.Provider;

export function useReadonly(): boolean {
  return useContext(ReadonlyContext);
}

export interface ReadonlyUnlockState {
  /** Server-wide posture: "full" (no lock), "readonly" (unlockable), "locked" (hard). */
  state: ReadonlyState;
  /** True while THIS session carries a live unlock (full control, time-boxed). */
  unlocked: boolean;
  /** Unlock deadline in epoch ms, or null while locked. */
  expiresAt: number | null;
  /** False when the server has no unlock password yet. */
  configured: boolean;
  /** Adopt a fresh unlock (the server just returned its deadline). */
  applyUnlock: (expiresAt: number | null) => void;
  /** Drop the unlock locally: the window closed, or a rejected write. */
  applyLock: () => void;
  /**
   * Close the window for real: the server drops the elevation for this session
   * first, then the UI follows. Use this for "Lock now"; `applyLock` only
   * mirrors a state the server has already decided.
   */
  lock: () => Promise<void>;
}

const DEFAULT_UNLOCK: ReadonlyUnlockState = {
  state: "readonly",
  unlocked: false,
  expiresAt: null,
  configured: false,
  applyUnlock: () => {},
  applyLock: () => {},
  lock: async () => {},
};

const ReadonlyUnlockContext = createContext<ReadonlyUnlockState>(DEFAULT_UNLOCK);

export const ReadonlyUnlockProvider = ReadonlyUnlockContext.Provider;

/** Posture + unlock window: what Settings and the top banner need. */
export function useReadonlyUnlock(): ReadonlyUnlockState {
  return useContext(ReadonlyUnlockContext);
}
