import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createAuthMiddleware,
  isReadonly,
  isReadonlyAllowed,
  readonlyModePath,
  __resetEnvAccountForTest,
} from "../auth.js";

/**
 * Read-only mode is the public-exposure safety net: with the dashboard on the
 * internet a leaked password must cost data, not the fleet. These tests pin the
 * three things that make it trustworthy:
 *   1. fail-closed defaults (no file ⇒ read-only)
 *   2. the gate sits on every authenticated path of the single middleware
 *   3. only the two documented paths slip through, and auth is not weakened
 */

const tmpDirs = [];

function modeFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sd-readonly-"));
  tmpDirs.push(dir);
  const file = path.join(dir, "readonly.mode");
  if (content !== null) fs.writeFileSync(file, content);
  return file;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(createAuthMiddleware());
  app.post("/api/auth/login", (req, res) => res.json({ login: true }));
  app.get("/api/auth/session", (req, res) => res.json({ session: true }));
  // Everything else answers 200 so a 403 can only come from the middleware.
  app.all("/api/*splat", (req, res) => res.json({ passed: true, path: req.path }));
  return app;
}

async function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function closeServer(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function call(server, method, url, headers = {}) {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.SPARKDASH_READONLY_MODE_FILE;
  delete process.env.SPARKDASH_READONLY;
  delete process.env.SPARKDASH_TOKEN;
  __resetEnvAccountForTest();
});

// ─── Mode resolution ──────────────────────────────────────
test("missing mode file means read-only (fail closed)", () => {
  process.env.SPARKDASH_READONLY_MODE_FILE = modeFile(null);
  assert.equal(isReadonly(), true);
});

test("a file that does not say 'full' is read-only", () => {
  for (const content of ["readonly\n", "nonsense\n", "\n", "fullish\n"]) {
    process.env.SPARKDASH_READONLY_MODE_FILE = modeFile(content);
    assert.equal(isReadonly(), true, `expected read-only for ${JSON.stringify(content)}`);
  }
});

test("only the literal 'full' switches state changes on", () => {
  for (const content of ["full\n", "  FuLl  \n", "full"]) {
    process.env.SPARKDASH_READONLY_MODE_FILE = modeFile(content);
    assert.equal(isReadonly(), false, `expected full for ${JSON.stringify(content)}`);
  }
});

test("an unreadable path falls back to read-only", () => {
  process.env.SPARKDASH_READONLY_MODE_FILE = path.join(os.tmpdir(), "missing-dir-x", "y");
  assert.equal(isReadonly(), true);
});

test("switching the file takes effect without a restart", () => {
  const file = modeFile("readonly\n");
  process.env.SPARKDASH_READONLY_MODE_FILE = file;
  assert.equal(isReadonly(), true);
  fs.writeFileSync(file, "full\n");
  assert.equal(isReadonly(), false);
  fs.writeFileSync(file, "readonly\n");
  assert.equal(isReadonly(), true);
});

test("SPARKDASH_READONLY=0 is the documented escape hatch", () => {
  process.env.SPARKDASH_READONLY_MODE_FILE = modeFile(null);
  process.env.SPARKDASH_READONLY = "0";
  assert.equal(isReadonly(), false);
  delete process.env.SPARKDASH_READONLY;
});

test("the mode file defaults next to config/auth.json", () => {
  delete process.env.SPARKDASH_READONLY_MODE_FILE;
  assert.match(readonlyModePath(), /config[\\/]readonly\.mode$/);
});

test("the allowlist is exactly logout + manual refresh", () => {
  assert.equal(isReadonlyAllowed("/api/auth/logout"), true);
  assert.equal(isReadonlyAllowed("/api/sparks/vm100/refresh/cpu"), true);
  // Lookalikes and every other state change stay refused.
  assert.equal(isReadonlyAllowed("/api/sparks/vm100/refresh/cpu/extra"), false);
  assert.equal(isReadonlyAllowed("/api/sparks/vm100/refresh/"), false);
  assert.equal(isReadonlyAllowed("/api/sparks/shutdown-all"), false);
  assert.equal(isReadonlyAllowed("/api/sparks/vm100/shutdown"), false);
  assert.equal(isReadonlyAllowed("/api/settings"), false);
  assert.equal(isReadonlyAllowed("/api/sparks"), false);
  assert.equal(isReadonlyAllowed("/api/sparks/vm100/password"), false);
  // An encoded slash stays one segment to the router (Express matches on the raw
  // path), so this can only ever be the refresh route — allowlisted, and harmless
  // because refresh changes no state.
  assert.equal(isReadonlyAllowed("/api/sparks/vm100/refresh/cpu%2F..%2Fshutdown"), true);
});

// ─── Gate behaviour through the real middleware ───────────
test("read-only refuses state changes and lets reads through", async () => {
  process.env.SPARKDASH_READONLY_MODE_FILE = modeFile("readonly\n");
  process.env.SPARKDASH_TOKEN = "test-token";
  const server = await listen(buildApp());
  try {
    const auth = { Authorization: "Bearer test-token" };
    assert.equal((await call(server, "GET", "/api/sparks", auth)).status, 200);
    // Static/WS paths are outside the /api gate and must never be blocked by it.
    const staticProbe = await call(server, "GET", "/ws", auth);
    assert.notEqual(staticProbe.status, 401);
    assert.notEqual(staticProbe.status, 403);

    const blocked = await call(server, "POST", "/api/sparks/shutdown-all", auth);
    assert.equal(blocked.status, 403);
    assert.match(blocked.body.error, /Read-only mode/);
    assert.equal((await call(server, "POST", "/api/sparks/vm100/shutdown", auth)).status, 403);
    assert.equal((await call(server, "POST", "/api/sparks/wake-all", auth)).status, 403);
    assert.equal((await call(server, "POST", "/api/sparks/hermes/update-all", auth)).status, 403);
    assert.equal((await call(server, "POST", "/api/sparks/vm100/hermes/update", auth)).status, 403);
    assert.equal((await call(server, "PUT", "/api/sparks/vm100/password", auth)).status, 403);
    assert.equal((await call(server, "PUT", "/api/settings", auth)).status, 403);
    assert.equal((await call(server, "POST", "/api/sparks", auth)).status, 403);
    assert.equal((await call(server, "DELETE", "/api/sparks/vm100", auth)).status, 403);
    assert.equal((await call(server, "PATCH", "/api/sparks/vm100", auth)).status, 403);
    assert.equal((await call(server, "POST", "/api/sparks/vm100/llm/bench", auth)).status, 403);
    assert.equal((await call(server, "POST", "/api/sparks/vm100/comfy/cancel", auth)).status, 403);

    // Allowlisted: manual refresh (no state change) and logout must keep working.
    assert.equal((await call(server, "POST", "/api/sparks/vm100/refresh/cpu", auth)).status, 200);
    assert.equal((await call(server, "POST", "/api/auth/logout", auth)).status, 200);
  } finally {
    await closeServer(server);
  }
});

test("full mode leaves state changes to the normal guards", async () => {
  process.env.SPARKDASH_READONLY_MODE_FILE = modeFile("full\n");
  process.env.SPARKDASH_TOKEN = "test-token";
  const server = await listen(buildApp());
  try {
    const auth = { Authorization: "Bearer test-token" };
    assert.equal((await call(server, "PUT", "/api/settings", auth)).status, 200);
    assert.equal((await call(server, "POST", "/api/sparks/shutdown-all", auth)).status, 200);
  } finally {
    await closeServer(server);
  }
});

test("read-only does not weaken authentication", async () => {
  process.env.SPARKDASH_READONLY_MODE_FILE = modeFile("readonly\n");
  process.env.SPARKDASH_TOKEN = "test-token";
  const server = await listen(buildApp());
  try {
    assert.equal((await call(server, "POST", "/api/sparks/shutdown-all")).status, 401);
    assert.equal((await call(server, "GET", "/api/sparks")).status, 401);
    assert.equal((await call(server, "GET", "/api/auth/session")).status, 200);
  } finally {
    await closeServer(server);
  }
});

test("cross-site writes are still rejected before the read-only gate", async () => {
  process.env.SPARKDASH_READONLY_MODE_FILE = modeFile("full\n");
  process.env.SPARKDASH_TOKEN = "test-token";
  const server = await listen(buildApp());
  try {
    const response = await call(server, "PUT", "/api/settings", {
      Authorization: "Bearer test-token",
      Origin: "https://evil.example",
      Host: "spark.simin.work",
    });
    assert.equal(response.status, 403);
    assert.match(response.body.error, /Cross-site/);
  } finally {
    await closeServer(server);
  }
});
