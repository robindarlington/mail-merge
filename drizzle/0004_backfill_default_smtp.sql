-- Custom SQL migration file, put your code below! --
-- Backfill surviving pre-06.1 smtp_configs rows into the new named-default model.
-- Order is guaranteed: 0003 added label/is_default/deleted_at + the partial unique
-- index; this 0004 stamps every non-deleted row with label='Default' (only when it
-- has no label yet) and is_default=1. Safe because each account held at most one row
-- pre-migration (the old single-row unique index), so the one-default-per-user
-- partial index cannot be violated.
UPDATE `smtp_configs` SET `label` = COALESCE(`label`, 'Default'), `is_default` = 1 WHERE `deleted_at` IS NULL;
