import fs from "fs";
import path from "path";
import { HOST_PATHS, SPARKS_JSON_PATH } from "./config.js";
import { loadAuthConfig } from "./auth.js";
import { tlsEnabled, tlsStartupError } from "./tls.js";

export function isLoopbackHost(host) {
  return host === "localhost" || host === "::1" || /^127\./.test(host || "");
}

export function evaluateStartupPreflight(input) {
  const loopback = isLoopbackHost(input.bindHost);
  const errors = [];
  const warnings = [];
  if (input.tlsError) errors.push(input.tlsError);
  if (input.authFile.state === "broken") {
    errors.push(`config/auth.json is unusable: ${input.authFile.error}`);
  }
  if (!loopback && input.authFile.state !== "ok" && !input.tokenConfigured) {
    errors.push(
      `Remote bind ${input.bindHost} has no account and no SPARKDASH_TOKEN. Run: npm run auth:init <user>, keep BIND_HOST=127.0.0.1, or set SPARKDASH_TOKEN.`
    );
  }
  if (!input.configWritable) errors.push("Config directory is not writable; fix the config volume ownership/permissions.");
  if (!input.secretsKey?.present) warnings.push("No secrets key exists yet; one will be created when the secrets store is first used. Back it up with the config directory.");
  if (!input.sshIdentity?.configured) warnings.push("No SSH identity is configured; remote key-auth units will be unavailable.");
  if (input.sshIdentity?.configured && input.sshIdentity.safePermissions === false) {
    warnings.push("SSH identity permissions are too open; set the private key to mode 600.");
  }
  if (!input.localCollectors?.available) warnings.push("Local host metrics are unavailable; verify /proc and /sys host mounts.");
  const authMode =
    input.authFile.state === "ok"
      ? "session"
      : input.tokenConfigured
        ? "token"
        : loopback
          ? "loopback-open"
          : "unconfigured";
  return {
    fatal: errors.length > 0,
    authMode,
    tls: input.tlsOn,
    errors,
    warnings,
  };
}

function pathWritable(target) {
  try {
    fs.accessSync(target, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function inspectStartupPreflight(bindHost) {
  const configDir = path.dirname(SPARKS_JSON_PATH);
  const keyFile = path.join(configDir, ".secrets-key");
  const identity = process.env.SSH_IDENTITY_FILE || path.join(process.env.HOME || "/root", ".ssh", "id_ed25519");
  let identityMode = null;
  try {
    identityMode = fs.statSync(identity).mode & 0o777;
  } catch {
    identityMode = null;
  }
  let authFile;
  try {
    authFile = loadAuthConfig() === null ? { state: "missing" } : { state: "ok" };
  } catch (err) {
    authFile = { state: "broken", error: err.message };
  }
  return evaluateStartupPreflight({
    bindHost,
    tokenConfigured: Boolean(process.env.SPARKDASH_TOKEN || process.env.DASHBOARD_TOKEN),
    authFile,
    tlsOn: tlsEnabled(),
    tlsError: tlsStartupError(bindHost),
    configWritable: pathWritable(configDir),
    secretsKey: {
      present: Boolean(process.env.SPARKDASH_SECRETS_KEY) || fs.existsSync(keyFile),
      source: process.env.SPARKDASH_SECRETS_KEY ? "environment" : "file",
    },
    sshIdentity: {
      configured: identityMode != null,
      path: identity,
      safePermissions: identityMode == null ? null : (identityMode & 0o077) === 0,
    },
    localCollectors: {
      available: fs.existsSync(path.join(HOST_PATHS.PROC, "meminfo")) && fs.existsSync(HOST_PATHS.SYS),
    },
  });
}

export function logStartupPreflight(preflight, bindHost, port) {
  console.log(
    `[sparkDash] preflight: bind=${bindHost}:${port} auth=${preflight.authMode} tls=${preflight.tls ? "on" : "off"}`
  );
  for (const warning of preflight.warnings) console.warn(`[sparkDash] preflight warning: ${warning}`);
  for (const error of preflight.errors) console.error(`[sparkDash] preflight error: ${error}`);
}
