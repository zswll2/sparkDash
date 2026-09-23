import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isReadonlyClient,
  refreshSparkMetric,
  setReadonlyState,
  updateDisabledDevices,
  fetchSparks,
} from "./client";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * The read-only guard in the API client exists so a control that forgot to
 * disable itself reports "read-only mode" instead of a bare HTTP 403. It must
 * never block reads, manual refresh, or the auth calls the session gate needs.
 * The server enforces the same rule regardless (see server/__tests__/readonly.test.js).
 */
describe("api client read-only guard", () => {
  afterEach(() => {
    setReadonlyState(false);
    vi.unstubAllGlobals();
  });

  it("refuses state-changing calls before they reach the network", async () => {
    setReadonlyState(true);
    const fetchMock = vi.fn(async () => jsonResponse(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updateDisabledDevices("pve", ["x"])).rejects.toThrow(/Read-only mode/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isReadonlyClient()).toBe(true);
  });

  it("still allows reads", async () => {
    setReadonlyState(true);
    const fetchMock = vi.fn(async () => jsonResponse(200, { sparks: [] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSparks()).resolves.toEqual({ sparks: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still allows the manual refresh trigger", async () => {
    setReadonlyState(true);
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await refreshSparkMetric("pve", "cpu");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lets everything through once read-only is off", async () => {
    setReadonlyState(false);
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await updateDisabledDevices("pve", []);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
