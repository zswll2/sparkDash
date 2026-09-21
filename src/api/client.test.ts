import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthRequiredError, fetchAuthSession, fetchSparks, login, logout } from "./client";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("api client auth handling", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws AuthRequiredError when the server answers 401", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { error: "Authentication required" })));
    await expect(fetchSparks()).rejects.toBeInstanceOf(AuthRequiredError);
    await expect(fetchSparks()).rejects.toMatchObject({ status: 401 });
  });

  it("sends credentials: same-origin on every request", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { sparks: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await fetchSparks();
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: "same-origin" });
  });

  it("login posts credentials and resolves on success", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true, user: "admin" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(login("admin", "pw")).resolves.toEqual({ ok: true, user: "admin" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/auth/login");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ username: "admin", password: "pw" });
  });

  it("logout posts to the logout route", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(logout()).resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/auth/logout");
    expect(init.method).toBe("POST");
  });

  it("fetchAuthSession returns the session payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(200, { authenticated: true, user: "admin" }))
    );
    await expect(fetchAuthSession()).resolves.toEqual({ authenticated: true, user: "admin" });
  });
});
