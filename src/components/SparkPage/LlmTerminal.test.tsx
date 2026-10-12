import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupRenders, render } from "../../testing/render";
import { LlmTerminal, MAX_TERMINAL_LINES, formatTerminalLine } from "./LlmTerminal";
import type { LlmMetrics } from "../../api/types";

function metrics(overrides: Partial<LlmMetrics> = {}): LlmMetrics {
  return {
    available: true,
    backend: "vllm",
    modelId: "qwen38-27b",
    modelPath: null,
    contextLength: 262144,
    gpuMemoryUtilization: 0.5,
    slotsActive: 1,
    slotsTotal: 4,
    generationTps: 42.25,
    prefillTps: 1204,
    totalOutputTokens: 1000,
    error: null,
    ...overrides,
  } as LlmMetrics;
}

const at183007 = new Date(2026, 9, 12, 18, 30, 7);

function lineCount(container: HTMLElement): number {
  return container.querySelectorAll(".llm-term__line").length;
}

function clickByText(container: HTMLElement, label: string) {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!button) throw new Error(`no button labelled ${label}`);
  act(() => button.click());
}

afterEach(() => cleanupRenders());

describe("formatTerminalLine", () => {
  it("puts decode and prefill first and prints only the columns the backend reports", () => {
    const line = formatTerminalLine(
      metrics({ kvCacheUsage: 0.12, requestsRunning: 1, requestsWaiting: 0 }),
      at183007
    );
    expect(line).toMatch(/^18:30:07 {2}dec +42\.3 {2}pre +1204/);
    expect(line).toMatch(/kv +12%/);
    expect(line).toContain("run 1/0");
    // Absent metrics must not print a fake zero column.
    expect(line).not.toContain("ttft");
    expect(line).not.toContain("cch");
    expect(line).not.toContain("itl95");
  });

  it("includes latency and prefill-split columns when they exist", () => {
    const line = formatTerminalLine(
      metrics({ ttftSeconds: 0.312, cachedPrefillTps: 9000, uncachedPrefillTps: 1500 }),
      at183007
    );
    expect(line).toContain("cch   9000");
    expect(line).toContain("unc   1500");
    expect(line).toContain("ttft 0.31s");
  });

  it("falls back to the p95 time-to-first-token when the live value is missing", () => {
    const line = formatTerminalLine(metrics({ ttftP95Seconds: 1.5 }), at183007);
    expect(line).toContain("ttft95 1.50s");
  });
});

describe("LlmTerminal", () => {
  it("appends one line per sample, and only while it is open", () => {
    const first = metrics();
    const second = metrics({ generationTps: 55.5 });
    const { container, root } = render(<LlmTerminal llm={first} visible={false} />);

    // Closed: nothing is buffered, however many samples pass by.
    expect(lineCount(container)).toBe(0);
    act(() => root.render(<LlmTerminal llm={first} visible={false} />));
    expect(lineCount(container)).toBe(0);

    // Opening prints the sample on hand immediately…
    act(() => root.render(<LlmTerminal llm={first} visible={true} />));
    expect(lineCount(container)).toBe(1);

    // …then every new sample adds exactly one line.
    act(() => root.render(<LlmTerminal llm={second} visible={true} />));
    expect(lineCount(container)).toBe(2);

    // Re-renders of the same sample (other panels updating) add nothing.
    act(() => root.render(<LlmTerminal llm={second} visible={true} />));
    expect(lineCount(container)).toBe(2);
    expect(container.textContent).toContain("55.5");
  });

  it("explains itself before the first sample arrives", () => {
    const { container, root } = render(<LlmTerminal llm={null} visible={true} />);
    expect(container.textContent).toContain("No LLM samples yet.");
    act(() => root.render(<LlmTerminal llm={metrics()} visible={true} />));
    expect(container.textContent).not.toContain("No LLM samples yet.");
  });

  it("clears on demand", () => {
    const { container } = render(<LlmTerminal llm={metrics()} visible={true} />);
    expect(lineCount(container)).toBe(1);
    clickByText(container, "Clear");
    expect(lineCount(container)).toBe(0);
    expect(container.textContent).toContain("Waiting for the next sample");
  });

  it("keeps the log bounded so a long-running tab cannot grow forever", () => {
    const { container, root } = render(<LlmTerminal llm={metrics()} visible={true} />);
    for (let i = 0; i < MAX_TERMINAL_LINES + 5; i += 1) {
      const sample = metrics({ generationTps: 10 + i });
      act(() => root.render(<LlmTerminal llm={sample} visible={true} />));
    }
    expect(lineCount(container)).toBe(MAX_TERMINAL_LINES);
    // The oldest lines are the ones dropped.
    expect(container.textContent).not.toContain("dec    10.0");
  });
});
