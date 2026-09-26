CREATE TABLE IF NOT EXISTS mk_migration_documents (
  kind TEXT NOT NULL CHECK (kind IN ('batch', 'item', 'repair', 'repair_run', 'repair_application', 'target')),
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 512),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  data JSONB NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  PRIMARY KEY (kind, id),
  CHECK (
    kind <> 'item' OR NOT (data ? 'identityKey') OR
    (jsonb_typeof(data -> 'identityKey') = 'string' AND length(data ->> 'identityKey') > 0)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS mk_migration_item_identity_key
  ON mk_migration_documents ((data ->> 'identityKey'))
  WHERE kind = 'item' AND data ? 'identityKey';

CREATE INDEX IF NOT EXISTS mk_migration_document_filters
  ON mk_migration_documents USING GIN (data jsonb_path_ops);
