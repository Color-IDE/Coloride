//! A debug session with vscode-js-debug: the adapter process, its parent session (the launch
//! request) and the child session it asks for through `startDebugging` (the actual debuggee).

use std::collections::BTreeMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::connection::{DapConnection, DapIncoming};
use super::DebugError;
use crate::process::SupervisedChild;
use crate::trust::{GatedCapability, WorkspaceTrustGate};

/// Events reach the UI in frames, at most one every 16 ms.
pub const DEBUG_EVENT_FRAME: Duration = Duration::from_millis(16);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const ADAPTER_START_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_OUTPUT_CHARS: usize = 64 * 1024;

/// Which DAP session an event came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DebugSessionRole {
    /// The launch request (process output of the launcher, overall termination).
    Launcher,
    /// The program being debugged (stops, threads, output, breakpoints).
    Debuggee,
}

/// A DAP event, forwarded as data (its body is untrusted adapter output).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DebugEvent {
    pub role: DebugSessionRole,
    pub event: String,
    pub body: Value,
}

/// Receives frames of events (never empty).
pub type DebugEventSink = Arc<dyn Fn(Vec<DebugEvent>) + Send + Sync>;

/// What to debug: a JavaScript (or TypeScript with source maps) file of the workspace, run
/// with `node`.
#[derive(Debug, Clone)]
pub struct DebugLaunch {
    pub program: PathBuf,
    pub args: Vec<String>,
}

/// Requests the UI may send to the debuggee. Anything else (launching other programs, custom
/// adapter requests) is not exposed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum DebugCommand {
    Continue {
        thread_id: i64,
    },
    Next {
        thread_id: i64,
    },
    StepIn {
        thread_id: i64,
    },
    StepOut {
        thread_id: i64,
    },
    Pause {
        thread_id: i64,
    },
    Threads,
    StackTrace {
        thread_id: i64,
    },
    Scopes {
        frame_id: i64,
    },
    Variables {
        variables_reference: i64,
    },
    Evaluate {
        expression: String,
        frame_id: Option<i64>,
    },
}

impl DebugCommand {
    fn request(&self) -> (&'static str, Value) {
        match self {
            Self::Continue { thread_id } => ("continue", json!({"threadId": thread_id})),
            Self::Next { thread_id } => ("next", json!({"threadId": thread_id})),
            Self::StepIn { thread_id } => ("stepIn", json!({"threadId": thread_id})),
            Self::StepOut { thread_id } => ("stepOut", json!({"threadId": thread_id})),
            Self::Pause { thread_id } => ("pause", json!({"threadId": thread_id})),
            Self::Threads => ("threads", json!({})),
            Self::StackTrace { thread_id } => (
                "stackTrace",
                json!({"threadId": thread_id, "startFrame": 0, "levels": 200}),
            ),
            Self::Scopes { frame_id } => ("scopes", json!({"frameId": frame_id})),
            Self::Variables {
                variables_reference,
            } => (
                "variables",
                json!({"variablesReference": variables_reference}),
            ),
            Self::Evaluate {
                expression,
                frame_id,
            } => (
                "evaluate",
                json!({"expression": expression, "frameId": frame_id, "context": "repl"}),
            ),
        }
    }
}

type Breakpoints = BTreeMap<PathBuf, Vec<u32>>;

struct Shared {
    breakpoints: Mutex<Breakpoints>,
    debuggee: Mutex<Option<Arc<DapConnection>>>,
    events: mpsc::Sender<DebugEvent>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn initialize_arguments() -> Value {
    json!({
        "clientID": "coloride",
        "clientName": "Coloride",
        "adapterID": "pwa-node",
        "locale": "en",
        "linesStartAt1": true,
        "columnsStartAt1": true,
        "pathFormat": "path",
        "supportsVariableType": true,
        "supportsStartDebuggingRequest": true,
        // The adapter must not open terminals or run anything on our side.
        "supportsRunInTerminalRequest": false,
    })
}

fn set_breakpoints(
    connection: &DapConnection,
    path: &Path,
    lines: &[u32],
) -> Result<Value, DebugError> {
    connection.request(
        "setBreakpoints",
        json!({
            "source": {"path": path},
            "breakpoints": lines.iter().map(|line| json!({"line": line})).collect::<Vec<_>>(),
        }),
        REQUEST_TIMEOUT,
    )
}

/// Bounds what one adapter event can make the UI hold.
fn sanitize(event: &str, mut body: Value) -> Value {
    if event == "output" {
        if let Some(output) = body.get_mut("output") {
            if let Some(text) = output.as_str() {
                if text.chars().count() > MAX_OUTPUT_CHARS {
                    *output = Value::String(text.chars().take(MAX_OUTPUT_CHARS).collect());
                }
            }
        }
    }
    body
}

pub struct DebugSession {
    shared: Arc<Shared>,
    launcher: Arc<DapConnection>,
    /// Dropped last: kills the adapter and, through its process group, the debuggee.
    adapter: Mutex<SupervisedChild>,
}

impl std::fmt::Debug for DebugSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DebugSession").finish_non_exhaustive()
    }
}

impl DebugSession {
    /// Starts the adapter (`node <dap_server> 0 127.0.0.1`) and launches `launch.program`.
    /// Refused unless the workspace is trusted and the program is a file inside it.
    pub fn launch(
        gate: &WorkspaceTrustGate,
        node: &Path,
        dap_server: &Path,
        launch: &DebugLaunch,
        breakpoints: Breakpoints,
        sink: DebugEventSink,
    ) -> Result<Self, DebugError> {
        gate.authorize(GatedCapability::DebugAdapter)?;
        if !launch.program.is_file() || !gate.is_inside_workspace(&launch.program) {
            return Err(DebugError::ProgramOutsideWorkspace);
        }
        let mut command = gate.command(GatedCapability::DebugAdapter, node)?;
        command
            .command_mut()
            .arg(dap_server)
            .args(["0", "127.0.0.1"])
            .current_dir(gate.workspace_root())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut adapter = command
            .spawn()
            .map_err(|error| DebugError::AdapterStart(error.to_string()))?;
        let port = read_adapter_port(&mut adapter)?;

        let (events, frames) = mpsc::channel();
        spawn_event_pump(frames, sink);
        let shared = Arc::new(Shared {
            breakpoints: Mutex::new(breakpoints),
            debuggee: Mutex::new(None),
            events,
        });

        let handler_shared = Arc::clone(&shared);
        let launcher = DapConnection::connect(
            port,
            Box::new(move |connection, incoming| {
                on_launcher_message(&handler_shared, port, connection, incoming);
            }),
        )?;
        launcher.request("initialize", initialize_arguments(), REQUEST_TIMEOUT)?;
        // js-debug answers `launch` once configuration is done (after `initialized`), so the
        // launch request is not waited for here; its failure arrives as an event.
        let workspace = gate.workspace_root().to_path_buf();
        let program = launch.program.clone();
        let args = launch.args.clone();
        let launch_connection = Arc::clone(&launcher);
        let launch_events = shared.events.clone();
        std::thread::spawn(move || {
            let outcome = launch_connection.request(
                "launch",
                json!({
                    "type": "pwa-node",
                    "request": "launch",
                    "name": "Coloride",
                    "program": program,
                    "args": args,
                    "cwd": workspace,
                    "console": "internalConsole",
                    "outputCapture": "std",
                    // Only the program's own files: no `node_modules` stepping by default.
                    "skipFiles": ["<node_internals>/**"],
                }),
                ADAPTER_START_TIMEOUT,
            );
            if let Err(error) = outcome {
                let _ = launch_events.send(DebugEvent {
                    role: DebugSessionRole::Launcher,
                    event: "launchFailed".into(),
                    body: json!({"message": error.to_string()}),
                });
            }
        });
        Ok(Self {
            shared,
            launcher,
            adapter: Mutex::new(adapter),
        })
    }

    /// Replaces the breakpoints of one file; sent to the debuggee when it runs. Returns the
    /// adapter's answer (verified lines), or null before the debuggee has started.
    pub fn set_breakpoints(&self, path: &Path, lines: Vec<u32>) -> Result<Value, DebugError> {
        lock(&self.shared.breakpoints).insert(path.to_path_buf(), lines.clone());
        let debuggee = lock(&self.shared.debuggee).clone();
        match debuggee {
            Some(connection) => set_breakpoints(&connection, path, &lines),
            None => Ok(Value::Null),
        }
    }

    /// Sends one request to the debuggee's session.
    pub fn request(&self, command: &DebugCommand) -> Result<Value, DebugError> {
        let debuggee = lock(&self.shared.debuggee)
            .clone()
            .ok_or(DebugError::NoDebuggee)?;
        let (name, arguments) = command.request();
        debuggee.request(name, arguments, REQUEST_TIMEOUT)
    }

    /// Whether the adapter process is still running.
    #[must_use]
    pub fn is_running(&self) -> bool {
        matches!(lock(&self.adapter).try_wait(), Ok(None))
    }

    /// OS process id of the adapter (and of its process group).
    #[must_use]
    pub fn adapter_process_id(&self) -> u32 {
        lock(&self.adapter).id()
    }

    /// Ends the debuggee and the adapter.
    pub fn stop(&self) {
        let debuggee = lock(&self.shared.debuggee).take();
        for connection in debuggee.iter().chain(std::iter::once(&self.launcher)) {
            let _ = connection.request(
                "disconnect",
                json!({"terminateDebuggee": true}),
                Duration::from_millis(500),
            );
            connection.close();
        }
        lock(&self.adapter).kill();
    }
}

impl Drop for DebugSession {
    fn drop(&mut self) {
        self.stop();
    }
}

/// js-debug prints `Debug server listening at 127.0.0.1:PORT` once ready.
fn read_adapter_port(adapter: &mut SupervisedChild) -> Result<u16, DebugError> {
    let stdout = adapter
        .take_stdout()
        .ok_or_else(|| DebugError::AdapterStart("adapter stdout is not piped".into()))?;
    let (found, port) = mpsc::channel();
    std::thread::spawn(move || {
        let mut lines = BufReader::new(stdout).lines();
        let mut reported = false;
        for line in lines.by_ref().map_while(Result::ok) {
            if !reported {
                if let Some(port) = line
                    .rsplit_once(':')
                    .filter(|_| line.starts_with("Debug server listening at"))
                    .and_then(|(_, port)| port.trim().parse::<u16>().ok())
                {
                    let _ = found.send(port);
                    reported = true;
                }
            }
            // Keep draining so the adapter never blocks on a full pipe.
        }
    });
    port.recv_timeout(ADAPTER_START_TIMEOUT)
        .map_err(|_| DebugError::AdapterStart("the adapter did not report its port".into()))
}

fn on_launcher_message(
    shared: &Arc<Shared>,
    port: u16,
    connection: &Arc<DapConnection>,
    incoming: DapIncoming,
) {
    match incoming {
        DapIncoming::Event { event, body } => {
            if event == "initialized" {
                let connection = Arc::clone(connection);
                std::thread::spawn(move || {
                    let _ = connection.request("configurationDone", json!({}), REQUEST_TIMEOUT);
                });
            }
            let body = sanitize(&event, body);
            let _ = shared.events.send(DebugEvent {
                role: DebugSessionRole::Launcher,
                event,
                body,
            });
        }
        DapIncoming::Request {
            seq,
            command,
            arguments,
        } => {
            if command != "startDebugging" {
                // Nothing else is run on the adapter's behalf (`runInTerminal` included).
                connection.respond(
                    seq,
                    &command,
                    false,
                    json!({"error": {"id": 1, "format": "not supported"}}),
                );
                return;
            }
            connection.respond(seq, &command, true, json!({}));
            let shared = Arc::clone(shared);
            std::thread::spawn(move || start_debuggee_session(&shared, port, &arguments));
        }
    }
}

/// Opens the child session js-debug asked for and starts the program in it.
fn start_debuggee_session(shared: &Arc<Shared>, port: u16, arguments: &Value) {
    let report = |message: String| {
        let _ = shared.events.send(DebugEvent {
            role: DebugSessionRole::Debuggee,
            event: "launchFailed".into(),
            body: json!({"message": message}),
        });
    };
    let request = match arguments.get("request").and_then(Value::as_str) {
        Some("attach") => "attach",
        _ => "launch",
    };
    // Only the adapter's own target handle is passed back; the rest of what it sent is ignored.
    let Some(target) = arguments
        .pointer("/configuration/__pendingTargetId")
        .cloned()
    else {
        report("startDebugging without a target".into());
        return;
    };
    let configuration = json!({
        "type": "pwa-node",
        "name": arguments.pointer("/configuration/name").and_then(Value::as_str).unwrap_or("debuggee"),
        "__pendingTargetId": target,
    });
    let handler_shared = Arc::clone(shared);
    let connection = match DapConnection::connect(
        port,
        Box::new(move |connection, incoming| {
            on_debuggee_message(&handler_shared, connection, incoming)
        }),
    ) {
        Ok(connection) => connection,
        Err(error) => return report(error.to_string()),
    };
    if let Err(error) = connection.request("initialize", initialize_arguments(), REQUEST_TIMEOUT) {
        return report(error.to_string());
    }
    *lock(&shared.debuggee) = Some(Arc::clone(&connection));
    if let Err(error) = connection.request(request, configuration, ADAPTER_START_TIMEOUT) {
        report(error.to_string());
    }
}

fn on_debuggee_message(
    shared: &Arc<Shared>,
    connection: &Arc<DapConnection>,
    incoming: DapIncoming,
) {
    match incoming {
        DapIncoming::Event { event, body } => {
            if event == "initialized" {
                // Breakpoints first, then let the program run.
                let breakpoints = lock(&shared.breakpoints).clone();
                let connection = Arc::clone(connection);
                std::thread::spawn(move || {
                    for (path, lines) in &breakpoints {
                        let _ = set_breakpoints(&connection, path, lines);
                    }
                    let _ = connection.request("configurationDone", json!({}), REQUEST_TIMEOUT);
                });
            }
            let body = sanitize(&event, body);
            let _ = shared.events.send(DebugEvent {
                role: DebugSessionRole::Debuggee,
                event,
                body,
            });
        }
        DapIncoming::Request { seq, command, .. } => {
            connection.respond(
                seq,
                &command,
                false,
                json!({"error": {"id": 1, "format": "not supported"}}),
            );
        }
    }
}

/// Groups events into frames, at most one every 16 ms.
fn spawn_event_pump(events: mpsc::Receiver<DebugEvent>, sink: DebugEventSink) {
    std::thread::spawn(move || {
        let mut last_sent: Option<Instant> = None;
        while let Ok(first) = events.recv() {
            let started = match last_sent {
                Some(sent) if sent.elapsed() < DEBUG_EVENT_FRAME => sent,
                _ => Instant::now(),
            };
            let mut frame = vec![first];
            let mut ended = false;
            while let Some(left) = DEBUG_EVENT_FRAME.checked_sub(started.elapsed()) {
                match events.recv_timeout(left) {
                    Ok(event) => frame.push(event),
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => {
                        ended = true;
                        break;
                    }
                }
            }
            sink(frame);
            last_sent = Some(Instant::now());
            if ended {
                break;
            }
        }
    });
}
