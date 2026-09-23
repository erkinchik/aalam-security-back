-- The next migration (drop_personal_organization_type) assumes personal
-- organizations are already gone: on existing databases they were deleted by
-- hand. A fresh database still has `Default` from add_multi_tenancy, so the type
-- cast fails. Delete them here so the chain applies from scratch.
--
-- Databases that already dropped the `type` column (drop_organization_type) get
-- this migration after the others, and for them it is a no-op. The comparison
-- goes through ::text because the recreated enum no longer has PERSONAL.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'Organization'
      AND column_name = 'type'
  ) THEN
    DELETE FROM "Organization" WHERE "type"::text = 'PERSONAL';
  END IF;
END $$;
