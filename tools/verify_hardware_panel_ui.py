#!/usr/bin/env python3
"""End-to-end verification of the Hardware sensors panel + Overview temperatures.

Runs on VM100 (google-chrome + playwright live here). It boots a *separate*
sparkDash instance bound to 127.0.0.1 on its own port with its own temp config,
so production (`:5555`, systemd) is never touched — and it uses a throwaway
account, so no real credential is involved anywhere. The temp instance runs the
same code and the same built frontend as production, and polls the real hosts.

Checks:
  1. served API payload: pve sensors (cpu/board/fans/disks/nics/igpu), vm100 empty
  2. the 2 s sensor loop keeps updating (two reads 4 s apart differ)
  3. PVE page renders component temps + fans with duty, in Chinese
  4. Overview card carries board / disk / fan readings
  5. no console errors and no 4xx/5xx on the page's own requests
  6. screenshots for the record

Usage: python3 tools/verify_hardware_panel_ui.py
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
import urllib.request

REPO = "/www/project/sparkDash"
NODE_BIN = "/www/server/nodejs/v24.13.0/bin"
PORT = 5610
BASE = f"http://127.0.0.1:{PORT}"
USER = "e2euser"
TEMP_SECRET = "sparkdash-e2e-temp-secret"
SHOT_DIR = pathlib.Path("/root/sd-verify")

failures: list[str] = []
console_errors: list[str] = []
bad_responses: list[str] = []
session_token = ""


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


def wait_listen(log: pathlib.Path, seconds: int = 30) -> bool:
    for _ in range(seconds * 2):
        if log.exists() and "server listening" in log.read_text(errors="ignore"):
            return True
        time.sleep(0.5)
    return False


def login() -> str:
    request = urllib.request.Request(
        f"{BASE}/api/auth/login",
        data=json.dumps({"username": USER, "password": TEMP_SECRET}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        cookie = response.headers.get("Set-Cookie") or ""
    for part in cookie.split(";"):
        if part.strip().startswith("sparkdash_session="):
            return part.strip().split("=", 1)[1]
    return ""


def api(path: str) -> dict:
    request = urllib.request.Request(
        f"{BASE}{path}", headers={"Cookie": f"sparkdash_session={session_token}"}
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)


def sensors(spark_id: str) -> dict:
    return api(f"/api/sparks/{spark_id}/metrics")["metrics"]["sensors"]


def wait_for_sensors(seconds: int = 25) -> dict:
    deadline = time.time() + seconds
    reading = sensors("pve")
    while not reading.get("available") and time.time() < deadline:
        time.sleep(1)
        reading = sensors("pve")
    return reading


def verify_api() -> None:  # noqa: C901 - linear assertions
    global session_token
    session_token = login()
    check("temp instance login yields a session cookie", bool(session_token))
    if not session_token:
        raise SystemExit(1)

    pve = wait_for_sensors()
    print("pve sensors:", json.dumps(pve, ensure_ascii=False))
    check("pve sensors available", pve["available"] is True)
    check(
        "pve CPU junction reading",
        bool(pve["cpu"]) and pve["cpu"]["temperature"] > 0,
        str(pve["cpu"]),
    )
    check(
        "pve board rows in chip order",
        [r["key"] for r in pve["board"]]
        == ["SYSTIN", "CPUTIN", "PECI/TSI Agent 0 Calibration", "TSI0_TEMP"],
        str([r["key"] for r in pve["board"]]),
    )
    check(
        "pve fans carry rpm + duty",
        [f["key"] for f in pve["fans"]] == ["fan2", "fan3", "fan5", "fan6"]
        and all(f["rpm"] > 0 and f["pwmPercent"] is not None for f in pve["fans"]),
        str([(f["key"], f["rpm"], f["pwmPercent"]) for f in pve["fans"]]),
    )
    check(
        "pve disks labelled with the drive model",
        len(pve["disks"]) == 2 and all(r["label"].startswith("ZHITAI") for r in pve["disks"]),
        str([(r["key"], r["label"], r["temperature"]) for r in pve["disks"]]),
    )
    check("pve NIC rows", len(pve["nics"]) == 2, str(pve["nics"]))
    check("pve iGPU reading", bool(pve["igpu"]), str(pve["igpu"]))

    vm = sensors("vm100")
    print("vm100 sensors:", json.dumps(vm, ensure_ascii=False))
    check(
        "vm100 reports no sensors (guest)",
        vm["available"] is False and vm["reason"] == "no-sensors",
    )

    time.sleep(4)
    again = sensors("pve")
    check(
        "pve readings refresh on the 2 s loop",
        [f["rpm"] for f in again["fans"]] != [f["rpm"] for f in pve["fans"]]
        or again["cpu"]["temperature"] != pve["cpu"]["temperature"],
        f"cpu {pve['cpu']['temperature']} -> {again['cpu']['temperature']}, "
        f"fans {[f['rpm'] for f in pve['fans']]} -> {[f['rpm'] for f in again['fans']]}",
    )


def verify_ui() -> None:  # noqa: C901 - linear assertions
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
        page.on(
            "console",
            lambda msg: console_errors.append(msg.text) if msg.type == "error" else None,
        )
        page.on(
            "response",
            lambda response: bad_responses.append(f"{response.status} {response.url}")
            if response.status >= 400
            else None,
        )

        page.goto(BASE, wait_until="load", timeout=30000)
        page.wait_for_selector("text=PVE", timeout=30000)
        page.locator("button:has-text('PVE'), [role=tab]:has-text('PVE')").first.click()
        page.wait_for_selector("text=硬件 / 传感器", timeout=30000)
        page.wait_for_timeout(3000)  # let a couple of 2 s sensor polls land

        pve_text = page.inner_text("body")
        for needle in [
            "硬件 / 传感器",
            "温度",
            "风扇",
            "转/分",
            "ZHITAI Ti600 1TB",
            "ZHITAI TiPro9000 2TB",
            "enp10s0 PHY",
            "核心边缘",
            "系统",
            "CPU 插座",
        ]:
            check(f"PVE panel shows {needle!r}", needle in pve_text)
        check(
            "PVE panel shows fan rpm + duty",
            bool(re.search(r"\d{3,5}\s*·\s*\d{1,3}%", pve_text)),
            next((line for line in pve_text.splitlines() if "·" in line and "%" in line), ""),
        )
        check(
            "PVE panel hides empty fan headers",
            "fan1" not in pve_text and "fan4" not in pve_text,
        )
        check("no English fallback leaked", "Hardware sensors" not in pve_text)
        page.screenshot(path=str(SHOT_DIR / "hardware-panel-zh.png"), full_page=True)

        page.locator("button:has-text('总览'), [role=tab]:has-text('总览')").first.click()
        page.wait_for_timeout(3000)
        overview_text = page.inner_text("body")
        for needle in ["主板", "硬盘", "风扇"]:
            check(f"Overview card shows {needle}", needle in overview_text)
        page.screenshot(path=str(SHOT_DIR / "overview-zh.png"), full_page=True)

        context.close()
        browser.close()

    check("no console errors", not console_errors, "; ".join(console_errors[:3]))
    check("no 4xx/5xx responses", not bad_responses, "; ".join(bad_responses[:3]))
    print(f"screenshots: {SHOT_DIR}/hardware-panel-zh.png, {SHOT_DIR}/overview-zh.png")


def main() -> int:
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="sensorver-"))
    log = tmp / "instance.log"
    shutil.copy(f"{REPO}/config/sparks.json", tmp / "sparks.json")
    # Production shows Chinese; keep that so the new strings are exercised.
    settings = json.loads(pathlib.Path(f"{REPO}/config/settings.json").read_text())
    settings["language"] = "zh"
    (tmp / "settings.json").write_text(json.dumps(settings, indent=2) + "\n")

    env = {
        "PATH": f"{NODE_BIN}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME": "/root",
        "BIND_HOST": "127.0.0.1",
        "PORT": str(PORT),
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
        verify_api()
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
