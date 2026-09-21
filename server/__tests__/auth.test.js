import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashPassword, verifyPassword, loadAuthConfig, authConfigPath } from "../auth.js";
import {
  createSession,
  getSession,
  destroySession,
  touchSession,
  sessionCookieName,
  parseCookieHeader,
  serializeSessionCookie,
  __resetSessionsForTest,
} from "../auth.js";

function withAuthJson(body, mode) {
  const dir = mkdtempSync(path.join(tmpdir(), "sparkdash-auth-"));
  const file = path.join(dir, "auth.json");
  if (body !== undefined) writeFileSync(file, body);
  if (mode !== undefined) chmodSync(file, mode);
  process.env.SPARKDASH_AUTH_JSON = file;
  return { file, cleanup: () => { rmSync(dir, { recursive: true, force: true }); delete process.env.SPARKDASH_AUTH_JSON; } };
}

test("hashPassword produces scrypt record; verifyPassword accepts correct password", () => {
  const rec = hashPassword("s3cret-password");
  assert.equal(rec.N, 16384);
  assert.equal(rec.r, 8);
  assert.equal(rec.p, 1);
  assert.equal(rec.keylen, 64);
  assert.match(rec.salt, /^[0-9a-f]{64}$/);
  assert.match(rec.hash, /^[0-9a-f]{128}$/);
  assert.equal(verifyPassword("s3cret-password", rec), true);
});

test("verifyPassword rejects wrong password", () => {
  const rec = hashPassword("s3cret-password");
  assert.equal(verifyPassword("wrong-password", rec), false);
});

test("verifyPassword rejects empty password", () => {
  const rec = hashPassword("s3cret-password");
  assert.equal(verifyPassword("", rec), false);
});

test("verifyPassword with tampered (short) hash returns false without throwing", () => {
  const rec = hashPassword("s3cret-password");
  const tampered = { ...rec, hash: "abcd" };
  assert.equal(verifyPassword("s3cret-password", tampered), false);
});

test("verifyPassword handles malformed records without throwing", () => {
  assert.equal(verifyPassword("x", null), false);
  assert.equal(verifyPassword("x", {}), false);
  assert.equal(verifyPassword("x", { salt: "zz", hash: "not-hex" }), false);
});

test("loadAuthConfig returns null when file is missing", () => {
  const { cleanup } = withAuthJson(undefined);
  try {
    assert.equal(loadAuthConfig(), null);
  } finally {
    cleanup();
  }
});

test("loadAuthConfig returns the record for a valid 0600 file", () => {
  const rec = { user: "admin", algo: "scrypt", salt: "aa", hash: "bb", updatedAt: "2026-09-21T00:00:00Z" };
  const { cleanup } = withAuthJson(JSON.stringify(rec), 0o600);
  try {
    assert.deepEqual(loadAuthConfig(), rec);
  } finally {
    cleanup();
  }
});

test("loadAuthConfig throws on malformed JSON (never degrades to no-account)", () => {
  const { cleanup } = withAuthJson("{not json", 0o600);
  try {
    assert.throws(() => loadAuthConfig(), /not valid JSON/);
  } finally {
    cleanup();
  }
});

test("loadAuthConfig throws on group/world-readable permissions", () => {
  const rec = { user: "admin", salt: "aa", hash: "bb" };
  const { cleanup } = withAuthJson(JSON.stringify(rec), 0o644);
  try {
    assert.throws(() => loadAuthConfig(), /insecure permissions/);
  } finally {
    cleanup();
  }
});

test("authConfigPath honors SPARKDASH_AUTH_JSON override", () => {
  const custom = path.join(tmpdir(), "custom-auth.json");
  process.env.SPARKDASH_AUTH_JSON = custom;
  try {
    assert.equal(authConfigPath(), custom);
  } finally {
    delete process.env.SPARKDASH_AUTH_JSON;
  }
  assert.match(authConfigPath(), /config[\\/]auth\.json$/);
});

test("session lifecycle: create → get → destroy → null", () => {
  __resetSessionsForTest();
  const { id } = createSession("admin", { ip: "192.168.10.1" });
  assert.match(id, /^[0-9a-f]{64}$/);
  assert.equal(getSession(id).user, "admin");
  destroySession(id);
  assert.equal(getSession(id), null);
});

test("expired session (TTL=50ms) returns null and is removed", async () => {
  __resetSessionsForTest();
  process.env.SESSION_TTL_MS = "50";
  try {
    const { id } = createSession("admin");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(getSession(id), null);
    assert.equal(getSession(id), null); // stays gone
  } finally {
    delete process.env.SESSION_TTL_MS;
    __resetSessionsForTest();
  }
});

test("touchSession keeps a session alive past its original creation", async () => {
  __resetSessionsForTest();
  process.env.SESSION_TTL_MS = "60";
  try {
    const { id } = createSession("admin");
    await new Promise((resolve) => setTimeout(resolve, 40));
    touchSession(id);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.notEqual(getSession(id), null); // sliding expiry from lastSeen
  } finally {
    delete process.env.SESSION_TTL_MS;
    __resetSessionsForTest();
  }
});

test("sessionCookieName and cookie round-trip", () => {
  assert.equal(sessionCookieName(), "sparkdash_session");
  const cookie = serializeSessionCookie("abc123", { secure: false, maxAgeSec: 43200 });
  assert.ok(cookie.includes("sparkdash_session=abc123"));
  assert.ok(cookie.includes("HttpOnly"));
  assert.ok(cookie.includes("SameSite=Strict"));
  assert.ok(cookie.includes("Path=/"));
  assert.ok(cookie.includes("Max-Age=43200"));
  assert.ok(!cookie.includes("Secure"));
  assert.equal(parseCookieHeader(cookie)[sessionCookieName()], "abc123");
});

test("serializeSessionCookie adds Secure when secure:true", () => {
  const cookie = serializeSessionCookie("abc123", { secure: true, maxAgeSec: 60 });
  assert.ok(cookie.includes("Secure"));
});

test("parseCookieHeader handles multiple cookies and junk", () => {
  const parsed = parseCookieHeader("theme=dark; sparkdash_session=tok%2Ben; other=1");
  assert.equal(parsed.theme, "dark");
  assert.equal(parsed.sparkdash_session, "tok+en");
  assert.equal(parsed.other, "1");
  assert.deepEqual(parseCookieHeader(""), {});
  assert.deepEqual(parseCookieHeader("garbage"), {});
});
