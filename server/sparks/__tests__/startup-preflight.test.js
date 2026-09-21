import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateStartupPreflight } from "../../startupPreflight.js";

function preflightInput(overrides = {}) {
  return {
    bindHost: "127.0.0.1",
    configWritable: true,
    secretsKey: { present: true, source: "file" },
    sshIdentity: { configured: false },
    localCollectors: { available: true },
    tokenConfigured: false,
    authFile: { state: "missing" },
    tlsOn: true,
    tlsError: null,
    ...overrides,
  };
}

test("loopback without account or token stays open for local debugging", () => {
  const safe = evaluateStartupPreflight(preflightInput());
  assert.equal(safe.fatal, false);
  assert.equal(safe.authMode, "loopback-open");
});

test("remote bind without account or token is fatal (unconfigured)", () => {
  const exposed = evaluateStartupPreflight(preflightInput({ bindHost: "0.0.0.0" }));
  assert.equal(exposed.fatal, true);
  assert.equal(exposed.authMode, "unconfigured");
  assert.match(exposed.errors.join(" "), /auth\.json|SPARKDASH_TOKEN/);
});

test("token-configured remote bind reports authMode token", () => {
  const authed = evaluateStartupPreflight(
    preflightInput({ bindHost: "0.0.0.0", tokenConfigured: true })
  );
  assert.equal(authed.fatal, false);
  assert.equal(authed.authMode, "token");
});

test("account-configured remote bind reports authMode session and is not fatal", () => {
  const withAccount = evaluateStartupPreflight(
    preflightInput({ bindHost: "0.0.0.0", authFile: { state: "ok" } })
  );
  assert.equal(withAccount.fatal, false);
  assert.equal(withAccount.authMode, "session");
});

test("a broken auth.json is fatal regardless of bind", () => {
  const broken = evaluateStartupPreflight(
    preflightInput({ authFile: { state: "broken", error: "not valid JSON" } })
  );
  assert.equal(broken.fatal, true);
  assert.match(broken.errors.join(" "), /auth\.json is unusable/);
});

test("TLS gate failures are fatal and share the T6 judgment", () => {
  const tlsFatal = evaluateStartupPreflight(
    preflightInput({ bindHost: "0.0.0.0", authFile: { state: "ok" }, tlsError: "TLS is enabled but missing — run: npm run tls:gen" })
  );
  assert.equal(tlsFatal.fatal, true);
  assert.match(tlsFatal.errors.join(" "), /tls:gen/);
});

test("tls=off is reported so the startup log can print tls=off", () => {
  const off = evaluateStartupPreflight(preflightInput({ tlsOn: false }));
  assert.equal(off.tls, false);
  assert.equal(off.fatal, false);
});

test("Compose files default to loopback and do not hard-code 0.0.0.0", async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
  for (const file of ["docker-compose.yml", "docker-compose.dev.yml"]) {
    const text = await readFile(join(root, file), "utf8");
    assert.match(text, /BIND_HOST=\$\{BIND_HOST:-127\.0\.0\.1\}/);
    assert.equal(text.includes("BIND_HOST=0.0.0.0"), false);
  }
});
