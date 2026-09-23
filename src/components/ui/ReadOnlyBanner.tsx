import { t } from "../../i18n";
import { InfoIcon } from "./icons";

/**
 * Shown on every tab while the server is in read-only mode, so a disabled button
 * never reads as a broken dashboard.
 */
export function ReadOnlyBanner({ className }: { className?: string }) {
  return (
    <div
      role="status"
      className={`flex items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-1.5 text-[11px] font-medium text-warning ${
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
