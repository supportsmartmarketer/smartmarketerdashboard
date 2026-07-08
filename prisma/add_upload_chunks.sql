-- Chunked CSV upload tables (run after deploy or via prisma db push)

CREATE TABLE IF NOT EXISTS upload_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  upload_id UUID NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (upload_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS upload_chunks_upload_id_idx ON upload_chunks (upload_id);

CREATE TABLE IF NOT EXISTS upload_visitor_identities (
  upload_id UUID NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  visitor_key TEXT NOT NULL,
  identity JSONB NOT NULL,
  PRIMARY KEY (upload_id, visitor_key)
);
