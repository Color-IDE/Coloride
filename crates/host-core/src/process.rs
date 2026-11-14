//! Child processes that cannot outlive the Host (`LOT-010` risk: orphaned `vtsls`).
//!
//! Every process launched through [`crate::trust::GatedCommand`] becomes a [`SupervisedChild`]:
//!
//! * it leads its own process group, so the whole tree it starts is killed with it;
//! * dropping the handle (normal Host shutdown, a supervisor stopping, trust revoked) kills
//!   that group;
//! * a watchdog covers an abrupt Host exit (crash, `SIGKILL`), when no destructor runs: a tiny
//!   `sh` process blocks reading a pipe whose only write end the Host holds. The kernel closes
//!   that end when the Host dies, whatever the cause; the watchdog then kills the group.
//!
//! No `unsafe` is involved: the group is created with `CommandExt::process_group` and signalled
//! through `rustix`'s safe API. On platforms without this mechanism (Windows needs a Job
//! Object) launching fails with an explicit error instead of starting an unsupervised process.

use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, ExitStatus};

/// Why a child could not be put under supervision.
#[derive(Debug, thiserror::Error)]
pub enum SupervisionError {
    #[error("failed to launch the process: {0}")]
    Spawn(#[source] std::io::Error),
    #[error("failed to start the orphan watchdog: {0}")]
    Watchdog(#[source] std::io::Error),
    #[error("process supervision is not available on this platform; refusing to launch an unsupervised process")]
    Unsupported,
}

/// Kills a process group if the Host dies abruptly (see the module documentation).
#[derive(Debug)]
pub(crate) struct OrphanWatchdog {
    process: Child,
    /// Held open for as long as the Host lives: its closing is what triggers the watchdog.
    _trigger: Option<ChildStdin>,
}

impl OrphanWatchdog {
    /// Watches process group `group` (the pid of a child that leads its own group).
    #[cfg(unix)]
    pub(crate) fn start(group: u32) -> Result<Self, SupervisionError> {
        use std::os::unix::process::CommandExt;
        use std::process::Stdio;
        // `read` returns when the pipe is closed (it is never written to). `-s KILL --` is the
        // form that dash (the `/bin/sh` of Debian and Ubuntu) accepts for a group id: it rejects
        // `kill -KILL -- -<pgid>`.
        // Sanctioned launch: only reachable from gated launches (see `clippy.toml`).
        #[allow(clippy::disallowed_methods)]
        let mut process = Command::new("/bin/sh")
            .arg("-c")
            .arg(r#"read _; kill -s KILL -- "-$1" 2>/dev/null"#)
            .arg("coloride-watchdog")
            .arg(group.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            // Its own group: signals aimed at the Host's group or the child's do not stop it.
            .process_group(0)
            .spawn()
            .map_err(SupervisionError::Watchdog)?;
        let trigger = process.stdin.take();
        Ok(Self {
            process,
            _trigger: trigger,
        })
    }

    #[cfg(not(unix))]
    pub(crate) fn start(_group: u32) -> Result<Self, SupervisionError> {
        Err(SupervisionError::Unsupported)
    }

    /// The group is gone: stop watching before its id can be reused.
    pub(crate) fn stop(mut self) {
        let _ = self.process.kill();
        let _ = self.process.wait();
    }
}

/// Sends `SIGKILL` to process group `group`. Returns false if it could not be signalled.
#[cfg(unix)]
pub(crate) fn kill_process_group(group: u32) -> bool {
    use rustix::process::{kill_process_group, Pid, Signal};
    i32::try_from(group)
        .ok()
        .and_then(Pid::from_raw)
        .is_some_and(|group| kill_process_group(group, Signal::KILL).is_ok())
}

#[cfg(not(unix))]
pub(crate) fn kill_process_group(_group: u32) -> bool {
    false
}

/// A child process bound to the Host's lifetime. See the module documentation.
#[derive(Debug)]
pub struct SupervisedChild {
    child: Child,
    /// Stopped once the child is gone, so it never signals a recycled process group id.
    watchdog: Option<OrphanWatchdog>,
    reaped: bool,
}

impl SupervisedChild {
    #[cfg(unix)]
    pub(crate) fn spawn(mut command: Command) -> Result<Self, SupervisionError> {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
        let child = command.spawn().map_err(SupervisionError::Spawn)?;
        let mut supervised = Self {
            child,
            watchdog: None,
            reaped: false,
        };
        // If the watchdog cannot start, `supervised` is dropped here, which kills the child:
        // never run unsupervised.
        supervised.watchdog = Some(OrphanWatchdog::start(supervised.child.id())?);
        Ok(supervised)
    }

    #[cfg(not(unix))]
    pub(crate) fn spawn(_command: Command) -> Result<Self, SupervisionError> {
        Err(SupervisionError::Unsupported)
    }

    /// OS process id of the child, which is also its process group id.
    #[must_use]
    pub fn id(&self) -> u32 {
        self.child.id()
    }

    pub fn take_stdin(&mut self) -> Option<ChildStdin> {
        self.child.stdin.take()
    }

    pub fn take_stdout(&mut self) -> Option<ChildStdout> {
        self.child.stdout.take()
    }

    pub fn take_stderr(&mut self) -> Option<ChildStderr> {
        self.child.stderr.take()
    }

    /// Exit status if the child has already exited.
    pub fn try_wait(&mut self) -> std::io::Result<Option<ExitStatus>> {
        let status = self.child.try_wait()?;
        if status.is_some() {
            self.finish();
        }
        Ok(status)
    }

    /// Waits for the child to exit by itself.
    pub fn wait(&mut self) -> std::io::Result<ExitStatus> {
        let status = self.child.wait()?;
        self.finish();
        Ok(status)
    }

    /// Kills the child and everything it started, then reaps it.
    pub fn kill(&mut self) {
        if self.reaped {
            return;
        }
        // Not reaped yet, so the pid (and group id) still belongs to our child.
        if !kill_process_group(self.child.id()) {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
        self.finish();
    }

    fn finish(&mut self) {
        self.reaped = true;
        if let Some(watchdog) = self.watchdog.take() {
            watchdog.stop();
        }
    }
}

impl Drop for SupervisedChild {
    fn drop(&mut self) {
        self.kill();
    }
}
