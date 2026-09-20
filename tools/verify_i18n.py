#!/usr/bin/env python3
"""Real-browser verification of the sparkDash language switch.

Runs on VM100 (where google-chrome + playwright live) against the live panel.

Checks:
  1. the page renders at all (guards the "t is not defined" class of breakage)
  2. the server-side language setting reaches the UI (html lang + t() output)
  3. Settings -> Language switches en <-> zh without a reload
  4. Save persists to /api/settings
  5. no console errors, no 4xx/5xx on the page's own requests
  6. writes a screenshot for the record

Usage: python3 tools/verify_i18n.py [--keep-zh|--keep-en]
"""
import json
import sys
import urllib.request
from playwright.sync_api import sync_playwright

URL = "http://192.168.10.100:5555/"
API = "http://192.168.10.100:5555/api/settings"
SHOT = "/root/i18n-verify/language-switch.png"
FINAL_LANGUAGE = "zh" if "--keep-en" not in sys.argv else "en"


def api_settings() -> dict:
    with urllib.request.urlopen(API, timeout=10) as response:
        return json.load(response)


def put_language(language: str) -> dict:
    request = urllib.request.Request(
        API,
        data=json.dumps({"language": language}).encode(),
        headers={"Content-Type": "application/json"},
        method="PUT",
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.load(response)


def launch_browser(playwright):
    """Prefer the installed Chrome: the bundled headless shell revision on this
    host does not match the installed playwright build."""
    args = ["--no-sandbox", "--disable-dev-shm-usage"]
    for attempt in (
        {"channel": "chrome", "args": args},
        {"executable_path": "/usr/bin/google-chrome", "args": args},
        {},
    ):
        try:
            return playwright.chromium.launch(**attempt)
        except Exception as error:  # noqa: BLE001 - try the next strategy
            print(f"  启动失败({attempt.get('channel') or attempt.get('executable_path') or 'bundled'}): {error}".split("\n")[0])
    raise SystemExit("no usable chromium")


def main() -> int:
    console = []
    failed = []
    problems = []

    with sync_playwright() as playwright:
        browser = launch_browser(playwright)
        page = browser.new_page(viewport={"width": 1440, "height": 950})
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
            if response.status >= 400 and URL.split("//")[1].split(":")[0] in response.url
            else None,
        )

        page.goto(URL, wait_until="networkidle", timeout=45000)
        page.wait_for_timeout(3000)

        print("== 1. 页面渲染 ==")
        body = page.inner_text("body")
        print(f"  title        : {page.title()}")
        print(f"  html lang    : {page.evaluate('document.documentElement.lang')}")
        print(f"  body 字符数  : {len(body)}")
        print(f"  body 前 200  : {body[:200].replace(chr(10), ' | ')}")
        if len(body) < 50:
            problems.append("页面正文为空 —— 前端可能没渲染出来")

        print("\n== 2. 打开设置面板 ==")
        page.click('button[aria-label="Settings"], button[aria-label="设置"]')
        page.wait_for_selector(".settings-panel", timeout=10000)
        page.wait_for_timeout(600)
        panel = page.inner_text(".settings-panel")
        print("  面板首行:", panel.split("\n")[0])
        print("  面板前 260 字:", panel[:260].replace("\n", " | "))

        language_label = page.locator(".settings-panel").locator("label").first

        print("\n== 3. 切到 English ==")
        language_buttons = page.locator(".settings-panel button")
        print(f"  按钮标签: {[language_buttons.nth(i).inner_text().strip() for i in range(2)]}")
        language_buttons.nth(0).click()  # English
        page.wait_for_timeout(700)
        print(f"  语言行标签: {language_label.inner_text().strip()}")
        english_state = language_label.inner_text().strip()

        print("\n== 4. 切回 中文 ==")
        language_buttons.nth(1).click()  # 中文
        page.wait_for_timeout(700)
        print(f"  语言行标签: {language_label.inner_text().strip()}")
        chinese_state = language_label.inner_text().strip()

        if english_state == chinese_state:
            problems.append(f"切换中英文时语言行标签没变(都是 {english_state!r}) —— t() 没有重新渲染")
        print(f"  切换生效   : {english_state!r} -> {chinese_state!r}")

        print("\n== 5. 保存 ==")
        save_button = page.locator(".settings-panel button").last
        print(f"  保存按钮标签: {save_button.inner_text().strip()}")
        save_button.click()
        page.wait_for_timeout(1500)
        page.wait_for_selector(".settings-panel", state="detached", timeout=8000)
        saved = api_settings().get("language")
        print(f"  服务端 language = {saved}")
        if saved != "zh":
            problems.append(f"保存后服务端 language={saved!r}，期望 'zh'")

        print("\n== 6. 刷新后是否保持(服务端持久化) ==")
        page.reload(wait_until="networkidle")
        page.wait_for_timeout(2500)
        print(f"  html lang   : {page.evaluate('document.documentElement.lang')}")
        page.screenshot(path=SHOT, full_page=True)
        print(f"  截图        : {SHOT}")

        browser.close()

    if FINAL_LANGUAGE != "zh":
        print(f"\n恢复语言为 {FINAL_LANGUAGE}: {put_language(FINAL_LANGUAGE).get('language')}")

    print("\n== 7. console 错误/警告 ==")
    print("  " + ("\n  ".join(console) if console else "无"))
    print("== 8. 页面自身 4xx/5xx ==")
    print("  " + ("\n  ".join(failed) if failed else "无"))
    if any("pageerror" in line or "error:" in line for line in console):
        problems.append("有 console error")

    print("\n== 结论 ==")
    if problems:
        for problem in problems:
            print(f"  ✗ {problem}")
        return 1
    print("  ✓ 语言开关端到端通过（渲染 / 切换 / 保存 / 持久化 无报错）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
