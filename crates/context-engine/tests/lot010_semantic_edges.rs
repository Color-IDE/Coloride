//! LOT-010 — dependency edges confirmed by a language server become `ExactSemantic`.

use context_engine::{AclAndSecretScanner, GraphEdgeConfidence, SqliteWalContextEngine};

fn confidence(
    engine: &SqliteWalContextEngine,
    importer: &str,
    target: &str,
) -> Option<GraphEdgeConfidence> {
    engine
        .symbol_edges_table()
        .iter()
        .find(|edge| edge.importer_file == importer && edge.target_file == target)
        .map(|edge| edge.confidence)
}

#[test]
fn a_confirmed_edge_stays_exact_semantic_until_its_importer_changes_its_imports() {
    let dir = tempfile::tempdir().unwrap();
    let mut engine = SqliteWalContextEngine::open(
        dir.path().join("index.sqlite3"),
        "main",
        AclAndSecretScanner::default(),
    )
    .unwrap();
    engine
        .index_file("src/b.ts", 1, "export const b = 1;\n")
        .unwrap();
    engine
        .index_file(
            "src/a.ts",
            1,
            "import { b } from \"./b\";\nexport const a = b;\n",
        )
        .unwrap();
    assert_eq!(
        confidence(&engine, "src/a.ts", "src/b.ts"),
        Some(GraphEdgeConfidence::SyntacticAst)
    );

    // No such edge: nothing is invented.
    assert!(!engine.confirm_semantic_edge("src/b.ts", "src/a.ts"));
    assert!(engine.confirm_semantic_edge("src/a.ts", "src/b.ts"));
    assert_eq!(
        confidence(&engine, "src/a.ts", "src/b.ts"),
        Some(GraphEdgeConfidence::ExactSemantic)
    );

    // Re-indexing the target, or the importer with the same imports, keeps the confirmation.
    engine
        .index_file("src/b.ts", 2, "export const b = 2;\n")
        .unwrap();
    engine
        .index_file(
            "src/a.ts",
            2,
            "import { b } from \"./b\";\nexport const a = b + 1;\n",
        )
        .unwrap();
    assert_eq!(
        confidence(&engine, "src/a.ts", "src/b.ts"),
        Some(GraphEdgeConfidence::ExactSemantic)
    );

    // The importer's imports change: the resolution must be confirmed again.
    engine
        .index_file(
            "src/a.ts",
            3,
            "import { b } from \"./b\";\nimport { c } from \"./c\";\nexport const a = b;\n",
        )
        .unwrap();
    assert_eq!(
        confidence(&engine, "src/a.ts", "src/b.ts"),
        Some(GraphEdgeConfidence::SyntacticAst)
    );
}
