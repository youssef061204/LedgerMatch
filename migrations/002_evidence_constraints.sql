-- A CHECK expression evaluating to NULL passes in PostgreSQL, so require the
-- explanation explicitly whenever a reversal timestamp exists.
ALTER TABLE allocations DROP CONSTRAINT allocations_check;
ALTER TABLE allocations ADD CONSTRAINT allocations_reversal_explanation
  CHECK (
    (reversed_at IS NULL AND reversal_note IS NULL)
    OR (reversed_at IS NOT NULL AND reversal_note IS NOT NULL AND length(trim(reversal_note)) > 0)
  );

-- A decision may only cite allocation evidence from its own workspace.
ALTER TABLE allocations ADD CONSTRAINT allocations_workspace_id_unique UNIQUE (workspace_id, id);
ALTER TABLE decisions DROP CONSTRAINT decisions_allocation_id_fkey;
ALTER TABLE decisions ADD CONSTRAINT decisions_workspace_allocation_fk
  FOREIGN KEY (workspace_id, allocation_id) REFERENCES allocations (workspace_id, id);
