import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { hashPassword, __resetSessionsForTest } from "../auth.js";

/**
 * Read-only unlock: the public posture stays fail-closed, but an operator can
 * trade the *separate* unlock password for a bounded window of full control on
 * their own session. These tests pin the properties that make that safe:
 *   1. locked by default, and the unlock route cannot open anything by itself
 *   2. the window is per session, expiring, revocable — never fleet-wide
 *   3. a hard lock ("locked") ignores the unlock password entirely
 *   4. wrong passwords cost attempts on the caller's own address only
 *   5. an unusable credential refuses rather than crashes (fail closed)
 */

const LOGIN_PASSWORD = "correct-horse-battery";
const UNLOCK_PASSWORD = "unlock-correct-horse-battery";
const TOKEN = "test-bearer-token-1234";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startServer(
  t,
  { mode = "readonly\n", unlock = UNLOCK_PASSWORD, unlockMode = 0o600, ttlMs = null } = {}
) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-unlock-"));
  const readonlyMode = path.join(tmp, "readonly.mode");
  if (mode !== null) await writeFile(readonlyMode, mode);
  const env = {
    ...process.env,
    BIND_HOST: "127.0.0.1",
    PORT: String(await freePort()),
    TLS_ENABLED: "0",
    SPARKDASH_READONLY_MODE_FILE: readonlyMode,
    SPARKDASH_READONLY_UNLOCK_JSON: path.join(tmp, "readonly.json"),
    SPARKDASH_TOKEN: TOKEN,
    SETTINGS_JSON_PATH: path.join(tmp, "settings.json"),
    SPARKS_JSON_PATH: path.join(tmp, "sparks.json"),
    SPARKS_SECRETS_PATH: path.join(tmp, "sparks-secrets.json"),
    SECRETS_KEY_PATH: path.join(tmp, ".secrets-key"),
    LLM_DAILY_JSON_PATH: path.join(tmp, "llm-daily.json"),
    FLEET_ENERGY_JSON_PATH: path.join(tmp, "fleet-energy.json"),
  };
  if (ttlMs != null) env.SPARKDASH_READONLY_UNLOCK_TTL_MS = String(ttlMs);
  await writeFile(env.SPARKS_JSON_PATH, "[]\n");
  await writeFile(env.SETTINGS_JSON_PATH, "{}\n");

  const authFile = path.join(tmp, "auth.json");
  await writeFile(
    authFile,
    JSON.stringify({ user: "admin", updatedAt: new Date().toISOString(), ...hashPassword(LOGIN_PASSWORD) })
  );
  await chmod(authFile, 0o600);
  env.SPARKDASH_AUTH_JSON = authFile;

  if (unlock) {
    const unlockFile = env.SPARKDASH_READONLY_UNLOCK_JSON;
    await writeFile(
      unlockFile,
      JSON.stringify({ updatedAt: new Date().toISOString(), ...hashPassword(unlock) })
    );
    await chmod(unlockFile, unlockMode);
  }

  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  await Promise.race([
    new Promise((resolve) => {
      const check = () => (output.includes("server listening") ? resolve() : setTimeout(check, 10));
      check();
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`no start:\n${output}`)), 3000)),
  ]);
  const port = Number(env.PORT);
  const cookie = await signIn(port);
  return { port, cookie, output: () => output };
}

async function signIn(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: LOGIN_PASSWORD }),
  });
  assert.equal(res.status, 200);
  return res.headers.get("set-cookie").split(";")[0];
}

function unlockRequest(port, cookie, password) {
  return fetch(`http://127.0.0.1:${port}/api/readonly/unlock`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

function lockRequest(port, cookie) {
  return fetch(`http://127.0.0.1:${port}/api/readonly/lock`, {
    method: "POST",
    headers: { cookie },
  });
}

/** Any state-changing route: 200 = control allowed, 403 = the read-only gate. */
function writeProbe(port, headers) {
  return fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ pollIntervalMs: 2000 }),
  });
}

function health(port, headers) {
  return fetch(`http://127.0.0.1:${port}/api/health`, { headers }).then((r) => r.json());
}

test("locked by default: writes are refused and unlock reports the missing password", async (t) => {
  const { port, cookie } = await startServer(t, { unlock: null });

  const blocked = await writeProbe(port, { cookie });
  assert.equal(blocked.status, 403);
  assert.match((await blocked.json()).error, /^Read-only mode:/);

  const noCredential = await unlockRequest(port, cookie, "whatever");
  assert.equal(noCredential.status, 409);
  assert.match((await noCredential.json()).error, /No unlock password configured/);

  const h = await health(port, { cookie });
  assert.equal(h.readonly, true);
  assert.equal(h.readonlyState, "readonly");
  assert.equal(h.readonlyUnlockConfigured, false);
  assert.equal(h.readonlyUnlocked, false);
  assert.equal(h.readonlyUnlockExpiresAt, null);
});

test("the right password opens writes for that session; lock closes them again", async (t) => {
  const { port, cookie } = await startServer(t);

  const wrong = await unlockRequest(port, cookie, "not-the-password");
  assert.equal(wrong.status, 401);
  assert.deepEqual(await wrong.json(), { error: "Invalid unlock password" });
  assert.equal((await writeProbe(port, { cookie })).status, 403);

  const ok = await unlockRequest(port, cookie, UNLOCK_PASSWORD);
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.unlocked, true);
  assert.equal(typeof body.expiresAt, "number");
  assert.ok(body.expiresAt > Date.now());

  assert.equal((await writeProbe(port, { cookie })).status, 200);

  const unlockedHealth = await health(port, { cookie });
  assert.equal(unlockedHealth.readonlyUnlocked, true);
  // Sliding window: the probe above renewed the deadline rather than shortening it.
  assert.ok(unlockedHealth.readonlyUnlockExpiresAt >= body.expiresAt);
  assert.ok(unlockedHealth.readonlyUnlockExpiresAt > Date.now());
  // The posture itself never changes: only this session is elevated.
  assert.equal(unlockedHealth.readonlyState, "readonly");
  assert.equal(unlockedHealth.readonly, true);

  const locked = await lockRequest(port, cookie);
  assert.equal(locked.status, 200);
  assert.deepEqual(await locked.json(), { ok: true, readonlyState: "readonly", unlocked: false, expiresAt: null });
  assert.equal((await writeProbe(port, { cookie })).status, 403);
  assert.equal((await health(port, { cookie })).readonlyUnlocked, false);
});

test("unlock is per session — a second sign-in stays locked", async (t) => {
  const { port, cookie } = await startServer(t);
  const otherCookie = await signIn(port);

  assert.equal((await unlockRequest(port, cookie, UNLOCK_PASSWORD)).status, 200);
  assert.equal((await writeProbe(port, { cookie })).status, 200);
  assert.equal((await writeProbe(port, { cookie: otherCookie })).status, 403);
  assert.equal((await health(port, { cookie: otherCookie })).readonlyUnlocked, false);
});

test("wrong passwords lock the caller's own address, then the right one gets 429", async (t) => {
  const { port, cookie } = await startServer(t);
  for (let i = 0; i < 5; i += 1) {
    const res = await unlockRequest(port, cookie, `wrong-${i}`);
    assert.equal(res.status, 401, `attempt ${i + 1} should be a plain rejection`);
  }
  const locked = await unlockRequest(port, cookie, UNLOCK_PASSWORD);
  assert.equal(locked.status, 429);
  assert.equal((await writeProbe(port, { cookie })).status, 403);
});

test("a hard lock ignores the unlock password entirely", async (t) => {
  const { port, cookie } = await startServer(t, { mode: "locked\n" });

  const res = await unlockRequest(port, cookie, UNLOCK_PASSWORD);
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /hard lock/);
  assert.equal((await writeProbe(port, { cookie })).status, 403);
  assert.equal((await health(port, { cookie })).readonlyState, "locked");
});

test("the unlock window expires on its own", async (t) => {
  const { port, cookie } = await startServer(t, { ttlMs: 700 });
  assert.equal((await unlockRequest(port, cookie, UNLOCK_PASSWORD)).status, 200);
  assert.equal((await writeProbe(port, { cookie })).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal((await writeProbe(port, { cookie })).status, 403);
  assert.equal((await health(port, { cookie })).readonlyUnlocked, false);
});

test("polling the dashboard does not renew the window — only writes do", async (t) => {
  const { port, cookie } = await startServer(t, { ttlMs: 900 });
  assert.equal((await unlockRequest(port, cookie, UNLOCK_PASSWORD)).status, 200);
  // A tab that only reads (health poll, WS snapshots) must not be able to hold an
  // unattended window open: "activity" means a state-changing request.
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await health(port, { cookie });
  }
  assert.equal((await health(port, { cookie })).readonlyUnlocked, false);
  assert.equal((await writeProbe(port, { cookie })).status, 403);
});

test("a write keeps the window alive while the operator works", async (t) => {
  const { port, cookie } = await startServer(t, { ttlMs: 1200 });
  assert.equal((await unlockRequest(port, cookie, UNLOCK_PASSWORD)).status, 200);
  // 3 × (write + 700 ms) would exceed the TTL without the sliding renewal.
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal((await writeProbe(port, { cookie })).status, 200, `write ${i + 1} should renew`);
  }
});

test("an unusable unlock credential refuses instead of crashing", async (t) => {
  const { port, cookie } = await startServer(t, { unlockMode: 0o644 });

  const res = await unlockRequest(port, cookie, UNLOCK_PASSWORD);
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /insecure permissions/);
  assert.equal((await writeProbe(port, { cookie })).status, 403);

  const h = await health(port, { cookie });
  assert.equal(h.ok, true, "the server must stay healthy");
  assert.equal(h.readonlyUnlockConfigured, false);
});

test("unlock needs a session: anonymous and bearer callers are refused", async (t) => {
  const { port, cookie } = await startServer(t);

  const anonymous = await fetch(`http://127.0.0.1:${port}/api/readonly/unlock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: UNLOCK_PASSWORD }),
  });
  assert.equal(anonymous.status, 401);

  const bearer = await fetch(`http://127.0.0.1:${port}/api/readonly/unlock`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ password: UNLOCK_PASSWORD }),
  });
  assert.equal(bearer.status, 403);
  assert.match((await bearer.json()).error, /browser session/);

  // …and the bearer caller is still refused by the gate afterwards.
  const bearerWrite = await writeProbe(port, { authorization: `Bearer ${TOKEN}` });
  assert.equal(bearerWrite.status, 403);

  // Cross-site unlocks are rejected before anything else happens.
  const crossSite = await fetch(`http://127.0.0.1:${port}/api/readonly/unlock`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ password: UNLOCK_PASSWORD }),
  });
  assert.equal(crossSite.status, 403);
  assert.equal((await writeProbe(port, { cookie })).status, 403);
});

test("full control: unlock is a no-op and writes pass", async (t) => {
  const { port, cookie } = await startServer(t, { mode: "full\n" });

  const res = await unlockRequest(port, cookie, "irrelevant");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, readonlyState: "full", unlocked: false, expiresAt: null });
  assert.equal((await writeProbe(port, { cookie })).status, 200);
  const h = await health(port, { cookie });
  assert.equal(h.readonly, false);
  assert.equal(h.readonlyState, "full");
});

test.after(() => {
  __resetSessionsForTest();
});
