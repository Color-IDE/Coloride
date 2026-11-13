//! Bounded mutation journal: unchanged reads are O(1), lagging consumers request a snapshot.
#[cfg(feature = "vector")]
use std::collections::BTreeSet;
use std::collections::VecDeque;

#[derive(Debug, Default, Clone)]
pub(crate) struct ChangeJournal {
    revision: u64,
    events: VecDeque<(u64, Option<String>)>,
}
impl ChangeJournal {
    #[cfg(feature = "vector")]
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn mark(&mut self, path: Option<String>) {
        self.revision += 1;
        self.events.push_back((self.revision, path));
        if self.events.len() > 4096 {
            self.events.pop_front();
        }
    }
    #[cfg(feature = "vector")]
    pub fn since(&self, revision: u64) -> Option<BTreeSet<String>> {
        if revision == self.revision {
            return Some(BTreeSet::new());
        }
        if self
            .events
            .front()
            .map_or(true, |(first, _)| revision + 1 < *first)
        {
            return None;
        }
        let mut paths = BTreeSet::new();
        for (_, path) in self.events.iter().rev().take_while(|(r, _)| *r > revision) {
            paths.insert(path.clone()?);
        }
        Some(paths)
    }
}
