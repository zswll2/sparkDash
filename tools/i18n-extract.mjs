#!/usr/bin/env node
/**
 * i18n extractor for sparkDash.
 *
 * Rewrites src/**\/*.tsx in place so user-visible strings go through t("..."),
 * and collects every wrapped string into tools/i18n-strings.json for translation.
 *
 * What it wraps:
 *   - JSX text children            (<p>Uptime</p>   -> <p>{t("Uptime")}</p>)
 *   - text attributes              (title="Settings" -> title={t("Settings")})
 *   - string values in JSX children expressions ({cond ? "Online" : "Offline"})
 *
 * What it leaves alone: className/style values, object keys, code identifiers,
 * strings already inside t()/tr(), tests, and the i18n directory itself.
 *
 * A string with no Chinese entry falls back to English at runtime, so extraction
 * need not be perfect in one pass — re-run it any time; existing keys keep their
 * translation and only new strings are appended.
 *
 * Usage:  node tools/i18n-extract.mjs [--check]
 *
 * Note: TypeScript 7 (the Go compiler) no longer ships the JS compiler API, so
 * this uses @babel/parser (devDependency) purely as a parser.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const STRINGS_PATH = path.join(ROOT, "tools", "i18n-strings.json");
const CHECK_ONLY = process.argv.includes("--check");

/** Attributes whose value is shown to the user. */
const TEXT_ATTRS = new Set([
  "title",
  "aria-label",
  "placeholder",
  "alt",
  "label",
  "description",
  "tooltip",
  "caption",
]);

const WRAPPERS = new Set(["t", "tr"]);
const SKIP_DIRS = new Set(["node_modules", "i18n", "testing", "__tests__"]);

function listTsxFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      listTsxFiles(full, acc);
      continue;
    }
    if (!entry.name.endsWith(".tsx")) continue;
    if (entry.name.endsWith(".test.tsx")) continue;
    acc.push(full);
  }
  return acc;
}

/** JSX entities that are safe to decode into a plain string literal. */
const ENTITIES = new Map([
  ["&apos;", "'"],
  ["&#39;", "'"],
  ["&quot;", '"'],
  ["&#34;", '"'],
  ["&amp;", "&"],
  ["&lt;", "<"],
  ["&gt;", ">"],
  ["&nbsp;", "\u00a0"],
  ["&mdash;", "\u2014"],
  ["&ndash;", "\u2013"],
  ["&hellip;", "\u2026"],
  ["&times;", "\u00d7"],
  ["&minus;", "\u2212"],
  ["&deg;", "\u00b0"],
  ["&rarr;", "\u2192"],
  ["&larr;", "\u2190"],
  ["&middot;", "\u00b7"],
]);

function decodeEntities(text) {
  return text.replace(/&[a-zA-Z]+;|&#\d+;/g, (match) => ENTITIES.get(match) ?? match);
}

function walk(node, ancestors, visit) {
  visit(node, ancestors);
  const next = ancestors.concat(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc" || key === "start" || key === "end" || key === "extra") continue;
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child.type === "string") walk(child, next, visit);
      }
    } else if (value && typeof value.type === "string") {
      walk(value, next, visit);
    }
  }
}

/** True when the literal is already an argument of t(...)/tr(...). */
function isAlreadyWrapped(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const node = ancestors[i];
    if (node.type === "CallExpression" && node.callee?.type === "Identifier") {
      if (WRAPPERS.has(node.callee.name)) return true;
    }
    if (node.type === "JSXExpressionContainer" || node.type.endsWith("Statement")) {
      return false;
    }
  }
  return false;
}

/**
 * True when the literal ends up as text in the DOM: a JSX child, or the value of
 * a text attribute. Ternary/logical/array plumbing in between is fine; object
 * and array props, className and style are not.
 */
function isDisplayedLiteral(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const node = ancestors[i];
    if (node.type === "JSXExpressionContainer") {
      const holder = ancestors[i - 1];
      if (holder?.type === "JSXAttribute") {
        return TEXT_ATTRS.has(holder.name?.name);
      }
      return true; // JSX child expression
    }
    if (node.type === "ConditionalExpression" || node.type === "ParenthesizedExpression") {
      continue;
    }
    if (node.type === "LogicalExpression") {
      if (node.operator === "&&" || node.operator === "||") continue;
      return false;
    }
    if (node.type === "ArrayExpression") continue;
    return false;
  }
  return false;
}

function relativeI18nPath(file) {
  const rel = path
    .relative(path.dirname(file), path.join(SRC, "i18n"))
    .replace(/\\/g, "/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function extractFile(file, strings) {
  const source = fs.readFileSync(file, "utf8");
  const sourceFile = parse(source, {
    sourceType: "module",
    plugins: ["jsx", "typescript"],
  });
  const edits = [];

  const add = (key, start, end, replacement) => {
    if (!key) return;
    if (!strings.has(key)) strings.set(key, "");
    edits.push({ start, end, replacement });
  };

  walk(sourceFile.program, [], (node, ancestors) => {
    // <p>Uptime</p>
    if (node.type === "JSXText") {
      const raw = source.slice(node.start, node.end);
      const decoded = decodeEntities(raw);
      // Braces and angle brackets would not survive a string literal.
      if (/[<>{}]/.test(decoded.trim())) return;
      const collapsed = decoded.replace(/\s+/g, " ").trim();
      if (collapsed.length < 2 || !/[A-Za-z]/.test(collapsed)) return;
      const leading = raw.match(/^\s*/)[0];
      const trailing = raw.match(/\s*$/)[0];
      add(
        collapsed,
        node.start,
        node.end,
        `${leading}{t(${JSON.stringify(collapsed)})}${trailing}`
      );
      return;
    }

    // title="Settings" / aria-label="Close"
    if (node.type === "JSXAttribute") {
      const name = node.name?.name;
      if (TEXT_ATTRS.has(name) && node.value?.type === "StringLiteral") {
        const text = node.value.value;
        if (text.trim() && /[A-Za-z]/.test(text)) {
          add(text, node.value.start, node.value.end, `{t(${JSON.stringify(text)})}`);
        }
      }
      return;
    }

    // {"Online"} / {cond ? "Online" : "Offline"} / {busy && "Saving…"}
    if (node.type === "StringLiteral") {
      const text = node.value;
      if (!text.trim() || !/[A-Za-z]/.test(text)) return;
      if (isAlreadyWrapped(ancestors)) {
        // Written by hand as t("...") — already translated in place, but it still
        // needs a dictionary entry, otherwise it can never be translated.
        if (!strings.has(text)) strings.set(text, "");
        return;
      }
      if (isDisplayedLiteral(ancestors)) {
        add(text, node.start, node.end, `t(${JSON.stringify(text)})`);
      }
    }
  });

  // Ensure the module imports t when it calls it. Merging into an existing
  // import from ./i18n matters: a file that already imports something else from
  // that path must still get t, or the bundle throws "t is not defined".
  const called = new Set();
  walk(sourceFile.program, [], (node) => {
    if (node.type === "CallExpression" && node.callee?.type === "Identifier") {
      called.add(node.callee.name);
    }
  });
  if (called.has("t")) {
    const importPath = relativeI18nPath(file);
    const decl = sourceFile.program.body.find(
      (node) => node.type === "ImportDeclaration" && node.source.value === importPath
    );
    const importsT = Boolean(
      decl?.specifiers?.some(
        (spec) => spec.type === "ImportSpecifier" && spec.imported?.name === "t"
      )
    );
    if (!importsT) {
      if (decl?.specifiers?.length) {
        const first = decl.specifiers[0];
        edits.push({ start: first.start, end: first.start, replacement: "t, " });
      } else if (decl) {
        edits.push({ start: decl.source.start, end: decl.source.start, replacement: "t " });
      } else {
        const lastImport = sourceFile.program.body
          .filter((node) => node.type === "ImportDeclaration")
          .pop();
        const insertAt = lastImport ? lastImport.end : 0;
        edits.push({
          start: insertAt,
          end: insertAt,
          replacement: `\nimport { t } from "${importPath}";`,
        });
      }
    }
  }

  if (edits.length === 0) return { file, wrapped: 0 };

  let next = source;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    next = next.slice(0, edit.start) + edit.replacement + next.slice(edit.end);
  }

  if (!CHECK_ONLY) fs.writeFileSync(file, next);
  return { file, wrapped: edits.length };
}

function main() {
  const strings = new Map();
  if (fs.existsSync(STRINGS_PATH)) {
    for (const [key, value] of Object.entries(
      JSON.parse(fs.readFileSync(STRINGS_PATH, "utf8"))
    )) {
      strings.set(key, value);
    }
  }
  const before = new Set(strings.keys());

  const files = listTsxFiles(SRC);
  const touched = [];
  let totalWrapped = 0;
  for (const file of files) {
    let result;
    try {
      result = extractFile(file, strings);
    } catch (err) {
      console.error(`SKIP ${path.relative(ROOT, file)}: ${err.message}`);
      continue;
    }
    if (result.wrapped > 0) {
      touched.push(result);
      totalWrapped += result.wrapped;
    }
  }

  if (!CHECK_ONLY) {
    const sorted = {};
    for (const key of [...strings.keys()].sort((a, b) => a.localeCompare(b))) {
      sorted[key] = strings.get(key);
    }
    fs.writeFileSync(STRINGS_PATH, JSON.stringify(sorted, null, 2) + "\n");
  }

  const added = [...strings.keys()].filter((key) => !before.has(key));
  console.log(
    `${CHECK_ONLY ? "[check] " : ""}tsx files: ${files.length}, touched: ${touched.length}, ` +
      `wrapped: ${totalWrapped}, new keys: ${added.length}, total keys: ${strings.size}`
  );
  for (const entry of touched.slice(0, 15)) {
    console.log(`  ${path.relative(ROOT, entry.file)} (${entry.wrapped})`);
  }
  if (touched.length > 15) console.log(`  … and ${touched.length - 15} more files`);
}

main();
