import type { SensorMetrics, SensorReading } from "../../api/types";
import { Panel } from "../ui/Panel";
import { Sparkline } from "../ui/Sparkline";
import { FanIcon, ThermometerIcon } from "../ui/icons";
import { useMetricsHistoryTail } from "../../hooks/metricsStore";
import { t } from "../../i18n";

interface HardwarePanelProps {
  /** Sensor inventory for this unit; null/undefined when the server omits it. */
  sensors: SensorMetrics | null | undefined;
  sparkId: string;
  temperatureUnit: "celsius" | "fahrenheit";
  className?: string;
}

function celsiusToFahrenheit(c: number): number {
  return Math.round((c * 9) / 5 + 32);
}

/**
 * Chip labels that mean nothing to a human. Everything else is shown as the
 * chip reports it — inventing friendly names for unmapped sensors is how a
 * panel starts lying.
 */
const READING_LABELS: Record<string, string> = {
  SYSTIN: "System",
  CPUTIN: "CPU socket",
  "PECI/TSI Agent 0 Calibration": "PECI",
  TSI0_TEMP: "TSI0",
  edge: "Edge",
  junction: "Junction",
  "PHY Temperature": "PHY",
  "MAC Temperature": "MAC",
};

function readingLabel(reading: { key: string; label: string }): string {
  const source = READING_LABELS[reading.label] ?? READING_LABELS[reading.key] ?? reading.label;
  return t(source);
}

/**
 * Warn/crit bands per component family. A CPU junction runs 30 °C hotter than
 * a chassis thermistor at the same moment, so one global band would pin every
 * NVMe row amber or let a 90 °C socket read as fine.
 */
function tempColor(celsius: number, family: "cpu" | "disk" | "other"): string {
  const [warn, crit] = family === "disk" ? [70, 80] : family === "cpu" ? [85, 95] : [85, 100];
  if (celsius >= crit) return "var(--color-danger)";
  if (celsius >= warn) return "var(--color-warning)";
  return "var(--color-accent)";
}

function ReadingRow({
  label,
  value,
  color,
  title,
  spark,
}: {
  label: string;
  value: string;
  color: string;
  title?: string;
  spark?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="truncate text-muted" title={title ?? label}>
        {label}
      </span>
      <div className="flex shrink-0 items-center gap-3">
        {spark}
        <span className="font-tabular text-sm font-semibold" style={{ color }}>
          {value}
        </span>
      </div>
    </div>
  );
}

function GroupHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] uppercase tracking-wide text-muted">{children}</div>
  );
}

/**
 * Hardware sensors panel — CPU / board / NVMe / NIC / iGPU temperatures plus
 * fan speeds for a real hardware host (the hypervisor box).
 *
 * Sensor rows the chips cannot back up are dropped server-side (floating
 * AUXTIN inputs, 0 °C PCH internals, fan headers with no fan), so what is left
 * is what the machine actually measures. An unreachable or sensor-less unit
 * says so instead of rendering an empty table.
 */
export function HardwarePanel({
  sensors,
  sparkId,
  temperatureUnit,
  className,
}: HardwarePanelProps) {
  const cpuTempHistory = useMetricsHistoryTail(sparkId, "cpu.temp");

  const available = Boolean(sensors?.available);
  const formatTemp = (celsius: number): string =>
    temperatureUnit === "fahrenheit"
      ? `${celsiusToFahrenheit(celsius)}°F`
      : `${celsius}°C`;
  const formatReading = (reading: SensorReading, family: "cpu" | "disk" | "other") => (
    <ReadingRow
      key={reading.key}
      label={readingLabel(reading)}
      value={formatTemp(reading.temperature)}
      color={tempColor(reading.temperature, family)}
      title={`${reading.key} · ${reading.temperature}°C`}
    />
  );

  return (
    <Panel
      title={t("Hardware sensors")}
      icon={<ThermometerIcon />}
      className={`panel-hardware ${className ?? ""}`}
      bodyClassName="space-y-3"
    >
      {!available ? (
        <p className="text-xs text-muted">
          {sensors?.reason === "unreadable"
            ? t("Sensor chips could not be read (SSH or sysfs error).")
            : t(
                "This machine exposes no hardware sensors (virtual machine or no monitoring chip)."
              )}
        </p>
      ) : (
        <>
          <section className="space-y-1.5">
            <div className="flex items-center justify-between">
              <GroupHeading>{t("Temperatures")}</GroupHeading>
              <span className="text-[10px] text-muted">
                {temperatureUnit === "fahrenheit" ? t("°F") : t("°C")}
              </span>
            </div>
            {sensors?.cpu && (
              <ReadingRow
                label={t("CPU")}
                value={formatTemp(sensors.cpu.temperature)}
                color={tempColor(sensors.cpu.temperature, "cpu")}
                title={`${sensors.cpu.label} · ${sensors.cpu.temperature}°C`}
                spark={
                  <Sparkline
                    data={cpuTempHistory}
                    color={tempColor(sensors.cpu.temperature, "cpu")}
                    width={120}
                  />
                }
              />
            )}
            {sensors?.igpu && formatReading(sensors.igpu, "other")}
            {(sensors?.board ?? []).map((reading) => formatReading(reading, "other"))}
            {(sensors?.disks ?? []).map((reading) => formatReading(reading, "disk"))}
            {(sensors?.nics ?? []).map((reading) => (
              <ReadingRow
                key={reading.key}
                label={`${reading.nicName} ${readingLabel(reading)}`}
                value={formatTemp(reading.temperature)}
                color={tempColor(reading.temperature, "other")}
                title={`${reading.key} · ${reading.temperature}°C`}
              />
            ))}
          </section>

          {(sensors?.fans ?? []).length > 0 && (
            <section className="space-y-1.5 border-t border-border pt-3">
              <div className="flex items-center justify-between">
                <GroupHeading>
                  <span className="inline-flex items-center gap-1">
                    <FanIcon className="h-3 w-3" />
                    {t("Fans")}
                  </span>
                </GroupHeading>
                <span className="text-[10px] text-muted">{t("rpm")}</span>
              </div>
              {(sensors?.fans ?? []).map((fan) => (
                <ReadingRow
                  key={fan.key}
                  label={
                    /^fan\d+$/i.test(fan.key)
                      ? `${t("Fan")} ${fan.key.replace(/^fan/i, "")}`
                      : fan.label
                  }
                  value={
                    fan.pwmPercent != null ? `${fan.rpm} · ${fan.pwmPercent}%` : String(fan.rpm)
                  }
                  color="var(--color-accent)"
                  title={
                    fan.pwmPercent != null
                      ? `${fan.key} · ${fan.rpm} rpm · ${fan.pwmPercent}% duty`
                      : `${fan.key} · ${fan.rpm} rpm`
                  }
                />
              ))}
              <p className="text-[10px] leading-snug text-muted">
                {t("Headers without a fan (0 rpm) are hidden.")}
              </p>
            </section>
          )}
        </>
      )}
    </Panel>
  );
}
