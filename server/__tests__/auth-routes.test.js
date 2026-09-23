import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { hashPassword } from "../auth.js";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startServer(t, { withAccount = true } = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-authroutes-"));
  // This suite drives write paths, so it declares the full-control mode the way
  // a deployment does. Read-only enforcement itself lives in readonly.test.js.
  const readonlyMode = path.join(tmp, "readonly.mode");
  await writeFile(readonlyMode, "full\n");
  const env = {
    ...process.env,
    BIND_HOST: "127.0.0.1",
    PORT: String(await freePort()),
    TLS_ENABLED: "0",
    SPARKDASH_READONLY_MODE_FILE: readonlyMode,
    SPARKS_JSON_PATH: path.join(tmp, "sparks.json"),
    SPARKS_SECRETS_PATH: path.join(tmp, "sparks-secrets.json"),
    SECRETS_KEY_PATH: path.join(tmp, ".secrets-key"),
    LLM_DAILY_JSON_PATH: path.join(tmp, "llm-daily.json"),
    FLEET_ENERGY_JSON_PATH: path.join(tmp, "fleet-energy.json"),
  };
  await writeFile(env.SPARKS_JSON_PATH, "[]\n");
  if (withAccount) {
    const rec = { user: "admin", updatedAt: new Date().toISOString(), ...hashPassword("correct-horse-battery") };
    const authFile = path.join(tmp, "auth.json");
    await writeFile(authFile, JSON.stringify(rec));
    await chmod(authFile, 0o600);
    env.SPARKDASH_AUTH_JSON = authFile;
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
  return { port: Number(env.PORT), child };
}

function login(port, body, headers = {}) {
  return fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("login: five wrong passwords lock the account — correct password then gets 429", async (t) => {
  const { port } = await startServer(t);
  for (let i = 0; i < 5; i += 1) {
    const res = await login(port, { username: "admin", password: `wrong-${i}` });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Invalid credentials" });
  }
  const locked = await login(port, { username: "admin", password: "correct-horse-battery" });
  assert.equal(locked.status, 429);
});

test("login: correct credentials → 200 with session cookie; unknown user → same 401 message", async (t) => {
  const { port } = await startServer(t);
  const good = await login(port, { username: "admin", password: "correct-horse-battery" });
  assert.equal(good.status, 200);
  assert.deepEqual(await good.json(), { ok: true, user: "admin" });
  const setCookie = good.headers.get("set-cookie");
  assert.match(setCookie, /sparkdash_session=[^;]+/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  const unknown = await login(port, { username: "nosuchuser", password: "whatever" });
  assert.equal(unknown.status, 401);
  assert.deepEqual(await unknown.json(), { error: "Invalid credentials" });
});

test("logout destroys the session — the old cookie no longer opens /api/sparks", async (t) => {
  const { port } = await startServer(t);
  const loginRes = await login(port, { username: "admin", password: "correct-horse-battery" });
  const cookie = loginRes.headers.get("set-cookie").split(";")[0];
  const withCookie = { cookie };
  const before = await fetch(`http://127.0.0.1:${port}/api/sparks`, { headers: withCookie });
  assert.equal(before.status, 200);
  const out = await fetch(`http://127.0.0.1:${port}/api/auth/logout`, {
    method: "POST",
    headers: withCookie,
  });
  assert.equal(out.status, 200);
  assert.match(out.headers.get("set-cookie") || "", /Max-Age=0/);
  const after = await fetch(`http://127.0.0.1:${port}/api/sparks`, { headers: withCookie });
  assert.equal(after.status, 401);
});

test("GET /api/auth/session reflects cookie state", async (t) => {
  const { port } = await startServer(t);
  const anon = await fetch(`http://127.0.0.1:${port}/api/auth/session`);
  assert.deepEqual(await anon.json(), { authenticated: false, user: null });
  const loginRes = await login(port, { username: "admin", password: "correct-horse-battery" });
  const cookie = loginRes.headers.get("set-cookie").split(";")[0];
  const authed = await fetch(`http://127.0.0.1:${port}/api/auth/session`, { headers: { cookie } });
  assert.deepEqual(await authed.json(), { authenticated: true, user: "admin" });
});
