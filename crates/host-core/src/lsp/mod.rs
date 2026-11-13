//! Language servers supervised by the Host (`LOT-010`): JSON-RPC over stdio, document
//! synchronization from `ropey` buffers, and revision-tagged diagnostics.

mod client;
mod features;
mod services;
mod session;
mod transport;
mod uri;

pub use client::{LspClient, LspError, NotificationHandler, PendingRequest};
pub use services::{
    biome_server_spec, language_id_for_path, resolve_workspace_tool, tsgo_server_spec,
    vtsls_server_spec, LanguageServerSpec, LanguageServices,
};
pub use session::{
    DiagnosticsMode, DiagnosticsSink, DocumentRef, LanguageServerProfile, LanguageServerSession,
};
pub use transport::{read_message, write_message};
pub use uri::{file_uri_to_path, path_to_file_uri};
