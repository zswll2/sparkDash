#!/usr/bin/env node
// Set (or clear) the read-only unlock password.
//
//   node tools/readonly-setpass.mjs                      # type it twice (hidden echo)
//   node tools/readonly-setpass.mjs --generate           # 32-char random, written to a 0600 file
//   node tools/readonly-setpass.mjs --from-file <path>   # hash the first line of <path>
//   node tools/readonly-setpass.mjs --clear              # remove it (unlock disabled)
//
// The plaintext never reaches argv, this process's stdout, or a shell history:
// the hash goes to config/readonly.json (mode 0600, gitignored) and, with
// --generate, the plaintext goes to a 0600 file whose path is printed instead.
import { randomBytes, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TARGET = process.env.SPARKDASH_READONLY_UNLOCK_JSON || path.join(ROOT, "config", "readonly.json");
const MIN_LENGTH = 12; // ops secret: longer than a login password, typed rarely

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true) : null;
};

function hash(password) {
  const N = 16384;
  const r = 8;
  const p = 1;
  const keylen = 64;
  const salt = randomBytes(32).toString("hex");
  return {
    algo: "scrypt",
    N,
    r,
    p,
    keylen,
    salt,
    hash: scryptSync(password, salt, keylen, { N, r, p }).toString("hex"),
    updatedAt: new Date().toISOString(),
  };
}

function write(record, plaintextPath = null) {
  mkdirSync(path.dirname(TARGET), { recursive: true });
  writeFileSync(TARGET, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  try {
    const mode = statSync(TARGET).mode & 0o777;
    if (mode & 0o077) {
      console.error(`WARNING: ${TARGET} is ${mode.toString(8).padStart(3, "0")} (want 600) — the server will refuse to unlock with it.`);
    }
  } catch {
    /* ignore */
  }
  console.log(`Unlock credential written: ${TARGET} (mode 0600) at ${record.updatedAt}`);
  if (plaintextPath) {
    writeFileSync(plaintextPath, "", { mode: 0o600 });
    console.log(`Plaintext written to: ${plaintextPath} (mode 0600) — read it with:`);
    console.log(`  cat ${plaintextPath}`);
    console.log("Delete that file once you have it stored somewhere safe.");
  }
  console.log("Unlock window per unlock: SPARKDASH_READONLY_UNLOCK_TTL_MS (default 1800000 = 30 min).");
}

function readPasswordOnce(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const chars = [];
    const onData = (chunk) => {
      for (const ch of chunk.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          finish();
          resolve(chars.join(""));
          return;
        }
        if (ch === "\u0003") {
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") chars.pop();
        else if (ch >= " ") chars.push(ch);
      }
    };
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
    function finish() {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(wasRaw ?? false);
      process.stdin.pause();
      process.stdout.write("\n");
    }
  });
}

if (argv.includes("--clear")) {
  try {
    unlinkSync(TARGET);
    console.log(`Removed ${TARGET} — unlocking from the dashboard is now impossible (the mode file still decides the posture).`);
  } catch (err) {
    if (err.code === "ENOENT") console.log(`Nothing to remove: ${TARGET} does not exist.`);
    else {
      console.error(`Could not remove ${TARGET}: ${err.message}`);
      process.exit(1);
    }
  }
  process.exit(0);
}

const fromFile = flag("--from-file");
if (typeof fromFile === "string") {
  let raw;
  try {
    raw = readFileSync(fromFile, "utf8");
  } catch (err) {
    console.error(`Cannot read ${fromFile}: ${err.message}`);
    process.exit(1);
  }
  const password = raw.split(/\r?\n/)[0].trim();
  if (password.length < MIN_LENGTH) {
    console.error(`Password in ${fromFile} is shorter than ${MIN_LENGTH} characters.`);
    process.exit(1);
  }
  write(hash(password));
  console.log(`Remember to delete ${fromFile}.`);
  process.exit(0);
}

if (argv.includes("--generate")) {
  // No lookalikes, no shell metacharacters.
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(32);
  const password = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
  const plaintextFlag = flag("--plaintext-file");
  const plaintextPath =
    typeof plaintextFlag === "string" ? plaintextFlag : path.join(ROOT, "config", "readonly-password.txt");
  write(hash(password), plaintextPath);
  process.exit(0);
}

if (!process.stdin.isTTY) {
  console.error("Needs an interactive terminal (hidden input), or use --generate / --from-file <path>.");
  process.exit(1);
}

const password = await readPasswordOnce("New read-only unlock password: ");
const confirm = await readPasswordOnce("Confirm: ");
if (password !== confirm) {
  console.error("Passwords do not match.");
  process.exit(1);
}
if (password.length < MIN_LENGTH) {
  console.error(`Unlock password must be at least ${MIN_LENGTH} characters.`);
  process.exit(1);
}
write(hash(password));
