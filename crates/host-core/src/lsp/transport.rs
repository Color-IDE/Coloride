//! LSP base protocol framing: `Content-Length: N\r\n\r\n<N bytes of JSON>`.

use std::io::{self, BufRead, Read, Write};

use serde_json::Value;

/// A server is an untrusted peer: refuse frames that would exhaust memory.
const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
const MAX_HEADER_LINE_BYTES: u64 = 8 * 1024;

pub fn write_message(writer: &mut impl Write, message: &Value) -> io::Result<()> {
    let body = serde_json::to_vec(message)?;
    write!(writer, "Content-Length: {}\r\n\r\n", body.len())?;
    writer.write_all(&body)?;
    writer.flush()
}

/// Reads one message. `Ok(None)` is a clean end of stream (the server exited).
pub fn read_message(reader: &mut impl BufRead) -> io::Result<Option<Value>> {
    let mut content_length: Option<usize> = None;
    loop {
        let mut line = String::new();
        let read = (&mut *reader)
            .take(MAX_HEADER_LINE_BYTES)
            .read_line(&mut line)?;
        if read == 0 {
            return if content_length.is_none() {
                Ok(None)
            } else {
                Err(invalid("stream ended inside a message header"))
            };
        }
        if !line.ends_with('\n') {
            return Err(invalid("header line too long or truncated"));
        }
        let line = line.trim_end_matches(['\r', '\n']);
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                let length: usize = value
                    .trim()
                    .parse()
                    .map_err(|_| invalid("Content-Length is not a number"))?;
                if length > MAX_MESSAGE_BYTES {
                    return Err(invalid("message larger than the accepted maximum"));
                }
                content_length = Some(length);
            }
        }
    }
    let length = content_length.ok_or_else(|| invalid("missing Content-Length header"))?;
    let mut body = vec![0_u8; length];
    reader.read_exact(&mut body)?;
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(io::Error::from)
}

fn invalid(reason: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, reason)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn frames_round_trip_including_non_ascii_bodies() {
        let mut wire = Vec::new();
        let first = json!({"jsonrpc": "2.0", "id": 1, "result": "héllo 𝄞"});
        let second = json!({"jsonrpc": "2.0", "method": "exit"});
        write_message(&mut wire, &first).unwrap();
        write_message(&mut wire, &second).unwrap();
        let mut reader = io::BufReader::new(wire.as_slice());
        assert_eq!(read_message(&mut reader).unwrap(), Some(first));
        assert_eq!(read_message(&mut reader).unwrap(), Some(second));
        assert_eq!(read_message(&mut reader).unwrap(), None);
    }

    #[test]
    fn malformed_and_oversized_frames_are_errors_not_panics() {
        for wire in [
            &b"Content-Length: nope\r\n\r\n{}"[..],
            b"Content-Type: x\r\n\r\n{}",
            b"Content-Length: 99999999999\r\n\r\n",
            b"Content-Length: 10\r\n\r\n{}",
            b"Content-Length: 2\r\n\r\n{]",
            b"Content-Length: 2\r\n",
        ] {
            assert!(read_message(&mut io::BufReader::new(wire)).is_err());
        }
    }
}
