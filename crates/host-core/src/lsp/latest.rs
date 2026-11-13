//! The latest diagnostics of every open document, per tool, for consumers outside the editor
//! (the context MCP server, the Judge): they read diagnostics bound to one content hash.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::contracts::DocumentDiagnostics;

#[derive(Debug, Default)]
pub struct LatestDiagnostics {
    by_document: Mutex<HashMap<String, Vec<DocumentDiagnostics>>>,
}

impl LatestDiagnostics {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    fn table(&self) -> std::sync::MutexGuard<'_, HashMap<String, Vec<DocumentDiagnostics>>> {
        self.by_document
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Keeps `batch` unless a newer one from the same tool is already known. Batches of an
    /// earlier session generation of the document are dropped.
    pub fn record(&self, batch: DocumentDiagnostics) {
        let mut table = self.table();
        let batches = table.entry(batch.document_id.clone()).or_default();
        let newer_known = batches.iter().any(|known| {
            known.source == batch.source
                && (known.session_generation, known.base_revision)
                    > (batch.session_generation, batch.base_revision)
        });
        if newer_known {
            return;
        }
        batches.retain(|known| {
            known.source != batch.source && known.session_generation >= batch.session_generation
        });
        batches.push(batch);
    }

    /// The batches computed for the document's most recent content, one per tool. A tool that
    /// has not answered for that content yet is absent rather than reported with old results.
    #[must_use]
    pub fn current(&self, document_id: &str) -> Vec<DocumentDiagnostics> {
        let table = self.table();
        let Some(batches) = table.get(document_id) else {
            return Vec::new();
        };
        let Some(newest) = batches
            .iter()
            .max_by_key(|batch| (batch.session_generation, batch.base_revision))
        else {
            return Vec::new();
        };
        batches
            .iter()
            .filter(|batch| batch.content_blake3_hash == newest.content_blake3_hash)
            .cloned()
            .collect()
    }

    pub fn clear(&self) {
        self.table().clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::{DiagnosticSource, CONTRACT_SCHEMA_VERSION};

    fn batch(
        source: DiagnosticSource,
        generation: u32,
        revision: u32,
        hash: &str,
    ) -> DocumentDiagnostics {
        DocumentDiagnostics {
            schema_version: CONTRACT_SCHEMA_VERSION,
            document_id: "src/a.ts".into(),
            session_generation: generation,
            base_revision: revision,
            content_blake3_hash: hash.into(),
            source,
            items: Vec::new(),
        }
    }

    #[test]
    fn only_batches_for_the_newest_content_are_current() {
        let latest = LatestDiagnostics::new();
        latest.record(batch(DiagnosticSource::Biome, 1, 3, "h3"));
        latest.record(batch(DiagnosticSource::Vtsls, 1, 3, "h3"));
        assert_eq!(latest.current("src/a.ts").len(), 2);

        // Biome answers for revision 4 first: vtsls's revision-3 batch is not current any more.
        latest.record(batch(DiagnosticSource::Biome, 1, 4, "h4"));
        let current = latest.current("src/a.ts");
        assert_eq!(current.len(), 1);
        assert_eq!(current[0].source, DiagnosticSource::Biome);

        // A late batch for an older revision does not replace a newer one.
        latest.record(batch(DiagnosticSource::Biome, 1, 2, "h2"));
        assert_eq!(latest.current("src/a.ts")[0].base_revision, 4);

        // A new session generation drops what belonged to the previous one.
        latest.record(batch(DiagnosticSource::Vtsls, 2, 0, "g0"));
        let current = latest.current("src/a.ts");
        assert_eq!((current.len(), current[0].session_generation), (1, 2));
        assert!(latest.current("src/other.ts").is_empty());
    }
}
