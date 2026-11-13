//! LOT-010 — Biome fed from `ropey` buffers, with revision-tagged UTF-16 diagnostics.
//!
//! Runs the **real** Biome binary installed in this repository (`pnpm install`), as a real
//! child process speaking LSP over stdio. Nothing is mocked.
#![cfg(unix)]
#![allow(clippy::disallowed_methods)] // `ps` in a test

use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::time::{Duration, Instant};

use host_core::{
    biome_server_spec, resolve_workspace_tool, DiagnosticSource, DocumentDiagnostics,
    DocumentService, EditorSelection, EditorTransaction, LanguageServices, TextChange,
    TransactionOrigin, Utf16CodeUnitOffset, Utf16Span, WorkspaceTrustGate, CONTRACT_SCHEMA_VERSION,
};

fn repository_biome() -> PathBuf {
    let biome = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../node_modules/.bin/biome");
    assert!(
        biome.is_file(),
        "the real Biome binary is required for this test: run `pnpm install` ({} not found)",
        biome.display()
    );
    biome.canonicalize().unwrap()
}

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    gate: WorkspaceTrustGate,
    documents: DocumentService,
    services: LanguageServices,
    diagnostics: Receiver<DocumentDiagnostics>,
}

const DOCUMENT_ID: &str = "src/main.ts";
const GENERATION: u32 = 3;
/// "𝄞" takes two UTF-16 units and four UTF-8 bytes: any unit mix-up shifts the spans below.
const INITIAL: &str = "const clef = \"𝄞\";\nexport const same = clef == \"x\";\n";

fn fixture(trusted: bool) -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("workspace");
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join(DOCUMENT_ID), INITIAL).unwrap();
    let root = root.canonicalize().unwrap();
    let gate = WorkspaceTrustGate::open(dir.path().join("trust.json"), &root).unwrap();
    if trusted {
        gate.grant().unwrap();
    }
    let (sender, diagnostics) = mpsc::channel();
    let services = LanguageServices::new(
        gate.clone(),
        Arc::new(move |batch| {
            let _ = sender.send(batch);
        }),
    );
    let mut documents = DocumentService::new_in_memory();
    documents
        .open_document_from_disk(DOCUMENT_ID, GENERATION, root.join(DOCUMENT_ID))
        .unwrap();
    Fixture {
        _dir: dir,
        root,
        gate,
        documents,
        services,
        diagnostics,
    }
}

impl Fixture {
    fn text(&self) -> String {
        self.documents
            .session(DOCUMENT_ID, GENERATION)
            .unwrap()
            .text()
    }

    fn revision(&self) -> u32 {
        self.documents
            .session(DOCUMENT_ID, GENERATION)
            .unwrap()
            .interactive_revision()
    }

    /// Applies a user edit to the authoritative rope, then feeds the delta to the servers.
    fn edit(&mut self, start: u32, end: u32, inserted: &str) {
        let session = self.documents.session(DOCUMENT_ID, GENERATION).unwrap();
        let rope_before = session.rope().clone();
        let changes = vec![TextChange {
            range_utf16: Utf16Span::new(
                Utf16CodeUnitOffset::new(start),
                Utf16CodeUnitOffset::new(end),
            ),
            range_utf8: None,
            inserted_text: inserted.to_string(),
        }];
        let base_revision = session.interactive_revision();
        self.documents
            .apply_transaction(EditorTransaction {
                schema_version: CONTRACT_SCHEMA_VERSION,
                document_id: DOCUMENT_ID.to_string(),
                session_generation: GENERATION,
                base_revision,
                op_id: format!("op-{base_revision}"),
                changes: changes.clone(),
                selection: EditorSelection::default(),
                origin: TransactionOrigin::User,
                ime_composing: false,
            })
            .unwrap();
        let session = self.documents.session(DOCUMENT_ID, GENERATION).unwrap();
        self.services
            .transaction_applied(&rope_before, &changes, session);
    }

    /// Waits for Biome's diagnostics for exactly `revision`.
    fn diagnostics_for(&self, revision: u32) -> DocumentDiagnostics {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .unwrap_or_else(|| panic!("no Biome diagnostics for revision {revision}"));
            let batch = self
                .diagnostics
                .recv_timeout(remaining)
                .unwrap_or_else(|_| panic!("no Biome diagnostics for revision {revision}"));
            assert!(
                batch.base_revision <= revision,
                "diagnostics from the future"
            );
            if batch.base_revision == revision {
                return batch;
            }
        }
    }
}

/// The text a diagnostic covers, sliced with UTF-16 offsets as CodeMirror 6 would.
fn covered(text: &str, batch: &DocumentDiagnostics, code: &str) -> String {
    let item = batch
        .items
        .iter()
        .find(|item| item.code == code)
        .unwrap_or_else(|| panic!("no `{code}` diagnostic in {:?}", batch.items));
    let units: Vec<u16> = text.encode_utf16().collect();
    String::from_utf16(&units[item.span_utf16.start.as_usize()..item.span_utf16.end.as_usize()])
        .unwrap()
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
fn real_biome_reports_diagnostics_tagged_with_the_revision_they_were_computed_for() {
    let mut fx = fixture(true);
    assert!(fx
        .services
        .ensure_server(&biome_server_spec(repository_biome())));
    assert!(fx.services.is_running(DiagnosticSource::Biome));
    let session = fx.documents.session(DOCUMENT_ID, GENERATION).unwrap();
    fx.services.document_opened(session);

    let opened_at = fx.revision();
    let first = fx.diagnostics_for(opened_at);
    assert_eq!(first.document_id, DOCUMENT_ID);
    assert_eq!(first.session_generation, GENERATION);
    assert_eq!(first.source, DiagnosticSource::Biome);
    assert_eq!(first.content_blake3_hash, session_hash(&fx));
    // The span is right only if columns after "𝄞" were counted in UTF-16 units.
    assert_eq!(
        covered(&fx.text(), &first, "lint/suspicious/noDoubleEquals"),
        "=="
    );

    // The user inserts a line above: an incremental delta, a new revision.
    fx.edit(0, 0, "// 𝄞 header\n");
    let second = fx.diagnostics_for(opened_at + 1);
    assert_eq!(second.content_blake3_hash, session_hash(&fx));
    assert_eq!(
        covered(&fx.text(), &second, "lint/suspicious/noDoubleEquals"),
        "=="
    );
    let shift = "// 𝄞 header\n".encode_utf16().count() as u32;
    let span = |batch: &DocumentDiagnostics| {
        batch
            .items
            .iter()
            .find(|item| item.code == "lint/suspicious/noDoubleEquals")
            .unwrap()
            .span_utf16
    };
    assert_eq!(
        span(&second).start.as_u32(),
        span(&first).start.as_u32() + shift
    );

    // Fixing the code clears the diagnostic at the next revision: the server really follows
    // the buffer, it does not re-read the file on disk (which still has `==`).
    let position = span(&second);
    fx.edit(position.start.as_u32(), position.end.as_u32(), "===");
    let third = fx.diagnostics_for(opened_at + 2);
    assert!(third
        .items
        .iter()
        .all(|item| item.code != "lint/suspicious/noDoubleEquals"));
    assert!(std::fs::read_to_string(fx.root.join(DOCUMENT_ID))
        .unwrap()
        .contains("clef == "));
}

fn session_hash(fx: &Fixture) -> String {
    fx.documents
        .session(DOCUMENT_ID, GENERATION)
        .unwrap()
        .content_blake3_hash()
        .to_string()
}

#[test]
fn a_document_opened_before_trust_is_picked_up_when_the_server_starts() {
    let fx = fixture(false);
    // Untrusted: the tool is not even resolved, and asking for the server launches nothing.
    assert_eq!(resolve_workspace_tool(&fx.gate, "biome"), None);
    assert!(!fx
        .services
        .ensure_server(&biome_server_spec(repository_biome())));
    fx.services
        .document_opened(fx.documents.session(DOCUMENT_ID, GENERATION).unwrap());
    assert_eq!(fx.gate.spawned_process_count(), 0);
    assert!(fx
        .diagnostics
        .recv_timeout(Duration::from_millis(300))
        .is_err());

    fx.gate.grant().unwrap();
    assert!(fx
        .services
        .ensure_server(&biome_server_spec(repository_biome())));
    let batch = fx.diagnostics_for(fx.revision());
    assert_eq!(
        covered(&fx.text(), &batch, "lint/suspicious/noDoubleEquals"),
        "=="
    );
}

#[test]
fn stopping_the_services_kills_the_server_process() {
    let fx = fixture(true);
    assert!(fx
        .services
        .ensure_server(&biome_server_spec(repository_biome())));
    let pids = fx.services.server_process_ids();
    assert_eq!(pids.len(), 1);
    assert!(is_alive(pids[0]));

    fx.services.stop();
    assert!(!fx.services.is_running(DiagnosticSource::Biome));
    let deadline = Instant::now() + Duration::from_secs(5);
    while is_alive(pids[0]) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(25));
    }
    assert!(!is_alive(pids[0]), "Biome survived LanguageServices::stop");

    // Revoked trust: it cannot be started again.
    fx.gate.revoke().unwrap();
    assert!(!fx
        .services
        .ensure_server(&biome_server_spec(repository_biome())));
}
