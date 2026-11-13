//! Explicitly launched read-only context server; never starts workspace scripts or extensions.
use context_engine::{ContextBundleAssembler, LocalMcpServer, SqliteWalContextEngine};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    let root = std::path::PathBuf::from(
        args.next()
            .ok_or("Usage: coloride-context-mcp WORKSPACE INDEX_PATH BRANCH")?,
    )
    .canonicalize()?;
    let db = std::path::PathBuf::from(args.next().ok_or("Missing INDEX_PATH")?);
    // Require an existing parent inside the worktree; no implicit global cache writes.
    let parent = db.parent().ok_or("Index needs a parent")?.canonicalize()?;
    if !parent.starts_with(&root) {
        return Err("Index must reside inside the workspace".into());
    }
    if db.exists() && !db.canonicalize()?.starts_with(&root) {
        return Err("Index symlink escapes workspace".into());
    }
    let branch = args
        .next()
        .ok_or("Missing BRANCH")?
        .into_string()
        .map_err(|_| "Invalid branch")?;
    #[cfg(feature = "vector")]
    let vector_cache = match args.next() {
        Some(flag) if flag == "--vectors" => {
            let cache = std::path::PathBuf::from(args.next().ok_or("Missing vector cache path")?)
                .canonicalize()?;
            if !cache.starts_with(&root) {
                return Err("Vector cache must reside inside workspace".into());
            }
            Some(cache)
        }
        Some(_) => return Err("Unexpected argument".into()),
        None => None,
    };
    if args.next().is_some() {
        return Err("Unexpected argument".into());
    }
    let wal = SqliteWalContextEngine::wal_path_for(&db);
    if wal.exists() && !wal.canonicalize()?.starts_with(&root) {
        return Err("WAL symlink escapes workspace".into());
    }
    let engine = SqliteWalContextEngine::open_or_rebuild_from_workspace(db, &root, branch)?;
    let mut server = LocalMcpServer::new(engine, ContextBundleAssembler::default());
    #[cfg(feature = "vector")]
    if let Some(cache) = vector_cache {
        server.enable_vectors(cache);
    }
    server.serve(std::io::stdin().lock(), std::io::stdout().lock())?;
    Ok(())
}
