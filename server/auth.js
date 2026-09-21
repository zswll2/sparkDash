import { timingSafeEqual, scryptSync, randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

export function isLoopbackRequest(req) {
  const addr = req.socket?.remoteAddress || "";
  return addr === "::1" || addr === "::ffff:127.0.0.1" || /^127\./.test(addr);
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

export function loadAuthConfig() {
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
