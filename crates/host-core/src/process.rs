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

/// A child process bound to the Host's lifetime. See the module documentation.
#[derive(Debug)]
pub struct SupervisedChild {
    child: Child,
    /// Killed once the child is gone, so it never signals a recycled process group id.
    watchdog: Option<Child>,
    /// Held open for as long as the Host lives: its closing is what triggers the watchdog.
    watchdog_trigger: Option<ChildStdin>,
    reaped: bool,
}

impl SupervisedChild {
    #[cfg(unix)]
    pub(crate) fn spawn(mut command: Command) -> Result<Self, SupervisionError> {
        use std::os::unix::process::CommandExt;
        use std::process::Stdio;

        command.process_group(0);
        let child = command.spawn().map_err(SupervisionError::Spawn)?;
        let mut supervised = Self {
            child,
            watchdog: None,
            watchdog_trigger: None,
            reaped: false,
        };
        // `read` returns when the pipe is closed (it is never written to). The group id equals
        // the child's pid because the child leads its group. If the watchdog cannot start,
        // `supervised` is dropped here, which kills the child: never run unsupervised.
        // Sanctioned launch: reachable only from `GatedCommand::spawn` (see `clippy.toml`).
        #[allow(clippy::disallowed_methods)]
        let mut watchdog = Command::new("/bin/sh")
            .arg("-c")
            .arg(r#"read _; kill -KILL -- "-$1" 2>/dev/null"#)
            .arg("coloride-watchdog")
            .arg(supervised.child.id().to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            // Its own group: signals aimed at the Host's group or the child's do not stop it.
            .process_group(0)
            .spawn()
            .map_err(SupervisionError::Watchdog)?;
        supervised.watchdog_trigger = watchdog.stdin.take();
        supervised.watchdog = Some(watchdog);
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
        self.kill_group();
        let _ = self.child.wait();
        self.finish();
    }

    #[cfg(unix)]
    fn kill_group(&mut self) {
        use rustix::process::{kill_process_group, Pid, Signal};
        // Not reaped yet, so the pid (and group id) still belongs to our child.
        let group = i32::try_from(self.child.id()).ok().and_then(Pid::from_raw);
        let signalled = group.is_some_and(|group| kill_process_group(group, Signal::KILL).is_ok());
        if !signalled {
            let _ = self.child.kill();
        }
    }

    #[cfg(not(unix))]
    fn kill_group(&mut self) {
        let _ = self.child.kill();
    }

    /// The child is reaped: stop the watchdog before its target id can be reused.
    fn finish(&mut self) {
        self.reaped = true;
        if let Some(mut watchdog) = self.watchdog.take() {
            let _ = watchdog.kill();
            let _ = watchdog.wait();
        }
        self.watchdog_trigger = None;
    }
}

impl Drop for SupervisedChild {
    fn drop(&mut self) {
        self.kill();
    }
}
