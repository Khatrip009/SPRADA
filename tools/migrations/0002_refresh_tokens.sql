-- Create refresh tokens table to store hashed refresh tokens and rotate them
CREATE TABLE IF NOT EXISTS refresh_tokens (
id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
token_hash text NOT NULL,
created_at timestamptz DEFAULT now(),
expires_at timestamptz NOT NULL,
revoked boolean DEFAULT false,
replaced_by uuid NULL
);
CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens (user_id);