use ropey::Rope;
use thiserror::Error;

use crate::contracts::{LineCol, Utf16CodeUnitOffset, Utf16Span, Utf8ByteOffset, Utf8Span};

/// Errors raised during UTF-8 ↔ UTF-16 offset and span conversions on `ropey::Rope`.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum OffsetConversionError {
    #[error("UTF-16 offset {offset:?} is out of bounds (len_utf16 = {len_utf16})")]
    OutOfBoundsUtf16 {
        offset: Utf16CodeUnitOffset,
        len_utf16: u32,
    },
    #[error("UTF-16 offset {offset:?} splits a UTF-16 surrogate pair")]
    UnalignedUtf16Surrogate { offset: Utf16CodeUnitOffset },
    #[error("UTF-8 byte offset {offset:?} is out of bounds (len_bytes = {len_bytes})")]
    OutOfBoundsUtf8 {
        offset: Utf8ByteOffset,
        len_bytes: u32,
    },
    #[error("UTF-8 byte offset {offset:?} does not lie on a valid UTF-8 character boundary")]
    UnalignedUtf8CharBoundary { offset: Utf8ByteOffset },
    #[error("Invalid span order: start ({start}) > end ({end})")]
    InvalidSpanOrder { start: u32, end: u32 },
    #[error("Line index {line} is out of bounds (total_lines = {total_lines})")]
    LineOutOfBounds { line: u32, total_lines: u32 },
    #[error("UTF-16 column {col_utf16} on line {line} is out of bounds (line_len_utf16 = {line_len_utf16})")]
    ColumnOutOfBounds {
        line: u32,
        col_utf16: u32,
        line_len_utf16: u32,
    },
}

/// Convert a UTF-16 code unit offset to a `ropey::Rope` scalar `char` index,
/// rejecting out-of-bounds offsets and offsets that split a surrogate pair.
pub fn utf16_to_char_idx(
    rope: &Rope,
    offset_utf16: Utf16CodeUnitOffset,
) -> Result<usize, OffsetConversionError> {
    let cu = offset_utf16.as_usize();
    let total_cu = rope.len_utf16_cu();
    if cu > total_cu {
        return Err(OffsetConversionError::OutOfBoundsUtf16 {
            offset: offset_utf16,
            len_utf16: total_cu as u32,
        });
    }

    let char_idx = rope.utf16_cu_to_char(cu);
    if rope.char_to_utf16_cu(char_idx) != cu {
        return Err(OffsetConversionError::UnalignedUtf16Surrogate {
            offset: offset_utf16,
        });
    }

    Ok(char_idx)
}

/// Convert a UTF-8 byte offset to a `ropey::Rope` scalar `char` index,
/// rejecting out-of-bounds offsets and offsets inside a multi-byte UTF-8 codepoint.
pub fn utf8_to_char_idx(
    rope: &Rope,
    offset_utf8: Utf8ByteOffset,
) -> Result<usize, OffsetConversionError> {
    let byte_idx = offset_utf8.as_usize();
    let total_bytes = rope.len_bytes();
    if byte_idx > total_bytes {
        return Err(OffsetConversionError::OutOfBoundsUtf8 {
            offset: offset_utf8,
            len_bytes: total_bytes as u32,
        });
    }

    let char_idx = rope.byte_to_char(byte_idx);
    if rope.char_to_byte(char_idx) != byte_idx {
        return Err(OffsetConversionError::UnalignedUtf8CharBoundary {
            offset: offset_utf8,
        });
    }

    Ok(char_idx)
}

/// Centralized converter: UTF-16 code unit offset → UTF-8 byte offset on `ropey::Rope`.
pub fn utf16_to_utf8(
    rope: &Rope,
    offset_utf16: Utf16CodeUnitOffset,
) -> Result<Utf8ByteOffset, OffsetConversionError> {
    let char_idx = utf16_to_char_idx(rope, offset_utf16)?;
    let byte_idx = rope.char_to_byte(char_idx);
    Ok(Utf8ByteOffset::new(byte_idx as u32))
}

/// Centralized converter: UTF-8 byte offset → UTF-16 code unit offset on `ropey::Rope`.
pub fn utf8_to_utf16(
    rope: &Rope,
    offset_utf8: Utf8ByteOffset,
) -> Result<Utf16CodeUnitOffset, OffsetConversionError> {
    let char_idx = utf8_to_char_idx(rope, offset_utf8)?;
    let cu_idx = rope.char_to_utf16_cu(char_idx);
    Ok(Utf16CodeUnitOffset::new(cu_idx as u32))
}

/// Convert a half-open `Utf16Span` `[start, end)` to a `Utf8Span` `[start, end)`.
pub fn utf16_span_to_utf8(
    rope: &Rope,
    span_utf16: Utf16Span,
) -> Result<Utf8Span, OffsetConversionError> {
    if span_utf16.start > span_utf16.end {
        return Err(OffsetConversionError::InvalidSpanOrder {
            start: span_utf16.start.as_u32(),
            end: span_utf16.end.as_u32(),
        });
    }
    let start = utf16_to_utf8(rope, span_utf16.start)?;
    let end = utf16_to_utf8(rope, span_utf16.end)?;
    Ok(Utf8Span::new(start, end))
}

/// Convert a half-open `Utf8Span` `[start, end)` to a `Utf16Span` `[start, end)`.
pub fn utf8_span_to_utf16(
    rope: &Rope,
    span_utf8: Utf8Span,
) -> Result<Utf16Span, OffsetConversionError> {
    if span_utf8.start > span_utf8.end {
        return Err(OffsetConversionError::InvalidSpanOrder {
            start: span_utf8.start.as_u32(),
            end: span_utf8.end.as_u32(),
        });
    }
    let start = utf8_to_utf16(rope, span_utf8.start)?;
    let end = utf8_to_utf16(rope, span_utf8.end)?;
    Ok(Utf16Span::new(start, end))
}

/// Convert a UTF-16 code unit offset to a zero-based `(line, col_utf16)` coordinate.
pub fn utf16_to_line_col(
    rope: &Rope,
    offset_utf16: Utf16CodeUnitOffset,
) -> Result<LineCol, OffsetConversionError> {
    let char_idx = utf16_to_char_idx(rope, offset_utf16)?;
    let line_idx = rope.char_to_line(char_idx);
    let line_start_char = rope.line_to_char(line_idx);
    let line_start_cu = rope.char_to_utf16_cu(line_start_char);
    let col_utf16 = (offset_utf16.as_usize() - line_start_cu) as u32;
    Ok(LineCol::new(line_idx as u32, col_utf16))
}

/// Convert a zero-based `(line, col_utf16)` coordinate to a UTF-16 code unit offset.
pub fn line_col_to_utf16(
    rope: &Rope,
    line_col: LineCol,
) -> Result<Utf16CodeUnitOffset, OffsetConversionError> {
    let line_idx = line_col.line as usize;
    let total_lines = rope.len_lines();
    if line_idx >= total_lines {
        return Err(OffsetConversionError::LineOutOfBounds {
            line: line_col.line,
            total_lines: total_lines as u32,
        });
    }

    let line_slice = rope.line(line_idx);
    let mut line_chars = line_slice.len_chars();
    if line_chars > 0 && line_slice.char(line_chars - 1) == '\n' {
        line_chars -= 1;
        if line_chars > 0 && line_slice.char(line_chars - 1) == '\r' {
            line_chars -= 1;
        }
    } else if line_chars > 0 && line_slice.char(line_chars - 1) == '\r' {
        line_chars -= 1;
    }

    let visible_line_slice = line_slice.slice(0..line_chars);
    let line_len_utf16 = visible_line_slice.len_utf16_cu() as u32;
    if line_col.col_utf16 > line_len_utf16 {
        return Err(OffsetConversionError::ColumnOutOfBounds {
            line: line_col.line,
            col_utf16: line_col.col_utf16,
            line_len_utf16,
        });
    }

    let line_start_char = rope.line_to_char(line_idx);
    let line_start_cu = rope.char_to_utf16_cu(line_start_char);
    let target_cu = Utf16CodeUnitOffset::new(line_start_cu as u32 + line_col.col_utf16);
    // Validate surrogate alignment on the full rope.
    let _ = utf16_to_char_idx(rope, target_cu)?;
    Ok(target_cu)
}

/// Compute the lowercase hex `blake3` digest of a `ropey::Rope` by streaming its chunks
/// without allocating a contiguous string buffer.
#[must_use]
pub fn compute_rope_blake3_hex(rope: &Rope) -> String {
    let mut hasher = blake3::Hasher::new();
    for chunk in rope.chunks() {
        hasher.update(chunk.as_bytes());
    }
    hasher.finalize().to_hex().to_string()
}
