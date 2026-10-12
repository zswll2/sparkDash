/**
 * Unlock-window formatting, shared by the top banner and the Settings panel so
 * the same deadline never renders two different ways.
 */

/** `m:ss` (or `h:mm:ss` past an hour) — never negative. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}
