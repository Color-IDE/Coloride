import type { ExcerptFreshness } from "@coloride/protocol-types";
import { isSecretBearingPath, redactSecretsInLine } from "../security/secrets.js";
import type { StoreContext } from "./context.js";
import type { DocumentBuffer } from "./documents.js";
import type { CockpitSearchResultItem, CockpitStoreBundle } from "./types.js";

/**
 * Instant lexical search (`LOT-008`) across the document buffers:
 * - unsaved in-memory buffers rank above disk snapshots (`LiveUnsavedBuffer` vs `IndexedCommit`);
 * - ACL exclusions (`.env`, `.pem`, `.key`) are skipped and secrets are redacted in excerpts.
 */
export function searchDocumentBuffers(
  buffers: ReadonlyMap<string, DocumentBuffer>,
  query: string,
): CockpitSearchResultItem[] {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (terms.length === 0) return [];

  const results: CockpitSearchResultItem[] = [];
  for (const [filePath, record] of buffers) {
    if (isSecretBearingPath(filePath)) {
      continue;
    }
    const lowerPath = filePath.toLowerCase();
    const lines = record.content.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      const { sanitized, redactedCount } = redactSecretsInLine(lines[idx] ?? "");
      const lowerLine = sanitized.toLowerCase();
      let matchedTerms = 0;
      for (const term of terms) {
        if (lowerLine.includes(term) || lowerPath.includes(term)) {
          matchedTerms += 1;
        }
      }
      if (matchedTerms === terms.length) {
        const freshness: ExcerptFreshness = record.unsaved ? "LiveUnsavedBuffer" : "IndexedCommit";
        results.push({
          filePath,
          line: idx + 1,
          snippet: sanitized.trim(),
          freshness,
          score: matchedTerms * 10 + (record.unsaved ? 5 : 0),
          secretsRedacted: redactedCount,
        });
      }
    }
  }
  results.sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath));
  return results;
}

type SearchActions = Pick<CockpitStoreBundle, "runGlobalSearch" | "setGlobalSearchResults">;

export function createSearchActions(ctx: StoreContext): SearchActions {
  const { zone2, documents } = ctx;
  return {
    runGlobalSearch(query: string): readonly CockpitSearchResultItem[] {
      const results = searchDocumentBuffers(documents, query);
      zone2.setState((prev) => ({
        ...prev,
        searchQuery: query.trim() ? query : "",
        searchResults: results,
      }));
      return results;
    },

    setGlobalSearchResults(query: string, results: readonly CockpitSearchResultItem[]): void {
      zone2.setState((prev) => ({
        ...prev,
        searchQuery: query,
        searchResults: results,
      }));
    },
  };
}
