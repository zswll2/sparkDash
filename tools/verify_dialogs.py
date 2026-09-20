#!/usr/bin/env python3
"""Deeper dialog check: the Add Spark sheet must render Chinese too.

The Settings dialog is covered by tools/verify_i18n.py; dialogs opened from the
tab bar are a separate code path (modal-sheet + its own strings), so check one.

Usage: python3 tools/verify_dialogs.py
"""
import re
import sys

from playwright.sync_api import sync_playwright

URL = "http://192.168.10.100:5555/"
SHOT = "/root/i18n-verify/add-spark-dialog.png"
CJK = re.compile(r"[\u4e00-\u9fff]")


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
            if response.status >= 400
            else None,
        )

        page.goto(URL, wait_until="networkidle", timeout=45000)
        page.wait_for_timeout(2500)

        print("== 打开「新增 Spark」弹窗 ==")
        page.get_by_role(
            "button", name=re.compile("Add Spark|添加 Spark")
        ).first.click()
        page.wait_for_selector(".modal-sheet", timeout=10000)
        page.wait_for_timeout(800)
        sheet = page.inner_text(".modal-sheet")
        print(f"弹窗字符数: {len(sheet)}")
        print("弹窗内容(前 400):", sheet[:400].replace("\n", " | "))
        page.screenshot(path=SHOT, full_page=True)
        print("截图:", SHOT)

        chinese = len(CJK.findall(sheet))
        english_words = len(re.findall(r"[A-Za-z]{4,}", sheet))
        print(f"\n中文字符数: {chinese} | 英文单词数: {english_words}")

        problems = []
        if chinese == 0:
            problems.append("弹窗内没有中文 —— 该弹窗未接入翻译")
        if any("pageerror" in line or line.startswith("error:") for line in console):
            problems.append(f"console 有错误: {console[:2]}")

        browser.close()

    print("\nconsole 问题:", console or "无")
    print("4xx/5xx:", failed or "无")
    print("\n== 结论 ==")
    for problem in problems:
        print(f"  ✗ {problem}")
    if problems:
        return 1
    print("  ✓ 新增 Spark 弹窗已中文化，无控制台报错")
    return 0


if __name__ == "__main__":
    sys.exit(main())
