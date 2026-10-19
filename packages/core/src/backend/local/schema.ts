// SPDX-License-Identifier: Apache-2.0
/**
 * Embedded SQLite schema for LocalBackend. Holds only the content tables —
 * no billing/team/auth columns. Source of truth for the OSS edition.
 * Idempotent (CREATE ... IF NOT EXISTS) so it doubles as the bootstrap + the migration base.
 *
 * Schema evolution: the canonical store at `~/.pathrule/<ws>/pathrule.db` upgrades
 * via the numbered MIGRATIONS list below, gated on `PRAGMA user_version`. v1 is the full base
 * schema; future schema changes append `{ version: N, sql }` deltas — never
 * edit a released migration. `SCHEMA_VERSION` is the latest version a fresh DB ends up at.
 */
export const SCHEMA_VERSION = 14;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  local_root_path TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  parent_id TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  order_index INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  orphaned_at TEXT,
  original_path TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nodes_ws ON nodes(workspace_id);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  node_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'claude',
  version_id TEXT NOT NULL,
  version_number INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  last_edited_by TEXT,
  last_edited_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_memories_ws ON memories(workspace_id, status);

CREATE TABLE IF NOT EXISTS rules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'medium',
  version_id TEXT NOT NULL,
  version_number INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  last_edited_by TEXT,
  last_edited_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_rules_ws ON rules(workspace_id, status);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  content TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  github_url TEXT,
  version TEXT NOT NULL DEFAULT '1.0.0',
  tags TEXT NOT NULL DEFAULT '[]',
  version_id TEXT NOT NULL,
  version_number INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  last_edited_by TEXT,
  last_edited_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  content_fetched_at TEXT,
  status TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS idx_skills_ws ON skills(workspace_id, status);

CREATE TABLE IF NOT EXISTS node_rules (
  node_id TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  PRIMARY KEY (node_id, rule_id)
);
CREATE INDEX IF NOT EXISTS idx_node_rules_rule ON node_rules(rule_id);

CREATE TABLE IF NOT EXISTS node_skills (
  node_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (node_id, skill_id)
);
CREATE INDEX IF NOT EXISTS idx_node_skills_skill ON node_skills(skill_id);

CREATE TABLE IF NOT EXISTS activity_logs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  node_path TEXT,
  domain TEXT,
  action TEXT,
  scope TEXT,
  subjects TEXT NOT NULL DEFAULT '[]',
  task_summary TEXT,
  files_touched TEXT NOT NULL DEFAULT '[]',
  ai_client TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_ws ON activity_logs(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS refresh_tasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  subject_type TEXT NOT NULL DEFAULT 'memory',
  subject_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'drift',
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  claimed_by_ai TEXT,
  claimed_at TEXT,
  resolved_at TEXT,
  resolved_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refresh_ws ON refresh_tasks(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_refresh_subject ON refresh_tasks(subject_id, status);

-- Path snapshot read by rankPriorSolutions (and relevantMemoriesForPath).
-- (memory_id, path) populated by recordMemoryContextPaths: the workspace-relative
-- paths active when a memory was written.
CREATE TABLE IF NOT EXISTS memory_context_paths (
  memory_id TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (memory_id, path)
);
CREATE INDEX IF NOT EXISTS idx_memory_context_paths_path ON memory_context_paths(path);

-- Bring-your-own semantic store. One embedding row per memory, written by
-- LocalBackend on memory write/update when an embedding key is configured.
-- The vector is stored as a packed float32 BLOB (the same width vector stores use;
-- read back with a Float32Array view, no per-query parse) for a solo-scale
-- brute-force cosine scan; dims/model are kept per row so a query only compares
-- matching-dimension vectors.
CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  embedding BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_embeddings_ws ON memory_embeddings(workspace_id);

-- Extra local checkouts (git worktrees) that resolve to this workspace.
-- The workspaces.local_root_path column stays the ONE canonical clone; these are
-- additional working directories of the same repo, where an isolated session runs.
-- Without them a session in a worktree resolves to no workspace at all and loses
-- every memory, rule and skill. Keyed by PATH: one workspace can have many
-- worktrees, and a directory belongs to exactly one workspace.
CREATE TABLE IF NOT EXISTS workspace_worktree_paths (
  local_root_path TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  branch TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_worktree_paths_ws ON workspace_worktree_paths(workspace_id);
`;

// Delta applied to DBs already at v1 (the table is in SCHEMA_SQL for fresh DBs).
// Historical: created the embedding column as TEXT (JSON). v3 converts it to BLOB —
// left unedited (an append-only migration log), v3 supersedes the storage format.
const MIGRATION_V2_EMBEDDINGS = `
CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  embedding TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_embeddings_ws ON memory_embeddings(workspace_id);
`;

// Convert the embedding store from JSON-text to packed float32 BLOB. Embeddings are
// derived (recomputed from a memory's text on its next write/update) and only present
// when a bring-your-own embedding key is configured, so dropping the old rows is safe —
// no source-of-truth is lost. Recreate (not ALTER) since the column's storage changes.
const MIGRATION_V3_EMBEDDINGS_BLOB = `
DROP TABLE IF EXISTS memory_embeddings;
CREATE TABLE memory_embeddings (
  memory_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  embedding BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memory_embeddings_ws ON memory_embeddings(workspace_id);
`;

/**
 * Ordered, append-only migration list applied by LocalBackend on open (gated on
 * `PRAGMA user_version`). v1 is the full idempotent base schema, so it is a safe no-op on a
 * DB created by the pre-migration-runner bootstrap. Add new versions as deltas; never mutate
 * an existing entry.
 */
// Worktree bindings for stores already at v3 (the table is in SCHEMA_SQL for
// fresh DBs). Additive: nothing existing changes, and a store that never sees an
// isolated session simply keeps an empty table.
const MIGRATION_V4_WORKTREE_PATHS = `
CREATE TABLE IF NOT EXISTS workspace_worktree_paths (
  local_root_path TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  branch TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_worktree_paths_ws ON workspace_worktree_paths(workspace_id);
`;

// Executable CONSTRAINT atoms, so the same rule compiles to the same hook-index stub
// here as it does in the cloud. Deliberately NOT added to SCHEMA_SQL: a fresh DB starts
// at user_version 0 and runs every migration in order, and `ALTER TABLE ... ADD COLUMN`
// has no IF NOT EXISTS in SQLite, so a column present in the base schema would make
// this delta fail on exactly the databases that need it least.
const MIGRATION_V5_RULE_CONSTRAINTS = `
ALTER TABLE rules ADD COLUMN constraints TEXT NOT NULL DEFAULT '[]';
`;

// Typed knowledge atoms that do not belong to a rule. See docs/architecture/decisions/0001-remedy-atom-persistence.md
// for why this is a table rather than a `remedies` column on `memories`: a remedy can hang off a
// memory OR a rule, the review queue's one hot question is "what is proposed in this workspace",
// and dedup wants an index rather than application logic.
//
// `rules.constraints` deliberately stays where it is. CONSTRAINT and CHECK atoms are already
// compiled from that column by the local hook index and by four cloud migrations, and moving
// them buys this slice nothing.
//
// Columns hold what is QUERIED; `payload` holds what is only ever DISPLAYED.
const MIGRATION_V6_KNOWLEDGE_ATOMS = `
CREATE TABLE IF NOT EXISTS knowledge_atoms (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  node_path TEXT,
  authority TEXT NOT NULL DEFAULT 'inferred',
  status TEXT NOT NULL DEFAULT 'proposed',
  approved_by TEXT,
  fingerprint TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  observed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_atoms_fingerprint ON knowledge_atoms(workspace_id, fingerprint);
CREATE INDEX IF NOT EXISTS idx_atoms_pending ON knowledge_atoms(workspace_id, kind, status);
CREATE INDEX IF NOT EXISTS idx_atoms_subject ON knowledge_atoms(subject_type, subject_id);
`;

// A local, append-only record that an approved remedy atom was DELIVERED to an agent execution.
// Deliberately metadata-only: `atom_id` is the remedy fingerprint (an opaque hash that joins back
// to knowledge_atoms), never the condition/action/evidence text. It stays local by construction,
// because it is exposed only through LocalBackend and is not part of the KnowledgeBackend interface
// the mirror-sync and cloud handlers operate over. The `event` column exists so that the epistemic
// chain delivered -> used -> succeeded/failed can later be separate rows without a schema change;
// delivery is NOT success.
const MIGRATION_V7_REMEDY_DELIVERIES = `
CREATE TABLE IF NOT EXISTS remedy_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  atom_id TEXT NOT NULL,
  session_id TEXT,
  path TEXT,
  event TEXT NOT NULL DEFAULT 'delivered',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_remedy_deliveries_ws ON remedy_deliveries(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_remedy_deliveries_atom ON remedy_deliveries(atom_id);
`;

// Append-only outcome-observation evidence for delivered knowledge. Each row is one categorical
// observation, never mutated: later evidence may contradict an earlier reading, one atom may succeed
// in one context and fail in another, and future learning needs the temporal history. It is
// metadata-only by construction, exactly like remedy_deliveries: `atom_id` is a fingerprint hash,
// and event_type / evidence_kind / strength are closed enums. No edited text, no command, no error
// body ever lands here, because attribution is computed where the content is live (the caller) and
// only the decision is stored. delivery_id = "<session_id>:<atom_id>" ties an observation back to
// exactly one delivery. Stays local: exposed only through LocalBackend, never on KnowledgeBackend.
const MIGRATION_V8_KNOWLEDGE_EVIDENCE = `
CREATE TABLE IF NOT EXISTS knowledge_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  atom_id TEXT NOT NULL,
  delivery_id TEXT,
  session_id TEXT,
  path TEXT,
  event_type TEXT NOT NULL,
  evidence_kind TEXT,
  strength TEXT,
  observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_knowledge_evidence_atom ON knowledge_evidence(workspace_id, atom_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_evidence_session ON knowledge_evidence(session_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_evidence_delivery ON knowledge_evidence(delivery_id);
`;

// Two additive, nullable columns on the append-only evidence table. `reason` is the closed
// UsageReason enum from the shared engine (why an event was or was not attributed), so the whole
// delivery -> event -> attribution -> outcome chain is inspectable for a session/atom/delivery
// without re-deriving it (V30 debug trace). `signature` is the deterministic, path/number-free error
// fingerprint used for condition-observation and error-persistence evidence: it is NOT raw error
// text, it is the normalized shape hash, so no error body ever lands in the table. Both stay local.
const MIGRATION_V9_EVIDENCE_REASON = `
ALTER TABLE knowledge_evidence ADD COLUMN reason TEXT;
ALTER TABLE knowledge_evidence ADD COLUMN signature TEXT;
CREATE INDEX IF NOT EXISTS idx_knowledge_evidence_type ON knowledge_evidence(workspace_id, atom_id, event_type);
CREATE INDEX IF NOT EXISTS idx_remedy_deliveries_session ON remedy_deliveries(workspace_id, session_id);
`;

const MIGRATION_V14_RUNTIME_EVENTS = `
CREATE TABLE IF NOT EXISTS runtime_event_groups (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  environment TEXT NOT NULL,
  kind TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  node_path TEXT,
  label TEXT,
  flow TEXT,
  release TEXT,
  message TEXT,
  metadata TEXT,
  occurrence_count INTEGER NOT NULL DEFAULT 0,
  release_occurrence_count INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  verification TEXT NOT NULL,
  correction TEXT,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, environment, kind, fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_runtime_event_groups_seen ON runtime_event_groups(workspace_id, last_seen, id);
CREATE INDEX IF NOT EXISTS idx_runtime_event_groups_path ON runtime_event_groups(workspace_id, node_path);
CREATE TABLE IF NOT EXISTS runtime_event_releases (
  workspace_id TEXT NOT NULL,
  environment TEXT NOT NULL,
  release TEXT NOT NULL,
  envelopes INTEGER NOT NULL DEFAULT 0,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  PRIMARY KEY (workspace_id, environment, release)
);
CREATE TABLE IF NOT EXISTS runtime_event_receipts (
  workspace_id TEXT NOT NULL,
  envelope_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, envelope_id)
);
CREATE INDEX IF NOT EXISTS idx_runtime_event_receipts_at ON runtime_event_receipts(workspace_id, received_at);
CREATE TABLE IF NOT EXISTS runtime_event_history (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  event TEXT NOT NULL,
  attempt_id TEXT,
  from_state TEXT,
  to_state TEXT NOT NULL,
  release TEXT,
  revision INTEGER NOT NULL,
  payload TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS idx_runtime_event_history_group ON runtime_event_history(workspace_id, group_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runtime_event_history_attempt
  ON runtime_event_history(workspace_id, group_id, attempt_id) WHERE event = 'correction';
`;

export const MIGRATIONS: ReadonlyArray<{ version: number; sql: string }> = [
  { version: 1, sql: SCHEMA_SQL },
  { version: 2, sql: MIGRATION_V2_EMBEDDINGS },
  { version: 3, sql: MIGRATION_V3_EMBEDDINGS_BLOB },
  { version: 4, sql: MIGRATION_V4_WORKTREE_PATHS },
  { version: 5, sql: MIGRATION_V5_RULE_CONSTRAINTS },
  { version: 6, sql: MIGRATION_V6_KNOWLEDGE_ATOMS },
  { version: 7, sql: MIGRATION_V7_REMEDY_DELIVERIES },
  { version: 8, sql: MIGRATION_V8_KNOWLEDGE_EVIDENCE },
  { version: 9, sql: MIGRATION_V9_EVIDENCE_REASON },
  { version: 10, sql: "ALTER TABLE activity_logs ADD COLUMN provenance TEXT;" },
  {
    version: 11,
    sql: `CREATE TABLE IF NOT EXISTS learning_claims (
      workspace_id TEXT NOT NULL,
      id TEXT NOT NULL,
      claim TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, id)
    );
    CREATE INDEX IF NOT EXISTS idx_learning_claims_ws ON learning_claims(workspace_id, created_at);`,
  },
  { version: 12, sql: `CREATE TABLE learning_claim_retirements (
    workspace_id TEXT NOT NULL, id TEXT NOT NULL, replacement_id TEXT,
    PRIMARY KEY(workspace_id, id)
  );` },
  // A memory's secondary context links (relatedPaths), kept apart from memory_context_paths:
  // those are the activity paths recorded at write time, these are declared, and clearing one
  // must never clear the other.
  {
    version: 13,
    sql: `CREATE TABLE IF NOT EXISTS memory_related_paths (
      memory_id TEXT NOT NULL,
      path TEXT NOT NULL,
      PRIMARY KEY (memory_id, path)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_related_paths_path ON memory_related_paths(path);`,
  },
  // Runtime events an application sends to Pathrule Local (runtime-events-store.ts): one row per
  // group, the releases each environment sent from, the envelope ids already applied, and the
  // audit of corrections and verification states.
  { version: 14, sql: MIGRATION_V14_RUNTIME_EVENTS },
];
