import { timingSafeEqual, scryptSync, randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite } from "./util/atomicWrite.js";

export function configuredToken() {
  const token = process.env.SPARKDASH_TOKEN || process.env.DASHBOARD_TOKEN || "";
  return token.trim();
}

export function isLoopbackBind(host) {
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}

export function requireRemoteAuth(bindHost) {
  return !isLoopbackBind(bindHost);
}

/** Legacy escape hatch — no longer gates any request; kept only for startup copy. */
export function allowOpenRemote() {
  const v = process.env.SPARKDASH_ALLOW_OPEN_REMOTE;
  if (v == null || v === "") return true;
  return v === "1";
}

function tokensEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function extractBearer(req) {
  const header = req.headers?.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (match) return match[1].trim();
  const query = req.query?.token;
  return typeof query === "string" ? query.trim() : "";
}

export function authenticate(req) {
  const expected = configuredToken();
  const provided = extractBearer(req);
  if (!expected || !provided || !tokensEqual(provided, expected)) {
    return { ok: false, status: 401, error: "Authentication required" };
  }
  return { ok: true, mode: "bearer" };
}

// ─── Client address behind a reverse proxy (T16) ─────────────────────────
// TRUST_PROXY lists the peers that may set X-Forwarded-For (the frpc host, nginx).
// Unset means the header is never trusted, so a direct client cannot forge its
// address and slip past the login lockout.

function normalizeClientAddress(addr) {
  const value = String(addr || "");
  return value.startsWith("::ffff:") ? value.slice(7) : value;
}

export function trustedProxies() {
  return String(process.env.TRUST_PROXY || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function addressMatches(addr, entry) {
  if (!addr || !entry) return false;
  if (!entry.includes("/")) return addr === entry;
  const [network, bitsRaw] = entry.split("/");
  const bits = parseInt(bitsRaw, 10);
  if (!Number.isFinite(bits) || bits < 0 || bits > 32) return false;
  const toInt = (ip) => {
    const parts = String(ip).split(".");
    if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return null;
    return parts.reduce((acc, part) => ((acc << 8) | (parseInt(part, 10) & 255)) >>> 0, 0);
  };
  const a = toInt(addr);
  const n = toInt(network);
  if (a === null || n === null) return false;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (a & mask) === (n & mask);
}

/**
 * Address used for rate limiting, logs and the loopback trust check. Behind a
 * trusted proxy the left-most X-Forwarded-For entry wins; otherwise the socket
 * address is authoritative.
 */
export function clientAddress(req) {
  const socketAddr = normalizeClientAddress(req.socket?.remoteAddress);
  const proxies = trustedProxies();
  if (!proxies.length || !proxies.some((entry) => addressMatches(socketAddr, entry))) return socketAddr;
  const forwarded = String(req.headers?.["x-forwarded-for"] || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return forwarded.length ? normalizeClientAddress(forwarded[0]) : socketAddr;
}

export function isLoopbackRequest(req) {
  const addr = clientAddress(req);
  return addr === "::1" || addr === "127.0.0.1" || /^127\./.test(addr);
}

/**
 * CSRF source check for write requests. An explicit Origin must match Host;
 * no Origin is fine unless Sec-Fetch-Site says cross-site (browsers send one
 * of the two on cross-site fetches; curl/scripts send neither).
 */
export function originAllowed(req) {
  const origin = typeof req.headers?.origin === "string" ? req.headers.origin : "";
  const host = typeof req.headers?.host === "string" ? req.headers.host : "";
  if (origin) {
    try {
      return host !== "" && new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  return req.headers?.["sec-fetch-site"] !== "cross-site";
}

function sessionFromRequest(req) {
  const id = parseCookieHeader(req.headers?.cookie)[sessionCookieName()];
  if (!id) return null;
  const session = getSession(id);
  return session ? { id, ...session } : null;
}

function accountConfigured() {
  try {
    return loadAuthConfig() !== null;
  } catch {
    return true; // broken/insecure auth.json ≠ no account — fail closed
  }
}

export function createAuthMiddleware() {
  return function authMiddleware(req, res, next) {
    const method = (req.method || "GET").toUpperCase();
    const reqPath = req.path || "";

    // 1. Anonymous whitelist — exactly three entries; everything else must auth.
    if (reqPath === "/api/auth/session" || reqPath === "/api/auth/login") return next();
    if (method === "GET" && !reqPath.startsWith("/api/")) return next();

    // 2. Cross-site write rejection — before authentication so session-authed
    //    writes are covered too.
    const mutating = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
    if (mutating && !originAllowed(req)) {
      return res.status(403).json({ error: "Cross-site request rejected" });
    }

    // 3. Valid session cookie.
    const session = sessionFromRequest(req);
    if (session) {
      touchSession(session.id);
      req.authUser = session.user;
      return next();
    }

    // 4. Valid Bearer token (script compatibility).
    const expected = configuredToken();
    const provided = extractBearer(req);
    if (expected && provided && tokensEqual(provided, expected)) return next();

    // 5. Loopback local trust only while no account is configured — keeps
    //    server-side curl debugging working on a fresh install.
    if (isLoopbackRequest(req) && !accountConfigured()) return next();

    // 6. Denied.
    return res.status(401).json({ error: "Authentication required" });
  };
}

export function authorizeUpgrade(req) {
  const session = sessionFromRequest(req);
  if (session && originAllowed(req)) return true;
  const expected = configuredToken();
  const provided = extractBearer(req);
  if (expected && provided && tokensEqual(provided, expected)) return true;
  if (isLoopbackRequest(req) && !accountConfigured()) return true;
  return false;
}

// ─── Password hashing + account storage (T1) ─────────────────────────────
// Single-account credential file: config/auth.json (mode 0600, gitignored).
// Schema: { user, algo:"scrypt", N, r, p, keylen, salt(32hex), hash(128hex), updatedAt }

export function authConfigPath() {
  if (process.env.SPARKDASH_AUTH_JSON) return process.env.SPARKDASH_AUTH_JSON;
  const __filename = fileURLToPath(import.meta.url);
  const ROOT = path.resolve(path.dirname(__filename), "..");
  return path.join(ROOT, "config", "auth.json");
}

export function hashPassword(password, salt) {
  const useSalt = salt || randomBytes(32).toString("hex");
  const N = 16384;
  const r = 8;
  const p = 1;
  const keylen = 64;
  const hash = scryptSync(String(password), useSalt, keylen, { N, r, p }).toString("hex");
  return { salt: useSalt, hash, N, r, p, keylen };
}

export function verifyPassword(password, record) {
  try {
    if (!record || typeof record !== "object") return false;
    const keylen = record.keylen ?? 64;
    const N = record.N ?? 16384;
    const r = record.r ?? 8;
    const p = record.p ?? 1;
    const expected = Buffer.from(String(record.hash || ""), "hex");
    const actual = scryptSync(String(password ?? ""), String(record.salt || ""), keylen, { N, r, p });
    if (actual.length !== expected.length) return false;
    return timingSafeEqual(actual, expected);
  } catch {
    return false; // malformed record/hex counts as "wrong password", never a crash
  }
}

/**
 * Credential record from config/auth.json (mode 0600).
 * @returns {object|null} null when the file simply does not exist.
 * @throws on a malformed JSON body or unsafe permissions — never degrade to "no account".
 */
export function loadAuthFile() {
  const file = authConfigPath();
  let st;
  try {
    st = statSync(file);
  } catch (err) {
    if (err && err.code === "ENOENT") return null; // missing file = no account (distinct from a parse error, which throws)
    throw err;
  }
  const mode = st.mode & 0o777;
  if (mode & 0o077) {
    throw new Error(
      `Refusing auth.json with insecure permissions ${mode.toString(8).padStart(3, "0")} (want 600): ${file}`
    );
  }
  let record;
  try {
    record = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`config/auth.json is unreadable or not valid JSON: ${err.message}`);
  }
  if (
    !record ||
    typeof record.user !== "string" ||
    typeof record.salt !== "string" ||
    typeof record.hash !== "string"
  ) {
    throw new Error("config/auth.json is malformed (need string fields: user, salt, hash)");
  }
  return record;
}

// ─── Account from the environment (T15) ──────────────────────────────────
// Precedence: config/auth.json wins whenever it exists; the variables below are
// the fallback so a fresh deployment only needs two lines in .env. The hash form
// is preferred (nothing reversible on disk); the plaintext form seeds auth.json
// once and is reported as insecure in the startup log.

const ENV_HASH_ALGO = "scrypt";

/** `scrypt:N:r:p:<salt-hex>:<hash-hex>` — the record fields on one copy-pasteable line. */
export function passwordHashForEnv(password) {
  const { salt, hash, N, r, p } = hashPassword(password);
  return `${ENV_HASH_ALGO}:${N}:${r}:${p}:${salt}:${hash}`;
}

export function parsePasswordHashEnv(spec, user) {
  const parts = String(spec || "").trim().split(":");
  if (parts.length !== 6 || parts[0] !== ENV_HASH_ALGO) {
    throw new Error(
      "SPARKDASH_ADMIN_PASSWORD_HASH must look like scrypt:<N>:<r>:<p>:<salt-hex>:<hash-hex> (generate with `npm run auth:hash`)"
    );
  }
  const [, nRaw, rRaw, pRaw, salt, hash] = parts;
  const N = parseInt(nRaw, 10);
  const r = parseInt(rRaw, 10);
  const p = parseInt(pRaw, 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p) || !salt || !hash) {
    throw new Error("SPARKDASH_ADMIN_PASSWORD_HASH has non-numeric scrypt parameters");
  }
  return {
    user,
    algo: ENV_HASH_ALGO,
    N,
    r,
    p,
    keylen: 64,
    salt,
    hash,
    updatedAt: new Date().toISOString(),
    source: "env-hash",
  };
}

/** Env files with a plaintext admin password must not be group/world readable. */
export function envAccountWarnings() {
  const warnings = [];
  const plain = (process.env.SPARKDASH_ADMIN_PASSWORD || "").trim();
  if (!plain) return warnings;
  warnings.push(
    "SPARKDASH_ADMIN_PASSWORD is plaintext in the environment — prefer SPARKDASH_ADMIN_PASSWORD_HASH (`npm run auth:hash`) and delete the plaintext line."
  );
  const envFile = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), ".env");
  try {
    const mode = statSync(envFile).mode & 0o777;
    if (mode & 0o077) {
      warnings.push(
        `The .env file is ${mode.toString(8).padStart(3, "0")} (want 600) but holds a plaintext admin password: chmod 600 ${envFile}`
      );
    }
  } catch {
    /* no .env file (variables set some other way) — nothing to check */
  }
  return warnings;
}

let envAccountCache;
let envSeedReported = false;

export function __resetEnvAccountForTest() {
  envAccountCache = undefined;
  envSeedReported = false;
}

/** Resolve the env-provided account, seeding auth.json once for the plaintext form. */
export function accountFromEnv() {
  if (envAccountCache !== undefined) return envAccountCache;
  const user = (process.env.SPARKDASH_ADMIN_USER || "admin").trim() || "admin";
  const hashSpec = (process.env.SPARKDASH_ADMIN_PASSWORD_HASH || "").trim();
  const plain = (process.env.SPARKDASH_ADMIN_PASSWORD || "").trim();

  if (hashSpec) {
    envAccountCache = parsePasswordHashEnv(hashSpec, user); // malformed spec throws → fail closed
    return envAccountCache;
  }
  if (!plain) {
    envAccountCache = null;
    return null;
  }

  const record = {
    user,
    algo: ENV_HASH_ALGO,
    ...hashPassword(plain),
    updatedAt: new Date().toISOString(),
    source: "env-plaintext",
  };
  const file = authConfigPath();
  const persisted = { ...record };
  delete persisted.source;
  try {
    atomicWrite(file, `${JSON.stringify(persisted, null, 2)}\n`, 0o600);
    if (!envSeedReported) {
      envSeedReported = true;
      console.warn(
        `[auth] created ${file} from SPARKDASH_ADMIN_PASSWORD (plaintext). Switch to SPARKDASH_ADMIN_PASSWORD_HASH and delete that line.`
      );
    }
  } catch (err) {
    if (!envSeedReported) {
      envSeedReported = true;
      console.warn(
        `[auth] could not persist the env account to ${file} (${err.message}); using the in-memory account for this process only`
      );
    }
  }
  envAccountCache = record;
  return record;
}

/**
 * The active account: config/auth.json first (it is the durable source of truth),
 * the environment only while that file does not exist.
 */
export function loadAuthConfig() {
  const fromFile = loadAuthFile();
  if (fromFile) return fromFile;
  return accountFromEnv();
}

// ─── Cookie sessions (T2) ────────────────────────────────────────────────
// In-memory sessions: restart logs everyone out by design (no JWT persistence).

export const sessionCookieName = () => "sparkdash_session";

const sessions = new Map();

function sessionTtlMs() {
  const parsed = parseInt(process.env.SESSION_TTL_MS || "43200000", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 43200000;
}

export function createSession(user, { ip } = {}) {
  const id = randomBytes(32).toString("hex"); // fresh id per login → no session fixation
  const now = Date.now();
  sessions.set(id, { user: String(user), createdAt: now, lastSeen: now, ip: ip || null });
  return { id, expiresAt: now + sessionTtlMs() };
}

export function getSession(id) {
  if (typeof id !== "string" || !id) return null;
  const session = sessions.get(id);
  if (!session) return null;
  if (Date.now() - session.lastSeen > sessionTtlMs()) {
    sessions.delete(id);
    return null;
  }
  return { user: session.user, createdAt: session.createdAt, lastSeen: session.lastSeen };
}

export function destroySession(id) {
  sessions.delete(id);
}

export function touchSession(id) {
  const session = sessions.get(id);
  if (session) session.lastSeen = Date.now();
}

export function __resetSessionsForTest() {
  sessions.clear();
}

// Passive expiry alone never reclaims sessions that are never revisited.
const sessionSweeper = setInterval(
  () => {
    const cutoff = Date.now() - sessionTtlMs();
    for (const [id, session] of sessions) {
      if (session.lastSeen < cutoff) sessions.delete(id);
    }
  },
  5 * 60 * 1000
);
sessionSweeper.unref();

export function parseCookieHeader(header) {
  const out = {};
  if (typeof header !== "string" || !header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

export function serializeSessionCookie(id, { secure = false, maxAgeSec } = {}) {
  const parts = [`${sessionCookieName()}=${encodeURIComponent(id)}`, "HttpOnly", "SameSite=Strict", "Path=/"];
  if (Number.isFinite(maxAgeSec)) parts.push(`Max-Age=${Math.floor(maxAgeSec)}`);
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
