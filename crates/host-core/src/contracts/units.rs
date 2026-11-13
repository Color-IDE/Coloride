//! Explicit offset newtypes and spans: UTF-8 vs UTF-16 never mix (`LOT-002`).

use super::*;

// ============================================================================
// 1. Explicit Offset Newtypes & Spans (UTF-8 vs UTF-16 Separation)
// ============================================================================

/// Explicit UTF-8 byte offset used by Rust (`ropey::Rope`) and `Tree-sitter`.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize, TS,
)]
pub struct Utf8ByteOffset(pub u32);

impl Utf8ByteOffset {
    pub const ZERO: Self = Self(0);

    #[must_use]
    pub const fn new(offset: u32) -> Self {
        Self(offset)
    }

    #[must_use]
    pub const fn as_u32(self) -> u32 {
        self.0
    }

    #[must_use]
    pub const fn as_usize(self) -> usize {
        self.0 as usize
    }
}

/// Explicit UTF-16 code unit offset used by CodeMirror 6, LSP, and VS Code Extension Host.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize, TS,
)]
pub struct Utf16CodeUnitOffset(pub u32);

impl Utf16CodeUnitOffset {
    pub const ZERO: Self = Self(0);

    #[must_use]
    pub const fn new(offset: u32) -> Self {
        Self(offset)
    }

    #[must_use]
    pub const fn as_u32(self) -> u32 {
        self.0
    }

    #[must_use]
    pub const fn as_usize(self) -> usize {
        self.0 as usize
    }
}

/// Zero-based line and UTF-16 column coordinate.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize, TS,
)]
pub struct LineCol {
    pub line: u32,
    pub col_utf16: u32,
}

impl LineCol {
    #[must_use]
    pub const fn new(line: u32, col_utf16: u32) -> Self {
        Self { line, col_utf16 }
    }
}

/// Half-open UTF-8 byte span `[start, end)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize, TS)]
pub struct Utf8Span {
    pub start: Utf8ByteOffset,
    pub end: Utf8ByteOffset,
}

impl Utf8Span {
    #[must_use]
    pub const fn new(start: Utf8ByteOffset, end: Utf8ByteOffset) -> Self {
        Self { start, end }
    }

    #[must_use]
    pub const fn len_bytes(self) -> u32 {
        self.end.0.saturating_sub(self.start.0)
    }

    #[must_use]
    pub const fn is_empty(self) -> bool {
        self.start.0 >= self.end.0
    }
}

/// Half-open UTF-16 code unit span `[start, end)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize, TS)]
pub struct Utf16Span {
    pub start: Utf16CodeUnitOffset,
    pub end: Utf16CodeUnitOffset,
}

impl Utf16Span {
    #[must_use]
    pub const fn new(start: Utf16CodeUnitOffset, end: Utf16CodeUnitOffset) -> Self {
        Self { start, end }
    }

    #[must_use]
    pub const fn len_code_units(self) -> u32 {
        self.end.0.saturating_sub(self.start.0)
    }

    #[must_use]
    pub const fn is_empty(self) -> bool {
        self.start.0 >= self.end.0
    }
}
