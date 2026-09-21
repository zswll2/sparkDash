import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { WebSocket } from "ws";
import { hashPassword } from "../auth.js";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startServer(t) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "sparkdash-wsauth-"));
  const env = {
    ...process.env,
    BIND_HOST: "127.0.0.1",
    PORT: String(await freePort()),
    TLS_ENABLED: "0",
    SPARKS_JSON_PATH: path.join(tmp, "sparks.json"),
    SPARKS_SECRETS_PATH: path.join(tmp, "sparks-secrets.json"),
    SECRETS_KEY_PATH: path.join(tmp, ".secrets-key"),
    LLM_DAILY_JSON_PATH: path.join(tmp, "llm-daily.json"),
    FLEET_ENERGY_JSON_PATH: path.join(tmp, "fleet-energy.json"),
  };
  await writeFile(env.SPARKS_JSON_PATH, "[]\n");
  const rec = { user: "admin", updatedAt: new Date().toISOString(), ...hashPassword("correct-horse-battery") };
  const authFile = path.join(tmp, "auth.json");
  await writeFile(authFile, JSON.stringify(rec));
  await chmod(authFile, 0o600);
  env.SPARKDASH_AUTH_JSON = authFile;
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
  return { port: Number(env.PORT) };
}

/**
 * Open a socket and wait for its first message. The listener is registered
 * before the handshake completes, so a snapshot that arrives immediately after
 * `open` (the normal case) can never be missed — unlike a helper that closes the
 * socket as soon as it opens.
 */
function wsOpenAndWait(url, headers, ms = 10000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const bail = setTimeout(() => {
      ws.terminate();
      reject(new Error(`websocket snapshot neither arrived nor rejected within ${ms}ms`));
    }, ms);
    ws.on("message", (data) => {
      clearTimeout(bail);
      resolve({ ws, data: String(data) });
    });
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(bail);
      resolve({ ws: null, status: res.statusCode });
    });
    ws.on("error", (err) => {
      clearTimeout(bail);
      resolve({ ws: null, message: String(err.message) });
    });
  });
}

async function realSessionCookie(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "correct-horse-battery" }),
  });
  assert.equal(res.status, 200);
  return res.headers.get("set-cookie").split(";")[0];
}

function wsOutcome(url, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const bail = setTimeout(() => {
      ws.terminate();
      reject(new Error("websocket handshake neither opened nor rejected within 5s"));
    }, 5000);
    ws.on("open", () => {
      clearTimeout(bail);
      resolve({ open: true, ws });
      ws.close();
    });
    ws.on("unexpected-response", (_req, res) => {
      clearTimeout(bail);
      resolve({ open: false, status: res.statusCode });
    });
    ws.on("error", (err) => {
      clearTimeout(bail);
      resolve({ open: false, message: String(err.message) });
    });
  });
}

test("WebSocket upgrade without a cookie is rejected (401)", async (t) => {
  const { port } = await startServer(t);
  const outcome = await wsOutcome(`ws://127.0.0.1:${port}/ws`, {});
  assert.equal(outcome.open, false);
  assert.equal(outcome.status, 401);
});

test("WebSocket upgrade with a valid session cookie and no Origin is accepted and streams a snapshot", async (t) => {
  const { port } = await startServer(t);
  const cookie = await realSessionCookie(port);
  const snapshot = await wsOpenAndWait(`ws://127.0.0.1:${port}/ws`, { cookie });
  t.after(() => snapshot.ws && snapshot.ws.close());
  assert.notEqual(
    snapshot.ws,
    null,
    `expected an accepted upgrade, got ${snapshot.status ?? snapshot.message}`
  );
  assert.equal(JSON.parse(snapshot.data).type, "snapshot");
});

test("WebSocket upgrade with a session cookie but cross-site Origin is rejected", async (t) => {
  const { port } = await startServer(t);
  const cookie = await realSessionCookie(port);
  const outcome = await wsOutcome(`ws://127.0.0.1:${port}/ws`, {
    cookie,
    origin: "http://evil.example",
  });
  assert.equal(outcome.open, false);
});
