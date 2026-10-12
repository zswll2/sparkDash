#!/usr/bin/env python3
"""End-to-end verification: read-only unlock from Settings + the LLM live terminal.

Runs on VM100 (google-chrome + playwright live here). It boots a *separate*
sparkDash instance on 127.0.0.1:5611 with its own temp config (read-only posture,
throwaway account, throwaway unlock password) so production `:5555` is never
touched. The temp instance runs the same code, the same built frontend and the
same collectors (it polls the real hosts, which is what makes the terminal show
real tok/s).

Checks:
  A. API: posture fields on /api/health, wrong password refused, right password
     opens writes for that session, Lock now closes them again
  B. UI: locked banner → Settings shows the unlock box → wrong password surfaces
     the error → right password flips the banner to a countdown → a real write
     lands (poll interval saved) → Lock now restores the locked banner
  C. UI: the LLM card's terminal appends one line per sample with timestamps
  D. UI: clicking the overview card *body* opens that unit's page
  E. no console errors, no unexpected 4xx/5xx (the deliberate wrong-password 401
     is reported separately), screenshots for the record

Usage: python3 tools/verify_unlock_terminal_ui.py
"""

from __future__ import annotations

import json
import pathlib
import re
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
USER = "unlocke2e"
LOGIN_SECRET = "sparkdash-unlock-e2e-login"
UNLOCK_SECRET = "sparkdash-unlock-e2e-ops-32-characters"
SHOT_DIR = pathlib.Path("/root/sd-verify")
# The wrong-password probe is part of the test, not a defect.
INTENTIONAL_4XX = ("/api/readonly/unlock",)

failures: list[str] = []
console_errors: list[str] = []
bad_responses: list[str] = []
noted_responses: list[str] = []
session_token = ""


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {label}{f'  ({detail})' if detail else ''}")
    if not ok:
        failures.append(label)


def password_hash(secret: str) -> str:
    out = subprocess.run(
        [
            f"{NODE_BIN}/node",
            "--input-type=module",
            "-e",
            "import('" + REPO + "/server/auth.js').then(m=>console.log(m.passwordHashForEnv(process.argv[1])))",
            secret,
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return out.stdout.strip()


def unlock_record(secret: str) -> dict:
    """Same scrypt record schema the server's `npm run readonly:passwd` writes."""
    out = subprocess.run(
        [
            f"{NODE_BIN}/node",
            "--input-type=module",
            "-e",
            "import('" + REPO + "/server/auth.js').then(m=>console.log(JSON.stringify({updatedAt:new Date().toISOString(),...m.hashPassword(process.argv[1])})))",
            secret,
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(out.stdout.strip())


def request(method: str, path: str, payload: dict | None = None, cookie: str | None = None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(f"{BASE}{path}", data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if cookie:
        req.add_header("Cookie", f"sparkdash_session={cookie}")
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            body = response.read().decode()
            return response.status, (json.loads(body) if body else {})
    except urllib.error.HTTPError as err:
        body = err.read().decode()
        try:
            return err.code, json.loads(body)
        except json.JSONDecodeError:
            return err.code, {"raw": body}


def api(path: str, method: str = "GET", payload: dict | None = None):
    status, body = request(method, path, payload, session_token)
    if status >= 400:
        raise SystemExit(f"unexpected {status} for {method} {path}: {body}")
    return body


def wait_listen(log: pathlib.Path, seconds: int = 30) -> bool:
    for _ in range(seconds * 2):
        if log.exists() and "server listening" in log.read_text(errors="ignore"):
            return True
        time.sleep(0.5)
    return False


def verify_api(unlock_file: pathlib.Path) -> None:
    global session_token

    req = urllib.request.Request(
        f"{BASE}/api/auth/login",
        data=json.dumps({"username": USER, "password": LOGIN_SECRET}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as response:
        set_cookie = response.headers.get("Set-Cookie") or ""
    session_token = next(
        (
            part.strip().split("=", 1)[1]
            for part in set_cookie.split(";")
            if part.strip().startswith("sparkdash_session=")
        ),
        "",
    )
    check("temp instance login yields a session cookie", bool(session_token))
    if not session_token:
        raise SystemExit(1)

    health = api("/api/health")
    check("health reports the read-only posture", health.get("readonlyState") == "readonly", str(health.get("readonlyState")))
    check("health reports the unlock password as configured", health.get("readonlyUnlockConfigured") is True)
    check("health starts locked", health.get("readonlyUnlocked") is False)

    status, _ = request("PUT", "/api/settings", {"pollIntervalMs": 5000}, session_token)
    check("writes are refused while locked", status == 403, str(status))

    status, body = request("POST", "/api/readonly/unlock", {"password": "nope"}, session_token)
    check("wrong unlock password is refused", status == 401, f"{status} {body}")

    status, body = request("POST", "/api/readonly/unlock", {"password": UNLOCK_SECRET}, session_token)
    check("right unlock password opens a window", status == 200 and body.get("unlocked") is True, f"{status} {body}")
    check("the window carries a deadline", isinstance(body.get("expiresAt"), int) and body["expiresAt"] > time.time() * 1000)

    h2 = api("/api/health")
    check("health reports this session as unlocked", h2.get("readonlyUnlocked") is True)
    status, _ = request("PUT", "/api/settings", {"pollIntervalMs": 1000}, session_token)
    check("writes pass while unlocked", status == 200, str(status))

    status, body = request("POST", "/api/readonly/lock", None, session_token)
    check("Lock now succeeds", status == 200 and body.get("unlocked") is False, f"{status} {body}")
    status, _ = request("PUT", "/api/settings", {"pollIntervalMs": 5000}, session_token)
    check("writes are refused again after locking", status == 403, str(status))
    check("health is locked again", api("/api/health").get("readonlyUnlocked") is False)

    # The credential file itself stays 0600 — the server refuses anything looser.
    mode = unlock_file.stat().st_mode & 0o777
    check("unlock credential is 0600", mode == 0o600, oct(mode))


def verify_ui() -> None:
    from playwright.sync_api import sync_playwright

    SHOT_DIR.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            channel="chrome", args=["--no-sandbox", "--disable-dev-shm-usage"]
        )
        context = browser.new_context(viewport={"width": 1600, "height": 1400})
        context.add_cookies(
            [
                {
                    "name": "sparkdash_session",
                    "value": session_token,
                    "url": BASE,
                    "httpOnly": True,
                    "sameSite": "Strict",
                }
            ]
        )
        page = context.new_page()
        page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)

        def note_response(response) -> None:
            if response.status < 400:
                return
            line = f"{response.status} {response.url}"
            if any(marker in response.url for marker in INTENTIONAL_4XX):
                noted_responses.append(line)
            else:
                bad_responses.append(line)

        page.on("response", note_response)

        page.goto(BASE, wait_until="load", timeout=30000)
        page.wait_for_timeout(2500)

        body = page.inner_text("body")
        check("locked banner is shown", "只读模式" in body and "仅可查看" in body)
        check("no English fallback leaked into the banner", "this dashboard is view-only" not in body)

        # ── The banner must lead there: an operator could not find the box ──
        banner_unlock = page.locator("button:has-text('解锁')")
        check("the locked banner offers a way in", banner_unlock.count() == 1, f"{banner_unlock.count()} buttons")
        banner_unlock.first.click()
        page.wait_for_timeout(1200)
        check("the banner button opens Settings", page.locator(".settings-panel").count() == 1)

        field = page.locator("input[placeholder='解锁口令']")
        check("settings offers the unlock password field", field.count() == 1)
        box = field.first.bounding_box()
        check(
            "the unlock box sits at the top of the panel (no hunting/scrolling)",
            bool(box) and box["y"] < 700,
            f"y={round(box['y']) if box else None}",
        )
        page.fill("input[placeholder='解锁口令']", "definitely-wrong")
        page.locator(".settings-panel button:has-text('解锁')").first.click()
        page.wait_for_timeout(1500)
        check("the wrong password surfaces the server error", "Invalid unlock password" in page.inner_text("body"))

        page.fill("input[placeholder='解锁口令']", UNLOCK_SECRET)
        page.locator(".settings-panel button:has-text('解锁')").first.click()
        page.wait_for_timeout(1800)
        unlocked_body = page.inner_text("body")
        check("the banner switches to the unlocked variant", "本次会话已解锁只读模式" in unlocked_body)
        check(
            "the banner counts the window down",
            re.search(r"剩余 \d+:\d\d", unlocked_body) is not None,
            next((line for line in unlocked_body.splitlines() if "剩余" in line), ""),
        )
        page.screenshot(path=str(SHOT_DIR / "unlock-settings-zh.png"), full_page=True)

        # ── A real write through the UI now that the window is open ──
        page.locator("button:has-text('2s')").first.click()
        page.locator("button:has-text('保存')").first.click()
        page.wait_for_timeout(1800)
        saved = api("/api/settings")
        check(
            "a UI write reached the server after unlocking",
            saved.get("pollIntervalMs") == 2000,
            str(saved.get("pollIntervalMs")),
        )
        # Back to the 1 s cadence, which is what production runs: the terminal
        # prints one line per broadcast, so this is the rate being verified.
        status, _ = request("PUT", "/api/settings", {"pollIntervalMs": 1000}, session_token)
        check("cadence restored for the terminal check", status == 200, str(status))

        # ── Lock again from the banner ──
        page.locator("button:has-text('立即锁定')").first.click()
        page.wait_for_timeout(1500)
        relocked = page.inner_text("body")
        check("Lock now restores the locked banner", "仅可查看" in relocked and "本次会话已解锁只读模式" not in relocked)
        status, _ = request("PUT", "/api/settings", {"pollIntervalMs": 5000}, session_token)
        check("the server refuses writes again after the UI lock", status == 403, str(status))

        # ── LLM live terminal ──
        page.locator("button:has-text('VM100'), [role=tab]:has-text('VM100')").first.click()
        page.wait_for_timeout(3000)
        toggle = page.locator("button:has-text('终端')")
        check("the LLM card offers the terminal toggle", toggle.count() > 0)
        if toggle.count():
            toggle.first.click()
            page.wait_for_selector(".llm-term__body", timeout=15000)
            page.wait_for_timeout(1500)
            first_lines = page.eval_on_selector_all(
                ".llm-term__line", "els => els.map((e) => e.textContent)"
            )
            page.wait_for_timeout(6000)
            second_lines = page.eval_on_selector_all(
                ".llm-term__line", "els => els.map((e) => e.textContent)"
            )
            check(
                "the terminal appends one line per broadcast (~1/s)",
                len(second_lines) >= len(first_lines) + 4,
                f"{len(first_lines)} -> {len(second_lines)} lines in 6 s",
            )
            check(
                "lines carry a timestamp and decode/prefill tok/s",
                bool(second_lines) and all(re.match(r"^\d\d:\d\d:\d\d {2}dec +\d", line or "") for line in second_lines),
                (second_lines or [""])[-1],
            )
            stamps = [line.split(" ")[0] for line in second_lines]
            check(
                "terminal lines carry fresh timestamps (not a frozen line)",
                len(set(stamps)) >= 3 and stamps == sorted(stamps),
                f"{len(set(stamps))} distinct timestamps in {len(stamps)} lines",
            )
            page.screenshot(path=str(SHOT_DIR / "llm-terminal-zh.png"), full_page=True)

        # ── Whole-card click on the overview ──
        page.locator("button:has-text('总览'), [role=tab]:has-text('总览')").first.click()
        page.wait_for_timeout(2000)
        card = page.locator(".overview-card--clickable").filter(has_text="VM100").first
        check("overview cards are clickable surfaces", page.locator(".overview-card--clickable").count() > 0)
        box = card.bounding_box()
        if box:
            # Click the card *body*, away from the title/buttons at the top.
            page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] - 10)
            page.wait_for_timeout(2000)
            check(
                "clicking the card body opens that unit",
                page.url.rstrip("/").endswith("/spark/vm100"),
                page.url,
            )
            page.screenshot(path=str(SHOT_DIR / "overview-card-click-zh.png"), full_page=True)
        else:
            check("VM100 card is visible on the overview", False, "no bounding box")

        context.close()
        browser.close()

    # The wrong-password probe makes the browser log one 401; that is the test.
    unexpected_console = [err for err in console_errors if "status of 401" not in err]
    check("no console errors", not unexpected_console, "; ".join(unexpected_console[:3]))
    check("no unexpected 4xx/5xx responses", not bad_responses, "; ".join(bad_responses[:3]))
    print(
        f"intentional 4xx (probe): {noted_responses}; "
        f"browser-logged 401 from that probe: {len(console_errors) - len(unexpected_console)}"
    )
    print(f"screenshots: {SHOT_DIR}/unlock-settings-zh.png, {SHOT_DIR}/llm-terminal-zh.png, {SHOT_DIR}/overview-card-click-zh.png")


def main() -> int:
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="unlockver-"))
    log = tmp / "instance.log"
    shutil.copy(f"{REPO}/config/sparks.json", tmp / "sparks.json")
    settings = json.loads(pathlib.Path(f"{REPO}/config/settings.json").read_text())
    settings["language"] = "zh"
    (tmp / "settings.json").write_text(json.dumps(settings, indent=2) + "\n")

    mode_file = tmp / "readonly.mode"
    mode_file.write_text("readonly\n")
    unlock_file = tmp / "readonly.json"
    unlock_file.write_text(json.dumps(unlock_record(UNLOCK_SECRET)))
    unlock_file.chmod(0o600)

    env = {
        "PATH": f"{NODE_BIN}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME": "/root",
        "BIND_HOST": "127.0.0.1",
        "PORT": str(PORT),
        "TLS_ENABLED": "0",
        "SPARKDASH_AUTH_JSON": str(tmp / "auth.json"),
        "SPARKDASH_ADMIN_USER": USER,
        "SPARKDASH_ADMIN_PASSWORD_HASH": password_hash(LOGIN_SECRET),
        "SPARKDASH_READONLY_MODE_FILE": str(mode_file),
        "SPARKDASH_READONLY_UNLOCK_JSON": str(unlock_file),
        "SPARKS_JSON_PATH": str(tmp / "sparks.json"),
        "SPARKS_SECRETS_PATH": str(tmp / "sparks-secrets.json"),
        "SECRETS_KEY_PATH": str(tmp / ".secrets-key"),
        "LLM_DAILY_JSON_PATH": str(tmp / "llm-daily.json"),
        "FLEET_ENERGY_JSON_PATH": str(tmp / "fleet-energy.json"),
        "SETTINGS_JSON_PATH": str(tmp / "settings.json"),
    }
    with log.open("w") as handle:
        process = subprocess.Popen(
            [f"{NODE_BIN}/node", "server/index.js"],
            cwd=REPO,
            env=env,
            stdout=handle,
            stderr=handle,
        )
    try:
        if not wait_listen(log):
            print("FAIL  temp instance did not start; log tail:")
            print("\n".join(log.read_text().splitlines()[-12:]))
            return 1
        print(f"temp instance up on {BASE} (pid {process.pid})")
        verify_api(unlock_file)
        verify_ui()
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
