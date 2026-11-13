//! LOT-010 risk mitigation: children launched by the Host never outlive it.
//!
//! Real processes only. The "Host" of the abrupt-exit scenario is this test binary re-executed
//! in a helper mode, then killed with `SIGKILL` so that none of its destructors run.
#![cfg(unix)]
// Tests may start plain processes (the helper Host, `ps`); production code may not.
#![allow(clippy::disallowed_methods)]

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use host_core::{GatedCapability, WorkspaceTrustGate};

const HELPER_ENV: &str = "COLORIDE_LOT010_HOST_HELPER_DIR";

fn is_alive(pid: u32) -> bool {
    // `ps -p` exits 0 only while the pid exists (a zombie has `Z` state: treat as dead).
    let output = Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .expect("ps");
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
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

/// A long-lived child that ignores its stdin and starts a grandchild, like a language server
/// that forks workers. Prints the grandchild's pid.
fn spawn_stubborn_tree(gate: &WorkspaceTrustGate) -> (host_core::SupervisedChild, u32) {
    let mut command = gate
        .command(GatedCapability::WorkspaceLanguageServer, "/bin/sh")
        .unwrap();
    command
        .command_mut()
        .arg("-c")
        .arg("sleep 600 & echo $!; wait")
        .stdin(Stdio::null())
        .stdout(Stdio::piped());
    let mut child = command.spawn().unwrap();
    let mut line = String::new();
    BufReader::new(child.take_stdout().unwrap())
        .read_line(&mut line)
        .unwrap();
    let grandchild: u32 = line.trim().parse().expect("grandchild pid");
    (child, grandchild)
}

fn trusted_gate(dir: &std::path::Path) -> WorkspaceTrustGate {
    let workspace = dir.join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let gate = WorkspaceTrustGate::open(dir.join("trust.json"), &workspace).unwrap();
    gate.grant().unwrap();
    gate
}

#[test]
fn dropping_the_handle_kills_the_child_and_its_descendants() {
    let dir = tempfile::tempdir().unwrap();
    let gate = trusted_gate(dir.path());
    let (child, grandchild) = spawn_stubborn_tree(&gate);
    let pid = child.id();
    assert!(is_alive(pid) && is_alive(grandchild));

    drop(child);
    assert!(wait_until_dead(pid), "child survived its handle");
    assert!(
        wait_until_dead(grandchild),
        "grandchild survived its handle"
    );
}

/// Not a test of its own: the Host process of the scenario below. Does nothing unless the
/// environment variable is set by that scenario.
#[test]
fn helper_host_process() {
    let Ok(dir) = std::env::var(HELPER_ENV) else {
        return;
    };
    let gate = trusted_gate(std::path::Path::new(&dir));
    let (child, grandchild) = spawn_stubborn_tree(&gate);
    println!("\nPIDS {} {}", child.id(), grandchild);
    // Killed from outside while sleeping: no destructor ever runs.
    std::thread::sleep(Duration::from_secs(600));
}

#[test]
fn an_abruptly_killed_host_leaves_no_orphans() {
    let dir = tempfile::tempdir().unwrap();
    let mut host = Command::new(std::env::current_exe().unwrap())
        .args([
            "helper_host_process",
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
    for line in BufReader::new(host.stdout.take().unwrap()).lines() {
        let line = line.unwrap();
        if let Some(rest) = line.strip_prefix("PIDS ") {
            let mut parts = rest
                .split_whitespace()
                .map(|part| part.parse::<u32>().unwrap());
            pids = Some((parts.next().unwrap(), parts.next().unwrap()));
            break;
        }
    }
    let (child, grandchild) = pids.expect("helper host reported its children");
    assert!(is_alive(child) && is_alive(grandchild));

    host.kill().unwrap(); // SIGKILL: the abrupt exit
    host.wait().unwrap();

    assert!(
        wait_until_dead(child),
        "child orphaned by an abrupt Host exit"
    );
    assert!(
        wait_until_dead(grandchild),
        "grandchild orphaned by an abrupt Host exit"
    );
}
