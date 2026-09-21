import assert from "node:assert/strict";
import test from "node:test";
import { evaluateHealth } from "../../health.js";

function healthInput(overrides = {}) {
  return {
    bindHost: "127.0.0.1",
    configWritable: true,
    secretsKeyPresent: true,
    sshIdentityPresent: true,
    authFile: { state: "missing" },
    tokenConfigured: false,
    tlsOn: true,
    tlsError: null,
    ...overrides,
  };
}

test("loopback health is ok in loopback-open mode without account or token", () => {
  const health = evaluateHealth(healthInput());
  assert.equal(health.ok, true);
  assert.equal(health.authMode, "loopback-open");
  assert.equal(health.tls, true);
});

test("remote bind without account or token is not healthy (unconfigured)", () => {
  const health = evaluateHealth(healthInput({ bindHost: "0.0.0.0" }));
  assert.equal(health.ok, false);
  assert.equal(health.authMode, "unconfigured");
  assert.match(health.errors.join(" "), /auth:init|SPARKDASH_TOKEN/);
});

test("token-configured remote bind reports authMode token and is healthy", () => {
  const health = evaluateHealth(
    healthInput({ bindHost: "0.0.0.0", tokenConfigured: true })
  );
  assert.equal(health.ok, true);
  assert.equal(health.authMode, "token");
});

test("account-configured remote bind reports authMode session and is healthy", () => {
  const health = evaluateHealth(
    healthInput({ bindHost: "0.0.0.0", authFile: { state: "ok" } })
  );
  assert.equal(health.ok, true);
  assert.equal(health.authMode, "session");
});

test("tls is false when TLS is disabled or the certificate gate fails", () => {
  const off = evaluateHealth(healthInput({ tlsOn: false }));
  assert.equal(off.tls, false);
  const brokenCert = evaluateHealth(
    healthInput({ tlsError: "TLS is enabled but server.key is missing — run: npm run tls:gen" })
  );
  assert.equal(brokenCert.tls, false);
  assert.equal(brokenCert.ok, false);
});

test("a broken auth.json makes health not ok", () => {
  const health = evaluateHealth(
    healthInput({ authFile: { state: "broken", error: "not valid JSON" } })
  );
  assert.equal(health.ok, false);
  assert.match(health.errors.join(" "), /auth\.json is unusable/);
});
