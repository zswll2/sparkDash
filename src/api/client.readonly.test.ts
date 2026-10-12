import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isReadonlyClient,
  lockReadonly,
  refreshSparkMetric,
  setReadonlyBlockedHandler,
  setReadonlyState,
  unlockReadonly,
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
 * never block reads, manual refresh, the auth calls the session gate needs, or
 * the unlock calls — those are how an operator gets OUT of read-only mode.
 * The server enforces the same rule regardless (see server/__tests__/readonly.test.js).
 */
describe("api client read-only guard", () => {
  afterEach(() => {
    setReadonlyState(false);
    setReadonlyBlockedHandler(null);
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

  it("never blocks unlocking while locked — that is the way out", async () => {
    setReadonlyState(true);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      return jsonResponse(200, { ok: true, readonlyState: "readonly", unlocked: true, expiresAt: 123 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(unlockReadonly("ops-secret")).resolves.toMatchObject({ unlocked: true });
    await expect(lockReadonly()).resolves.toMatchObject({ unlocked: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/readonly/unlock");
    expect(String(fetchMock.mock.calls[1][0])).toContain("/api/readonly/lock");
  });

  it("tells the app shell when the server rejects a write as read-only", async () => {
    setReadonlyState(false);
    const onBlocked = vi.fn();
    setReadonlyBlockedHandler(onBlocked);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(403, { error: "Read-only mode: PUT /api/settings is disabled" })
      )
    );

    await expect(updateDisabledDevices("pve", ["x"])).rejects.toThrow(/Read-only mode/);
    expect(onBlocked).toHaveBeenCalledTimes(1);
  });

  it("does not cry wolf on unrelated failures", async () => {
    setReadonlyState(false);
    const onBlocked = vi.fn();
    setReadonlyBlockedHandler(onBlocked);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(500, { error: "boom" })));

    await expect(updateDisabledDevices("pve", ["x"])).rejects.toThrow(/boom/);
    expect(onBlocked).not.toHaveBeenCalled();
  });
});
