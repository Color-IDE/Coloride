//! One Debug Adapter Protocol connection over TCP (same framing as LSP).
//!
//! Like the LSP client, nothing here blocks the caller on the adapter: messages are queued to a
//! writer thread. Everything the adapter sends is untrusted data.

use std::collections::HashMap;
use std::io::BufReader;
use std::net::{Shutdown, TcpStream};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

use super::DebugError;
use crate::lsp::{read_message, write_message};

/// What the adapter sends besides responses.
#[derive(Debug, Clone)]
pub enum DapIncoming {
    Event {
        event: String,
        body: Value,
    },
    /// A reverse request (`startDebugging`, `runInTerminal`, ...): answer with `respond`.
    Request {
        seq: i64,
        command: String,
        arguments: Value,
    },
}

pub type DapHandler = Box<dyn Fn(&Arc<DapConnection>, DapIncoming) + Send + 'static>;

type Pending = Arc<Mutex<HashMap<i64, mpsc::Sender<Result<Value, String>>>>>;

pub struct DapConnection {
    outgoing: mpsc::Sender<Value>,
    pending: Pending,
    seq: AtomicI64,
    alive: Arc<AtomicBool>,
    stream: TcpStream,
}

impl std::fmt::Debug for DapConnection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DapConnection")
            .field("alive", &self.is_alive())
            .finish_non_exhaustive()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl DapConnection {
    /// Connects to the adapter on the loopback interface.
    pub fn connect(port: u16, handler: DapHandler) -> Result<Arc<Self>, DebugError> {
        let stream = TcpStream::connect(("127.0.0.1", port)).map_err(DebugError::io)?;
        stream.set_nodelay(true).map_err(DebugError::io)?;
        let mut writer = stream.try_clone().map_err(DebugError::io)?;
        let reader = stream.try_clone().map_err(DebugError::io)?;
        let (outgoing, queued) = mpsc::channel::<Value>();
        std::thread::spawn(move || {
            for message in queued {
                if write_message(&mut writer, &message).is_err() {
                    break;
                }
            }
        });
        let connection = Arc::new(Self {
            outgoing,
            pending: Arc::default(),
            seq: AtomicI64::new(1),
            alive: Arc::new(AtomicBool::new(true)),
            stream,
        });
        let weak = Arc::downgrade(&connection);
        let pending = Arc::clone(&connection.pending);
        let alive = Arc::clone(&connection.alive);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(reader);
            while let Ok(Some(message)) = read_message(&mut reader) {
                match message.get("type").and_then(Value::as_str) {
                    Some("response") => {
                        let Some(seq) = message.get("request_seq").and_then(Value::as_i64) else {
                            continue;
                        };
                        let Some(answer) = lock(&pending).remove(&seq) else {
                            continue;
                        };
                        let outcome =
                            if message.get("success").and_then(Value::as_bool) == Some(true) {
                                Ok(message.get("body").cloned().unwrap_or(Value::Null))
                            } else {
                                // The detail is in `body.error.format`; `message` is a short code.
                                Err(message
                                    .pointer("/body/error/format")
                                    .or_else(|| message.get("message"))
                                    .and_then(Value::as_str)
                                    .unwrap_or("request failed")
                                    .chars()
                                    .take(2_000)
                                    .collect())
                            };
                        let _ = answer.send(outcome);
                    }
                    Some("event") => {
                        let (Some(connection), Some(event)) =
                            (weak.upgrade(), message.get("event").and_then(Value::as_str))
                        else {
                            continue;
                        };
                        let body = message.get("body").cloned().unwrap_or(Value::Null);
                        handler(
                            &connection,
                            DapIncoming::Event {
                                event: event.to_string(),
                                body,
                            },
                        );
                    }
                    Some("request") => {
                        let (Some(connection), Some(seq), Some(command)) = (
                            weak.upgrade(),
                            message.get("seq").and_then(Value::as_i64),
                            message.get("command").and_then(Value::as_str),
                        ) else {
                            continue;
                        };
                        let arguments = message.get("arguments").cloned().unwrap_or(Value::Null);
                        handler(
                            &connection,
                            DapIncoming::Request {
                                seq,
                                command: command.to_string(),
                                arguments,
                            },
                        );
                    }
                    _ => {}
                }
            }
            alive.store(false, Ordering::SeqCst);
            lock(&pending).clear();
        });
        Ok(connection)
    }

    #[must_use]
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    fn next_seq(&self) -> i64 {
        self.seq.fetch_add(1, Ordering::SeqCst)
    }

    pub fn request(
        &self,
        command: &str,
        arguments: Value,
        timeout: Duration,
    ) -> Result<Value, DebugError> {
        if !self.is_alive() {
            return Err(DebugError::Disconnected);
        }
        let seq = self.next_seq();
        let (answer, answered) = mpsc::channel();
        lock(&self.pending).insert(seq, answer);
        let sent = self.outgoing.send(json!({
            "seq": seq, "type": "request", "command": command, "arguments": arguments,
        }));
        if sent.is_err() {
            lock(&self.pending).remove(&seq);
            return Err(DebugError::Disconnected);
        }
        match answered.recv_timeout(timeout) {
            Ok(Ok(body)) => Ok(body),
            Ok(Err(message)) => Err(DebugError::Adapter {
                command: command.to_string(),
                message,
            }),
            Err(RecvTimeoutError::Timeout) => {
                lock(&self.pending).remove(&seq);
                Err(DebugError::Timeout {
                    command: command.to_string(),
                })
            }
            Err(RecvTimeoutError::Disconnected) => Err(DebugError::Disconnected),
        }
    }

    /// Answers a reverse request.
    pub fn respond(&self, request_seq: i64, command: &str, success: bool, body: Value) {
        let _ = self.outgoing.send(json!({
            "seq": self.next_seq(), "type": "response", "request_seq": request_seq,
            "command": command, "success": success, "body": body,
        }));
    }

    pub fn close(&self) {
        let _ = self.stream.shutdown(Shutdown::Both);
    }
}

impl Drop for DapConnection {
    fn drop(&mut self) {
        self.close();
    }
}
