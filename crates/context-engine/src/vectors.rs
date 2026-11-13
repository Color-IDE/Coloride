//! Persistent sqlite-vec index; only changed chunks are embedded on a background worker.
use crate::{ContextSearchHit, SqliteWalContextEngine};
use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
use rusqlite::{params, Connection};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::Arc,
};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum CompactEmbeddingModel {
    #[default]
    BgeSmall,
    MiniLm,
}
impl CompactEmbeddingModel {
    fn fastembed(self) -> EmbeddingModel {
        match self {
            Self::BgeSmall => EmbeddingModel::BGESmallENV15Q,
            Self::MiniLm => EmbeddingModel::AllMiniLML6V2Q,
        }
    }
    fn id(self) -> &'static str {
        match self {
            Self::BgeSmall => "bge-small-q:384:v1",
            Self::MiniLm => "minilm-q:384:v1",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct VectorCursor {
    index: u64,
    overlay: u64,
}
#[derive(Debug)]
pub(crate) struct VectorChunk {
    key: String,
    path: String,
    hash: String,
    text: String,
}
#[derive(Debug)]
pub(crate) struct VectorUpdate {
    pub branch: String,
    pub cursor: VectorCursor,
    paths: BTreeSet<String>,
    chunks: Vec<VectorChunk>,
    full: bool,
}

pub(crate) fn changes(
    engine: &mut SqliteWalContextEngine,
    previous: Option<VectorCursor>,
) -> Option<VectorUpdate> {
    let cursor = VectorCursor {
        index: engine.vector_changes.revision(),
        overlay: engine.overlay().changes.revision(),
    };
    if previous == Some(cursor) {
        return None;
    }
    let delta = previous.and_then(|p| {
        let mut paths = engine.vector_changes.since(p.index)?;
        paths.extend(engine.overlay().changes.since(p.overlay)?);
        Some(paths)
    });
    let full = delta.is_none();
    let paths = delta.unwrap_or_else(|| {
        engine
            .files_table()
            .keys()
            .chain(engine.overlay().entries().keys())
            .cloned()
            .collect()
    });
    let mut chunks = Vec::new();
    for path in &paths {
        for chunk in engine.context_chunks_for_path(path) {
            chunks.push(VectorChunk {
                key: chunk.chunk_id,
                path: path.clone(),
                hash: blake3::hash(chunk.sanitized_content.as_bytes())
                    .to_hex()
                    .to_string(),
                text: chunk.sanitized_content,
            });
        }
    }
    Some(VectorUpdate {
        branch: engine.active_git_branch().into(),
        cursor,
        paths,
        chunks,
        full,
    })
}

/// Only hashes, chunk identities and vectors are persisted. Source text stays in host/index buffers.
struct VectorStore {
    db: Connection,
    path: PathBuf,
    branch: String,
    kind: CompactEmbeddingModel,
    model_fingerprint: String,
}
impl VectorStore {
    #[cfg(test)]
    fn open(path: &Path, branch: &str, kind: CompactEmbeddingModel) -> Result<Self, String> {
        Self::open_fingerprint(path, branch, kind, kind.id())
    }
    fn open_fingerprint(
        path: &Path,
        branch: &str,
        kind: CompactEmbeddingModel,
        fingerprint: &str,
    ) -> Result<Self, String> {
        toolu_orm_sqlite_vec_register::register()?;
        let db = Connection::open(path).map_err(|e| e.to_string())?;
        db.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
            CREATE TABLE IF NOT EXISTS scope(id INTEGER PRIMARY KEY CHECK(id=1), branch TEXT NOT NULL, model TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS vector_keys(id INTEGER PRIMARY KEY, hash TEXT UNIQUE NOT NULL);
            CREATE VIRTUAL TABLE IF NOT EXISTS embeddings USING vec0(embedding float[384] distance_metric=cosine);
            CREATE TABLE IF NOT EXISTS chunks(key TEXT PRIMARY KEY,path TEXT NOT NULL,hash TEXT NOT NULL,vector_id INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS chunks_path ON chunks(path);
            CREATE INDEX IF NOT EXISTS chunks_vector ON chunks(vector_id);").map_err(|e| e.to_string())?;
        let current = db
            .query_row("SELECT branch,model FROM scope WHERE id=1", [], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .ok();
        if current != Some((branch.into(), fingerprint.into())) {
            db.execute_batch("BEGIN IMMEDIATE; DELETE FROM chunks; DELETE FROM embeddings; DELETE FROM vector_keys; DELETE FROM scope;").map_err(|e| e.to_string())?;
            db.execute(
                "INSERT INTO scope(id,branch,model) VALUES (1,?1,?2)",
                params![branch, fingerprint],
            )
            .map_err(|e| e.to_string())?;
            db.execute_batch("COMMIT").map_err(|e| e.to_string())?;
        }
        Ok(Self {
            db,
            path: path.into(),
            branch: branch.into(),
            kind,
            model_fingerprint: fingerprint.into(),
        })
    }

    fn sync(
        &mut self,
        update: &VectorUpdate,
        embed: impl FnOnce(Vec<&str>) -> Result<Vec<Vec<f32>>, String>,
    ) -> Result<usize, String> {
        if self.branch != update.branch {
            return Err("Branch changed during vector update".into());
        }
        let mut missing = Vec::new();
        let mut seen = BTreeSet::new();
        for chunk in &update.chunks {
            if seen.insert(&chunk.hash)
                && !self
                    .db
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM vector_keys WHERE hash=?1)",
                        [&chunk.hash],
                        |r| r.get::<_, bool>(0),
                    )
                    .map_err(|e| e.to_string())?
            {
                missing.push(chunk);
            }
        }
        let vectors = if missing.is_empty() {
            Vec::new()
        } else {
            embed(missing.iter().map(|c| c.text.as_str()).collect())?
        };
        if vectors.len() != missing.len()
            || vectors
                .iter()
                .any(|v| v.len() != 384 || v.iter().any(|x| !x.is_finite()))
        {
            return Err("Invalid embedding output".into());
        }
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        let scope = tx
            .query_row("SELECT branch,model FROM scope WHERE id=1", [], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        if scope != (self.branch.clone(), self.model_fingerprint.clone()) {
            return Err("Vector scope changed during update".into());
        }

        // Only old vectors referenced by affected paths can become orphaned.
        let mut retired = BTreeSet::new();
        if update.full {
            let mut statement = tx
                .prepare("SELECT id FROM vector_keys")
                .map_err(|e| e.to_string())?;
            for id in statement
                .query_map([], |r| r.get::<_, i64>(0))
                .map_err(|e| e.to_string())?
            {
                retired.insert(id.map_err(|e| e.to_string())?);
            }
        } else {
            let mut statement = tx
                .prepare("SELECT vector_id FROM chunks WHERE path=?1")
                .map_err(|e| e.to_string())?;
            for path in &update.paths {
                for id in statement
                    .query_map([path], |r| r.get::<_, i64>(0))
                    .map_err(|e| e.to_string())?
                {
                    retired.insert(id.map_err(|e| e.to_string())?);
                }
            }
        }
        for (chunk, vector) in missing.iter().zip(vectors) {
            tx.execute("INSERT INTO vector_keys(hash) VALUES (?1)", [&chunk.hash])
                .map_err(|e| e.to_string())?;
            let id = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO embeddings(rowid,embedding) VALUES (?1,?2)",
                params![
                    id,
                    serde_json::to_string(&vector).map_err(|e| e.to_string())?
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        if update.full {
            tx.execute("DELETE FROM chunks", [])
                .map_err(|e| e.to_string())?;
        } else {
            for path in &update.paths {
                tx.execute("DELETE FROM chunks WHERE path=?1", [path])
                    .map_err(|e| e.to_string())?;
            }
        }
        for chunk in &update.chunks {
            tx.execute("INSERT INTO chunks(key,path,hash,vector_id) SELECT ?1,?2,?3,id FROM vector_keys WHERE hash=?3", params![chunk.key,chunk.path,chunk.hash]).map_err(|e| e.to_string())?;
        }
        for id in retired {
            tx.execute("DELETE FROM embeddings WHERE rowid=?1 AND NOT EXISTS(SELECT 1 FROM chunks WHERE vector_id=?1)", [id]).map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM vector_keys WHERE id=?1 AND NOT EXISTS(SELECT 1 FROM chunks WHERE vector_id=?1)", [id]).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(missing.len())
    }

    fn matches(&self, branch: &str) -> bool {
        self.branch == branch
            && self
                .db
                .query_row("SELECT branch,model FROM scope WHERE id=1", [], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .map(|scope| scope == (branch.into(), self.model_fingerprint.clone()))
                .unwrap_or(false)
    }
}

pub struct VectorIndex {
    store: VectorStore,
    model: Arc<TextEmbedding>,
}
impl VectorIndex {
    pub(crate) fn load(
        cache: &Path,
        kind: CompactEmbeddingModel,
        branch: &str,
    ) -> Result<Self, String> {
        // Fail with actionable instructions before fastembed's dynamic loader can panic.
        let runtime = std::env::var_os("ORT_DYLIB_PATH").ok_or("Set ORT_DYLIB_PATH to an installed ONNX Runtime 1.20+ shared library to enable embeddings")?;
        if !Path::new(&runtime).is_file() {
            return Err(format!(
                "ONNX Runtime library does not exist: {}",
                Path::new(&runtime).display()
            ));
        }
        let model = TextEmbedding::try_new(InitOptions::new(kind.fastembed()).with_cache_dir(cache.to_path_buf()).with_show_download_progress(false)).map_err(|e| format!("Cannot load embedding model: {e}; check ORT_DYLIB_PATH and ONNX Runtime 1.20+ compatibility"))?;
        let model_kind = kind.fastembed();
        let info = TextEmbedding::get_model_info(&model_kind).map_err(|e| e.to_string())?;
        let path = hf_hub::Cache::new(cache.to_path_buf())
            .model(info.model_code.clone())
            .get(&info.model_file)
            .ok_or("Downloaded model is absent from cache")?;
        if std::fs::metadata(path).map_err(|e| e.to_string())?.len() >= 150_000_000 {
            return Err("Embedding model must be smaller than 150 MB".into());
        }
        // Fingerprint model artifacts once on load, never the workspace on every search.
        let repo = hf_hub::Cache::new(cache.to_path_buf()).model(info.model_code.clone());
        let mut fingerprint = blake3::Hasher::new();
        fingerprint.update(kind.id().as_bytes());
        for name in [
            &info.model_file,
            "tokenizer.json",
            "config.json",
            "tokenizer_config.json",
            "special_tokens_map.json",
        ] {
            if let Some(path) = repo.get(name) {
                fingerprint.update(name.as_bytes());
                let mut reader = std::fs::File::open(path).map_err(|e| e.to_string())?;
                let mut buffer = [0u8; 65536];
                loop {
                    let read =
                        std::io::Read::read(&mut reader, &mut buffer).map_err(|e| e.to_string())?;
                    if read == 0 {
                        break;
                    }
                    fingerprint.update(&buffer[..read]);
                }
            }
        }
        Ok(Self {
            store: VectorStore::open_fingerprint(
                &cache.join("vectors.sqlite"),
                branch,
                kind,
                fingerprint.finalize().to_hex().as_str(),
            )?,
            model: Arc::new(model),
        })
    }
    pub(crate) fn fork(&self, branch: &str) -> Result<Self, String> {
        Ok(Self {
            store: VectorStore::open_fingerprint(
                &self.store.path,
                branch,
                self.store.kind,
                &self.store.model_fingerprint,
            )?,
            model: self.model.clone(),
        })
    }
    pub(crate) fn sync(&mut self, update: &VectorUpdate) -> Result<usize, String> {
        let model = self.model.clone();
        self.store.sync(update, |texts| {
            model.embed(texts, Some(32)).map_err(|e| e.to_string())
        })
    }
    pub(crate) fn matches(&self, engine: &SqliteWalContextEngine) -> bool {
        self.store.matches(engine.active_git_branch())
    }
    pub fn search(
        &self,
        engine: &mut SqliteWalContextEngine,
        query: &str,
    ) -> Result<Vec<ContextSearchHit>, String> {
        if !self.matches(engine) {
            return Err("Vector branch differs from workspace".into());
        }
        let vector = self
            .model
            .embed(vec![query], Some(1))
            .map_err(|e| e.to_string())?
            .pop()
            .ok_or("No query embedding")?;
        let mut stmt = self.store.db.prepare("SELECT c.key,c.path,c.hash,n.distance FROM (SELECT rowid,distance FROM embeddings WHERE embedding MATCH ?1 AND k=64) n JOIN chunks c ON c.vector_id=n.rowid ORDER BY n.distance,c.key LIMIT 64").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(
                [serde_json::to_string(&vector).map_err(|e| e.to_string())?],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, f64>(3)?,
                    ))
                },
            )
            .map_err(|e| e.to_string())?;
        let mut hits = Vec::new();
        for row in rows {
            let (key, path, hash, distance) = row.map_err(|e| e.to_string())?;
            if let Some(hit) = engine.vector_hit(&path, &key, &hash, 1.0 / (1.0 + distance)) {
                hits.push(hit);
            }
        }
        Ok(hits)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::AclAndSecretScanner;
    fn fake(texts: Vec<&str>) -> Result<Vec<Vec<f32>>, String> {
        Ok(texts
            .iter()
            .map(|_| {
                let mut v = vec![0.0; 384];
                v[0] = 1.0;
                v
            })
            .collect())
    }
    #[test]
    fn persistent_restart_and_incremental_chunk_reuse() {
        let dir = tempfile::tempdir().unwrap();
        let mut engine = SqliteWalContextEngine::open(
            dir.path().join("lexical"),
            "main",
            AclAndSecretScanner::new(),
        )
        .unwrap();
        engine
            .index_file(
                "src/a.ts",
                1,
                "export const first = 1;\nexport const second = 2;\n",
            )
            .unwrap();
        engine
            .index_file("src/b.ts", 1, "export const unrelated = 3;\n")
            .unwrap();
        let db = dir.path().join("vectors.sqlite");
        let update = changes(&mut engine, None).unwrap();
        let cursor = update.cursor;
        let count = update.chunks.len();
        let mut store = VectorStore::open(&db, "main", CompactEmbeddingModel::BgeSmall).unwrap();
        assert_eq!(store.sync(&update, fake).unwrap(), count);
        drop(store);
        assert_eq!(&std::fs::read(&db).unwrap()[..16], b"SQLite format 3\0");
        let mut store = VectorStore::open(&db, "main", CompactEmbeddingModel::BgeSmall).unwrap();
        let cold = changes(&mut engine, None).unwrap();
        assert_eq!(
            store
                .sync(&cold, |_| panic!(
                    "restart must not re-embed unchanged chunks"
                ))
                .unwrap(),
            0
        );
        assert!(changes(&mut engine, Some(cursor)).is_none());
        engine
            .index_file(
                "src/a.ts",
                2,
                "export const first = 1;\nexport const second = 20;\n",
            )
            .unwrap();
        let delta = changes(&mut engine, Some(cursor)).unwrap();
        assert!(!delta.full);
        assert_eq!(delta.paths, BTreeSet::from(["src/a.ts".into()]));
        assert_eq!(store.sync(&delta, fake).unwrap(), 1);
        let count_after: i64 = store
            .db
            .query_row("SELECT count(*) FROM chunks", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count_after, count as i64);
        assert!(changes(&mut engine, Some(delta.cursor)).is_none());
        engine.remove_file("src/b.ts").unwrap();
        let removed = changes(&mut engine, Some(delta.cursor)).unwrap();
        assert_eq!(
            store
                .sync(&removed, |_| panic!("deletions do not embed"))
                .unwrap(),
            0
        );
        let removed_count: i64 = store
            .db
            .query_row(
                "SELECT count(*) FROM chunks WHERE path='src/b.ts'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(removed_count, 0);
        // Only identities/hashes/vectors are stored, never excerpt content.
        let schema: String = store
            .db
            .query_row(
                "SELECT sql FROM sqlite_master WHERE name='chunks'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!schema.contains("text_content"));
    }
    #[test]
    fn overlay_updates_do_not_invalidate_unrelated_files_and_scope_resets() {
        let dir = tempfile::tempdir().unwrap();
        let mut engine = SqliteWalContextEngine::open(
            dir.path().join("index"),
            "main",
            AclAndSecretScanner::new(),
        )
        .unwrap();
        engine
            .index_file("src/a.ts", 1, "export const first = 1;")
            .unwrap();
        let first = changes(&mut engine, None).unwrap();
        let mut store = VectorStore::open(
            &dir.path().join("vectors.sqlite"),
            "main",
            CompactEmbeddingModel::BgeSmall,
        )
        .unwrap();
        store.sync(&first, fake).unwrap();
        engine.overlay_mut().upsert_buffer(
            "src/a.ts",
            ropey::Rope::from_str("export const first = 2;"),
            2,
            1,
            None,
        );
        let dirty = changes(&mut engine, Some(first.cursor)).unwrap();
        assert!(!dirty.full);
        assert_eq!(dirty.paths.len(), 1);
        assert_eq!(store.sync(&dirty, fake).unwrap(), 1);
        engine.overlay_mut().remove_buffer("src/a.ts");
        let removed = changes(&mut engine, Some(dirty.cursor)).unwrap();
        assert_eq!(removed.paths.len(), 1);
        store.sync(&removed, fake).unwrap();
        let other =
            VectorStore::open(&store.path, "other", CompactEmbeddingModel::BgeSmall).unwrap();
        assert!(!store.matches("main"));
        let count: i64 = other
            .db
            .query_row("SELECT count(*) FROM embeddings", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 0);
        assert!(store.sync(&first, fake).is_err());
        let model = VectorStore::open(&store.path, "other", CompactEmbeddingModel::MiniLm).unwrap();
        assert!(!other.matches("other"));
        assert!(model.matches("other"));
    }
    #[test]
    fn failed_embedding_is_atomic() {
        let dir = tempfile::tempdir().unwrap();
        let mut engine = SqliteWalContextEngine::open(
            dir.path().join("index"),
            "main",
            AclAndSecretScanner::new(),
        )
        .unwrap();
        engine
            .index_file("src/a.ts", 1, "export const first = 1;")
            .unwrap();
        let mut store = VectorStore::open(
            &dir.path().join("vectors.sqlite"),
            "main",
            CompactEmbeddingModel::BgeSmall,
        )
        .unwrap();
        let update = changes(&mut engine, None).unwrap();
        store.sync(&update, fake).unwrap();
        engine
            .index_file("src/a.ts", 2, "export const first = 2;")
            .unwrap();
        let changed = changes(&mut engine, Some(update.cursor)).unwrap();
        assert!(store
            .sync(&changed, |_| Err("inference failed".into()))
            .is_err());
        let hash: String = store
            .db
            .query_row("SELECT hash FROM chunks LIMIT 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(hash, update.chunks[0].hash);
    }
}
