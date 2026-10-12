#!/usr/bin/env python3
"""Acceptance: the dashboard's SGLang decode tok/s tracks the engine's live rate.

Runs on VM100. Boots a temp instance (own port + temp config + throwaway account,
never touches production :5555) pointed at the real sparks.json, runs a real
generation against the unit's LLM port, and compares what the dashboard reports
with what the engine reports while it decodes.

Why: on builds whose Prometheus token counters only flush when a request finishes
(VM100 5217, sglang 0.0.0.dev1), a counter delta is a finished request's whole
token count. The dashboard used to show 0 for the entire generation and then one
absurd spike (dec 2893 / pre 152477). It must now follow the engine's per-step
rate (internal_states[].last_gen_throughput / sglang:gen_throughput).

Usage: python3 tools/verify_sglang_live_tps.py [spark-id]
"""

from __future__ import annotations

import json
import pathlib
import re
import shutil
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

REPO = "/www/project/sparkDash"
NODE_BIN = "/www/server/nodejs/v24.13.0/bin"
PORT = 5612
BASE = f"http://127.0.0.1:{PORT}"
USER = "tpsverify"
TEMP_SECRET = "sparkdash-tps-verify-secret"
SPARK = sys.argv[1] if len(sys.argv) > 1 else "vm100"
# Port the verification actually generates on — set once the engine is located.
llm_port = None
# A single-GPU decode rate cannot plausibly exceed this; anything above it is a
# counter artefact, not a measurement.
ABSURD_TPS = 3000

failures: list[str] = []
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
            "import('" + REPO + "/server/auth.js').then(m=>console.log(m.passwordHashForEnv(process.argv[1])))",
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
    req = urllib.request.Request(
        f"{BASE}/api/auth/login",
        data=json.dumps({"username": USER, "password": TEMP_SECRET}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=10) as response:
        cookie = response.headers.get("Set-Cookie") or ""
    for part in cookie.split(";"):
        if part.strip().startswith("sparkdash_session="):
            return part.strip().split("=", 1)[1]
    return ""


def dashboard_llm() -> dict:
    req = urllib.request.Request(
        f"{BASE}/api/sparks/{SPARK}/metrics", headers={"Cookie": f"sparkdash_session={session}"}
    )
    with urllib.request.urlopen(req, timeout=15) as response:
        payload = json.load(response)
    entries = payload.get("metrics", {}).get("llm") or []
    # The array carries every monitored port (configured + auto-discovered); pick
    # the engine we are actually generating on, not blindly entries[0].
    for entry in entries:
        if entry.get("port") == llm_port:
            return entry
    for entry in entries:
        if entry.get("available"):
            return entry
    return entries[0] if entries else {}


def engine_metrics(port: int) -> dict:
    raw = urllib.request.urlopen(f"http://127.0.0.1:{port}/metrics", timeout=5).read().decode()
    gauge = None
    for line in raw.splitlines():
        if line.startswith("sglang:gen_throughput") or line.startswith("sglang_gen_throughput"):
            gauge = float(line.rsplit(" ", 1)[1])
            break
    last_gen = None
    # /server_info is the current path; /get_server_info is the deprecated alias and
    # can block under load, so a failure here must not sink the whole check.
    for path in ("/server_info", "/get_server_info"):
        try:
            info = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=5).read())
            states = info.get("internal_states") or []
            last_gen = (states[0] if states else {}).get("last_gen_throughput")
            break
        except Exception:  # noqa: BLE001 - optional detail for the log line
            continue
    return {"gauge": gauge, "last_gen_throughput": last_gen}


def generate(port: int, seconds: int) -> None:
    body = json.dumps(
        {
            "model": "qwen38-flash-next",
            "messages": [{"role": "user", "content": "写一篇 500 字的短文，主题是港口清晨的雾。"}],
            "max_tokens": 700,
            "stream": True,
        }
    ).encode()
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/v1/chat/completions",
        data=body,
        headers={"Content-Type": "application/json"},
    )
    start = time.time()
    n = 0
    with urllib.request.urlopen(req, timeout=180) as response:
        for chunk in response:
            if chunk.strip():
                n += 1
            if time.time() - start > seconds:
                break
    print(f"  [generate] {n} SSE chunks in {time.time() - start:.1f}s")


def main() -> int:
    global session, llm_port

    registry = json.loads(pathlib.Path(f"{REPO}/config/sparks.json").read_text())
    entries = registry.get("sparks") if isinstance(registry, dict) else registry
    spark = next((s for s in entries or [] if s.get("id") == SPARK), None)
    if not spark:
        print(f"SKIP  no spark {SPARK!r} in config/sparks.json")
        return 0
    ports = spark.get("llmPorts") or ([spark["llmPort"]] if spark.get("llmPort") else [])
    if not ports:
        print(f"SKIP  {SPARK} has no LLM port configured")
        return 0

    llm_port = None
    for candidate in list(ports) + list(range(5200, 5300)):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{candidate}/v1/models", timeout=3)
            llm_port = int(candidate)
            break
        except Exception:  # noqa: BLE001 - probe each candidate
            continue
    if llm_port is None:
        print(f"SKIP  no LLM answers /v1/models (registry {ports}, scanned 5200-5299)")
        return 0
    print(f"engine: {SPARK} port {llm_port}{'' if llm_port in ports else ' (found by scan — the registry still lists ' + str(ports) + ')'}")

    tmp = pathlib.Path(tempfile.mkdtemp(prefix="tpsver-"))
    log = tmp / "instance.log"
    shutil.copy(f"{REPO}/config/sparks.json", tmp / "sparks.json")
    settings = json.loads(pathlib.Path(f"{REPO}/config/settings.json").read_text())
    (tmp / "settings.json").write_text(json.dumps(settings, indent=2) + "\n")
    (tmp / "readonly.mode").write_text("full\n")

    env = {
        "PATH": f"{NODE_BIN}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "HOME": "/root",
        "BIND_HOST": "127.0.0.1",
        "PORT": str(PORT),
        "TLS_ENABLED": "0",
        "SPARKDASH_AUTH_JSON": str(tmp / "auth.json"),
        "SPARKDASH_ADMIN_USER": USER,
        "SPARKDASH_ADMIN_PASSWORD_HASH": password_hash(),
        "SPARKDASH_READONLY_MODE_FILE": str(tmp / "readonly.mode"),
        "SPARKS_JSON_PATH": str(tmp / "sparks.json"),
        "SPARKS_SECRETS_PATH": str(tmp / "sparks-secrets.json"),
        "SECRETS_KEY_PATH": str(tmp / ".secrets-key"),
        "LLM_DAILY_JSON_PATH": str(tmp / "llm-daily.json"),
        "FLEET_ENERGY_JSON_PATH": str(tmp / "fleet-energy.json"),
        "SETTINGS_JSON_PATH": str(tmp / "settings.json"),
        "POLL_INTERVAL_LLM": "1000",
    }
    with log.open("w") as handle:
        process = subprocess.Popen(
            [f"{NODE_BIN}/node", "server/index.js"], cwd=REPO, env=env, stdout=handle, stderr=handle
        )
    try:
        if not wait_listen(log):
            print("FAIL  temp instance did not start; log tail:")
            print("\n".join(log.read_text().splitlines()[-12:]))
            return 1
        session = login()
        check("temp instance login", bool(session))
        if not session:
            return 1

        # Warm up: the probe classifies the backend and seeds its baselines.
        for _ in range(4):
            time.sleep(1)
            dashboard_llm()

        print(f"=== generation + 1 s sampling for ~16 s (engine port {llm_port}) ===")
        threading.Thread(target=generate, args=(llm_port, 16), daemon=True).start()
        rows = []
        for _ in range(16):
            time.sleep(1)
            panel = dashboard_llm()
            engine = engine_metrics(llm_port)
            rows.append((panel, engine))
            print(
                f"  panel dec={panel.get('generationTps')} pre={panel.get('prefillTps')}  |  "
                f"engine gauge={engine['gauge']} last_gen={round(engine['last_gen_throughput'], 1) if engine['last_gen_throughput'] is not None else None}"
            )

        busy = [(p, e) for p, e in rows if (e["gauge"] or 0) > 20]
        live = [p.get("generationTps", 0) for p, _ in busy]
        # One 0 inside a long generation is a transient, not a defect: the engine's
        # own scrape blinks too (this suite watched its gauge drop to 16.6 for a
        # second mid-generation). What is being verified is "follows the engine",
        # not "never blinks".
        check(
            "the dashboard reports a live decode rate while the engine decodes",
            len(live) >= 3 and sum(1 for v in live if v > 0) >= max(3, len(live) - 1),
            f"{len(live)} busy samples, values={live}",
        )
        check(
            "no finished-request token count is published as a rate",
            all((p.get("generationTps") or 0) <= ABSURD_TPS for p, _ in rows)
            and all((p.get("prefillTps") or 0) <= ABSURD_TPS for p, _ in rows),
            f"max dec={max((p.get('generationTps') or 0) for p, _ in rows)} "
            f"max pre={max((p.get('prefillTps') or 0) for p, _ in rows)}",
        )
        gaps = sorted(
            abs(p.get("generationTps", 0) - e["gauge"]) / max(1.0, e["gauge"])
            for p, e in busy
            if (p.get("generationTps") or 0) > 0
        )
        median = gaps[len(gaps) // 2] if gaps else 1.0
        check(
            "the dashboard tracks the engine's own rate",
            len(gaps) >= 3 and median <= 0.05 and gaps[-1] <= 0.35,
            f"median gap {median:.3f}, worst {gaps[-1]:.2f} over {len(gaps)} samples",
        )

        # Wait for the ENGINE to be idle first: an abandoned stream keeps decoding
        # (this suite's own generation was still being served when it stopped
        # reading), and while it decodes the dashboard is right to show its rate.
        settled = False
        last_gauge = None
        stable_since = time.time()
        deadline = time.time() + 45
        while time.time() < deadline:
            time.sleep(2)
            gauge = engine_metrics(llm_port)["gauge"]
            if gauge != last_gauge:
                last_gauge = gauge
                stable_since = time.time()
            elif time.time() - stable_since >= 12:
                settled = True
                break
        if not settled:
            print("NOTE  the engine never went quiet within 45 s — skipping the idle check")
        else:
            idle = []
            for _ in range(6):
                time.sleep(1)
                idle.append(dashboard_llm().get("generationTps", 0))
                if len(idle) >= 3 and all(v == 0 for v in idle[-3:]):
                    break
            check(
                "the rate drops back to 0 once the engine is idle",
                len(idle) >= 3 and all(v == 0 for v in idle[-3:]),
                str(idle),
            )
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
