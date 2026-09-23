import { afterEach, describe, expect, it } from "vitest";
import { cleanupRenders, render } from "../../testing/render";
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
});
