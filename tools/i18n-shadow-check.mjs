#!/usr/bin/env node
/**
 * Guard for the i18n layer: a call to the translator that a local variable
 * shadows compiles fine and then throws "t is not a function" at runtime.
 *
 * The extractor wraps strings in t("..."); if any enclosing scope also declares
 * a variable named `t` (a common local name: `const t = setTimeout(...)`,
 * `(t) => ...`, `const t = gpu?.throttle`), that call hits the local value
 * instead of the import and the React tree unmounts — a blank page.
 *
 * Usage:
 *   node tools/i18n-shadow-check.mjs           report shadowed call sites
 *   node tools/i18n-shadow-check.mjs --fix     rename the local `t` to `tValue`
 *
 * Exit code 1 when anything is shadowed, so it can gate a release.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const FIX = process.argv.includes("--fix");

function listFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (["node_modules", "i18n", "testing", "__tests__"].includes(entry.name)) continue;
      listFiles(full, acc);
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (/\.d\.ts$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
    acc.push(full);
  }
  return acc;
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

/** Named declarations of `t` that a node introduces directly in its own scope. */
function declarationsOfT(node) {
  const names = [];
  const collect = (pattern) => {
    if (!pattern) return;
    if (pattern.type === "Identifier" && pattern.name === "t") names.push(pattern);
  };
  if (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  ) {
    for (const param of node.params) collect(param);
  }
  if (node.type === "CatchClause") collect(node.param);
  if (node.type === "VariableDeclaration") {
    for (const declarator of node.declarations) collect(declarator.id);
  }
  return names;
}

/** True when a `t(...)` call here resolves to a local binding, not the import. */
function isShadowed(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const node = ancestors[i];
    if (node.type === "BlockStatement" || node.type === "Program") {
      for (const statement of node.body ?? []) {
        if (statement.type === "VariableDeclaration" && declarationsOfT(statement).length) {
          return true;
        }
        // for (const t of ...) / for (let t in ...)
        if (
          (statement.type === "ForOfStatement" || statement.type === "ForInStatement") &&
          statement.left?.type === "VariableDeclaration" &&
          declarationsOfT(statement.left).length
        ) {
          return true;
        }
      }
      continue;
    }
    if (declarationsOfT(node).length) return true;
  }
  return false;
}

let problems = 0;
for (const file of listFiles(SRC)) {
  const source = fs.readFileSync(file, "utf8");
  let ast;
  try {
    ast = parse(source, { sourceType: "module", plugins: ["jsx", "typescript"] });
  } catch (error) {
    console.error(`SKIP ${path.relative(ROOT, file)}: ${error.message}`);
    continue;
  }

  const hits = [];
  walk(ast.program, [], (node, ancestors) => {
    if (
      node.type === "CallExpression" &&
      node.callee?.type === "Identifier" &&
      node.callee.name === "t" &&
      node.arguments?.[0]?.type === "StringLiteral" &&
      isShadowed(ancestors)
    ) {
      hits.push({ line: node.loc.start.line, text: source.slice(node.start, node.end) });
      // Record the nearest shadowing declarator for --fix
      for (let i = ancestors.length - 1; i >= 0; i--) {
        const found = declarationsOfT(ancestors[i]);
        if (found.length) {
          hits[hits.length - 1].declaration = found[0];
          break;
        }
      }
    }
  });

  if (!hits.length) continue;
  console.log(`${path.relative(ROOT, file)}`);
  for (const hit of hits) {
    console.log(`  L${hit.line}: ${hit.text.slice(0, 70)}`);
    problems++;
  }
  if (FIX) {
    // Rename the shadowing binding and every reference inside its own scope.
    const scope = hits.find((h) => h.declaration)?.declaration;
    if (scope) {
      const scopeNode = (() => {
        let found = null;
        walk(ast.program, [], (node) => {
          if (node.type === "VariableDeclarator" && node.start === scope.start) found = node;
        });
        return found;
      })();
      if (scopeNode) {
        const edits = [{ start: scope.start, end: scope.end, replacement: "tValue" }];
        const scopeRoot = scopeNode.init ?? scopeNode;
        walk(scopeRoot, [], (node) => {
          if (node.type === "Identifier" && node.name === "t" && node.start >= scopeRoot.start) {
            edits.push({ start: node.start, end: node.end, replacement: "tValue" });
          }
        });
        let next = source;
        for (const edit of edits.sort((a, b) => b.start - a.start)) {
          next = next.slice(0, edit.start) + edit.replacement + next.slice(edit.end);
        }
        fs.writeFileSync(file, next);
        console.log(`  → renamed the local t to tValue`);
      }
    }
  }
}

console.log(
  problems
    ? `\n${problems} shadowed t() call site(s) — these throw "t is not a function" at runtime`
    : "\nno shadowed t() call sites"
);
process.exit(problems ? 1 : 0);
