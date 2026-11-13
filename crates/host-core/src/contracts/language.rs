//! Language features answered by a language server for one exact document revision (`LOT-010`).
//!
//! Every answer names the revision it was computed for. Offsets into the requesting document
//! are UTF-16 offsets into the text of that revision: a consumer whose text has moved on must
//! discard the answer instead of applying it.

use super::*;

/// What is asked of the language server.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum LanguageFeature {
    Completion,
    Definition,
    References,
    Rename { new_name: String },
    Formatting,
}

/// A feature request about one position of one document revision. `revision` is the revision
/// the position refers to: the request fails if the Host is not at it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct LanguageFeatureRequest {
    pub document_id: String,
    pub session_generation: u32,
    pub revision: u32,
    pub position_utf16: Utf16CodeUnitOffset,
    pub feature: LanguageFeature,
}

/// A place in a file. `span_utf16` is only present for the requesting document, whose exact
/// text is known; other files are addressed by line and UTF-16 column. `file_path` is relative
/// to the workspace root, or absolute when the file is outside of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct LanguageLocation {
    pub file_path: String,
    pub inside_workspace: bool,
    pub start: LineCol,
    pub end: LineCol,
    pub span_utf16: Option<Utf16Span>,
}

/// A replacement in the requesting document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct LanguageTextEdit {
    pub span_utf16: Utf16Span,
    pub new_text: String,
}

/// One completion. `replace_span_utf16` is the text it replaces; `None` means "the word before
/// the cursor".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct LanguageCompletionItem {
    pub label: String,
    pub kind: String,
    pub detail: Option<String>,
    pub sort_text: String,
    pub filter_text: String,
    pub insert_text: String,
    pub replace_span_utf16: Option<Utf16Span>,
}

/// A replacement in a file other than the requesting document (a rename reaching it).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct LanguageFileEdit {
    pub start: LineCol,
    pub end: LineCol,
    pub new_text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct LanguageFileEdits {
    pub file_path: String,
    pub inside_workspace: bool,
    pub edits: Vec<LanguageFileEdit>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub enum LanguageFeatureResult {
    Completions {
        items: Vec<LanguageCompletionItem>,
        is_incomplete: bool,
    },
    Locations {
        locations: Vec<LanguageLocation>,
    },
    /// Edits of the requesting document (formatting), in ascending, non-overlapping order.
    Edits {
        edits: Vec<LanguageTextEdit>,
    },
    /// A rename: edits of the requesting document, plus the other files it reaches.
    Rename {
        edits: Vec<LanguageTextEdit>,
        other_files: Vec<LanguageFileEdits>,
    },
}

/// An answer, bound to the revision it was computed for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
pub struct LanguageFeatureResponse {
    pub schema_version: u16,
    pub document_id: String,
    pub session_generation: u32,
    pub base_revision: u32,
    pub content_blake3_hash: String,
    pub result: LanguageFeatureResult,
}
