#!/usr/bin/env python3
"""End-to-end verification of read-only mode (run on VM100).

Boots a throwaway instance (own port, own temp config, one-time account) and
proves the gate on the *real* HTTP surface, not in unit-test shapes:

  1. every state-changing route is refused with the read-only message
     (the allowlist — logout + manual refresh — still works)
  2. flipping config/readonly.mode to "full" takes effect WITHOUT a restart
  3. a real browser shows the read-only banner and a disabled batch button,
     and the banner disappears after the flip

Usage: python3 tools/verify_readonly_mode.py
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
PORT = 5611
BASE = f"http://127.0.0.1:{PORT}"
USER = "e2euser"
TEMP_SECRET = "sparkdash-e2e-temp-secret"
SHOT = pathlib.Path("/root/sd-verify/readonly-banner-zh.png")

failures: list[str] = []

# Every non-GET route registered in server/index.js (minus the two auth routes
# that must stay anonymous). Anything not listed as allowed must be refused.
WRITES = [
    ("POST", "/api/sparks/test"),
    ("POST", "/api/sparks"),
    ("PATCH", "/api/sparks/pve"),
    ("DELETE", "/api/sparks/pve"),
    ("PUT", "/api/sparks/order"),
    ("PUT", "/api/settings"),
    ("POST", "/api/sparks/pve/test"),
    ("POST", "/api/sparks/pve/comfy/cancel"),
    ("POST", "/api/sparks/hermes/update-all"),
    ("POST", "/api/sparks/pve/hermes/check"),
    ("POST", "/api/sparks/pve/hermes/update"),
    ("PUT", "/api/sparks/pve/password"),
    ("PUT", "/api/sparks/pve/disabled-devices"),
    ("PUT", "/api/sparks/pve/disabled-interfaces"),
    ("PUT", "/api/sparks/pve/llm-ports"),
    ("PUT", "/api/sparks/pve/llm-port"),
    ("POST", "/api/sparks/pve/llm-ports"),
    ("DELETE", "/api/sparks/pve/llm-ports/8888"),
    ("PUT", "/api/sparks/pve/llm-ports/8888/api-key"),
    ("POST", "/api/sparks/pve/llm/bench"),
    ("DELETE", "/api/sparks/pve/llm/bench"),
    ("DELETE", "/api/sparks/pve/llm/bench/xyz"),
    ("POST", "/api/sparks/pve/llm/prefill-bench"),
    ("DELETE", "/api/sparks/pve/llm/prefill-bench"),
    ("DELETE", "/api/sparks/pve/llm/prefill-bench/xyz"),
    ("POST", "/api/sparks/pve/llm/showcase"),
    ("DELETE", "/api/sparks/pve/llm/showcase"),
    ("DELETE", "/api/sparks/pve/llm/showcase/xyz"),
    ("POST", "/api/sparks/shutdown-all"),
    ("POST", "/api/sparks/wake-all"),
    ("POST", "/api/sparks/pve/shutdown"),
    ("POST", "/api/sparks/pve/wake"),
]
ALLOWED = [
    ("POST", "/api/sparks/pve/refresh/cpu"),
    ("POST", "/api/sparks/pve/refresh/storage"),
]

session = ""


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


def request(method: str, path: str, body: dict | None = None, cookie: str = "") -> tuple[int, str]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{BASE}{path}",
        data=data,
        headers={
            "Content-Type": "application/json",
            **( {"Cookie": f"sparkdash_session={cookie}"} if cookie else {} ),
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return response.status, response.read(400).decode(errors="replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read(400).decode(errors="replace")


def main() -> int:  # noqa: C901 - linear verification script
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="readonlyver-"))
    log = tmp / "instance.log"
    shutil.copy(f"{REPO}/config/sparks.json", tmp / "sparks.json")
    settings = json.loads(pathlib.Path(f"{REPO}/config/settings.json").read_text())
    settings["language"] = "zh"
    (tmp / "settings.json").write_text(json.dumps(settings, indent=2) + "\n")
    mode_file = tmp / "readonly.mode"
    mode_file.write_text("readonly\n")

    env = {
        "PATH": f"{NODE_BIN}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME": "/root",
        "BIND_HOST": "127.0.0.1",
        "PORT": str(PORT),
        "TLS_ENABLED": "0",
        "SPARKDASH_AUTH_JSON": str(tmp / "auth.json"),
        "SPARKDASH_ADMIN_USER": USER,
        "SPARKDASH_ADMIN_PASSWORD_HASH": password_hash(),
        "SPARKDASH_READONLY_MODE_FILE": str(mode_file),
        "SPARKS_JSON_PATH": str(tmp / "sparks.json"),
        "SPARKS_SECRETS_PATH": str(tmp / "sparks-secrets.json"),
        "SECRETS_KEY_PATH": str(tmp / ".secrets-key"),
        "LLM_DAILY_JSON_PATH": str(tmp / "llm-daily.json"),
        "FLEET_ENERGY_JSON_PATH": str(tmp / "fleet-energy.json"),
        "SETTINGS_JSON_PATH": str(tmp / "settings.json"),
    }
    with log.open("w") as handle:
        process = subprocess.Popen(
            [f"{NODE_BIN}/node", "server/index.js"], cwd=REPO, env=env, stdout=handle, stderr=handle
        )
    try:
        for _ in range(60):
            if "server listening" in log.read_text(errors="ignore"):
                break
            time.sleep(0.5)
        else:
            print("FAIL  instance did not start")
            print("\n".join(log.read_text().splitlines()[-10:]))
            return 1
        print(f"temp instance up on {BASE} (pid {process.pid})")

        global session
        import http.cookiejar

        opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
        )
        req = urllib.request.Request(
            f"{BASE}/api/auth/login",
            data=json.dumps({"username": USER, "password": TEMP_SECRET}).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with opener.open(req, timeout=10) as response:
            check("login works", response.status == 200)
            for part in (response.headers.get("Set-Cookie") or "").split(";"):
                if part.strip().startswith("sparkdash_session="):
                    session = part.strip().split("=", 1)[1]
        check("session cookie obtained", bool(session))

        health = json.loads(request("GET", "/api/health", cookie=session)[1])
        check("health reports readonly=true", health.get("readonly") is True, str(health.get("readonly")))

        # 1. every state change refused
        blocked = 0
        for method, path in WRITES:
            status, body = request(method, path, {}, cookie=session)
            if status == 403 and "Read-only mode" in body:
                blocked += 1
            else:
                check(f"{method} {path} refused", False, f"got {status} {body[:70]}")
        check(
            f"all {len(WRITES)} state-changing routes refused with the read-only message",
            blocked == len(WRITES),
            f"{blocked}/{len(WRITES)}",
        )

        # 2. allowlist still works
        for method, path in ALLOWED:
            status, body = request(method, path, {}, cookie=session)
            check(f"{method} {path} still allowed", "Read-only mode" not in body, f"got {status}")

        # Reads unaffected
        status, body = request("GET", "/api/sparks", cookie=session)
        check("reads still work", status == 200, f"{status}")

        # 3. flip the mode file — no restart
        mode_file.write_text("full\n")
        time.sleep(0.3)
        status, body = request("PUT", "/api/settings", {"language": "zh"}, cookie=session)
        check("after flip to full the same write is no longer blocked", "Read-only mode" not in body, f"got {status} {body[:70]}")
        health = json.loads(request("GET", "/api/health", cookie=session)[1])
        check("health reports readonly=false after the flip", health.get("readonly") is False)

        # 4. browser: banner + disabled control
        from playwright.sync_api import sync_playwright

        SHOT.parent.mkdir(parents=True, exist_ok=True)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(
                channel="chrome", args=["--no-sandbox", "--disable-dev-shm-usage"]
            )
            context = browser.new_context(viewport={"width": 1500, "height": 1100})
            context.add_cookies(
                [
                    {
                        "name": "sparkdash_session",
                        "value": session,
                        "url": BASE,
                        "httpOnly": True,
                        "sameSite": "Strict",
                    }
                ]
            )
            page = context.new_page()
            errors: list[str] = []
            page.on("console", lambda msg: errors.append(msg.text) if msg.type == "error" else None)
            page.goto(BASE, wait_until="load", timeout=30000)
            page.wait_for_selector("text=总览", timeout=30000)
            full_mode_text = page.inner_text("body")
            check("banner is gone after switching to full", "只读模式" not in full_mode_text)

            mode_file.write_text("readonly\n")
            page.reload(wait_until="load")
            page.wait_for_selector("text=只读模式", timeout=30000)
            readonly_text = page.inner_text("body")
            check("banner appears in read-only mode", "只读模式" in readonly_text)
            shutdown_button = page.locator("button:has-text('全部关机')").first
            check(
                "batch shutdown button is disabled",
                shutdown_button.is_disabled(),
                f"disabled={shutdown_button.is_disabled()}",
            )
            page.screenshot(path=str(SHOT), full_page=True)
            check("no console errors in the browser", not errors, "; ".join(errors[:3]))
            context.close()
            browser.close()
        # Logout is allowlisted too — probed last because it destroys the session.
        status, body = request("POST", "/api/auth/logout", {}, cookie=session)
        check("logout still allowed in read-only mode", "Read-only mode" not in body, f"got {status}")
        print(f"screenshot: {SHOT}")
    finally:
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
        shutil.rmtree(tmp, ignore_errors=True)

    print(f"\n{len(failures)} failure(s)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
