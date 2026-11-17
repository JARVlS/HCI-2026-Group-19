-- Optional accounts on top of the anonymous users (ADR-8, amended 17 Nov 2026). A row here turns a
-- user into an account that can log in from another browser with a username and password. Users
-- without a row stay guests, exactly as before. No email: nothing to verify, no personal data
-- needed, and no password reset (a forgotten password means a new account).
-- password_hash: "pbkdf2-sha256$<iterations>$<salt hex>$<hash hex>" (backend/src/passwords.py).
-- COLLATE NOCASE: "Leon" and "leon" are the same username.
CREATE TABLE accounts     (user_id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL,
                           created_at TEXT NOT NULL);
