import fs from "fs";
import path from "path";
import { HOST_PATHS, SPARKS_JSON_PATH } from "./config.js";
import { configuredToken, loadAuthConfig, requireRemoteAuth } from "./auth.js";
import { tlsEnabled, tlsStartupError } from "./tls.js";

export function evaluateHealth({
  bindHost,
  configWritable,
  secretsKeyPresent,
  sshIdentityPresent,
  authFile,
  tokenConfigured,
  tlsOn,
  tlsError,
}) {
  const remote = requireRemoteAuth(bindHost);
  const errors = [];
  const warnings = [];
  if (tlsError) errors.push(tlsError);
  if (authFile.state === "broken") {
    errors.push(`config/auth.json is unusable: ${authFile.error}`);
  }
  if (remote && authFile.state !== "ok" && !tokenConfigured) {
    errors.push(
      "Remote bind requires an account (run: npm run auth:init <user>) or SPARKDASH_TOKEN. Keep BIND_HOST=127.0.0.1 for local-only use."
    );
  }
  if (!configWritable) errors.push("Config directory is not writable");
  if (!secretsKeyPresent) warnings.push("Secrets key is not present yet");
  if (!sshIdentityPresent) warnings.push("SSH identity is not mounted");
  const authMode =
    authFile.state === "ok"
      ? "session"
      : tokenConfigured
        ? "token"
        : remote
          ? "unconfigured"
          : "loopback-open";
  return {
    ok: errors.length === 0,
    bindHost,
    authMode,
    tls: tlsOn && !tlsError,
    errors,
    warnings,
  };
}

export function inspectHealth(bindHost) {
  const configDir = path.dirname(SPARKS_JSON_PATH);
  let writable = true;
  try { fs.accessSync(configDir, fs.constants.W_OK); } catch { writable = false; }
  const keyFile = path.join(configDir, ".secrets-key");
  const identity = process.env.SSH_IDENTITY_FILE || path.join(process.env.HOME || "/root", ".ssh", "id_ed25519");
  let authFile;
  try {
    authFile = loadAuthConfig() === null ? { state: "missing" } : { state: "ok" };
  } catch (err) {
    authFile = { state: "broken", error: err.message };
  }
  return evaluateHealth({
    bindHost,
    configWritable: writable,
    secretsKeyPresent: Boolean(process.env.SPARKDASH_SECRETS_KEY) || fs.existsSync(keyFile),
    sshIdentityPresent: fs.existsSync(identity),
    authFile,
    tokenConfigured: Boolean(configuredToken()),
    tlsOn: tlsEnabled(),
    tlsError: tlsStartupError(bindHost),
  });
}
