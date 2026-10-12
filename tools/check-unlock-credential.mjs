#!/usr/bin/env node
/**
 * Verify the DEPLOYED read-only unlock credential against the deployed code —
 * without printing the password.
 *
 *   node tools/check-unlock-credential.mjs
 *
 * Why this exists: a hash can be stored and reported as "configured" while no
 * human holds a usable password (that happened once: the generator wrote an
 * empty plaintext file). Only checking the stored hash against the plaintext
 * catches that state. The plaintext is read from config/readonly-password.txt
 * (0600, gitignored); if that file is gone the script says so and skips the two
 * checks that need it.
 *
 * Run it after `npm run readonly:passwd` and after any config/readonly.json move.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isHardLocked,
  isReadonly,
  loadUnlockFile,
  readonlyState,
  readonlyUnlockTtlMs,
  unlockStatus,
  verifyUnlockPassword,
} from "../server/auth.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLAINTEXT = process.env.SPARKDASH_READONLY_PASSWORD_TXT || path.join(ROOT, "config", "readonly-password.txt");
const MIN_LENGTH = 10; // keep in sync with tools/readonly-setpass.mjs

const record = loadUnlockFile();
const status = unlockStatus();
const plaintext = existsSync(PLAINTEXT) ? readFileSync(PLAINTEXT, "utf8").trim() : null;

const checks = {
  "credential file is a scrypt record": Boolean(record?.hash && record?.salt && record?.N),
  "unlock status reports configured": status.configured === true && status.error === null,
  "posture is readonly (not hard-locked)": readonlyState() === "readonly" && isReadonly() && !isHardLocked(),
  "TTL is the 30 minute default": readonlyUnlockTtlMs() === 1_800_000,
};
if (plaintext !== null) {
  checks[`stored password is accepted (${plaintext.length} chars, min ${MIN_LENGTH})`] =
    plaintext.length >= MIN_LENGTH && verifyUnlockPassword(plaintext) === true;
  checks["a wrong password is rejected"] = verifyUnlockPassword(`${plaintext}x`) === false;
} else {
  console.log(`NOTE  ${PLAINTEXT} is absent — skipping the accept/reject checks against the real password.`);
}
checks["an empty password is rejected"] = verifyUnlockPassword("") === false;

let failed = 0;
for (const [label, ok] of Object.entries(checks)) {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
}
console.log(`\n${failed} failure(s)`);
process.exit(failed ? 1 : 0);
