import { useEffect, useState } from "react";
import { t } from "../../i18n";
import { formatRemaining } from "../../shared/readonlyTime";
import { InfoIcon } from "./icons";

/**
 * Shown on every tab while the server is in read-only mode, so a disabled button
 * never reads as a broken dashboard.
 *
 * With an active unlock it becomes a countdown plus a one-click way back to the
 * locked state: an operator who opened the fleet must not have to remember to
 * close it again.
 */
export function ReadOnlyBanner({
  className,
  unlocked = false,
  expiresAt = null,
  onLock,
}: {
  className?: string;
  /** True while this session holds a live unlock. */
  unlocked?: boolean;
  /** Unlock deadline (epoch ms) — drives the countdown. */
  expiresAt?: number | null;
  onLock?: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!unlocked || expiresAt == null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [unlocked, expiresAt]);

  if (unlocked) {
    return (
      <div
        role="status"
        className={`flex flex-wrap items-center gap-x-2 gap-y-1 border border-warning/40 bg-warning/10 px-3 py-1.5 text-[11px] font-medium text-warning ${
          className ?? ""
        }`}
      >
        <InfoIcon className="h-3.5 w-3.5 shrink-0" />
        <span>{t("Read-only mode is unlocked for this session.")}</span>
        {expiresAt != null && (
          <span className="font-tabular">
            {t("Remaining")} {formatRemaining(expiresAt - now)}
          </span>
        )}
        {onLock && (
          <button
            type="button"
            onClick={onLock}
            className="ml-auto border border-warning/50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition-colors hover:bg-warning/20"
          >
            {t("Lock now")}
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      role="status"
      className={`flex items-center gap-2 border border-warning/40 bg-warning/10 px-3 py-1.5 text-[11px] font-medium text-warning ${
        className ?? ""
      }`}
    >
      <InfoIcon className="h-3.5 w-3.5 shrink-0" />
      <span>
        {t("Read-only mode — this dashboard is view-only. Operations are disabled on the server.")}
      </span>
    </div>
  );
}
