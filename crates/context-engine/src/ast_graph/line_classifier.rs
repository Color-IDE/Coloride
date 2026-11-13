//! Line-level classification of TypeScript/JavaScript, JSON and CSS source into AST node kinds (`LOT-007`).

use super::*;

pub(super) fn parse_single_rope_line(
    language: SupportedAstLanguage,
    provider: &RopeTextProvider<'_>,
    line_idx: usize,
) -> AstNode {
    let rope = provider.rope();
    let start_byte = rope.line_to_byte(line_idx);
    let end_byte = if line_idx + 1 < rope.len_lines() {
        rope.line_to_byte(line_idx + 1)
    } else {
        rope.len_bytes()
    };

    let line_text = provider.line_text_trimmed_newline(line_idx);
    let trimmed = line_text.trim();
    let start_point = Point::new(line_idx as u32, 0);
    let end_point = Point::new(line_idx as u32, line_text.len() as u32);
    let span_utf8 = Utf8Span::new(
        Utf8ByteOffset::new(start_byte as u32),
        Utf8ByteOffset::new(end_byte as u32),
    );
    let node_blake3_hash = blake3::hash(trimmed.as_bytes()).to_hex().to_string();

    if trimmed.is_empty()
        || trimmed.starts_with("//")
        || trimmed.starts_with("/*")
        || trimmed.starts_with('*')
    {
        return AstNode {
            kind: AstNodeKind::CommentOrBlank,
            span_utf8,
            start_point,
            end_point,
            node_blake3_hash,
        };
    }

    let kind = match language {
        SupportedAstLanguage::TypeScript
        | SupportedAstLanguage::Tsx
        | SupportedAstLanguage::JavaScript => classify_ts_js_line(trimmed, language),
        SupportedAstLanguage::Json => classify_json_line(trimmed),
        SupportedAstLanguage::Css => classify_css_line(trimmed),
    };

    AstNode {
        kind,
        span_utf8,
        start_point,
        end_point,
        node_blake3_hash,
    }
}

pub(super) fn is_valid_identifier(ident: &str) -> bool {
    let mut chars = ident.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_ascii_alphabetic() || first == '_' || first == '$') {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
}

pub(super) fn extract_first_identifier(after_keyword: &str) -> Option<String> {
    let trimmed = after_keyword.trim_start();
    let end = trimmed
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '$'))
        .unwrap_or(trimmed.len());
    let candidate = &trimmed[..end];
    if is_valid_identifier(candidate) {
        Some(candidate.to_string())
    } else {
        None
    }
}

pub(super) fn extract_identifier_tokens(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '$' {
            current.push(ch);
        } else if !current.is_empty() {
            if is_valid_identifier(&current) && !is_ts_keyword(&current) {
                tokens.push(std::mem::take(&mut current));
            } else {
                current.clear();
            }
        }
    }
    if !current.is_empty() && is_valid_identifier(&current) && !is_ts_keyword(&current) {
        tokens.push(current);
    }
    tokens
}

pub(super) fn is_ts_keyword(word: &str) -> bool {
    matches!(
        word,
        "export"
            | "import"
            | "from"
            | "function"
            | "async"
            | "const"
            | "let"
            | "var"
            | "class"
            | "interface"
            | "type"
            | "return"
            | "if"
            | "else"
            | "for"
            | "while"
            | "true"
            | "false"
            | "null"
            | "undefined"
            | "string"
            | "number"
            | "boolean"
            | "void"
            | "Promise"
            | "default"
            | "new"
    )
}

pub(super) fn has_obvious_syntax_error(trimmed: &str) -> Option<String> {
    if trimmed.contains("???") || trimmed.contains("@@@") || trimmed.ends_with("= ;") {
        return Some("Unexpected syntax token in statement".to_string());
    }
    // Check unbalanced parentheses on single-line declaration/expression
    let open_parens = trimmed.chars().filter(|&c| c == '(').count();
    let close_parens = trimmed.chars().filter(|&c| c == ')').count();
    if open_parens != close_parens {
        return Some("Unbalanced parentheses in line".to_string());
    }
    // Check unclosed string literal on single line
    let double_quotes = trimmed.chars().filter(|&c| c == '"').count();
    let single_quotes = trimmed.chars().filter(|&c| c == '\'').count();
    if double_quotes % 2 != 0 || single_quotes % 2 != 0 {
        return Some("Unclosed string literal".to_string());
    }
    None
}

pub(super) fn parse_import_line(trimmed: &str) -> Option<AstNodeKind> {
    let rest = trimmed.strip_prefix("import ")?.trim();
    let from_idx = rest.find("from ")?;
    let clause = rest[..from_idx].trim().trim_start_matches("type ").trim();
    let source_part = rest[from_idx + 5..].trim().trim_end_matches(';').trim();
    let source_specifier = source_part
        .trim_matches('"')
        .trim_matches('\'')
        .trim()
        .to_string();
    if source_specifier.is_empty() {
        return None;
    }

    let mut imported_symbols = Vec::new();
    let cleaned_clause = clause.replace(['{', '}'], " ");
    for part in cleaned_clause.split(',') {
        let token = part.trim();
        if token.is_empty() {
            continue;
        }
        let actual = if let Some((_, alias)) = token.split_once(" as ") {
            alias.trim()
        } else if let Some(star_alias) = token.strip_prefix("* as ") {
            star_alias.trim()
        } else {
            token.trim_start_matches("type ").trim()
        };
        if is_valid_identifier(actual) {
            imported_symbols.push(actual.to_string());
        }
    }

    Some(AstNodeKind::ImportStatement {
        imported_symbols,
        source_specifier,
    })
}

pub(super) fn classify_ts_js_line(trimmed: &str, language: SupportedAstLanguage) -> AstNodeKind {
    if let Some(reason) = has_obvious_syntax_error(trimmed) {
        return AstNodeKind::Error { reason };
    }

    if trimmed.starts_with("import ") {
        if let Some(import_node) = parse_import_line(trimmed) {
            return import_node;
        }
    }

    let (exported, body) =
        if let Some(after_export_default) = trimmed.strip_prefix("export default ") {
            (true, after_export_default.trim_start())
        } else if let Some(after_export) = trimmed.strip_prefix("export ") {
            (true, after_export.trim_start())
        } else {
            (false, trimmed)
        };

    let body_no_async = body.strip_prefix("async ").unwrap_or(body).trim_start();

    if let Some(after_fn) = body_no_async.strip_prefix("function ") {
        if let Some(name) = extract_first_identifier(after_fn) {
            let is_react_component = (language == SupportedAstLanguage::Tsx
                || body.contains("JSX")
                || body.contains("ReactElement"))
                && name
                    .chars()
                    .next()
                    .map(|c| c.is_ascii_uppercase())
                    .unwrap_or(false);
            let kind = if is_react_component {
                SymbolKind::ReactComponent
            } else {
                SymbolKind::Function
            };
            let refs = extract_identifier_tokens(after_fn)
                .into_iter()
                .filter(|id| id != &name)
                .collect();
            return AstNodeKind::SymbolDeclaration {
                name,
                kind,
                exported,
                referenced_identifiers: refs,
            };
        }
    }

    if let Some(after_class) = body
        .strip_prefix("abstract class ")
        .or_else(|| body.strip_prefix("class "))
    {
        if let Some(name) = extract_first_identifier(after_class) {
            let refs = extract_identifier_tokens(after_class)
                .into_iter()
                .filter(|id| id != &name)
                .collect();
            return AstNodeKind::SymbolDeclaration {
                name,
                kind: SymbolKind::Class,
                exported,
                referenced_identifiers: refs,
            };
        }
    }

    if let Some(after_iface) = body.strip_prefix("interface ") {
        if let Some(name) = extract_first_identifier(after_iface) {
            let refs = extract_identifier_tokens(after_iface)
                .into_iter()
                .filter(|id| id != &name)
                .collect();
            return AstNodeKind::SymbolDeclaration {
                name,
                kind: SymbolKind::Interface,
                exported,
                referenced_identifiers: refs,
            };
        }
    }

    if let Some(after_type) = body.strip_prefix("type ") {
        if let Some(name) = extract_first_identifier(after_type) {
            let refs = extract_identifier_tokens(after_type)
                .into_iter()
                .filter(|id| id != &name)
                .collect();
            return AstNodeKind::SymbolDeclaration {
                name,
                kind: SymbolKind::TypeAlias,
                exported,
                referenced_identifiers: refs,
            };
        }
    }

    if let Some(after_decl) = body
        .strip_prefix("const ")
        .or_else(|| body.strip_prefix("let "))
        .or_else(|| body.strip_prefix("var "))
    {
        if let Some(name) = extract_first_identifier(after_decl) {
            let is_arrow_fn = after_decl.contains("=>");
            let is_uppercase = name
                .chars()
                .next()
                .map(|c| c.is_ascii_uppercase())
                .unwrap_or(false);
            let kind = if is_arrow_fn && language == SupportedAstLanguage::Tsx && is_uppercase {
                SymbolKind::ReactComponent
            } else if is_arrow_fn {
                SymbolKind::Function
            } else {
                SymbolKind::ConstOrVariable
            };
            let refs = extract_identifier_tokens(after_decl)
                .into_iter()
                .filter(|id| id != &name)
                .collect();
            return AstNodeKind::SymbolDeclaration {
                name,
                kind,
                exported,
                referenced_identifiers: refs,
            };
        }
    }

    AstNodeKind::Statement
}

pub(super) fn classify_json_line(trimmed: &str) -> AstNodeKind {
    if let Some(rest) = trimmed.strip_prefix('"') {
        if let Some((key, _)) = rest.split_once("\":") {
            return AstNodeKind::SymbolDeclaration {
                name: key.to_string(),
                kind: SymbolKind::JsonKey,
                exported: true,
                referenced_identifiers: Vec::new(),
            };
        }
    }
    AstNodeKind::Statement
}

pub(super) fn classify_css_line(trimmed: &str) -> AstNodeKind {
    if trimmed.ends_with('{') {
        let selector = trimmed.trim_end_matches('{').trim();
        if !selector.is_empty() {
            return AstNodeKind::SymbolDeclaration {
                name: selector.to_string(),
                kind: SymbolKind::CssSelector,
                exported: true,
                referenced_identifiers: Vec::new(),
            };
        }
    }
    AstNodeKind::Statement
}
