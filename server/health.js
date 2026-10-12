import fs from "fs";
import path from "path";
import { HOST_PATHS, SPARKS_JSON_PATH } from "./config.js";
import {
  configuredToken,
  isReadonly,
  loadAuthConfig,
  requireRemoteAuth,
  readonlyState,
  unlockStatus,
} from "./auth.js";
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
  readonly,
  posture,
  unlock,
  elevation,
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
  // A remote bind with full control is one leaked password away from someone
  // powering off the fleet — read-only mode is the intended public posture.
  if (remote && !readonly && authFile.state === "ok") {
    warnings.push(
      "Remote bind with full control enabled: switch to read-only (config/readonly.mode) unless you intend to operate the fleet from outside the LAN."
    );
  }
  // Read-only with no unlock password can only be lifted from a shell on the
  // host — say so, instead of letting the operator hunt for the Settings box.
  if (readonly && posture !== "locked" && unlock && !unlock.configured) {
    warnings.push(
      unlock.error
        ? `Read-only unlock is unusable: ${unlock.error}`
        : "Read-only with no unlock password configured: set one with `npm run readonly:passwd` to unlock from the dashboard."
    );
  }
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
    /** true = the server refuses state-changing requests (public posture). */
    readonly: Boolean(readonly),
    /** "full" | "readonly" | "locked" — "readonly" is unlockable from the UI. */
    readonlyState: posture === "locked" ? "locked" : readonly ? "readonly" : "full",
    /** True while THIS session holds a live unlock (needs a session cookie). */
    readonlyUnlocked: Boolean(elevation?.unlocked),
    /** Unlock deadline (epoch ms) for this session, or null. */
    readonlyUnlockExpiresAt: elevation?.expiresAt ?? null,
    /** False when no unlock password exists yet (Settings shows the hint). */
    readonlyUnlockConfigured: Boolean(unlock?.configured),
    errors,
    warnings,
  };
}

export function inspectHealth(bindHost, { elevation } = {}) {
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
    readonly: isReadonly(),
    posture: readonlyState(),
    unlock: unlockStatus(),
    elevation: elevation ?? { unlocked: false, expiresAt: null },
  });
}
