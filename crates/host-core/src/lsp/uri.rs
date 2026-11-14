//! `file://` URIs for absolute paths, as exchanged with language servers.

use std::path::{Path, PathBuf};

/// Percent-encodes everything except RFC 3986 unreserved characters and `/`.
#[must_use]
pub fn path_to_file_uri(path: &Path) -> String {
    let mut uri = String::from("file://");
    let text = path.to_string_lossy().replace('\\', "/");
    if !text.starts_with('/') {
        uri.push('/'); // Windows drive paths: file:///C:/...
    }
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                uri.push(byte as char);
            }
            _ => uri.push_str(&format!("%{byte:02X}")),
        }
    }
    uri
}

/// Decodes a `file://` URI sent by a server. `None` for anything else or malformed input.
#[must_use]
pub fn file_uri_to_path(uri: &str) -> Option<PathBuf> {
    let rest = uri.strip_prefix("file://")?;
    // Skip an authority (`file://localhost/...`); the path starts at the next `/`.
    let path = &rest[rest.find('/')?..];
    let mut bytes = Vec::with_capacity(path.len());
    let mut input = path.bytes();
    while let Some(byte) = input.next() {
        if byte == b'%' {
            let high = (input.next()? as char).to_digit(16)?;
            let low = (input.next()? as char).to_digit(16)?;
            bytes.push((high * 16 + low) as u8);
        } else {
            bytes.push(byte);
        }
    }
    let decoded = String::from_utf8(bytes).ok()?;
    // `/C:/dir` → `C:/dir`
    let windows_drive = decoded.len() > 2
        && decoded.as_bytes()[2] == b':'
        && decoded.as_bytes()[1].is_ascii_alphabetic();
    Some(PathBuf::from(if windows_drive {
        &decoded[1..]
    } else {
        &decoded
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_round_trip_with_spaces_and_non_ascii() {
        let path = Path::new("/work/mon projet/src/éditeur #1.ts");
        let uri = path_to_file_uri(path);
        assert_eq!(uri, "file:///work/mon%20projet/src/%C3%A9diteur%20%231.ts");
        assert_eq!(file_uri_to_path(&uri).unwrap(), path);
    }

    #[test]
    fn foreign_or_malformed_uris_are_rejected() {
        assert_eq!(file_uri_to_path("https://example.com/a.ts"), None);
        assert_eq!(file_uri_to_path("file:///a%zz.ts"), None);
        assert_eq!(file_uri_to_path("file:///a%2"), None);
        assert_eq!(file_uri_to_path("file:///%FF"), None);
    }
}
