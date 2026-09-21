import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { tlsEnabled, resolveTlsOptions, tlsStartupError, tlsCertPath, tlsKeyPath } from "../tls.js";

function withTlsEnv({ enabled, cert = null, key = null } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "sparkdash-tls-"));
  const prev = {
    TLS_ENABLED: process.env.TLS_ENABLED,
    TLS_CERT_PATH: process.env.TLS_CERT_PATH,
    TLS_KEY_PATH: process.env.TLS_KEY_PATH,
  };
  process.env.TLS_ENABLED = enabled ? "1" : "0";
  // Always pin the paths: a deployment that has real certificates in config/tls
  // must not turn the "certificate missing" cases into false passes.
  if (cert !== null || key !== null) {
    process.env.TLS_CERT_PATH = cert === null ? path.join(dir, "absent.crt") : cert;
    process.env.TLS_KEY_PATH = key === null ? path.join(dir, "absent.key") : key;
  } else {
    process.env.TLS_CERT_PATH = path.join(dir, "absent.crt");
    process.env.TLS_KEY_PATH = path.join(dir, "absent.key");
  }
  return {
    dir,
    restore: () => {
      for (const [name, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("TLS is enabled unless TLS_ENABLED=0", () => {
  const env = withTlsEnv({ enabled: true });
  try {
    assert.equal(tlsEnabled(), true);
    process.env.TLS_ENABLED = "0";
    assert.equal(tlsEnabled(), false);
  } finally {
    env.restore();
  }
});

test("resolveTlsOptions throws when the certificate files are missing", () => {
  const env = withTlsEnv({ enabled: true });
  try {
    assert.throws(() => resolveTlsOptions());
    assert.match(tlsStartupError("0.0.0.0"), /tls:gen/);
  } finally {
    env.restore();
  }
});

test("present cert files clear the fatal gate; loopback with TLS off is allowed", () => {
  const env = withTlsEnv({ enabled: true });
  try {
    const cert = path.join(env.dir, "server.crt");
    const key = path.join(env.dir, "server.key");
    writeFileSync(cert, "-----CERT-----");
    writeFileSync(key, "-----KEY-----");
    process.env.TLS_CERT_PATH = cert;
    process.env.TLS_KEY_PATH = key;
    assert.deepEqual(tlsStartupError("0.0.0.0"), null);
    const options = resolveTlsOptions();
    assert.equal(options.cert.toString(), "-----CERT-----");
    process.env.TLS_ENABLED = "0";
    assert.equal(tlsStartupError("127.0.0.1"), null);
  } finally {
    env.restore();
  }
});

test("TLS off on a non-loopback bind names the offending bind host", () => {
  const env = withTlsEnv({ enabled: false });
  try {
    assert.match(tlsStartupError("0.0.0.0"), /loopback.*0\.0\.0\.0/);
    assert.match(tlsStartupError("192.168.10.100"), /loopback.*192\.168\.10\.100/);
  } finally {
    env.restore();
  }
});

test("default paths point into config/tls", () => {
  const savedCert = process.env.TLS_CERT_PATH;
  const savedKey = process.env.TLS_KEY_PATH;
  delete process.env.TLS_CERT_PATH;
  delete process.env.TLS_KEY_PATH;
  try {
    assert.match(tlsCertPath(), /config[\\/]tls[\\/]server\.crt$/);
    assert.match(tlsKeyPath(), /config[\\/]tls[\\/]server\.key$/);
  } finally {
    if (savedCert !== undefined) process.env.TLS_CERT_PATH = savedCert;
    if (savedKey !== undefined) process.env.TLS_KEY_PATH = savedKey;
  }
});

test("subprocess: TLS_ENABLED=0 on a non-loopback bind exits non-zero without listening", async (t) => {
  const tmp = mkdtempSync(path.join(tmpdir(), "sparkdash-tlssub-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const child = spawn(process.execPath, ["server/index.js"], {
    cwd: path.resolve(import.meta.dirname, "../.."),
    env: {
      ...process.env,
      BIND_HOST: "0.0.0.0",
      PORT: "0",
      TLS_ENABLED: "0",
      SPARKDASH_AUTH_JSON: path.join(tmp, "absent.json"),
      SPARKS_JSON_PATH: path.join(tmp, "sparks.json"),
      SPARKS_SECRETS_PATH: path.join(tmp, "secrets.json"),
      SECRETS_KEY_PATH: path.join(tmp, ".secrets-key"),
      LLM_DAILY_JSON_PATH: path.join(tmp, "llm-daily.json"),
      FLEET_ENERGY_JSON_PATH: path.join(tmp, "fleet-energy.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const [code] = await new Promise((resolve) => child.on("exit", (c) => resolve([c, output])));
  assert.notEqual(code, 0);
  assert.match(output, /TLS_ENABLED=0 is only allowed on a loopback bind/);
  assert.doesNotMatch(output, /server listening/);
});
