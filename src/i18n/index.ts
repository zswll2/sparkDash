/**
 * Minimal i18n layer for sparkDash.
 *
 * Source of truth: every user-visible string stays in English in the component
 * (`t("Settings")`). With the language setting on "zh" the Chinese dictionary
 * (./zh) is consulted; a string with no Chinese entry falls back to the English
 * source, so a partially translated build never shows blanks or raw keys.
 *
 * The language is a persisted server setting (config/settings.json → "language")
 * so one deployment shows the same language in every browser. localStorage only
 * remembers the last value as a hint, to avoid an English flash on first paint.
 */
import { useSyncExternalStore } from "react";
import { zh } from "./zh";

export type Language = "en" | "zh";

const STORAGE_KEY = "sparkdash-language";
const TABLES: Record<Language, Record<string, string>> = { en: {}, zh };

function normalize(language: Language | null | undefined): Language {
  return language === "zh" ? "zh" : "en";
}

function readHint(): Language {
  if (typeof localStorage === "undefined") return "en";
  try {
    return normalize(localStorage.getItem(STORAGE_KEY) as Language | null);
  } catch {
    return "en";
  }
}

function applyDocumentLang(language: Language): void {
  if (typeof document !== "undefined") {
    document.documentElement.setAttribute("lang", language === "zh" ? "zh-CN" : "en");
  }
}

let currentLanguage: Language = readHint();
/** Language last persisted by the server — what Cancel/close reverts to. */
let savedLanguage: Language = currentLanguage;
const listeners = new Set<() => void>();

applyDocumentLang(currentLanguage);

export function getLanguage(): Language {
  return currentLanguage;
}

/** Switch the displayed language (no-op when unchanged). */
export function setLanguage(next: Language | null | undefined): void {
  const language = normalize(next);
  if (language === currentLanguage) return;
  currentLanguage = language;
  applyDocumentLang(language);
  try {
    localStorage.setItem(STORAGE_KEY, language);
  } catch {
    /* storage disabled — the server setting still applies */
  }
  for (const listener of listeners) listener();
}

/** Apply the language that just came back from the server (load or save). */
export function setSavedLanguage(next: Language | null | undefined): void {
  savedLanguage = normalize(next);
  setLanguage(savedLanguage);
}

/** Undo an unsaved preview, e.g. Settings closed without Save. */
export function revertLanguage(): void {
  setLanguage(savedLanguage);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Subscribe to language changes so the calling tree re-renders. */
export function useLanguage(): Language {
  return useSyncExternalStore(subscribe, getLanguage, () => "en" as Language);
}

/**
 * Translate one English source string. An unknown key returns the English
 * source, so a missing entry degrades to English instead of a raw key.
 */
export function t(source: string): string {
  const table = TABLES[currentLanguage];
  const hit = table ? table[source] : undefined;
  return hit ?? source;
}

/** Translate with `{placeholder}` substitution: tr("Added {n}", { n: 3 }). */
export function tr(source: string, vars: Record<string, string | number>): string {
  return t(source).replace(/\{(\w+)\}/g, (match, key) =>
    key in vars ? String(vars[key]) : match
  );
}
