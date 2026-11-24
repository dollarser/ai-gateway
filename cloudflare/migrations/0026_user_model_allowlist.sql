ALTER TABLE users ADD COLUMN allowed_model_ids TEXT DEFAULT NULL
  CHECK(allowed_model_ids IS NULL OR (json_valid(allowed_model_ids) AND json_type(allowed_model_ids)='array'));
