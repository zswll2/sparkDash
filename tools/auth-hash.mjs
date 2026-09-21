#!/usr/bin/env node
// Print the SPARKDASH_ADMIN_* lines for .env: node tools/auth-hash.mjs [user]
// Reads the password once with echo disabled and prints only the hash line —
// nothing reversible is written to disk, and the password never appears in argv,
// shell history, or this process's own output.
import { scryptSync, randomBytes } from "node:crypto";

const user = (process.argv[2] || process.env.SPARKDASH_ADMIN_USER || "admin").trim();
if (!user || user.includes(" ")) {
  console.error("Usage: node tools/auth-hash.mjs [user]");
  process.exit(1);
}
if (!process.stdin.isTTY) {
  console.error("auth-hash needs an interactive terminal (hidden password input).");
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

const password = await readPassword(`Password for "${user}": `);
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

console.log("");
console.log("Add these lines to .env (then keep .env mode 600):");
console.log(`SPARKDASH_ADMIN_USER=${user}`);
console.log(`SPARKDASH_ADMIN_PASSWORD_HASH=scrypt:${N}:${r}:${p}:${salt}:${hash}`);
console.log("");
console.log("Notes: config/auth.json wins while it exists — remove it if you want the env hash to take effect.");
console.log("The plaintext password was not stored anywhere.");
