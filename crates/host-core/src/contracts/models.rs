//! Contract #5: `ModelProvider` and its capabilities.

use super::*;

// ============================================================================
// 7. Contract #5 — ModelProvider
// ============================================================================

/// Execution backend category for a model or external ACP agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
pub enum ModelProviderKind {
    LocalLlamaCpp,
    LocalOllama,
    ByokCloud,
    ManagedColorideCloud,
    PrivateVllm,
    AcpExternalAgent,
}

/// Declared static capabilities of a model provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ModelCapabilities {
    pub supports_streaming: bool,
    pub supports_structured_tool_calls: bool,
    pub supports_prompt_caching: bool,
    pub max_context_tokens: u32,
    pub max_output_tokens: u32,
}

/// Token consumption, latency, and cost metrics for a model invocation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
pub struct ModelUsageMetrics {
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub cached_input_tokens: u32,
    pub latency_ms: u32,
    pub cost_usd_micros: u32,
}

/// Contract #5: Model provider descriptor, capabilities, cancellation token, and usage metrics.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct ModelProvider {
    pub schema_version: u16,
    pub provider_id: String,
    pub model_name: String,
    pub kind: ModelProviderKind,
    pub capabilities: ModelCapabilities,
    pub streaming_enabled: bool,
    pub structured_tool_calls: bool,
    pub cancellation_token_id: String,
    pub usage_metrics: ModelUsageMetrics,
}
