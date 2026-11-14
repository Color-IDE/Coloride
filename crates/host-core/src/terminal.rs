//! Integrated terminal (`LOT-010`): a login shell on a pseudo-terminal, started in a trusted
//! workspace only, whose output is delivered in frames of at most one every 16 ms.
//!
//! The shell leads its own session and process group (`portable-pty` calls `setsid`), so the
//! whole job tree is killed with the session, and an [`OrphanWatchdog`] kills it if the Host
//! dies abruptly.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use thiserror::Error;

use crate::process::{kill_process_group, OrphanWatchdog, SupervisionError};
use crate::trust::{GatedCapability, TrustError, WorkspaceTrustGate};

/// Output is sent at most once per frame (`AGENTS.md`: 16 ms stream batching).
pub const TERMINAL_FRAME: Duration = Duration::from_millis(16);
/// A frame never holds more than this; a flood is sent in several frames.
const MAX_FRAME_BYTES: usize = 256 * 1024;

#[derive(Debug, Error)]
pub enum TerminalError {
    #[error(transparent)]
    Trust(#[from] TrustError),
    #[error(transparent)]
    Supervision(#[from] SupervisionError),
    #[error("terminal error: {0}")]
    Pty(String),
}

fn pty_error(error: impl std::fmt::Display) -> TerminalError {
    TerminalError::Pty(error.to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalSize {
    pub cols: u16,
    pub rows: u16,
}

impl TerminalSize {
    fn pty(self) -> PtySize {
        PtySize {
            rows: self.rows.max(1),
            cols: self.cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TerminalEvent {
    /// Bytes the shell wrote during one frame (raw: may end inside a UTF-8 sequence).
    Output(Vec<u8>),
    /// The shell exited; nothing follows.
    Exited,
}

pub type TerminalSink = Arc<dyn Fn(TerminalEvent) + Send + Sync>;

/// What to run. `program: None` is the user's login shell.
#[derive(Debug, Clone, Default)]
pub struct TerminalLaunch {
    pub program: Option<PathBuf>,
    pub args: Vec<String>,
}

pub struct TerminalSession {
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
    watchdog: Mutex<Option<OrphanWatchdog>>,
    pid: u32,
}

impl std::fmt::Debug for TerminalSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TerminalSession")
            .field("pid", &self.pid)
            .finish_non_exhaustive()
    }
}

fn lock<T: ?Sized>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl TerminalSession {
    /// Starts a shell in the workspace root. Refused unless the workspace is trusted.
    pub fn spawn(
        gate: &WorkspaceTrustGate,
        launch: &TerminalLaunch,
        size: TerminalSize,
        sink: TerminalSink,
    ) -> Result<Self, TerminalError> {
        gate.authorize(GatedCapability::Terminal)?;
        let pair = native_pty_system().openpty(size.pty()).map_err(pty_error)?;
        let mut command = match &launch.program {
            Some(program) => {
                let mut command = CommandBuilder::new(program);
                command.args(&launch.args);
                command
            }
            None => CommandBuilder::new_default_prog(),
        };
        command.cwd(gate.workspace_root());
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env("TERM_PROGRAM", "Coloride");
        // Trust may have been revoked while the pty was being opened.
        gate.authorize(GatedCapability::Terminal)?;
        let mut child = pair.slave.spawn_command(command).map_err(pty_error)?;
        drop(pair.slave);
        gate.note_spawned();
        let pid = child.process_id().unwrap_or_default();
        let watchdog = match OrphanWatchdog::start(pid) {
            Ok(watchdog) => watchdog,
            Err(error) => {
                // Never leave an unsupervised shell running.
                kill_process_group(pid);
                let _ = child.kill();
                let _ = child.wait();
                return Err(error.into());
            }
        };
        let reader = pair.master.try_clone_reader().map_err(pty_error)?;
        let writer = pair.master.take_writer().map_err(pty_error)?;
        spawn_output_pump(reader, sink);
        Ok(Self {
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            child: Mutex::new(child),
            watchdog: Mutex::new(Some(watchdog)),
            pid,
        })
    }

    /// OS process id of the shell, which is also its process group id.
    #[must_use]
    pub fn process_id(&self) -> u32 {
        self.pid
    }

    /// Sends keystrokes (or pasted text) to the shell.
    pub fn write(&self, bytes: &[u8]) -> Result<(), TerminalError> {
        let mut writer = lock(&self.writer);
        writer.write_all(bytes).map_err(pty_error)?;
        writer.flush().map_err(pty_error)
    }

    pub fn resize(&self, size: TerminalSize) -> Result<(), TerminalError> {
        lock(&self.master).resize(size.pty()).map_err(pty_error)
    }

    /// Whether the shell has exited.
    #[must_use]
    pub fn has_exited(&self) -> bool {
        matches!(lock(&self.child).try_wait(), Ok(Some(_)))
    }

    /// Kills the shell and every job it started, then reaps it.
    pub fn kill(&self) {
        let mut child = lock(&self.child);
        if !matches!(child.try_wait(), Ok(Some(_))) {
            // Not reaped, so the group id still belongs to this shell.
            kill_process_group(self.pid);
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(watchdog) = lock(&self.watchdog).take() {
            watchdog.stop();
        }
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Reads the pty on one thread and hands frames to `sink` from another, so a slow consumer
/// never stalls the shell and a fast shell never floods the consumer.
fn spawn_output_pump(mut reader: Box<dyn Read + Send>, sink: TerminalSink) {
    let (chunks, received) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 16 * 1024];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break, // EOF / EIO once the shell and its jobs are gone
                Ok(read) => {
                    if chunks.send(buffer[..read].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    std::thread::spawn(move || {
        let mut last_sent: Option<Instant> = None;
        while let Ok(first) = received.recv() {
            // A frame closes no sooner than one frame after the previous one was sent.
            let started = match last_sent {
                Some(sent) if sent.elapsed() < TERMINAL_FRAME => sent,
                _ => Instant::now(),
            };
            let mut frame = first;
            let mut ended = false;
            while frame.len() < MAX_FRAME_BYTES {
                let Some(left) = TERMINAL_FRAME.checked_sub(started.elapsed()) else {
                    break;
                };
                match received.recv_timeout(left) {
                    Ok(more) => frame.extend_from_slice(&more),
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => {
                        ended = true;
                        break;
                    }
                }
            }
            if !ended && frame.len() < MAX_FRAME_BYTES {
                if let Some(left) = TERMINAL_FRAME.checked_sub(started.elapsed()) {
                    std::thread::sleep(left);
                }
            }
            sink(TerminalEvent::Output(frame));
            last_sent = Some(Instant::now());
            if ended {
                break;
            }
        }
        sink(TerminalEvent::Exited);
    });
}
