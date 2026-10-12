import { useCallback, useEffect, useRef, useState } from "react";
import type { LlmMetrics } from "../../api/types";
import { t } from "../../i18n";

/** Ring depth: four minutes of samples at the 1 s poll. */
export const MAX_TERMINAL_LINES = 240;

interface TerminalLine {
  id: number;
  text: string;
}

/**
 * One log line per received sample.
 *
 * Decode and prefill come first because those are the numbers an operator
 * actually watches while a model serves; every other column appears only when
 * the backend reports it (an unconditional column would print a fake 0).
 *
 * Exported so the format lives in exactly one place and can be unit-tested.
 */
export function formatTerminalLine(llm: LlmMetrics, at: Date = new Date()): string {
  const time = at.toTimeString().slice(0, 8);
  const cols: string[] = [
    `dec ${(llm.generationTps ?? 0).toFixed(1).padStart(7)}`,
    `pre ${(llm.prefillTps ?? 0).toFixed(0).padStart(6)}`,
  ];
  if (llm.cachedPrefillTps != null) cols.push(`cch ${llm.cachedPrefillTps.toFixed(0).padStart(6)}`);
  if (llm.uncachedPrefillTps != null) cols.push(`unc ${llm.uncachedPrefillTps.toFixed(0).padStart(6)}`);
  if (llm.kvCacheUsage != null) cols.push(`kv ${(llm.kvCacheUsage * 100).toFixed(0).padStart(3)}%`);
  if (llm.requestsRunning != null) cols.push(`run ${llm.requestsRunning}/${llm.requestsWaiting ?? 0}`);
  if (llm.ttftSeconds != null) cols.push(`ttft ${llm.ttftSeconds.toFixed(2)}s`);
  else if (llm.ttftP95Seconds != null) cols.push(`ttft95 ${llm.ttftP95Seconds.toFixed(2)}s`);
  if (llm.itlP95Seconds != null) cols.push(`itl95 ${llm.itlP95Seconds.toFixed(2)}s`);
  if ((llm.slotsTotal ?? 0) > 0) cols.push(`slots ${llm.slotsActive}/${llm.slotsTotal}`);
  return `${time}  ${cols.join("  ")}`;
}

/**
 * Live log of the LLM card's samples — a terminal, not a chart: lines arrive
 * one at a time as the server pushes them, so the operator can watch throughput
 * instead of guessing from a number that changes in place.
 *
 * Samples are appended only while the terminal is open (opening it shows a line
 * immediately, then one per sample), and the tail follows unless the operator
 * scrolled up to read something.
 */
export function LlmTerminal({
  llm,
  visible,
}: {
  llm: LlmMetrics | null;
  /** Rendered only when the operator opened the terminal. */
  visible: boolean;
}) {
  const [lines, setLines] = useState<TerminalLine[]>([]);
  const [follow, setFollow] = useState(true);
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const lastSample = useRef<LlmMetrics | null>(null);
  const wasVisible = useRef(false);
  const nextId = useRef(0);

  useEffect(() => {
    if (!visible) {
      wasVisible.current = false;
      return;
    }
    if (!llm) return;
    // The same sample object can re-render for unrelated reasons (a sibling
    // port updating, a settings change): one line per sample, not per render.
    if (wasVisible.current && lastSample.current === llm) return;
    wasVisible.current = true;
    lastSample.current = llm;
    setLines((prev) => {
      nextId.current += 1;
      const next = prev.length >= MAX_TERMINAL_LINES ? prev.slice(prev.length - MAX_TERMINAL_LINES + 1) : prev.slice();
      next.push({ id: nextId.current, text: formatTerminalLine(llm) });
      return next;
    });
  }, [llm, visible]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !follow) return;
    el.scrollTop = el.scrollHeight;
  }, [lines, follow]);

  const handleScroll = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 12);
  }, []);

  const handleCopy = useCallback(() => {
    const text = lines.map((line) => line.text).join("\n");
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      },
      () => {
        /* clipboard unavailable (insecure origin/permission) — the log stays readable */
      }
    );
  }, [lines]);

  return (
    <div className="llm-term">
      <div className="llm-term__bar">
        <span className="llm-term__title">{t("Live terminal")}</span>
        <span className="llm-term__hint">{t("One line per sample — dec/pre in tok/s")}</span>
        <span className="ml-auto flex items-center gap-1">
          <button type="button" onClick={() => setLines([])} className="llm-term__action">
            {t("Clear")}
          </button>
          <button
            type="button"
            onClick={handleCopy}
            disabled={lines.length === 0}
            className="llm-term__action disabled:opacity-40"
          >
            {copied ? t("Copied") : t("Copy")}
          </button>
        </span>
      </div>
      <div
        ref={bodyRef}
        onScroll={handleScroll}
        data-testid="llm-terminal-body"
        className="llm-term__body"
      >
        {lines.length === 0 ? (
          <div className="llm-term__empty">
            {llm ? t("Waiting for the next sample…") : t("No LLM samples yet.")}
          </div>
        ) : (
          lines.map((line) => (
            <div key={line.id} className="llm-term__line">
              {line.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
