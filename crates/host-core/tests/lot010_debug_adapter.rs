//! LOT-010 — JavaScript debugging with the **real** vscode-js-debug DAP server and real Node.
//! The adapter comes from `pnpm fetch:js-debug` (pinned version, verified SHA-256).
#![cfg(unix)]
#![allow(clippy::disallowed_methods)] // `ps` in a test

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::time::{Duration, Instant};

use host_core::{
    DebugCommand, DebugError, DebugEvent, DebugLaunch, DebugSession, DebugSessionRole, TrustError,
    WorkspaceTrustGate, DEBUG_EVENT_FRAME,
};

fn dap_server() -> PathBuf {
    let server = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tools/js-debug/v1.140.0/js-debug/src/dapDebugServer.js");
    assert!(
        server.is_file(),
        "the real js-debug adapter is required: run `pnpm fetch:js-debug`"
    );
    server.canonicalize().unwrap()
}

fn node() -> PathBuf {
    std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|dir| dir.join("node"))
        .find(|candidate| candidate.is_file())
        .expect("node on PATH")
}

const APP: &str = "const message = \"héllo 𝄞\";\nfunction add(a, b) {\n  const sum = a + b;\n  return sum;\n}\nconsole.log(message, add(40, 2));\n";

struct Fixture {
    _dir: tempfile::TempDir,
    gate: WorkspaceTrustGate,
    program: PathBuf,
}

fn fixture(trusted: bool, source: &str) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("workspace");
    std::fs::create_dir_all(&root).unwrap();
    std::fs::write(root.join("app.js"), source).unwrap();
    let root = root.canonicalize().unwrap();
    let gate = WorkspaceTrustGate::open(dir.path().join("trust.json"), &root).unwrap();
    if trusted {
        gate.grant().unwrap();
    }
    Fixture {
        _dir: dir,
        program: root.join("app.js"),
        gate,
    }
}

type Frames = Receiver<(Instant, Vec<DebugEvent>)>;

fn launch(fx: &Fixture, breakpoints: &[u32]) -> Result<(DebugSession, Frames), DebugError> {
    let (sender, frames) = mpsc::channel();
    let sender = std::sync::Mutex::new(sender);
    let session = DebugSession::launch(
        &fx.gate,
        &node(),
        &dap_server(),
        &DebugLaunch {
            program: fx.program.clone(),
            args: Vec::new(),
        },
        BTreeMap::from([(fx.program.clone(), breakpoints.to_vec())]),
        Arc::new(move |frame| {
            let _ = sender.lock().unwrap().send((Instant::now(), frame));
        }),
    )?;
    Ok((session, frames))
}

/// Collects events until one matches.
fn wait_for(
    frames: &Frames,
    seen: &mut Vec<(Instant, DebugEvent)>,
    matches: impl Fn(&DebugEvent) -> bool,
) -> DebugEvent {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Some((_, event)) = seen.iter().find(|(_, event)| matches(event)) {
            return event.clone();
        }
        let left = deadline
            .checked_duration_since(Instant::now())
            .unwrap_or_default();
        let (at, frame) = frames.recv_timeout(left).unwrap_or_else(|_| {
            panic!(
                "event not received; got {:?}",
                seen.iter().map(|(_, e)| &e.event).collect::<Vec<_>>()
            )
        });
        assert!(!frame.is_empty());
        seen.extend(frame.into_iter().map(|event| (at, event)));
    }
}

fn is_alive(pid: u32) -> bool {
    let output = std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .unwrap();
    output.status.success()
        && !String::from_utf8_lossy(&output.stdout)
            .trim()
            .starts_with('Z')
}

#[test]
fn nothing_is_launched_for_an_untrusted_workspace_or_a_program_outside_it() {
    let fx = fixture(false, APP);
    assert!(matches!(
        launch(&fx, &[4]),
        Err(DebugError::Trust(TrustError::Untrusted { .. }))
    ));
    assert_eq!(fx.gate.spawned_process_count(), 0);

    let trusted = fixture(true, APP);
    let outside = Fixture {
        program: fx.program.clone(),
        ..fixture(true, APP)
    };
    assert!(matches!(
        launch(&outside, &[4]),
        Err(DebugError::ProgramOutsideWorkspace)
    ));
    assert_eq!(outside.gate.spawned_process_count(), 0);
    drop(trusted);
}

#[test]
fn a_breakpoint_stops_the_program_and_its_stack_and_variables_can_be_read() {
    let fx = fixture(true, APP);
    let (session, frames) = launch(&fx, &[4]).unwrap();
    let mut seen = Vec::new();
    let stopped = wait_for(&frames, &mut seen, |e| {
        e.role == DebugSessionRole::Debuggee && e.event == "stopped"
    });
    assert_eq!(stopped.body["reason"], "breakpoint");
    let thread_id = stopped.body["threadId"].as_i64().unwrap();

    let stack = session
        .request(&DebugCommand::StackTrace { thread_id })
        .unwrap();
    let top = &stack["stackFrames"][0];
    assert_eq!(top["line"], 4);
    assert_eq!(
        top["source"]["path"]
            .as_str()
            .map(|p| p.ends_with("app.js")),
        Some(true)
    );
    let scopes = session
        .request(&DebugCommand::Scopes {
            frame_id: top["id"].as_i64().unwrap(),
        })
        .unwrap();
    let reference = scopes["scopes"][0]["variablesReference"].as_i64().unwrap();
    let variables = session
        .request(&DebugCommand::Variables {
            variables_reference: reference,
        })
        .unwrap();
    let value = |name: &str| {
        variables["variables"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["name"] == name)
            .map(|v| v["value"].as_str().unwrap().to_string())
    };
    assert_eq!(
        (value("a"), value("b"), value("sum")),
        (Some("40".into()), Some("2".into()), Some("42".into()))
    );
    let evaluated = session
        .request(&DebugCommand::Evaluate {
            expression: "a * b + sum".into(),
            frame_id: top["id"].as_i64(),
        })
        .unwrap();
    assert_eq!(evaluated["result"], "122"); // evaluated in the paused frame

    session
        .request(&DebugCommand::Continue { thread_id })
        .unwrap();
    let output = wait_for(&frames, &mut seen, |e| {
        e.event == "output"
            && e.body["output"]
                .as_str()
                .is_some_and(|text| text.contains("42"))
    });
    assert_eq!(
        output.body["output"].as_str().map(str::trim),
        Some("héllo 𝄞 42")
    );
    wait_for(&frames, &mut seen, |e| {
        e.role == DebugSessionRole::Debuggee && e.event == "terminated"
    });

    // Events arrived in frames at most one every 16 ms (the last one may close early).
    let mut sent: Vec<Instant> = seen.iter().map(|(at, _)| *at).collect();
    sent.dedup();
    for pair in sent.windows(2) {
        assert!(
            pair[1] - pair[0] + Duration::from_millis(1) >= DEBUG_EVENT_FRAME,
            "{:?}",
            pair[1] - pair[0]
        );
    }
}

#[test]
fn breakpoints_set_while_running_are_answered_by_the_adapter() {
    let fx = fixture(
        true,
        "setInterval(() => {\n  const tick = Date.now();\n}, 20);\n",
    );
    let (session, frames) = launch(&fx, &[]).unwrap();
    let mut seen = Vec::new();
    wait_for(&frames, &mut seen, |e| {
        e.role == DebugSessionRole::Debuggee && e.event == "thread"
    });
    let answer = session.set_breakpoints(&fx.program, vec![2]).unwrap();
    assert_eq!(answer["breakpoints"].as_array().map(Vec::len), Some(1));
    let stopped = wait_for(&frames, &mut seen, |e| e.event == "stopped");
    assert_eq!(stopped.body["reason"], "breakpoint");
}

#[test]
fn stopping_the_session_kills_the_adapter_and_the_debuggee() {
    let fx = fixture(
        true,
        "console.log(`pid=${process.pid}`);\nsetInterval(() => {}, 1000);\n",
    );
    let (session, frames) = launch(&fx, &[]).unwrap();
    let mut seen = Vec::new();
    let output = wait_for(&frames, &mut seen, |e| {
        e.event == "output"
            && e.body["output"]
                .as_str()
                .is_some_and(|text| text.contains("pid="))
    });
    let debuggee: u32 = output.body["output"]
        .as_str()
        .unwrap()
        .trim()
        .trim_start_matches("pid=")
        .parse()
        .unwrap();
    let adapter = session.adapter_process_id();
    assert!(is_alive(debuggee) && is_alive(adapter));
    // The debuggee is in the adapter's process group, so the orphan watchdog that kills the
    // adapter's group on an abrupt Host exit kills it too.
    let group = |pid: u32| {
        let output = std::process::Command::new("ps")
            .args(["-o", "pgid=", "-p", &pid.to_string()])
            .output()
            .unwrap();
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    };
    assert_eq!(
        group(debuggee),
        adapter.to_string(),
        "debuggee is outside the adapter's group"
    );

    drop(session);
    let deadline = Instant::now() + Duration::from_secs(10);
    while (is_alive(debuggee) || is_alive(adapter)) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(!is_alive(adapter), "adapter survived the session");
    assert!(!is_alive(debuggee), "debuggee survived the session");
}
