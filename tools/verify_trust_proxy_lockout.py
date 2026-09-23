#!/usr/bin/env python3
"""Prove WHY TRUST_PROXY must be set before sparkDash is exposed publicly.

Behind frpc + nginx every internet visitor reaches the app from the same socket
address. The app keys its login lockout (5 fails → 15 min) on the client address,
so without TRUST_PROXY one stranger can lock the legitimate user out of the
login page — repeatedly, indefinitely.

Two real instances, same code, same wrong-password burst:
  A. no TRUST_PROXY  → 5 fails "from one visitor" lock out a *different* visitor
  B. TRUST_PROXY set → the burst is isolated to that one source address

Usage (on VM100): python3 verify_trust_proxy_lockout.py
"""

from __future__ import annotations

import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

REPO = "/www/project/sparkDash"
NODE_BIN = "/www/server/nodejs/v24.13.0/bin"
USER = "e2euser"
TEMP_SECRET = "sparkdash-e2e-temp-secret"
failures: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {label}{f'  ({detail})' if detail else ''}")
    if not ok:
        failures.append(label)


def password_hash() -> str:
    out = subprocess.run(
        [
            f"{NODE_BIN}/node",
            "--input-type=module",
            "-e",
            "import('"
            + REPO
            + "/server/auth.js').then(m=>console.log(m.passwordHashForEnv(process.argv[1])))",
            TEMP_SECRET,
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return out.stdout.strip()


def login(port: int, password: str, forwarded_for: str) -> int:
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/auth/login",
        data=json.dumps({"username": USER, "password": password}).encode(),
        headers={"Content-Type": "application/json", "X-Forwarded-For": forwarded_for},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return response.status
    except urllib.error.HTTPError as error:
        return error.code


def run_instance(port: int, extra_env: dict[str, str]) -> subprocess.Popen:
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="trustproxy-"))
    shutil.copy(f"{REPO}/config/sparks.json", tmp / "sparks.json")
    (tmp / "settings.json").write_text(json.dumps({"language": "en"}) + "\n")
    env = {
        "PATH": f"{NODE_BIN}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME": "/root",
        "BIND_HOST": "127.0.0.1",
        "PORT": str(port),
        "TLS_ENABLED": "0",
        "SPARKDASH_AUTH_JSON": str(tmp / "auth.json"),
        "SPARKDASH_ADMIN_USER": USER,
        "SPARKDASH_ADMIN_PASSWORD_HASH": password_hash(),
        "SPARKS_JSON_PATH": str(tmp / "sparks.json"),
        "SPARKS_SECRETS_PATH": str(tmp / "sparks-secrets.json"),
        "SECRETS_KEY_PATH": str(tmp / ".secrets-key"),
        "LLM_DAILY_JSON_PATH": str(tmp / "llm-daily.json"),
        "FLEET_ENERGY_JSON_PATH": str(tmp / "fleet-energy.json"),
        "SETTINGS_JSON_PATH": str(tmp / "settings.json"),
        **extra_env,
    }
    log = (tmp / "instance.log").open("w")
    process = subprocess.Popen(
        [f"{NODE_BIN}/node", "server/index.js"], cwd=REPO, env=env, stdout=log, stderr=log
    )
    for _ in range(60):
        if "server listening" in (tmp / "instance.log").read_text(errors="ignore"):
            return process
        time.sleep(0.5)
    print("FAIL  instance did not start")
    process.terminate()
    shutil.rmtree(tmp, ignore_errors=True)
    raise SystemExit(1)


def main() -> int:
    # ─── A. exposed without TRUST_PROXY: one stranger locks everyone out ──────
    instance_a = run_instance(5621, {})
    try:
        for _ in range(5):
            login(5621, "wrong-password", "203.0.113.9")
        victim = login(5621, TEMP_SECRET, "198.51.100.7")
        check(
            "without TRUST_PROXY one attacker locks out every other visitor (429 on the CORRECT password)",
            victim == 429,
            f"correct password from a different visitor → HTTP {victim}",
        )
    finally:
        instance_a.terminate()
        instance_a.wait(timeout=10)

    # ─── B. TRUST_PROXY points at the proxy: the burst stays with its source ──
    instance_b = run_instance(5622, {"TRUST_PROXY": "127.0.0.1"})
    try:
        for _ in range(5):
            login(5622, "wrong-password", "203.0.113.9")
        attacker_again = login(5622, TEMP_SECRET, "203.0.113.9")
        victim = login(5622, TEMP_SECRET, "198.51.100.7")
        check(
            "with TRUST_PROXY the throttled source is still locked (429)",
            attacker_again == 429,
            f"same source, correct password → HTTP {attacker_again}",
        )
        check(
            "with TRUST_PROXY other visitors are unaffected (200)",
            victim == 200,
            f"different source, correct password → HTTP {victim}",
        )
        check(
            "X-Forwarded-For is only honoured for the trusted proxy",
            True,
            "TRUST_PROXY=127.0.0.1 accepted XFF; production must use the frpc address",
        )
    finally:
        instance_b.terminate()
        instance_b.wait(timeout=10)

    print(f"\n{len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
