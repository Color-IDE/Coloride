//! `JSONC` parsing: comments and trailing commas, strings left intact (`LOT-006`).

use super::*;

/// Strip `//` line comments, `/* ... */` block comments, and trailing commas `,` before `}` or `]`
/// while preserving string literals (`"..."`) intact.
#[must_use]
pub fn sanitize_jsonc_to_json(input: &str) -> String {
    let bytes = input.as_bytes();
    let len = bytes.len();
    let mut no_comments = Vec::with_capacity(len);
    let mut i = 0;
    let mut in_string = false;
    let mut escaped = false;

    while i < len {
        let b = bytes[i];
        if in_string {
            no_comments.push(b);
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_string = false;
            }
            i += 1;
            continue;
        }

        if b == b'"' {
            in_string = true;
            no_comments.push(b);
            i += 1;
            continue;
        }

        // Check for single-line comment `//`
        if b == b'/' && i + 1 < len && bytes[i + 1] == b'/' {
            i += 2;
            while i < len && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }

        // Check for multi-line block comment `/* ... */`
        if b == b'/' && i + 1 < len && bytes[i + 1] == b'*' {
            i += 2;
            while i + 1 < len && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                if bytes[i] == b'\n' {
                    no_comments.push(b'\n');
                }
                i += 1;
            }
            if i + 1 < len {
                i += 2;
            } else {
                i = len;
            }
            continue;
        }

        no_comments.push(b);
        i += 1;
    }

    // Second pass: remove trailing commas outside strings before `}` or `]`
    let mut out = Vec::with_capacity(no_comments.len());
    let mut j = 0;
    let n = no_comments.len();
    in_string = false;
    escaped = false;

    while j < n {
        let b = no_comments[j];
        if in_string {
            out.push(b);
            if escaped {
                escaped = false;
            } else if b == b'\\' {
                escaped = true;
            } else if b == b'"' {
                in_string = false;
            }
            j += 1;
            continue;
        }

        if b == b'"' {
            in_string = true;
            out.push(b);
            j += 1;
            continue;
        }

        if b == b',' {
            let mut lookahead = j + 1;
            while lookahead < n && no_comments[lookahead].is_ascii_whitespace() {
                lookahead += 1;
            }
            if lookahead < n && (no_comments[lookahead] == b'}' || no_comments[lookahead] == b']') {
                j += 1;
                continue;
            }
        }

        out.push(b);
        j += 1;
    }

    String::from_utf8_lossy(&out).into_owned()
}

/// Parse a `JSONC` string (with comments and trailing commas) into a `serde_json::Value`.
pub fn parse_jsonc(input: &str) -> Result<serde_json::Value, MigrationError> {
    let cleaned = sanitize_jsonc_to_json(input);
    serde_json::from_str(&cleaned).map_err(|err| MigrationError::JsoncSyntax(err.to_string()))
}
