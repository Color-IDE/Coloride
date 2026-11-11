use std::time::Instant;

use context_engine::{
    apply_editor_transaction_and_collect_edits, build_input_edit_for_utf8_range,
    GraphEdgeConfidence, ImpactAnalyzer, IncrementalAstParser, RopeTextProvider,
    SupportedAstLanguage, SymbolKind,
};
use host_core::{
    EditorSelection, EditorTransaction, TextChange, TransactionOrigin, Utf16CodeUnitOffset,
    Utf16Span, Utf8ByteOffset, CONTRACT_SCHEMA_VERSION,
};
use proptest::prelude::*;
use ropey::Rope;

fn generate_1500_line_typescript_source() -> String {
    let mut out = String::with_capacity(90_000);
    out.push_str("import { Decimal } from \"./decimal\";\n");
    for i in 0u32..1_499 {
        match i % 5 {
            0 => out.push_str(&format!(
                "export function computeMetric_{i}(input: number): number {{ return input + {i}; }}\n"
            )),
            1 => out.push_str(&format!(
                "export interface MetricSpec_{i} {{ readonly id: number; readonly label: string; }}\n"
            )),
            2 => out.push_str(&format!(
                "export type MetricAlias_{i} = MetricSpec_{} | null;\n",
                i.saturating_sub(1)
            )),
            3 => out.push_str(&format!(
                "export class MetricController_{i} {{ readonly version = {i}; }}\n"
            )),
            _ => out.push_str(&format!(
                "export const METRIC_CONST_{i}: number = {};\n",
                i * 10
            )),
        }
    }
    out
}

fn percentile_95_micros(samples_us: &[u128]) -> u128 {
    if samples_us.is_empty() {
        return 0;
    }
    let mut sorted = samples_us.to_vec();
    sorted.sort_unstable();
    let idx = ((sorted.len() * 95).div_ceil(100)).saturating_sub(1);
    sorted[idx.min(sorted.len() - 1)]
}

#[test]
fn blocking_200_random_incremental_edits_on_1500_line_ts_file_match_cold_parse_under_5ms_p95() {
    let initial_source = generate_1500_line_typescript_source();
    let mut rope = Rope::from_str(&initial_source);
    assert_eq!(rope.len_lines(), 1_501);

    let mut parser = IncrementalAstParser::new();
    let initial_provider = RopeTextProvider::new(&rope);
    let mut tree = parser.parse_with(SupportedAstLanguage::TypeScript, &initial_provider, None);

    let mut latencies_us = Vec::with_capacity(200);
    let mut rng_state: u64 = 0xC010_71DE_2026_0007;

    for step in 0..200usize {
        rng_state = rng_state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        let total_lines = rope.len_lines().saturating_sub(1).max(1);
        let target_line = (rng_state as usize) % total_lines;
        let line_start_byte = rope.line_to_byte(target_line);
        let line_end_byte = rope.line_to_byte((target_line + 1).min(rope.len_lines()));

        let replacement = match step % 4 {
            0 => format!(
                "export function updatedFn_{step}(x: number): number {{ return x * {step}; }}\n"
            ),
            1 => format!(
                "export const UPDATED_FLAG_{step} = true;\nexport type Pair_{step} = [number, string];\n"
            ),
            2 => format!("export interface UpdatedView_{step} {{ readonly active: boolean; }}\n"),
            _ => "// comment replacement line\n".to_string(),
        };

        let edit = build_input_edit_for_utf8_range(
            &rope,
            Utf8ByteOffset::new(line_start_byte as u32),
            Utf8ByteOffset::new(line_end_byte as u32),
            &replacement,
        );

        let start_char = rope.byte_to_char(line_start_byte);
        let end_char = rope.byte_to_char(line_end_byte);
        rope.remove(start_char..end_char);
        rope.insert(start_char, &replacement);

        let t0 = Instant::now();
        tree.edit(&edit);
        let provider = RopeTextProvider::new(&rope);
        tree = parser.parse_with(SupportedAstLanguage::TypeScript, &provider, Some(&tree));
        latencies_us.push(t0.elapsed().as_micros());
    }

    // Verify p95 incremental re-parse is strictly < 5 ms (5,000 microseconds)
    let p95_us = percentile_95_micros(&latencies_us);
    assert!(
        p95_us < 5_000,
        "Expected incremental re-parse p95 < 5000 us (5 ms), got {p95_us} us"
    );

    // Cold full parse on the final Rope must produce 100% identical S-expression and symbols
    let mut cold_parser = IncrementalAstParser::new();
    let final_provider = RopeTextProvider::new(&rope);
    let cold_tree = cold_parser.parse_with(SupportedAstLanguage::TypeScript, &final_provider, None);

    assert_eq!(tree.to_sexp(), cold_tree.to_sexp());
    assert_eq!(tree.symbols(), cold_tree.symbols());
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]
    #[test]
    fn proptest_incremental_tree_edit_equivalence_across_random_line_mutations(
        ops in proptest::collection::vec((0usize..60, 0u8..4, 1u32..999), 1..25)
    ) {
        let mut base = String::new();
        for i in 0..60 {
            base.push_str(&format!("export function fn_{i}(v: number): number {{ return v + {i}; }}\n"));
        }
        let mut rope = Rope::from_str(&base);
        let mut parser = IncrementalAstParser::new();
        let mut tree = parser.parse_with(
            SupportedAstLanguage::TypeScript,
            &RopeTextProvider::new(&rope),
            None,
        );

        for (line_seed, kind, num) in ops {
            let max_line = rope.len_lines().saturating_sub(1).max(1);
            let line_idx = line_seed % max_line;
            let start_b = rope.line_to_byte(line_idx);
            let end_b = rope.line_to_byte((line_idx + 1).min(rope.len_lines()));
            let new_line = match kind {
                0 => format!("export function propFn_{num}(a: string): string {{ return a; }}\n"),
                1 => format!("export class PropService_{num} {{ readonly id = {num}; }}\n"),
                2 => format!("export const PROP_VAL_{num} = {num};\nexport type T_{num} = number;\n"),
                _ => "export broken syntax (((\n".to_string(),
            };
            let edit = build_input_edit_for_utf8_range(
                &rope,
                Utf8ByteOffset::new(start_b as u32),
                Utf8ByteOffset::new(end_b as u32),
                &new_line,
            );
            let sc = rope.byte_to_char(start_b);
            let ec = rope.byte_to_char(end_b);
            rope.remove(sc..ec);
            rope.insert(sc, &new_line);

            tree.edit(&edit);
            tree = parser.parse_with(
                SupportedAstLanguage::TypeScript,
                &RopeTextProvider::new(&rope),
                Some(&tree),
            );
        }

        let cold = parser.parse_with(
            SupportedAstLanguage::TypeScript,
            &RopeTextProvider::new(&rope),
            None,
        );
        prop_assert_eq!(tree.to_sexp(), cold.to_sexp());
        prop_assert_eq!(tree.symbols(), cold.symbols());
    }
}

#[test]
fn blocking_syntax_error_resilience_and_test_impact_analysis_under_10ms() {
    let mut parser = IncrementalAstParser::new();
    let mut analyzer = ImpactAnalyzer::new();

    // 1. Initial `src/utils/money.ts`
    let money_initial = "\
export interface MoneyConfig { readonly currency: string; readonly decimals: number; }
export function formatCurrency(amount: number, currency: string): string { return `${amount} ${currency}`; }
export function parseAmount(raw: string): number { return Number(raw); }
";
    let mut money_rope = Rope::from_str(money_initial);
    let mut money_tree = parser.parse_with(
        SupportedAstLanguage::TypeScript,
        &RopeTextProvider::new(&money_rope),
        None,
    );
    analyzer.index_file("src/utils/money.ts", &money_rope, &money_tree);

    // 2. `src/checkout/Cart.tsx` importing `formatCurrency` from `../utils/money`
    let cart_source = "\
import { formatCurrency } from \"../utils/money\";
export function Cart(props: { total: number }): JSX.Element { return formatCurrency(props.total, \"EUR\"); }
";
    let cart_rope = Rope::from_str(cart_source);
    let cart_tree = parser.parse_with(
        SupportedAstLanguage::Tsx,
        &RopeTextProvider::new(&cart_rope),
        None,
    );
    assert_eq!(cart_tree.symbols()[0].kind, SymbolKind::ReactComponent);
    analyzer.index_file("src/checkout/Cart.tsx", &cart_rope, &cart_tree);

    // 3. Direct unit test `src/utils/__tests__/money.test.ts`
    let money_test_source = "\
import { formatCurrency, parseAmount } from \"../money\";
const res = formatCurrency(42, \"EUR\");
";
    let money_test_rope = Rope::from_str(money_test_source);
    let money_test_tree = parser.parse_with(
        SupportedAstLanguage::TypeScript,
        &RopeTextProvider::new(&money_test_rope),
        None,
    );
    analyzer.index_file(
        "src/utils/__tests__/money.test.ts",
        &money_test_rope,
        &money_test_tree,
    );

    // 4. Transitive component test `src/checkout/__tests__/Cart.test.tsx`
    let cart_test_source = "\
import { Cart } from \"../Cart\";
const rendered = Cart({ total: 99 });
";
    let cart_test_rope = Rope::from_str(cart_test_source);
    let cart_test_tree = parser.parse_with(
        SupportedAstLanguage::Tsx,
        &RopeTextProvider::new(&cart_test_rope),
        None,
    );
    analyzer.index_file(
        "src/checkout/__tests__/Cart.test.tsx",
        &cart_test_rope,
        &cart_test_tree,
    );

    // 5. Unrelated test file that must NOT be returned
    let auth_test_source = "\
import { login } from \"../login\";
const ok = login(\"alice\");
";
    let auth_test_rope = Rope::from_str(auth_test_source);
    let auth_test_tree = parser.parse_with(
        SupportedAstLanguage::TypeScript,
        &RopeTextProvider::new(&auth_test_rope),
        None,
    );
    analyzer.index_file(
        "src/auth/__tests__/login.test.ts",
        &auth_test_rope,
        &auth_test_tree,
    );

    // Now modify the signature of `formatCurrency` in `src/utils/money.ts` AND introduce a
    // temporary syntax error on the very next line via an `EditorTransaction`.
    let line1_start_cu = money_rope.char_to_utf16_cu(money_rope.line_to_char(1)) as u32;
    let line1_end_cu = money_rope.char_to_utf16_cu(money_rope.line_to_char(2)) as u32;
    let modified_block = "\
export function formatCurrency(amount: number, currency = \"EUR\", locale = \"fr-FR\"): string { return `${amount} ${currency} ${locale}`; }
const brokenLine = (((\n";

    let tx = EditorTransaction {
        schema_version: CONTRACT_SCHEMA_VERSION,
        document_id: "src/utils/money.ts".to_string(),
        session_generation: 1,
        base_revision: 0,
        op_id: "op-money-sig".to_string(),
        changes: vec![TextChange {
            range_utf16: Utf16Span::new(
                Utf16CodeUnitOffset::new(line1_start_cu),
                Utf16CodeUnitOffset::new(line1_end_cu),
            ),
            range_utf8: None,
            inserted_text: modified_block.to_string(),
        }],
        selection: EditorSelection::default(),
        origin: TransactionOrigin::User,
        ime_composing: false,
    };

    let edits =
        apply_editor_transaction_and_collect_edits(&mut money_rope, &tx).expect("valid edit");
    for edit in &edits {
        money_tree.edit(edit);
    }
    money_tree = parser.parse_with(
        SupportedAstLanguage::TypeScript,
        &RopeTextProvider::new(&money_rope),
        Some(&money_tree),
    );

    // Verify Tree-sitter isolates the ERROR node while preserving all valid surrounding symbols!
    assert!(money_tree.has_error());
    assert_eq!(money_tree.error_count(), 1);
    assert!(money_tree.to_sexp().contains("(ERROR "));

    let preserved_symbol_names: Vec<String> =
        money_tree.symbols().into_iter().map(|s| s.name).collect();
    assert_eq!(
        preserved_symbol_names,
        vec![
            "MoneyConfig".to_string(),
            "formatCurrency".to_string(),
            "parseAmount".to_string()
        ]
    );

    // Re-index `src/utils/money.ts` and run Test Impact Analysis in < 10 ms
    analyzer.index_file("src/utils/money.ts", &money_rope, &money_tree);

    let t_impact = Instant::now();
    let impacted = analyzer.find_impacted_tests(&[("src/utils/money.ts", "formatCurrency")], 3);
    let impact_elapsed_ms = t_impact.elapsed().as_millis();
    assert!(
        impact_elapsed_ms < 10,
        "Expected find_impacted_tests < 10 ms, took {impact_elapsed_ms} ms"
    );

    let impacted_paths: Vec<&str> = impacted.iter().map(|t| t.test_file_path.as_str()).collect();
    assert_eq!(
        impacted_paths,
        vec![
            "src/utils/__tests__/money.test.ts",
            "src/checkout/__tests__/Cart.test.tsx",
        ]
    );
    assert_eq!(impacted[0].hop_distance, 1);
    assert_eq!(impacted[0].confidence, GraphEdgeConfidence::SyntacticAst);
    assert_eq!(impacted[1].hop_distance, 2);
    assert_eq!(impacted[1].confidence, GraphEdgeConfidence::SyntacticAst);

    // Every edge in the graph carries an explicit confidence level
    assert!(!analyzer.edges().is_empty());
    for edge in analyzer.edges() {
        assert!(matches!(
            edge.confidence,
            GraphEdgeConfidence::ExactSemantic
                | GraphEdgeConfidence::SyntacticAst
                | GraphEdgeConfidence::HeuristicText
        ));
    }
}
