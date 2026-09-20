# i18n tooling

The UI ships English source strings and an optional Simplified Chinese
dictionary. Every user-visible string is written as `t("English source")`; with
the `language` setting on `zh` the dictionary is consulted, and a string with no
entry falls back to English — so a partially translated build never shows blanks
or raw keys.

## Layout

| Path | Role |
|------|------|
| `src/i18n/index.ts` | `t()`, `tr()`, `setLanguage()`, `useLanguage()` — the runtime |
| `src/i18n/zh.ts` | merges the generated and manual dictionaries |
| `src/i18n/zh.generated.ts` | **generated** from `tools/i18n-strings.json` — never edit by hand |
| `src/i18n/zh-manual.ts` | hand-written entries for strings no extraction pass can reach |
| `tools/i18n-strings.json` | `{ "English source": "中文" }` — the翻译 source of truth |
| `server/settings.js` | persists `language: "en" \| "zh"` in `config/settings.json` |

## Workflow

```bash
npm run i18n:extract      # wrap new strings in t() + append them to i18n-strings.json
#   → fill the empty values in tools/i18n-strings.json with 中文
npm run i18n:build        # regenerate src/i18n/zh.generated.ts
npm run build             # vite build
```

`i18n:extract` is safe to re-run: strings already inside `t()` are left alone
(but still collected), existing translations are preserved, and only new keys
are appended. Wrap logic lives in `tools/i18n-extract.mjs`:

- JSX text children, text attributes (`title`, `aria-label`, `placeholder`, …)
  and string values in JSX child expressions
- HTML entities are decoded into the literal (`&apos;` → `'`) so those strings
  can be translated too
- `className`/`style` values, object keys, `.ts` files and tests are untouched

## Verification

```bash
python3 tools/verify_i18n.py      # real browser: render, en↔zh switch, save, persist
python3 tools/verify_dialogs.py   # real browser: one deep dialog is translated
```

Both drive Chrome through Playwright, fail on console errors or 4xx/5xx, and
write screenshots to `/root/i18n-verify/`. Run them after any dictionary change —
a missing `t` import or an unwrapped string shows up here and nowhere else.

## Notes

- Language names (`English`, `中文`) are intentionally **not** translated.
- Brand names stay English: sparkDash, DGX Spark, SGLang, vLLM, Hermes, ComfyUI,
  Tailscale, NVMe, GPU/RAM/VRAM/TTFT/tok/s …
- After merging upstream, re-run `i18n:extract` — new upstream strings arrive
  untranslated and fall back to English until someone fills them in.
- `@babel/parser` is a devDependency of the extractor: TypeScript 7 (the Go
  compiler) no longer exposes the JS compiler API.
