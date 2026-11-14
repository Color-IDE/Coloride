//! LOT-010 — `vtsls` fed from `ropey` buffers, with revision-tagged UTF-16 diagnostics.
//!
//! Runs the **real** `vtsls` (and the `tsserver` it forks) installed in this repository
//! (`pnpm install`), as real child processes. Nothing is mocked.
//!
//! `vtsls` pushes diagnostics without saying which document version they are for, so the Host
//! asks for them instead and only publishes an answer it can tie to one revision. The property
//! checked here is the one the editor relies on: every batch delivered is exact for the text of
//! the revision it names, also while edits keep coming.
#![cfg(unix)]

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::time::{Duration, Instant};

use host_core::{
    vtsls_server_spec, DiagnosticSeverity, DiagnosticSource, DocumentDiagnostics, DocumentService,
    EditorSelection, EditorTransaction, LanguageServices, TextChange, TransactionOrigin,
    Utf16CodeUnitOffset, Utf16Span, WorkspaceTrustGate, CONTRACT_SCHEMA_VERSION,
};

const DOCUMENT_ID: &str = "src/main.ts";
const GENERATION: u32 = 2;
/// "𝄞" takes two UTF-16 units: the span of `missing` is right only if they are counted so.
const INITIAL: &str = "const clef = \"𝄞\"; export const total: number = clef + missing;\n";

fn repository_vtsls() -> PathBuf {
    let vtsls = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../node_modules/.bin/vtsls");
    assert!(
        vtsls.is_file(),
        "the real vtsls is required for this test: run `pnpm install` ({} not found)",
        vtsls.display()
    );
    vtsls.canonicalize().unwrap()
}

struct Fixture {
    _dir: tempfile::TempDir,
    documents: DocumentService,
    services: LanguageServices,
    diagnostics: Receiver<DocumentDiagnostics>,
    /// The exact text of every revision the buffer went through.
    texts: HashMap<u32, String>,
    /// How long handing each edit to the language servers took (the keystroke's share).
    forward_times: Vec<Duration>,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("workspace");
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(
        root.join("tsconfig.json"),
        r#"{"compilerOptions":{"strict":true},"include":["src"]}"#,
    )
    .unwrap();
    std::fs::write(root.join(DOCUMENT_ID), INITIAL).unwrap();
    let root = root.canonicalize().unwrap();
    let gate = WorkspaceTrustGate::open(dir.path().join("trust.json"), &root).unwrap();
    gate.grant().unwrap();
    let (sender, diagnostics) = mpsc::channel();
    let services = LanguageServices::new(
        gate,
        Arc::new(move |batch| {
            let _ = sender.send(batch);
        }),
    );
    let mut documents = DocumentService::new_in_memory();
    documents
        .open_document_from_disk(DOCUMENT_ID, GENERATION, root.join(DOCUMENT_ID))
        .unwrap();
    let mut fx = Fixture {
        _dir: dir,
        documents,
        services,
        diagnostics,
        texts: HashMap::new(),
        forward_times: Vec::new(),
    };
    fx.remember();
    fx.services
        .try_ensure_server(&vtsls_server_spec(repository_vtsls()))
        .unwrap_or_else(|error| panic!("language server did not start: {error}"));
    fx.services
        .document_opened(fx.documents.session(DOCUMENT_ID, GENERATION).unwrap());
    fx
}

impl Fixture {
    fn revision(&self) -> u32 {
        self.documents
            .session(DOCUMENT_ID, GENERATION)
            .unwrap()
            .interactive_revision()
    }

    fn remember(&mut self) {
        let session = self.documents.session(DOCUMENT_ID, GENERATION).unwrap();
        self.texts
            .insert(session.interactive_revision(), session.text());
    }

    fn edit(&mut self, start: u32, end: u32, inserted: &str) {
        let session = self.documents.session(DOCUMENT_ID, GENERATION).unwrap();
        let rope_before = session.rope().clone();
        let base_revision = session.interactive_revision();
        let changes = vec![TextChange {
            range_utf16: Utf16Span::new(
                Utf16CodeUnitOffset::new(start),
                Utf16CodeUnitOffset::new(end),
            ),
            range_utf8: None,
            inserted_text: inserted.to_string(),
        }];
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
        let started = Instant::now();
        self.services.transaction_applied(
            &rope_before,
            &changes,
            self.documents.session(DOCUMENT_ID, GENERATION).unwrap(),
        );
        self.forward_times.push(started.elapsed());
        self.remember();
    }

    /// Checks one delivered batch against the text of the revision it names: every reported
    /// "Cannot find name 'X'" must cover exactly `X` in **that** text.
    fn assert_exact_for_its_revision(&self, batch: &DocumentDiagnostics) {
        assert_eq!(batch.source, DiagnosticSource::Vtsls);
        assert_eq!(batch.document_id, DOCUMENT_ID);
        assert_eq!(batch.session_generation, GENERATION);
        let text = self
            .texts
            .get(&batch.base_revision)
            .unwrap_or_else(|| panic!("batch names unknown revision {}", batch.base_revision));
        let units: Vec<u16> = text.encode_utf16().collect();
        for item in batch.items.iter().filter(|item| item.code == "2304") {
            let covered = String::from_utf16(
                &units[item.span_utf16.start.as_usize()..item.span_utf16.end.as_usize()],
            )
            .unwrap();
            assert_eq!(
                item.message,
                format!("Cannot find name '{covered}'."),
                "revision {}: span {:?} does not cover the name it reports",
                batch.base_revision,
                item.span_utf16
            );
        }
    }

    /// Collects batches (checking each) until one for `revision` arrives.
    fn diagnostics_for(&self, revision: u32) -> DocumentDiagnostics {
        let deadline = Instant::now() + Duration::from_secs(90);
        loop {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .unwrap_or_else(|| panic!("no vtsls diagnostics for revision {revision}"));
            let batch = self
                .diagnostics
                .recv_timeout(remaining)
                .unwrap_or_else(|_| panic!("no vtsls diagnostics for revision {revision}"));
            self.assert_exact_for_its_revision(&batch);
            if batch.base_revision == revision {
                return batch;
            }
        }
    }
}

fn missing_names(batch: &DocumentDiagnostics) -> Vec<&str> {
    batch
        .items
        .iter()
        .filter(|item| item.code == "2304")
        .map(|item| item.message.as_str())
        .collect()
}

#[test]
fn real_vtsls_reports_type_errors_tagged_with_their_revision() {
    let mut fx = fixture();
    let first = fx.diagnostics_for(fx.revision());
    assert_eq!(missing_names(&first), ["Cannot find name 'missing'."]);
    // `clef + missing` is a string: not assignable to `number`.
    let type_error = first.items.iter().find(|item| item.code == "2322");
    assert_eq!(
        type_error.map(|item| item.severity),
        Some(DiagnosticSeverity::Error)
    );
    assert_eq!(first.content_blake3_hash, {
        let session = fx.documents.session(DOCUMENT_ID, GENERATION).unwrap();
        session.content_blake3_hash().to_string()
    });

    // A line inserted above shifts everything: the next batch is for the next revision.
    fx.edit(0, 0, "// 𝄞 header\n");
    let second = fx.diagnostics_for(fx.revision());
    assert_eq!(missing_names(&second), ["Cannot find name 'missing'."]);
    let start = |batch: &DocumentDiagnostics| {
        batch
            .items
            .iter()
            .find(|item| item.code == "2304")
            .unwrap()
            .span_utf16
            .start
            .as_u32()
    };
    assert_eq!(
        start(&second),
        start(&first) + "// 𝄞 header\n".encode_utf16().count() as u32
    );

    // Declaring the name fixes it, in the buffer only (the file on disk is unchanged).
    fx.edit(0, 0, "declare const missing: string;\n");
    let third = fx.diagnostics_for(fx.revision());
    assert_eq!(missing_names(&third), Vec::<&str>::new());
}

#[test]
fn under_a_burst_of_edits_every_delivered_batch_is_exact_for_the_revision_it_names() {
    let mut fx = fixture();
    fx.diagnostics_for(fx.revision());

    // Keystrokes faster than tsserver answers, each one moving `missing` and adding a second
    // unknown name whose spelling changes at every revision.
    for round in 0..40_u32 {
        fx.edit(0, 0, if round % 2 == 0 { "/* a */ " } else { "\n" });
        let end = fx.texts[&fx.revision()].encode_utf16().count() as u32;
        fx.edit(end, end, &format!("unknown{round};\n"));
        std::thread::sleep(Duration::from_millis(7));
    }
    // `diagnostics_for` checks every batch on the way; the last revision must be reached, and
    // it reports the names present in the final text.
    // Two-speed: the keystroke only enqueues the delta; vtsls works on its own time.
    let mut times = fx.forward_times.clone();
    times.sort_unstable();
    let p95 = times[times.len() * 95 / 100];
    assert!(
        p95 < Duration::from_millis(2),
        "forwarding an edit took {p95:?} (p95)"
    );
    let last = fx.diagnostics_for(fx.revision());
    let mut names = missing_names(&last);
    names.sort_unstable();
    assert_eq!(
        names.len(),
        41,
        "`missing` plus the 40 `unknownN` names: {names:?}"
    );
    assert!(names.contains(&"Cannot find name 'unknown39'."));
}
