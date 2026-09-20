/**
 * Hand-written Chinese entries for strings the extractor cannot see.
 *
 * The extractor (tools/i18n-extract.mjs) collects every string it wraps plus any
 * string already written inside t("..."), so most entries belong in
 * tools/i18n-strings.json → zh.generated.ts. Keep here only what no extraction
 * pass can reach: canvas / share-card text, strings built at runtime, and
 * sentences assembled from several literals.
 *
 * Keys are the English source strings. Manual entries win over generated ones.
 */
export const zhManual: Record<string, string> = {};
