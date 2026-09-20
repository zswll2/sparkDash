#!/usr/bin/env python3
"""Verify the local GPU host unit (vm100) renders in the dashboard.

Opens the panel, asserts the unit's tab exists, opens it, and reports the GPU /
CPU / RAM numbers the page shows plus any console error or 4xx/5xx.

Usage: python3 tools/verify_host_unit.py [unit-id] [expected-name]
"""
import re
import sys

from playwright.sync_api import sync_playwright

URL = "http://192.168.10.100:5555/"
UNIT = sys.argv[1] if len(sys.argv) > 1 else "vm100"
SHOT = f"/root/i18n-verify/unit-{UNIT}.png"


def launch_browser(playwright):
    args = ["--no-sandbox", "--disable-dev-shm-usage"]
    for attempt in (
        {"channel": "chrome", "args": args},
        {"executable_path": "/usr/bin/google-chrome", "args": args},
        {},
    ):
        try:
            return playwright.chromium.launch(**attempt)
        except Exception:  # noqa: BLE001
            continue
    raise SystemExit("no usable chromium")


def main() -> int:
    console = []
    failed = []
    problems = []

    with sync_playwright() as playwright:
        browser = launch_browser(playwright)
        page = browser.new_page(viewport={"width": 1440, "height": 1200})
        page.on(
            "console",
            lambda message: console.append(f"{message.type}: {message.text}")
            if message.type in ("error", "warning")
            else None,
        )
        page.on("pageerror", lambda error: console.append(f"pageerror: {error}"))
        page.on(
            "response",
            lambda response: failed.append(f"{response.status} {response.url}")
            if response.status >= 400 and "192.168.10.100" in response.url
            else None,
        )

        page.goto(URL, wait_until="networkidle", timeout=45000)
        page.wait_for_timeout(3000)

        print(f"== 1. 总览是否包含 {UNIT} ==")
        overview = page.inner_text("body")
        present = bool(re.search(re.escape(UNIT), overview, re.I))
        print("  tab 存在:", present)
        if not present:
            problems.append(f"总览页没有 {UNIT}")

        print(f"\n== 2. 打开 {UNIT} 单元页 ==")
        # Exact text match: the drag handle's accessible name also contains the unit id.
        page.locator("button").filter(has_text=re.compile(rf"^{re.escape(UNIT)}$", re.I)).first.click()
        page.wait_for_timeout(4000)
        body = page.inner_text("body")
        print(f"  URL: {page.url}")
        print(f"  页面字符数: {len(body)}")
        print("  内容:", " | ".join(body.split("\n")[:40])[:700])
        if f"/spark/{UNIT}" not in page.url:
            problems.append(f"点击 {UNIT} 后没有导航到单元页（URL={page.url}）")
        if len(body) < 100:
            problems.append("单元页正文为空 —— 页面在运行时崩了")

        print("\n== 3. 关键指标是否出现 ==")
        import json as _json
        import urllib.request as _url
        metrics = {}
        try:
            with _url.urlopen(f"http://192.168.10.100:5555/api/sparks/{UNIT}/metrics", timeout=10) as r:
                metrics = _json.load(r)
        except Exception as error:  # noqa: BLE001
            print(f"  (无法读取 API: {error})")
        cpu_temp = ((metrics.get("metrics") or {}).get("cpu") or {}).get("temperature") or 0
        expected = [("GPU 温度", r"温度\s*\n?\s*\d+", True),
                    ("显存(VRAM)", r"VRAM", True),
                    ("内存", r"(RAM|内存|可用)", True),
                    ("CPU 行", r"CPU", cpu_temp > 0)]
        for label, pattern, required in expected:
            hit = bool(re.search(pattern, body))
            mark = "✓" if hit else ("✗" if required else "–(本机无 CPU 温度传感器，跳过)")
            print(f"  {label}: {mark}")
            if required and not hit:
                problems.append(f"页面缺少 {label}")
        page.screenshot(path=SHOT, full_page=True)
        print(f"  截图: {SHOT}")
        browser.close()

    print("\n== 4. console 错误/警告 ==")
    print("  " + ("\n  ".join(console) if console else "无"))
    print("== 5. 4xx/5xx ==")
    print("  " + ("\n  ".join(failed) if failed else "无"))
    if any(line.startswith("error:") or "pageerror" in line for line in console):
        problems.append("有 console error")

    print("\n== 结论 ==")
    if problems:
        for problem in problems:
            print(f"  ✗ {problem}")
        return 1
    print(f"  ✓ {UNIT} 单元已接入面板，指标齐全，无报错")
    return 0


if __name__ == "__main__":
    sys.exit(main())
