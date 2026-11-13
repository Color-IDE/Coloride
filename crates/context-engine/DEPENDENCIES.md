# Optional vector dependency review (2026-11-13)

`toolu-orm-sqlite-vec-register = 0.12.0` remains pinned exactly. Its published
`Cargo.toml` and complete `src/lib.rs` were inspected locally before retaining it.

- It has no build script (`build = false`); its only direct dependencies are
  `rusqlite` 0.40 with bundled SQLite and exactly `sqlite-vec` 0.1.9.
- The source exposes one safe `register()` function. A process-wide `OnceLock`
  registers the statically linked `sqlite3_vec_init` entrypoint once, checks
  SQLite's return code, and caches the result. It contains no filesystem,
  network, shell, environment, or dynamic extension-loading operations.
- Its sole unsafe block casts sqlite-vec's erased C declaration to rusqlite's
  `RawAutoExtension` ABI and calls `register_auto_extension`. This matches the
  compiled `sqlite3_vec_init(sqlite3*, char**, const sqlite3_api_routines*)`
  entrypoint in sqlite-vec's C source. The integration tests exercise registration,
  cosine distance, persistent `vec0` queries, and reopen behavior.
- Published package checksum in `Cargo.lock`:
  `130b975308c3635bf5c12752bd48692b0cf6341a42ab8bd8da4e3a6e38b55dce`.
  Reviewed `src/lib.rs` SHA-256:
  `4ad8d33dba9a2ae2eacf8e3d30b85e8a84a5e670bbc1ecc450e698e230feeb4f`.

This is a source review of the registration wrapper, not an audit of all SQLite,
sqlite-vec, ONNX Runtime, fastembed, or model artifacts. Any version change needs
another review. It keeps FFI outside this workspace's `unsafe_code = forbid`
boundary; callers never supply an extension path or arbitrary entrypoint.

All vector dependencies are behind `vector`, disabled by default. Fastembed 4.9.1
pulls image/tokenizer/ONNX dependencies even for text-only inference, accounting
for much of the lockfile growth. This implementation does not enable automatic
ONNX Runtime binary downloads at build time. `ort-load-dynamic` requires an
installed runtime; `ORT_DYLIB_PATH` is checked explicitly and errors include the
required version and configuration. Missing runtime leaves lexical/AST retrieval
available. Quantized model downloads occur only after host opt-in. The model
cache and persistent `vectors.sqlite` live in the configured workspace cache.
