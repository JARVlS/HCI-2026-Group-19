-- Second slice of the D1 schema in IMPLEMENTATION_PLAN.md section 4: the knowledge graph and the
-- chats that PUT /api/sync writes and GET /api/state reads. Column definitions are copied
-- unchanged from the plan. The two *_user indexes are additions: GET /api/state reads every
-- table by user_id, and these two tables have no other index that starts with user_id.
CREATE TABLE concepts     (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, parent_id TEXT, kind TEXT NOT NULL, label TEXT NOT NULL,
                           slug TEXT NOT NULL, aliases_json TEXT NOT NULL DEFAULT '[]', description TEXT, created_by TEXT NOT NULL,
                           created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE INDEX concepts_user_slug ON concepts(user_id, slug);
CREATE TABLE concept_edges(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, from_id TEXT NOT NULL, to_id TEXT NOT NULL, kind TEXT NOT NULL,
                           created_at TEXT NOT NULL, UNIQUE(user_id, from_id, to_id, kind));
CREATE TABLE trees        (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, root_concept_id TEXT NOT NULL, title TEXT NOT NULL, grove_id TEXT,
                           split_from TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE INDEX trees_user ON trees(user_id, created_at);
CREATE TABLE conversations(id TEXT PRIMARY KEY, user_id TEXT NOT NULL, subject_id TEXT, title TEXT NOT NULL, study_mode INTEGER NOT NULL DEFAULT 0,
                           continued_from TEXT, carry_summary TEXT,
                           created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX conversations_user ON conversations(user_id, created_at);
CREATE TABLE messages     (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, conversation_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL,
                           classification_json TEXT, meta_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
CREATE INDEX messages_conv ON messages(conversation_id, created_at);
CREATE TABLE attempts     (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, conversation_id TEXT NOT NULL, message_id TEXT NOT NULL,
                           concept_id TEXT NOT NULL, mode TEXT NOT NULL, independence REAL NOT NULL, correctness REAL, confidence REAL NOT NULL,
                           source TEXT NOT NULL, reasons_json TEXT NOT NULL, evidence_json TEXT NOT NULL, superseded_by TEXT, created_at TEXT NOT NULL);
CREATE INDEX attempts_user_concept ON attempts(user_id, concept_id, created_at);
