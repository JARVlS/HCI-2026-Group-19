-- First slice of the D1 schema in IMPLEMENTATION_PLAN.md section 4 (users, usage, events).
-- Column definitions are copied unchanged from the plan, so a later migration can add the
-- remaining tables (concepts, concept_edges, trees, conversations, messages, attempts).
CREATE TABLE users        (id TEXT PRIMARY KEY, participant_id TEXT UNIQUE, condition TEXT, created_at TEXT NOT NULL);
CREATE TABLE events       (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, condition TEXT, type TEXT NOT NULL, payload_json TEXT NOT NULL,
                           client_ts TEXT NOT NULL, server_ts TEXT NOT NULL);
CREATE TABLE usage        (user_id TEXT NOT NULL, day TEXT NOT NULL, task TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0,
                           output_tokens INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day, task));
