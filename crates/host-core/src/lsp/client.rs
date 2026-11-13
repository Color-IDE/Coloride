//! JSON-RPC client for one language server process, over its stdin/stdout.
//!
//! Nothing here blocks the caller on the server: outgoing messages are queued to a writer
//! thread, so a stalled server can never delay a keystroke. Everything a server sends is
//! untrusted data: it is parsed defensively and never interpreted as an instruction.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use thiserror::Error;

use super::transport::{read_message, write_message};
use crate::process::SupervisedChild;
use crate::trust::{GatedCommand, TrustError};

#[derive(Debug, Error)]
pub enum LspError {
    #[error(transparent)]
    Trust(#[from] TrustError),
    #[error("language server exited or closed its connection")]
    Disconnected,
    #[error("language server did not answer `{method}` in time")]
    Timeout { method: String },
    #[error("language server answered `{method}` with an error: {message}")]
    Response { method: String, message: String },
    #[error("language server protocol violation: {0}")]
    Protocol(String),
}

type Pending = Arc<Mutex<HashMap<i64, mpsc::Sender<Result<Value, String>>>>>;

/// Called on the reader thread for every notification the server sends.
pub type NotificationHandler = Box<dyn Fn(&str, &Value) + Send + 'static>;

pub struct LspClient {
    outgoing: mpsc::Sender<Value>,
    pending: Pending,
    next_id: AtomicI64,
    alive: Arc<AtomicBool>,
    /// Dropping the client drops the child, which kills its whole process group.
    child: Mutex<SupervisedChild>,
}

impl std::fmt::Debug for LspClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LspClient")
            .field("alive", &self.is_alive())
            .finish_non_exhaustive()
    }
}

impl LspClient {
    /// Launches the server. `command` comes from the trust gate, so this cannot start anything
    /// for an untrusted workspace.
    pub fn spawn(
        mut command: GatedCommand,
        on_notification: NotificationHandler,
    ) -> Result<Self, LspError> {
        command
            .command_mut()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn()?;
        let (Some(mut stdin), Some(stdout), Some(stderr)) =
            (child.take_stdin(), child.take_stdout(), child.take_stderr())
        else {
            return Err(LspError::Protocol("server stdio is not piped".into()));
        };

        let alive = Arc::new(AtomicBool::new(true));
        let pending: Pending = Arc::default();
        let (outgoing, queued) = mpsc::channel::<Value>();

        std::thread::spawn(move || {
            for message in queued {
                if write_message(&mut stdin, &message).is_err() {
                    break;
                }
            }
            // Dropping stdin here closes the pipe: a well-behaved server exits on EOF.
        });

        std::thread::spawn(move || {
            // Drained so a chatty server never blocks on a full pipe.
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                tracing::debug!(target: "coloride::lsp", "{line}");
            }
        });

        {
            let alive = Arc::clone(&alive);
            let pending = Arc::clone(&pending);
            let replies = outgoing.clone();
            std::thread::spawn(move || {
                let mut reader = BufReader::new(stdout);
                while let Ok(Some(message)) = read_message(&mut reader) {
                    dispatch(&message, &pending, &replies, &on_notification);
                }
                alive.store(false, Ordering::SeqCst);
                // Wake every caller still waiting for an answer.
                lock(&pending).clear();
            });
        }

        Ok(Self {
            outgoing,
            pending,
            next_id: AtomicI64::new(1),
            alive,
            child: Mutex::new(child),
        })
    }

    #[must_use]
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// OS process id of the server.
    #[must_use]
    pub fn process_id(&self) -> u32 {
        lock(&self.child).id()
    }

    pub fn notify(&self, method: &str, params: Value) -> Result<(), LspError> {
        if !self.is_alive() {
            return Err(LspError::Disconnected);
        }
        self.outgoing
            .send(json!({"jsonrpc": "2.0", "method": method, "params": params}))
            .map_err(|_| LspError::Disconnected)
    }

    pub fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, LspError> {
        self.begin_request(method, params)?.wait(timeout)
    }

    /// Queues a request without waiting. The request takes its place in the outgoing stream
    /// now, so the caller can order it against notifications it sends before and after.
    pub fn begin_request(
        &self,
        method: &str,
        params: Value,
    ) -> Result<PendingRequest<'_>, LspError> {
        if !self.is_alive() {
            return Err(LspError::Disconnected);
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (answer, answered) = mpsc::channel();
        lock(&self.pending).insert(id, answer);
        let sent = self
            .outgoing
            .send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}));
        if sent.is_err() {
            lock(&self.pending).remove(&id);
            return Err(LspError::Disconnected);
        }
        Ok(PendingRequest {
            client: self,
            id,
            method: method.to_string(),
            answered,
        })
    }

    /// Asks the server to stop, then kills its process group whatever it answered.
    pub fn shutdown(&self) {
        if self.is_alive() {
            let _ = self.request("shutdown", Value::Null, Duration::from_millis(500));
            let _ = self.notify("exit", Value::Null);
        }
        lock(&self.child).kill();
    }
}

/// A request already on its way to the server.
pub struct PendingRequest<'a> {
    client: &'a LspClient,
    id: i64,
    method: String,
    answered: mpsc::Receiver<Result<Value, String>>,
}

impl PendingRequest<'_> {
    pub fn wait(self, timeout: Duration) -> Result<Value, LspError> {
        match self.answered.recv_timeout(timeout) {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(message)) => Err(LspError::Response {
                method: self.method,
                message,
            }),
            Err(RecvTimeoutError::Timeout) => {
                lock(&self.client.pending).remove(&self.id);
                // Tell the server we no longer want the answer.
                let _ = self
                    .client
                    .notify("$/cancelRequest", json!({"id": self.id}));
                Err(LspError::Timeout {
                    method: self.method,
                })
            }
            Err(RecvTimeoutError::Disconnected) => Err(LspError::Disconnected),
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn dispatch(
    message: &Value,
    pending: &Pending,
    replies: &mpsc::Sender<Value>,
    on_notification: &NotificationHandler,
) {
    let method = message.get("method").and_then(Value::as_str);
    let id = message.get("id").filter(|id| !id.is_null());
    match (method, id) {
        // A request from the server. We expose no client-side capability that runs anything:
        // configuration is answered with "no settings", the rest with a null result.
        (Some(method), Some(id)) => {
            let result = if method == "workspace/configuration" {
                let items = message
                    .pointer("/params/items")
                    .and_then(Value::as_array)
                    .map_or(0, Vec::len);
                Value::Array(vec![Value::Null; items.min(1024)])
            } else {
                Value::Null
            };
            let _ = replies.send(json!({"jsonrpc": "2.0", "id": id, "result": result}));
        }
        (Some(method), None) => {
            on_notification(method, message.get("params").unwrap_or(&Value::Null));
        }
        (None, Some(id)) => {
            let Some(id) = id.as_i64() else { return };
            let Some(answer) = lock(pending).remove(&id) else {
                return; // late answer to a request that timed out
            };
            let outcome = match message.get("error") {
                Some(error) => Err(error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown error")
                    .chars()
                    .take(2_000)
                    .collect()),
                None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
            };
            let _ = answer.send(outcome);
        }
        (None, None) => {}
    }
}
