import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isLoopbackBind } from "./auth.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function tlsEnabled() {
  return process.env.TLS_ENABLED !== "0";
}

export function tlsCertPath() {
  return process.env.TLS_CERT_PATH || path.join(ROOT, "config", "tls", "server.crt");
}

export function tlsKeyPath() {
  return process.env.TLS_KEY_PATH || path.join(ROOT, "config", "tls", "server.key");
}

export function resolveTlsOptions() {
  return {
    cert: readFileSync(tlsCertPath()),
    key: readFileSync(tlsKeyPath()),
  };
}

/**
 * Shared fatal gate (decision #6): TLS on without a certificate is a startup
 * error, and so is TLS off on a non-loopback bind — plain HTTP on the LAN is
 * exactly the exposure this dashboard must not fall back to.
 */
export function tlsStartupError(bindHost) {
  if (tlsEnabled()) {
    const missing = [tlsCertPath(), tlsKeyPath()].filter((file) => !existsSync(file));
    if (missing.length > 0) {
      return `TLS is enabled but ${missing.join(", ")} is missing — run: npm run tls:gen`;
    }
    return null;
  }
  if (!isLoopbackBind(bindHost)) {
    return `TLS_ENABLED=0 is only allowed on a loopback bind (got ${bindHost})`;
  }
  return null;
}
