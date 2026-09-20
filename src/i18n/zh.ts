/**
 * Simplified Chinese dictionary.
 *
 * Two sources are merged here:
 *  - zh.generated.ts — every string wrapped by tools/i18n-extract.mjs plus its
 *    translation (regenerated; edit the translation files, not this one).
 *  - zh-manual.ts    — strings the extractor cannot see (canvas/share-card text,
 *    sentence fragments assembled at runtime, settings labels added by hand).
 * Manual entries win on a key collision.
 */
import { zhGenerated } from "./zh.generated";
import { zhManual } from "./zh-manual";

export const zh: Record<string, string> = { ...zhGenerated, ...zhManual };
