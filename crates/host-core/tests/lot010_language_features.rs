//! LOT-010 — definitions, references, rename, formatting and completions from the **real**
//! `vtsls` and Biome (installed by `pnpm install`), bound to the revision they were asked for.
#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use host_core::{
    biome_server_spec, vtsls_server_spec, DocumentService, EditorSelection, EditorTransaction,
    LanguageFeature, LanguageFeatureRequest, LanguageFeatureResult, LanguageServices, LspError,
    TextChange, TransactionOrigin, Utf16CodeUnitOffset, Utf16Span, WorkspaceTrustGate,
    CONTRACT_SCHEMA_VERSION,
};

const DOCUMENT_ID: &str = "src/main.ts";
const GENERATION: u32 = 1;
const TIMEOUT: Duration = Duration::from_secs(60);
/// "𝄞" (two UTF-16 units) before every symbol: spans are right only if counted in UTF-16.
const MAIN: &str = "import { helper } from \"./util\";\nconst clef = \"𝄞\"; const counter = 1;\nexport const total = counter + helper(counter);\n";
const UTIL: &str = "export function helper(value: number): number {\n  return value * 2;\n}\n";

fn tool(name: &str) -> PathBuf {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../node_modules/.bin")
        .join(name);
    assert!(
        path.is_file(),
        "the real {name} is required: run `pnpm install`"
    );
    path.canonicalize().unwrap()
}

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    documents: DocumentService,
    services: LanguageServices,
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
    std::fs::write(root.join(DOCUMENT_ID), MAIN).unwrap();
    std::fs::write(root.join("src/util.ts"), UTIL).unwrap();
    let root = root.canonicalize().unwrap();
    let gate = WorkspaceTrustGate::open(dir.path().join("trust.json"), &root).unwrap();
    gate.grant().unwrap();
    let services = LanguageServices::new(gate, Arc::new(|_| {}));
    services
        .try_ensure_server(&vtsls_server_spec(tool("vtsls")))
        .unwrap_or_else(|error| panic!("language server did not start: {error}"));
    services
        .try_ensure_server(&biome_server_spec(tool("biome")))
        .unwrap_or_else(|error| panic!("language server did not start: {error}"));
    let mut documents = DocumentService::new_in_memory();
    documents
        .open_document_from_disk(DOCUMENT_ID, GENERATION, root.join(DOCUMENT_ID))
        .unwrap();
    services.document_opened(documents.session(DOCUMENT_ID, GENERATION).unwrap());
    Fixture {
        _dir: dir,
        root,
        documents,
        services,
    }
}

impl Fixture {
    fn path(&self) -> PathBuf {
        self.root.join(DOCUMENT_ID)
    }
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
    /// UTF-16 offset of the `nth` occurrence of `needle` (plus `within` units).
    fn offset(&self, needle: &str, nth: usize, within: u32) -> u32 {
        let text = self.text();
        let byte = text.match_indices(needle).nth(nth).unwrap().0;
        text[..byte].encode_utf16().count() as u32 + within
    }
    fn ask(
        &self,
        revision: u32,
        position: u32,
        feature: LanguageFeature,
    ) -> Result<LanguageFeatureResult, LspError> {
        let request = LanguageFeatureRequest {
            document_id: DOCUMENT_ID.into(),
            session_generation: GENERATION,
            revision,
            position_utf16: Utf16CodeUnitOffset::new(position),
            feature,
        };
        let response = self
            .services
            .request_feature(&self.path(), &request, TIMEOUT)?;
        assert_eq!(response.base_revision, revision);
        assert_eq!(
            response.content_blake3_hash,
            self.documents
                .session(DOCUMENT_ID, GENERATION)
                .unwrap()
                .content_blake3_hash()
        );
        Ok(response.result)
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
            inserted_text: inserted.into(),
        }];
        self.documents
            .apply_transaction(EditorTransaction {
                schema_version: CONTRACT_SCHEMA_VERSION,
                document_id: DOCUMENT_ID.into(),
                session_generation: GENERATION,
                base_revision,
                op_id: format!("op-{base_revision}"),
                changes: changes.clone(),
                selection: EditorSelection::default(),
                origin: TransactionOrigin::User,
                ime_composing: false,
            })
            .unwrap();
        self.services.transaction_applied(
            &rope_before,
            &changes,
            self.documents.session(DOCUMENT_ID, GENERATION).unwrap(),
        );
    }
    fn covered(&self, span: Utf16Span) -> String {
        let units: Vec<u16> = self.text().encode_utf16().collect();
        String::from_utf16(&units[span.start.as_usize()..span.end.as_usize()]).unwrap()
    }
}

#[test]
fn definition_and_references_point_at_the_right_text_including_other_files() {
    let fx = fixture();
    let at_use = fx.offset("counter", 1, 2);
    let LanguageFeatureResult::Locations { locations } = fx
        .ask(fx.revision(), at_use, LanguageFeature::Definition)
        .unwrap()
    else {
        panic!()
    };
    let declaration = locations
        .iter()
        .find_map(|l| l.span_utf16)
        .expect("definition in this file");
    assert_eq!(declaration.start.as_u32(), fx.offset("counter", 0, 0));
    assert_eq!(fx.covered(declaration), "counter");

    let at_helper = fx.offset("helper(", 0, 1);
    // Until its semantic project is loaded, vtsls answers from its syntax-only server, which
    // stops at the import binding. Every answer must be exact for this revision; the one from
    // the loaded project reaches util.ts.
    let deadline = std::time::Instant::now() + TIMEOUT;
    let other = loop {
        let LanguageFeatureResult::Locations { locations } = fx
            .ask(fx.revision(), at_helper, LanguageFeature::Definition)
            .unwrap()
        else {
            panic!()
        };
        for span in locations.iter().filter_map(|l| l.span_utf16) {
            assert_eq!(fx.covered(span), "helper");
        }
        if let Some(other) = locations.into_iter().find(|l| l.span_utf16.is_none()) {
            break other;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "definition never reached util.ts"
        );
        std::thread::sleep(Duration::from_millis(100));
    };
    assert_eq!(
        (
            other.file_path.as_str(),
            other.inside_workspace,
            other.start.line
        ),
        ("src/util.ts", true, 0)
    );

    let LanguageFeatureResult::Locations { locations } = fx
        .ask(fx.revision(), at_use, LanguageFeature::References)
        .unwrap()
    else {
        panic!()
    };
    let in_document: Vec<String> = locations
        .iter()
        .filter_map(|l| l.span_utf16)
        .map(|s| fx.covered(s))
        .collect();
    assert_eq!(in_document, ["counter", "counter", "counter"]);
}

#[test]
fn rename_edits_this_document_and_reports_other_files() {
    let fx = fixture();
    let LanguageFeatureResult::Rename { edits, other_files } = fx
        .ask(
            fx.revision(),
            fx.offset("helper", 0, 1),
            LanguageFeature::Rename {
                new_name: "twice".into(),
            },
        )
        .unwrap()
    else {
        panic!()
    };
    // Renamed at a use of an imported name, TypeScript renames the local binding: the import
    // becomes `helper as twice` and util.ts is left alone. Applying the edits to this
    // revision's text must give exactly that.
    let mut units: Vec<u16> = fx.text().encode_utf16().collect();
    for edit in edits.iter().rev() {
        units.splice(
            edit.span_utf16.start.as_usize()..edit.span_utf16.end.as_usize(),
            edit.new_text.encode_utf16(),
        );
    }
    let renamed = String::from_utf16(&units).unwrap();
    assert!(
        renamed.starts_with("import { helper as twice } from \"./util\";"),
        "{renamed}"
    );
    assert!(renamed.contains("counter + twice(counter)"), "{renamed}");
    assert!(other_files.is_empty());
}

#[test]
fn completions_list_symbols_in_scope() {
    let mut fx = fixture();
    let end = fx.text().encode_utf16().count() as u32;
    fx.edit(end, end, "coun");
    let LanguageFeatureResult::Completions { items, .. } = fx
        .ask(fx.revision(), end + 4, LanguageFeature::Completion)
        .unwrap()
    else {
        panic!()
    };
    assert!(
        items
            .iter()
            .any(|i| i.label == "counter" && i.kind == "variable"),
        "{:?}",
        items.iter().map(|i| &i.label).take(20).collect::<Vec<_>>()
    );
}

#[test]
fn formatting_comes_from_biome_and_edits_the_revision_it_was_asked_for() {
    let mut fx = fixture();
    let end = fx.text().encode_utf16().count() as u32;
    fx.edit(end, end, "const   spaced   =   1 ;\n");
    let LanguageFeatureResult::Edits { edits } = fx
        .ask(fx.revision(), 0, LanguageFeature::Formatting)
        .unwrap()
    else {
        panic!()
    };
    assert!(!edits.is_empty());
    // Applying them (back to front) to this revision's text gives Biome's formatting.
    let mut units: Vec<u16> = fx.text().encode_utf16().collect();
    for edit in edits.iter().rev() {
        units.splice(
            edit.span_utf16.start.as_usize()..edit.span_utf16.end.as_usize(),
            edit.new_text.encode_utf16(),
        );
    }
    let formatted = String::from_utf16(&units).unwrap();
    assert!(formatted.contains("const spaced = 1;"), "{formatted}");
    assert!(formatted.contains("const clef = \"𝄞\";"));
}

#[test]
fn a_request_for_an_outdated_revision_is_refused_not_answered_against_newer_text() {
    let mut fx = fixture();
    let old = fx.revision();
    let position = fx.offset("counter", 1, 2);
    fx.edit(0, 0, "// moved\n");
    let refused = fx.ask(old, position, LanguageFeature::Definition);
    assert!(
        matches!(refused, Err(LspError::StaleRevision { requested, current }) if requested == old && current == old + 1)
    );
    // The same question about the current revision is answered.
    assert!(fx
        .ask(
            fx.revision(),
            fx.offset("counter", 1, 2),
            LanguageFeature::Definition
        )
        .is_ok());
}
