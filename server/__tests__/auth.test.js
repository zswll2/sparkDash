import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  hashPassword,
  verifyPassword,
  loadAuthConfig,
  authConfigPath,
  passwordHashForEnv,
  parsePasswordHashEnv,
  __resetEnvAccountForTest,
  clientAddress,
  trustedProxies,
  isLoopbackRequest,
} from "../auth.js";
import {
  createSession,
  getSession,
  destroySession,
  touchSession,
  sessionCookieName,
  parseCookieHeader,
  serializeSessionCookie,
  __resetSessionsForTest,
  createAuthMiddleware,
  authorizeUpgrade,
  originAllowed,
} from "../auth.js";

// ─── fake req/res harness ─────────────────────────────────────────────────
// This suite covers authentication + CSRF on write requests, so it declares the
// full-control mode a deployment declares. The read-only gate itself (which
// 403s these writes when no mode file exists) lives in readonly.test.js.
const readonlyModeDir = mkdtempSync(path.join(tmpdir(), "sparkdash-auth-writes-"));
const readonlyModeFile = path.join(readonlyModeDir, "readonly.mode");
writeFileSync(readonlyModeFile, "full\n");
process.env.SPARKDASH_READONLY_MODE_FILE = readonlyModeFile;

function fakeReq({ method = "GET", path = "/api/sparks", headers = {}, remoteAddress = "192.168.10.5" } = {}) {
  return { method, path, headers, query: {}, socket: { remoteAddress: remoteAddress } };
}

function fakeRes() {
  const res = { statusCode: 0, body: null };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (data) => {
    res.body = data;
    return res;
  };
  return res;
}

function runMiddleware(req) {
  const res = fakeRes();
  let passed = false;
  createAuthMiddleware()(req, res, () => {
    passed = true;
  });
  return { passed, res };
}

function sessionCookieHeader(user = "admin") {
  const { id } = createSession(user);
  return { cookie: `${sessionCookieName()}=${id}` };
}

function useAccountFile(record) {
  const dir = mkdtempSync(path.join(tmpdir(), "sparkdash-mw-"));
  const file = path.join(dir, "auth.json");
  if (record === null) {
    process.env.SPARKDASH_AUTH_JSON = path.join(dir, "absent.json"); // guaranteed missing
    return () => {
      rmSync(dir, { recursive: true, force: true });
      delete process.env.SPARKDASH_AUTH_JSON;
    };
  }
  writeFileSync(file, JSON.stringify(record));
  process.env.SPARKDASH_AUTH_JSON = file;
  return () => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SPARKDASH_AUTH_JSON;
  };
}

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

// ─── middleware (T3) ──────────────────────────────────────────────────────
const ACCOUNT = { user: "admin", algo: "scrypt", salt: "aa", hash: "bb" };

test("whitelist: GET /api/auth/session, POST /api/auth/login and non-/api GET pass unauthenticated", () => {
  const cleanup = useAccountFile(ACCOUNT);
  try {
    assert.equal(runMiddleware(fakeReq({ path: "/api/auth/session" })).passed, true);
    assert.equal(runMiddleware(fakeReq({ method: "POST", path: "/api/auth/login" })).passed, true);
    assert.equal(runMiddleware(fakeReq({ path: "/assets/index-abc123.js" })).passed, true);
    assert.equal(runMiddleware(fakeReq({ path: "/" })).passed, true);
  } finally {
    cleanup();
  }
});

test("unauthenticated GET /api/sparks → 401 and GET /api/health → 401 (no account, remote source)", () => {
  const cleanup = useAccountFile(null);
  try {
    const sparks = runMiddleware(fakeReq({ path: "/api/sparks" }));
    assert.equal(sparks.passed, false);
    assert.equal(sparks.res.statusCode, 401);
    const health = runMiddleware(fakeReq({ path: "/api/health" }));
    assert.equal(health.passed, false);
    assert.equal(health.res.statusCode, 401);
  } finally {
    cleanup();
  }
});

test("authenticated session write with cross-site Origin → 403 even though session is valid", () => {
  const cleanup = useAccountFile(ACCOUNT);
  try {
    const headers = { ...sessionCookieHeader(), origin: "http://evil.example", host: "192.168.10.100:5555" };
    const result = runMiddleware(fakeReq({ method: "PUT", path: "/api/settings", headers }));
    assert.equal(result.passed, false);
    assert.equal(result.res.statusCode, 403);
    assert.deepEqual(result.res.body, { error: "Cross-site request rejected" });
  } finally {
    cleanup();
  }
});

test("authenticated session write with same-origin Origin → allowed", () => {
  const cleanup = useAccountFile(ACCOUNT);
  try {
    const headers = { ...sessionCookieHeader(), origin: "https://192.168.10.100:5555", host: "192.168.10.100:5555" };
    assert.equal(runMiddleware(fakeReq({ method: "PUT", path: "/api/settings", headers })).passed, true);
  } finally {
    cleanup();
  }
});

test("authenticated session write without Origin and without cross-site hint → allowed", () => {
  const cleanup = useAccountFile(ACCOUNT);
  try {
    const headers = { ...sessionCookieHeader(), host: "192.168.10.100:5555" };
    assert.equal(runMiddleware(fakeReq({ method: "PUT", path: "/api/settings", headers })).passed, true);
  } finally {
    cleanup();
  }
});

test("write without Origin but Sec-Fetch-Site: cross-site → 403", () => {
  const cleanup = useAccountFile(ACCOUNT);
  try {
    const headers = { ...sessionCookieHeader(), host: "192.168.10.100:5555", "sec-fetch-site": "cross-site" };
    const result = runMiddleware(fakeReq({ method: "PUT", path: "/api/settings", headers }));
    assert.equal(result.res.statusCode, 403);
  } finally {
    cleanup();
  }
});

test("loopback source with no account → local trust; loopback with account → 401", () => {
  const cleanupNoAccount = useAccountFile(null);
  try {
    const req = fakeReq({ path: "/api/sparks", remoteAddress: "127.0.0.1" });
    assert.equal(runMiddleware(req).passed, true);
  } finally {
    cleanupNoAccount();
  }
  const cleanupAccount = useAccountFile(ACCOUNT);
  try {
    const req = fakeReq({ path: "/api/sparks", remoteAddress: "::1" });
    const result = runMiddleware(req);
    assert.equal(result.passed, false);
    assert.equal(result.res.statusCode, 401);
  } finally {
    cleanupAccount();
  }
});

test("bearer token still authenticates when SPARKDASH_TOKEN is set", () => {
  const cleanup = useAccountFile(ACCOUNT);
  process.env.SPARKDASH_TOKEN = "secret-token";
  try {
    const headers = { authorization: "Bearer secret-token", host: "192.168.10.100:5555" };
    assert.equal(runMiddleware(fakeReq({ method: "PUT", path: "/api/settings", headers })).passed, true);
    const bad = runMiddleware(
      fakeReq({ method: "PUT", path: "/api/settings", headers: { authorization: "Bearer nope" } })
    );
    assert.equal(bad.res.statusCode, 401);
  } finally {
    delete process.env.SPARKDASH_TOKEN;
    cleanup();
  }
});

test("authorizeUpgrade: session + clean origin ok; cross-site origin rejected; bearer ok; loopback no-account ok", () => {
  const cleanup = useAccountFile(null);
  process.env.SPARKDASH_TOKEN = "ws-token";
  try {
    const okHeaders = { ...sessionCookieHeader(), host: "h:1" };
    assert.equal(authorizeUpgrade(fakeReq({ path: "/ws", headers: okHeaders })), true);
    const evilHeaders = { ...sessionCookieHeader(), host: "h:1", origin: "http://evil.example" };
    assert.equal(authorizeUpgrade(fakeReq({ path: "/ws", headers: evilHeaders })), false);
    const bearerHeaders = { authorization: "Bearer ws-token" };
    assert.equal(authorizeUpgrade(fakeReq({ path: "/ws", headers: bearerHeaders })), true);
    const loopback = fakeReq({ path: "/ws", remoteAddress: "127.0.0.1" });
    assert.equal(authorizeUpgrade(loopback), true);
    const remote = fakeReq({ path: "/ws", remoteAddress: "192.168.10.9" });
    assert.equal(authorizeUpgrade(remote), false);
  } finally {
    delete process.env.SPARKDASH_TOKEN;
    cleanup();
    __resetSessionsForTest();
  }
});

test("originAllowed: missing host with Origin → false; sec-fetch-site same-origin without Origin → true", () => {
  assert.equal(originAllowed(fakeReq({ headers: { origin: "http://x", host: "" } })), false);
  assert.equal(originAllowed(fakeReq({ headers: { origin: "http://h:1", host: "h:1" } })), true);
  assert.equal(
    originAllowed(fakeReq({ headers: { host: "h:1", "sec-fetch-site": "same-origin" } })),
    true
  );
  assert.equal(originAllowed(fakeReq({ headers: { host: "h:1", origin: "not a url" } })), false);
});

// ─── env-provided account (T15) ──────────────────────────────────────────
// config/auth.json wins while it exists; the env vars are the fresh-install path.
function withEnvAccount({ user, hash, plain, authJsonPath }, fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "sparkdash-envacc-"));
  const prev = {
    SPARKDASH_AUTH_JSON: process.env.SPARKDASH_AUTH_JSON,
    SPARKDASH_ADMIN_USER: process.env.SPARKDASH_ADMIN_USER,
    SPARKDASH_ADMIN_PASSWORD_HASH: process.env.SPARKDASH_ADMIN_PASSWORD_HASH,
    SPARKDASH_ADMIN_PASSWORD: process.env.SPARKDASH_ADMIN_PASSWORD,
  };
  process.env.SPARKDASH_AUTH_JSON = authJsonPath ?? path.join(dir, "absent-auth.json");
  delete process.env.SPARKDASH_ADMIN_USER;
  delete process.env.SPARKDASH_ADMIN_PASSWORD_HASH;
  delete process.env.SPARKDASH_ADMIN_PASSWORD;
  if (user !== undefined) process.env.SPARKDASH_ADMIN_USER = user;
  if (hash !== undefined) process.env.SPARKDASH_ADMIN_PASSWORD_HASH = hash;
  if (plain !== undefined) process.env.SPARKDASH_ADMIN_PASSWORD = plain;
  __resetEnvAccountForTest();
  try {
    return fn(dir);
  } finally {
    for (const [name, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    __resetEnvAccountForTest();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("SPARKDASH_ADMIN_PASSWORD_HASH supplies the account without any file", () => {
  withEnvAccount({ user: "zswll2", hash: passwordHashForEnv("env-secret-123") }, (dir) => {
    const record = loadAuthConfig();
    assert.equal(record.user, "zswll2");
    assert.equal(verifyPassword("env-secret-123", record), true);
    assert.equal(verifyPassword("nope", record), false);
    assert.equal(existsSync(path.join(dir, "absent-auth.json")), false);
  });
});

test("config/auth.json wins over the env account while it exists", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sparkdash-envwin-"));
  const file = path.join(dir, "auth.json");
  const fileRecord = { user: "fileuser", algo: "scrypt", ...hashPassword("file-secret-1"), updatedAt: new Date().toISOString() };
  writeFileSync(file, JSON.stringify(fileRecord), { mode: 0o600 });
  chmodSync(file, 0o600);
  try {
    withEnvAccount({ user: "envuser", hash: passwordHashForEnv("env-secret-123"), authJsonPath: file }, () => {
      const record = loadAuthConfig();
      assert.equal(record.user, "fileuser");
      assert.equal(verifyPassword("file-secret-1", record), true);
      assert.equal(verifyPassword("env-secret-123", record), false);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SPARKDASH_ADMIN_PASSWORD seeds config/auth.json once, then still works without it", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sparkdash-envseed-"));
  const file = path.join(dir, "auth.json");
  try {
    withEnvAccount({ user: "seeduser", plain: "seed-secret-1", authJsonPath: file }, () => {
      const record = loadAuthConfig();
      assert.equal(record.user, "seeduser");
      assert.equal(verifyPassword("seed-secret-1", record), true);
    });
    assert.equal(existsSync(file), true, "auth.json should have been seeded");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    withEnvAccount({ authJsonPath: file }, () => {
      const record = loadAuthConfig();
      assert.equal(record.user, "seeduser");
      assert.equal(verifyPassword("seed-secret-1", record), true);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a malformed SPARKDASH_ADMIN_PASSWORD_HASH throws (fail closed)", () => {
  withEnvAccount({ hash: "plaintext-is-not-a-hash" }, () => {
    assert.throws(() => loadAuthConfig(), /SPARKDASH_ADMIN_PASSWORD_HASH/);
  });
});

test("no auth.json and no env account -> null (no account configured)", () => {
  withEnvAccount({}, () => {
    assert.equal(loadAuthConfig(), null);
  });
});

test("passwordHashForEnv round-trips through parsePasswordHashEnv", () => {
  const spec = passwordHashForEnv("round-trip-1");
  assert.match(spec, /^scrypt:16384:8:1:[0-9a-f]{64}:[0-9a-f]{128}$/);
  const record = parsePasswordHashEnv(spec, "admin");
  assert.equal(verifyPassword("round-trip-1", record), true);
});

// ─── reverse-proxy client address (T16) ──────────────────────────────────
function withTrustProxy(value, fn) {
  const prev = process.env.TRUST_PROXY;
  if (value === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = prev;
  }
}

function proxyReq({ socketAddr = "192.168.1.254", xff } = {}) {
  return {
    method: "POST",
    path: "/api/auth/login",
    query: {},
    socket: { remoteAddress: socketAddr },
    headers: xff ? { "x-forwarded-for": xff } : {},
  };
}

test("clientAddress ignores X-Forwarded-For while TRUST_PROXY is unset", () => {
  withTrustProxy(undefined, () => {
    assert.equal(clientAddress(proxyReq({ xff: "203.0.113.9" })), "192.168.1.254");
    assert.deepEqual(trustedProxies(), []);
  });
});

test("clientAddress takes the left-most X-Forwarded-For entry from a trusted proxy", () => {
  withTrustProxy("192.168.1.254", () => {
    assert.equal(clientAddress(proxyReq({ xff: "203.0.113.9, 10.0.0.1" })), "203.0.113.9");
    assert.equal(clientAddress(proxyReq({ xff: "::ffff:203.0.113.9" })), "203.0.113.9");
    assert.equal(clientAddress(proxyReq({})), "192.168.1.254");
  });
});

test("clientAddress honours a CIDR entry and rejects peers outside it", () => {
  withTrustProxy("192.168.1.0/24", () => {
    assert.equal(clientAddress(proxyReq({ socketAddr: "192.168.1.254", xff: "203.0.113.7" })), "203.0.113.7");
    assert.equal(clientAddress(proxyReq({ socketAddr: "198.51.100.4", xff: "203.0.113.7" })), "198.51.100.4");
  });
});

test("a proxied remote client is not treated as loopback", () => {
  withTrustProxy("192.168.1.254", () => {
    assert.equal(isLoopbackRequest(proxyReq({ xff: "203.0.113.9" })), false);
    assert.equal(isLoopbackRequest(proxyReq({ xff: "127.0.0.1" })), true);
  });
  withTrustProxy(undefined, () => {
    assert.equal(isLoopbackRequest(proxyReq({ socketAddr: "127.0.0.1" })), true);
  });
});
