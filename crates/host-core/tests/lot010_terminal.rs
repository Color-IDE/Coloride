//! LOT-010 — integrated terminal on a real pseudo-terminal with real shells.
#![cfg(unix)]
#![allow(clippy::disallowed_methods)] // `ps` and the helper Host in tests

use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::time::{Duration, Instant};

use host_core::{
    GatedCapability, TerminalEvent, TerminalLaunch, TerminalSession, TerminalSize, TrustError,
    WorkspaceTrustGate, TERMINAL_FRAME,
};

const SIZE: TerminalSize = TerminalSize {
    cols: 100,
    rows: 30,
};
const HELPER_ENV: &str = "COLORIDE_LOT010_TERMINAL_HOST_DIR";

fn gate(dir: &std::path::Path, trusted: bool) -> WorkspaceTrustGate {
    let workspace = dir.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let gate = WorkspaceTrustGate::open(dir.join("trust.json"), &workspace).unwrap();
    if trusted {
        gate.grant().unwrap();
    }
    gate
}

fn sh(script: &str) -> TerminalLaunch {
    TerminalLaunch {
        program: Some("/bin/sh".into()),
        args: vec!["-c".into(), script.into()],
    }
}

fn open(
    gate: &WorkspaceTrustGate,
    launch: &TerminalLaunch,
) -> (TerminalSession, Receiver<(Instant, TerminalEvent)>) {
    let (sender, events) = mpsc::channel();
    let sender = std::sync::Mutex::new(sender);
    let session = TerminalSession::spawn(
        gate,
        launch,
        SIZE,
        Arc::new(move |event| {
            let _ = sender.lock().unwrap().send((Instant::now(), event));
        }),
    )
    .unwrap();
    (session, events)
}

/// Collects output until `needle` appears (or the shell exits).
fn read_until(events: &Receiver<(Instant, TerminalEvent)>, needle: &str) -> String {
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut output = Vec::new();
    while !String::from_utf8_lossy(&output).contains(needle) {
        let left = deadline
            .checked_duration_since(Instant::now())
            .unwrap_or_default();
        let Ok((_, event)) = events.recv_timeout(left) else {
            panic!(
                "no {needle:?} in terminal output: {:?}",
                String::from_utf8_lossy(&output)
            );
        };
        match event {
            TerminalEvent::Output(bytes) => output.extend(bytes),
            TerminalEvent::Exited => break,
        }
    }
    String::from_utf8_lossy(&output).into_owned()
}

fn is_alive(pid: u32) -> bool {
    let output = Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    output.status.success()
        && !String::from_utf8_lossy(&output.stdout)
            .trim()
            .starts_with('Z')
}

fn wait_until_dead(pid: u32) -> bool {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if !is_alive(pid) {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    false
}

#[test]
fn an_untrusted_workspace_gets_no_terminal() {
    let dir = tempfile::tempdir().unwrap();
    let gate = gate(dir.path(), false);
    let refused = TerminalSession::spawn(&gate, &TerminalLaunch::default(), SIZE, Arc::new(|_| {}));
    assert!(matches!(
        refused,
        Err(host_core::TerminalError::Trust(TrustError::Untrusted {
            capability: GatedCapability::Terminal,
            ..
        }))
    ));
    assert_eq!(gate.spawned_process_count(), 0);
}

#[test]
fn keystrokes_reach_the_shell_in_the_workspace_and_its_output_comes_back() {
    let dir = tempfile::tempdir().unwrap();
    let gate = gate(dir.path(), true);
    let (session, events) = open(&gate, &sh("exec /bin/sh -i"));
    session.write(b"echo \"ok-$((40+2))\"; pwd\n").unwrap();
    // One frame may hold both answers: read until the later one, then check both.
    let output = read_until(&events, "/workspace");
    assert!(output.contains("ok-42"), "{output}");
    assert_eq!(gate.spawned_process_count(), 1);

    // Resizing reaches the pty (`stty size` prints "rows cols").
    session
        .resize(TerminalSize {
            cols: 132,
            rows: 41,
        })
        .unwrap();
    session.write(b"stty size\n").unwrap();
    assert!(read_until(&events, "41 132").contains("41 132"));
}

#[test]
fn output_is_delivered_in_frames_at_most_one_per_16_ms() {
    let dir = tempfile::tempdir().unwrap();
    let gate = gate(dir.path(), true);
    let (_session, events) = open(
        &gate,
        &sh("i=0; while [ $i -lt 3000 ]; do echo line$i; i=$((i+1)); done"),
    );
    let mut frames = Vec::new();
    let mut output = Vec::new();
    loop {
        let (at, event) = events.recv_timeout(Duration::from_secs(20)).unwrap();
        match event {
            TerminalEvent::Output(bytes) => {
                frames.push(at);
                output.extend(bytes);
            }
            TerminalEvent::Exited => break,
        }
    }
    let text = String::from_utf8_lossy(&output);
    assert!(text.contains("line0") && text.contains("line2999"));
    assert!(
        frames.len() < 3000 / 10,
        "{} frames for 3000 lines: not batched",
        frames.len()
    );
    let tolerance = Duration::from_millis(1);
    // The last frame is flushed as soon as the shell exits.
    for pair in frames[..frames.len() - 1].windows(2) {
        assert!(
            pair[1] - pair[0] + tolerance >= TERMINAL_FRAME,
            "frames {:?} apart",
            pair[1] - pair[0]
        );
    }
}

#[test]
fn closing_the_terminal_kills_the_shell_and_its_background_jobs() {
    let dir = tempfile::tempdir().unwrap();
    let gate = gate(dir.path(), true);
    let (session, events) = open(&gate, &sh("sleep 600 & echo job=$!; wait"));
    let output = read_until(&events, "\n");
    let job: u32 = output.split("job=").nth(1).unwrap().trim().parse().unwrap();
    let shell = session.process_id();
    assert!(is_alive(shell) && is_alive(job));
    drop(session);
    assert!(wait_until_dead(shell));
    assert!(wait_until_dead(job), "background job survived the terminal");
}

/// Not a test of its own: the Host of the scenario below (does nothing unless asked).
#[test]
fn helper_host_with_a_terminal() {
    let Ok(dir) = std::env::var(HELPER_ENV) else {
        return;
    };
    let gate = gate(std::path::Path::new(&dir), true);
    let (session, events) = open(&gate, &sh("sleep 600 & echo job=$!; wait"));
    let output = read_until(&events, "\n");
    let job = output.split("job=").nth(1).unwrap().trim().to_string();
    println!("\nPIDS {} {}", session.process_id(), job);
    std::thread::sleep(Duration::from_secs(600));
}

#[test]
fn a_host_killed_abruptly_leaves_no_terminal_behind() {
    use std::io::BufRead;
    let dir = tempfile::tempdir().unwrap();
    let mut host = Command::new(std::env::current_exe().unwrap())
        .args([
            "helper_host_with_a_terminal",
            "--exact",
            "--nocapture",
            "--test-threads=1",
        ])
        .env(HELPER_ENV, dir.path())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut pids = None;
    for line in std::io::BufReader::new(host.stdout.take().unwrap()).lines() {
        let line = line.unwrap();
        if let Some(rest) = line.strip_prefix("PIDS ") {
            let mut parts = rest
                .split_whitespace()
                .map(|part| part.parse::<u32>().unwrap());
            pids = Some((parts.next().unwrap(), parts.next().unwrap()));
            break;
        }
    }
    let (shell, job) = pids.expect("helper host reported its terminal");
    assert!(is_alive(shell) && is_alive(job));
    host.kill().unwrap(); // SIGKILL
    host.wait().unwrap();
    assert!(
        wait_until_dead(shell),
        "shell orphaned by an abrupt Host exit"
    );
    assert!(wait_until_dead(job), "job orphaned by an abrupt Host exit");
}
