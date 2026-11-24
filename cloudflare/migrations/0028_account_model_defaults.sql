-- Convert the former global switches to a registration template, then remove them.
INSERT INTO settings(name,value)
SELECT 'new_account_model_ids', json_group_array(id) FROM (
  SELECT substr(name,14) AS id
  FROM settings WHERE substr(name,1,13)='public_model:' AND value='true'
  UNION
  SELECT 'gpt-6-luna' WHERE NOT EXISTS(SELECT 1 FROM settings WHERE name='public_model:gpt-6-luna')
  ORDER BY id
);

UPDATE users SET allowed_model_ids=(SELECT value FROM settings WHERE name='new_account_model_ids')
WHERE allowed_model_ids IS NULL;

DELETE FROM settings WHERE substr(name,1,13)='public_model:';

CREATE TRIGGER initialize_account_model_ids AFTER INSERT ON users
WHEN NEW.allowed_model_ids IS NULL
BEGIN
  UPDATE users SET allowed_model_ids=(SELECT value FROM settings WHERE name='new_account_model_ids') WHERE id=NEW.id;
END;

CREATE TRIGGER require_account_model_ids BEFORE UPDATE OF allowed_model_ids ON users
WHEN NEW.allowed_model_ids IS NULL
BEGIN
  SELECT RAISE(ABORT,'account_model_ids_required');
END;
