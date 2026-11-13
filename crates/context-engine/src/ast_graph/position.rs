//! Byte/point coordinates, `InputEdit`s and the zero-copy `ropey` text provider (`LOT-007`).

use super::*;

/// Zero-based `(row, column)` byte coordinate matching `tree_sitter::Point`.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default, Serialize, Deserialize,
)]
pub struct Point {
    pub row: u32,
    pub column: u32,
}

impl Point {
    #[must_use]
    pub const fn new(row: u32, column: u32) -> Self {
        Self { row, column }
    }
}

/// Incremental UTF-8 byte & point delta matching `tree_sitter::InputEdit` (`LOT-007`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct InputEdit {
    pub start_byte: Utf8ByteOffset,
    pub old_end_byte: Utf8ByteOffset,
    pub new_end_byte: Utf8ByteOffset,
    pub start_position: Point,
    pub old_end_position: Point,
    pub new_end_position: Point,
}

/// Languages supported by the incremental AST parser in `LOT-007`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum SupportedAstLanguage {
    TypeScript,
    Tsx,
    JavaScript,
    Json,
    Css,
}

impl SupportedAstLanguage {
    #[must_use]
    pub fn from_path(path: &str) -> Self {
        let lower = path.to_ascii_lowercase();
        if lower.ends_with(".tsx") || lower.ends_with(".jsx") {
            Self::Tsx
        } else if lower.ends_with(".js") || lower.ends_with(".mjs") || lower.ends_with(".cjs") {
            Self::JavaScript
        } else if lower.ends_with(".json") {
            Self::Json
        } else if lower.ends_with(".css") {
            Self::Css
        } else {
            Self::TypeScript
        }
    }
}

/// Zero-copy chunk provider reading directly from `ropey::Rope` without contiguous full-buffer allocation.
pub struct RopeTextProvider<'a> {
    rope: &'a Rope,
}

impl<'a> RopeTextProvider<'a> {
    #[must_use]
    pub const fn new(rope: &'a Rope) -> Self {
        Self { rope }
    }

    #[must_use]
    pub const fn rope(&self) -> &'a Rope {
        self.rope
    }

    #[must_use]
    pub fn len_bytes(&self) -> usize {
        self.rope.len_bytes()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.rope.len_bytes() == 0
    }

    /// Iterate over raw `&str` chunks from `ropey::Rope` intersecting `[start_byte, end_byte)`
    /// without copying the whole document into a contiguous `String`.
    pub fn chunks_in_byte_range(
        &self,
        start_byte: usize,
        end_byte: usize,
    ) -> impl Iterator<Item = &'a str> {
        let clamped_end = end_byte.min(self.rope.len_bytes());
        let clamped_start = start_byte.min(clamped_end);
        self.rope.byte_slice(clamped_start..clamped_end).chunks()
    }

    /// Read a specific line by index (`0..len_lines()`) without copying the full rope.
    #[must_use]
    pub fn line_text_trimmed_newline(&self, line_idx: usize) -> String {
        let slice = self.rope.line(line_idx);
        let mut s = String::with_capacity(slice.len_bytes());
        for chunk in slice.chunks() {
            s.push_str(chunk);
        }
        if s.ends_with('\n') {
            s.pop();
            if s.ends_with('\r') {
                s.pop();
            }
        }
        s
    }
}

/// Compute `Point { row, column }` (in UTF-8 column bytes) for a byte offset using `ropey::Rope` metrics.
#[must_use]
pub fn byte_offset_to_point(rope: &Rope, byte_offset: usize) -> Point {
    let clamped = byte_offset.min(rope.len_bytes());
    let line_idx = rope.byte_to_line(clamped);
    let line_start_byte = rope.line_to_byte(line_idx);
    Point {
        row: line_idx as u32,
        column: (clamped - line_start_byte) as u32,
    }
}

/// Advance a `Point` by scanning a UTF-8 string slice.
#[must_use]
pub fn advance_point_by_str(start: Point, text: &str) -> Point {
    let mut row = start.row;
    let mut col = start.column;
    for b in text.bytes() {
        if b == b'\n' {
            row += 1;
            col = 0;
        } else {
            col += 1;
        }
    }
    Point { row, column: col }
}

/// Build an `InputEdit` on `rope` before mutating `[start_byte, old_end_byte)` with `inserted_text`.
#[must_use]
pub fn build_input_edit_for_utf8_range(
    rope: &Rope,
    start_byte: Utf8ByteOffset,
    old_end_byte: Utf8ByteOffset,
    inserted_text: &str,
) -> InputEdit {
    let start_b = start_byte.as_usize();
    let old_end_b = old_end_byte.as_usize();
    let new_end_b = start_b + inserted_text.len();

    let start_position = byte_offset_to_point(rope, start_b);
    let old_end_position = byte_offset_to_point(rope, old_end_b);
    let new_end_position = advance_point_by_str(start_position, inserted_text);

    InputEdit {
        start_byte,
        old_end_byte,
        new_end_byte: Utf8ByteOffset::new(new_end_b as u32),
        start_position,
        old_end_position,
        new_end_position,
    }
}

/// Apply an `EditorTransaction` to `rope` and return the corresponding `InputEdit` sequence (`LOT-007`).
pub fn apply_editor_transaction_and_collect_edits(
    rope: &mut Rope,
    tx: &EditorTransaction,
) -> Result<Vec<InputEdit>, OffsetConversionError> {
    let mut edits = Vec::with_capacity(tx.changes.len());
    for change in &tx.changes {
        let utf8_span = match change.range_utf8 {
            Some(span) => span,
            None => utf16_span_to_utf8(rope, change.range_utf16)?,
        };
        let input_edit = build_input_edit_for_utf8_range(
            rope,
            utf8_span.start,
            utf8_span.end,
            &change.inserted_text,
        );
        let start_char = rope.byte_to_char(utf8_span.start.as_usize());
        let end_char = rope.byte_to_char(utf8_span.end.as_usize());
        rope.remove(start_char..end_char);
        if !change.inserted_text.is_empty() {
            rope.insert(start_char, &change.inserted_text);
        }
        edits.push(input_edit);
    }
    Ok(edits)
}
