import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupRenders, render } from "../../testing/render";
import { formatRemaining } from "../../shared/readonlyTime";
import { ReadOnlyBanner } from "./ReadOnlyBanner";

afterEach(() => cleanupRenders());

describe("ReadOnlyBanner", () => {
  it("states that the dashboard is view-only", () => {
    const { container } = render(<ReadOnlyBanner />);
    expect(container.textContent ?? "").toContain("Read-only mode");
    expect(container.textContent ?? "").toContain("view-only");
  });

  it("is announced as a status region, not an error", () => {
    const { container } = render(<ReadOnlyBanner />);
    expect(container.querySelector("[role='status']")).not.toBeNull();
  });

  it("counts the unlock down and offers to lock again", () => {
    const onLock = vi.fn();
    const { container } = render(
      <ReadOnlyBanner unlocked expiresAt={Date.now() + 90_000} onLock={onLock} />
    );
    expect(container.textContent ?? "").toContain("unlocked for this session");
    expect(container.textContent ?? "").toMatch(/1:2\d/);

    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Lock now");
    act(() => button?.click());
    expect(onLock).toHaveBeenCalledTimes(1);
  });

  it("omits the countdown when the server sends no deadline", () => {
    const { container } = render(<ReadOnlyBanner unlocked onLock={() => {}} />);
    expect(container.textContent ?? "").toContain("unlocked for this session");
    expect(container.textContent ?? "").not.toContain("Remaining");
  });

  it("offers the way in while locked", () => {
    const onUnlock = vi.fn();
    const { container } = render(<ReadOnlyBanner onUnlock={onUnlock} />);
    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Unlock");
    act(() => button?.click());
    expect(onUnlock).toHaveBeenCalledTimes(1);
  });
});

describe("formatRemaining", () => {
  it("renders m:ss and never goes negative", () => {
    expect(formatRemaining(90_000)).toBe("1:30");
    expect(formatRemaining(9_000)).toBe("0:09");
    expect(formatRemaining(-5_000)).toBe("0:00");
  });

  it("grows to h:mm:ss past an hour", () => {
    expect(formatRemaining(3_600_000 + 61_000)).toBe("1:01:01");
  });
});
