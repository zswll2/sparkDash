import type { SparkTestResponse } from "../../api/types";
import { t } from "../../i18n";

export function ConnectivityResult({ result }: { result: SparkTestResponse }) {
  return (
    <div
      className={`mt-3 rounded px-3 py-2 text-xs ${result.ok ? "bg-success/20" : "bg-danger/20"}`}
      role="status"
    >
      <p className={result.ok ? "text-success" : "text-danger"}>
        {result.ok ? t("All required capabilities passed.") : t("One or more required capabilities failed.")}
      </p>
      <ul className="mt-1 space-y-1">
        {result.capabilities.map((capability) => (
          <li key={capability.id} className={capability.status === "fail" ? "text-danger" : "text-muted"}>
            <strong>{capability.label}:</strong>{" "}
            {capability.status === "pass" ? t("Pass") : capability.status === "fail" ? t("Fail") : t("Skipped")}
            {capability.message ? ` — ${capability.message}` : ""}
            {capability.recovery ? ` ${capability.recovery}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}
