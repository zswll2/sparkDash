#!/usr/bin/env node
// One-shot account setup: node tools/auth-init.mjs <user>
// Prompts twice for the password with echo disabled, writes config/auth.json
// at mode 0600, and prints only the outcome — never the password or hash.
import { randomBytes, scryptSync } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const user = process.argv[2];

if (!user || user.includes(" ")) {
  console.error("Usage: node tools/auth-init.mjs <user>");
  process.exit(1);
}
if (!process.stdin.isTTY) {
  console.error("auth-init needs an interactive terminal (hidden password input).");
  process.exit(1);
}

function readPassword(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const chars = [];
    const onData = (chunk) => {
      const text = chunk.toString("utf8");
      for (const ch of text) {
        if (ch === "\r" || ch === "\n") {
          finish();
          resolve(chars.join(""));
          return;
        }
        if (ch === "\u0003") {
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          chars.pop();
        } else if (ch >= " " || ch === "\t") {
          chars.push(ch);
        }
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

const password = await readPassword(`Set password for "${user}": `);
const confirm = await readPassword("Confirm password: ");

if (password !== confirm) {
  console.error("Passwords do not match.");
  process.exit(1);
}
if (password.length < 8) {
  console.error("Password must be at least 8 characters.");
  process.exit(1);
}

const N = 16384;
const r = 8;
const p = 1;
const keylen = 64;
const salt = randomBytes(32).toString("hex");
const hash = scryptSync(password, salt, keylen, { N, r, p }).toString("hex");
const record = {
  user,
  algo: "scrypt",
  N,
  r,
  p,
  keylen,
  salt,
  hash,
  updatedAt: new Date().toISOString(),
};

mkdirSync(path.join(ROOT, "config"), { recursive: true });
const file = process.env.SPARKDASH_AUTH_JSON || path.join(ROOT, "config", "auth.json");
writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });

console.log(`Account written: ${file} (user: ${user}, mode 0600) at ${record.updatedAt}`);
