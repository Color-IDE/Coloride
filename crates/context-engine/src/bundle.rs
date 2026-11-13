//! Token-bounded, destination-authorized context assembly (LOT-009).
use std::collections::BTreeSet;

use host_core::{AuthorizedDestination, ConfidenceLevel, ContextBundle, ExcerptFreshness};
use serde::{Deserialize, Serialize};

use crate::{ContextSearchHit, SqliteWalContextEngine};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RetrievalMode {
    LexicalAndAstOnly,
    HybridVector,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum VectorState {
    Disabled,
    Building,
    Ready,
    Stale,
    Failed { reason: String },
}

pub(crate) enum VectorRetrieval {
    #[cfg(feature = "vector")]
    Available {
        hits: Vec<ContextSearchHit>,
        updating: bool,
    },
    Unavailable(VectorState),
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AssembledContextBundle {
    pub bundle: ContextBundle,
    pub retrieval_mode: RetrievalMode,
    pub vector_state: VectorState,
    pub degradation_reason: Option<String>,
    /// Explicit conservative accounting; this is not a model-tokenizer token count.
    pub token_accounting: String,
    pub prompt_format: String,
    /// Stable excerpts occupy this prefix of `bundle.excerpts`; text is transmitted once.
    pub cache_prefix_excerpt_count: usize,
}
impl AssembledContextBundle {
    pub fn render_prompt(&self) -> String {
        self.bundle
            .excerpts
            .iter()
            .map(|e| envelope(e) + "\n")
            .collect()
    }
}

/// Policy is configured by the host, never by an MCP request.
#[derive(Debug, Clone)]
pub struct ContextBundleAssembler {
    allowed_destinations: Vec<AuthorizedDestination>,
}

impl Default for ContextBundleAssembler {
    fn default() -> Self {
        Self::new(vec![AuthorizedDestination::LocalOnly])
    }
}

impl ContextBundleAssembler {
    pub fn new(allowed_destinations: Vec<AuthorizedDestination>) -> Self {
        Self {
            allowed_destinations,
        }
    }

    pub fn assemble(
        &self,
        engine: &mut SqliteWalContextEngine,
        query: &str,
        budget: Option<u32>,
        destination: AuthorizedDestination,
    ) -> Result<AssembledContextBundle, String> {
        self.assemble_hits(
            engine,
            query,
            budget,
            destination,
            VectorRetrieval::Unavailable(VectorState::Disabled),
        )
    }

    pub(crate) fn assemble_hits(
        &self,
        engine: &mut SqliteWalContextEngine,
        query: &str,
        budget: Option<u32>,
        destination: AuthorizedDestination,
        retrieval: VectorRetrieval,
    ) -> Result<AssembledContextBundle, String> {
        if !self.allowed_destinations.contains(&destination) {
            return Err("Context export destination is not authorized by workspace policy".into());
        }
        let (extra_hits, retrieval_mode, vector_state, degradation_reason) = match retrieval {
            #[cfg(feature = "vector")]
            VectorRetrieval::Available { hits, updating } => (
                hits,
                RetrievalMode::HybridVector,
                if updating {
                    VectorState::Building
                } else {
                    VectorState::Ready
                },
                None,
            ),
            VectorRetrieval::Unavailable(state) => {
                let reason = match &state {
                    VectorState::Failed { reason } => reason.clone(),
                    other => format!("Vector retrieval {other:?}"),
                };
                (
                    Vec::<ContextSearchHit>::new(),
                    RetrievalMode::LexicalAndAstOnly,
                    state,
                    Some(reason),
                )
            }
        };
        let budget = budget.unwrap_or(16_000).min(1_000_000);
        let mut hits = engine.query_hybrid(query, 256);
        // Reciprocal rank fusion keeps BM25, graph proximity and cosine distances
        // comparable without depending on their unrelated numeric scales.
        let mut graph_order = (0..hits.len()).collect::<Vec<_>>();
        graph_order.sort_by(|a, b| {
            hits[*b]
                .graph_boost
                .total_cmp(&hits[*a].graph_boost)
                .then(a.cmp(b))
        });
        let mut graph_ranks = vec![0; hits.len()];
        for (rank, index) in graph_order.into_iter().enumerate() {
            graph_ranks[index] = rank;
        }
        for (rank, hit) in hits.iter_mut().enumerate() {
            hit.combined_score = 1.0 / (60.0 + rank as f64 + 1.0)
                + if hit.graph_boost > 0.0 {
                    1.0 / (60.0 + graph_ranks[rank] as f64 + 1.0)
                } else {
                    0.0
                };
        }
        for (rank, mut hit) in extra_hits.into_iter().enumerate() {
            let score = 1.0 / (60.0 + rank as f64 + 1.0);
            if let Some(existing) = hits.iter_mut().find(|existing| {
                existing.excerpt.source_path == hit.excerpt.source_path
                    && existing.excerpt.span_utf8 == hit.excerpt.span_utf8
                    && existing.excerpt.content_blake3_hash == hit.excerpt.content_blake3_hash
            }) {
                existing.combined_score += score;
            } else {
                hit.combined_score = score;
                hits.push(hit);
            }
        }
        hits.sort_by(|a, b| {
            b.combined_score
                .total_cmp(&a.combined_score)
                .then_with(|| a.excerpt.source_path.cmp(&b.excerpt.source_path))
                .then_with(|| a.excerpt.span_utf8.start.cmp(&b.excerpt.span_utf8.start))
        });
        let mut seen = BTreeSet::new();
        let mut excerpts = Vec::new();
        let mut used = 0u32;
        for hit in hits {
            let mut excerpt = hit.excerpt;
            if !seen.insert((
                excerpt.source_path.clone(),
                excerpt.content_blake3_hash.clone(),
                excerpt.span_utf8.start.0,
                excerpt.span_utf8.end.0,
            )) {
                continue;
            }
            if engine
                .scanner()
                .check_path_acl(&excerpt.source_path)
                .is_err()
            {
                continue;
            }
            excerpt.content = engine
                .scanner_mut()
                .sanitize_text(&excerpt.source_path, &excerpt.content)
                .sanitized_text;
            if engine
                .impact_analyzer()
                .files()
                .get(&excerpt.source_path)
                .is_some_and(|f| f.has_syntax_error)
            {
                excerpt.confidence = ConfidenceLevel::HeuristicText;
            }
            // UTF-8 byte count is a conservative upper bound for byte-level tokenizers.
            // Count the entire serialized data envelope, including provenance and escaping.
            let encoded = envelope(&excerpt);
            let cost = u32::try_from(encoded.len() + 1).unwrap_or(u32::MAX);
            if cost > budget.saturating_sub(used) {
                continue;
            }
            used += cost;
            excerpts.push(excerpt);
        }
        // Persisted excerpts precede live edits, so edits do not reorder the stable cache prefix.
        excerpts.sort_by(|a, b| {
            let live = |f| matches!(f, ExcerptFreshness::LiveUnsavedBuffer);
            live(a.freshness)
                .cmp(&live(b.freshness))
                .then_with(|| a.source_path.cmp(&b.source_path))
                .then_with(|| a.span_utf8.start.cmp(&b.span_utf8.start))
        });
        let mut prompt = String::new();
        let mut prefix = String::new();
        for excerpt in &excerpts {
            let text = envelope(excerpt) + "\n";
            if excerpt.freshness != ExcerptFreshness::LiveUnsavedBuffer {
                prefix.push_str(&text);
            }
            prompt.push_str(&text);
        }
        let cache_prefix_excerpt_count = excerpts
            .iter()
            .take_while(|e| e.freshness != ExcerptFreshness::LiveUnsavedBuffer)
            .count();
        let bundle = ContextBundle {
            schema_version: host_core::CONTRACT_SCHEMA_VERSION,
            bundle_id: blake3::hash(prompt.as_bytes()).to_hex().to_string(),
            workspace_version: engine.active_git_branch().into(),
            classification: if prompt.contains(crate::REDACTED_SECRET_MARKER) {
                host_core::DataClassification::RestrictedFiltered
            } else {
                host_core::DataClassification::Internal
            },
            excerpts,
            token_budget_max: budget,
            token_budget_used: used,
            authorized_destination: destination,
            // Cache identity, not a second copy of source text.
            cache_control_prefix: Some(blake3::hash(prefix.as_bytes()).to_hex().to_string()),
        };
        Ok(AssembledContextBundle {
            bundle,
            retrieval_mode,
            vector_state,
            degradation_reason,
            token_accounting: "ConservativeUtf8BytesUpperBound".into(),
            prompt_format: "UntrustedSourceExcerptJsonLinesV1".into(),
            cache_prefix_excerpt_count,
        })
    }
}

fn envelope(excerpt: &host_core::ContextExcerpt) -> String {
    serde_json::json!({"type":"untrusted_source_excerpt", "provenance": excerpt}).to_string()
}

#[cfg(all(test, feature = "vector"))]
mod tests {
    use super::*;
    #[test]
    fn ready_vectors_with_zero_hits_are_still_hybrid() {
        let dir = tempfile::tempdir().unwrap();
        let mut engine = SqliteWalContextEngine::open(
            dir.path().join("index"),
            "main",
            crate::AclAndSecretScanner::new(),
        )
        .unwrap();
        let bundle = ContextBundleAssembler::default()
            .assemble_hits(
                &mut engine,
                "absent",
                None,
                AuthorizedDestination::LocalOnly,
                VectorRetrieval::Available {
                    hits: Vec::new(),
                    updating: false,
                },
            )
            .unwrap();
        assert_eq!(bundle.retrieval_mode, RetrievalMode::HybridVector);
        assert_eq!(bundle.vector_state, VectorState::Ready);
        assert!(bundle.degradation_reason.is_none());
    }
}
