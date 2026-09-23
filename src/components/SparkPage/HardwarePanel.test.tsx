import { afterEach, describe, expect, it } from "vitest";
import { HardwarePanel } from "./HardwarePanel";
import { cleanupRenders, render } from "../../testing/render";
import { makeEmptySensors, makeSensors } from "../../testing/fixtures";

afterEach(() => cleanupRenders());

describe("HardwarePanel", () => {
  it("lists component temperatures and fan speeds", () => {
    const { container } = render(
      <HardwarePanel sensors={makeSensors()} sparkId="pve" temperatureUnit="celsius" />
    );
    const text = container.textContent ?? "";

    expect(text).toContain("Hardware sensors");
    expect(text).toContain("Temperatures");
    expect(text).toContain("76.3°C"); // CPU junction
    expect(text).toContain("System"); // SYSTIN, mapped to a readable label
    expect(text).toContain("38°C");
    expect(text).toContain("ZHITAI Ti600 1TB");
    expect(text).toContain("enp10s0 PHY");
    expect(text).toContain("Edge");
    expect(text).toContain("Fans");
    expect(text).toContain("2760 · 70%");
    // Empty headers are dropped server-side; the footnote explains the gap
    // between the board's seven channels and the three running fans.
    expect(text).not.toMatch(/fan1|fan4|fan7/);
    expect(text).toContain("Headers without a fan (0 rpm) are hidden.");
  });

  it("shows the temperature unit from settings", () => {
    const { container } = render(
      <HardwarePanel sensors={makeSensors()} sparkId="pve" temperatureUnit="fahrenheit" />
    );
    const text = container.textContent ?? "";
    expect(text).toContain("169°F"); // 76.3 °C
    expect(text).toContain("100°F"); // 38 °C
    expect(text).not.toContain("°C");
  });

  it("explains a sensor-less unit instead of rendering an empty table", () => {
    const { container } = render(
      <HardwarePanel sensors={makeEmptySensors()} sparkId="vm100" temperatureUnit="celsius" />
    );
    const text = container.textContent ?? "";
    expect(text).toContain("no hardware sensors");
    expect(text).not.toContain("Temperatures");
  });

  it("tells a failed probe apart from a machine without sensors", () => {
    const { container } = render(
      <HardwarePanel
        sensors={makeEmptySensors("unreadable")}
        sparkId="pve"
        temperatureUnit="celsius"
      />
    );
    expect(container.textContent ?? "").toContain("could not be read");
  });

  it("stays quiet when the server sends no sensor payload at all", () => {
    const { container } = render(
      <HardwarePanel sensors={null} sparkId="spark-1" temperatureUnit="celsius" />
    );
    expect(container.textContent ?? "").toContain("no hardware sensors");
  });
});
