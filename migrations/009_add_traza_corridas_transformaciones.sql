-- =============================================================
-- Migration 009: Run traceability columns for both transformation jobs
-- Adds runner metadata (GitHub Actions run id / attempt / job / URL) and a
-- capped `alertas` JSONB summary to the run-record tables of:
--   - tocino -> chicharron   (sps_transformaciones_corridas, migration 006)
--   - negativos              (sps_transformaciones_negativos_corridas, migration 007)
-- Additive and idempotent: nullable columns, no defaults, no backfill, no
-- rewrite of historical rows. Safe to re-run. Run it BEFORE deploying the
-- Backend-Carnes API / UI that read these columns (executed by hand in Supabase).
-- =============================================================

ALTER TABLE sps_transformaciones_corridas
    ADD COLUMN IF NOT EXISTS github_run_id      BIGINT,
    ADD COLUMN IF NOT EXISTS github_run_attempt SMALLINT,
    ADD COLUMN IF NOT EXISTS github_job         TEXT,
    ADD COLUMN IF NOT EXISTS github_run_url     TEXT,
    ADD COLUMN IF NOT EXISTS alertas            JSONB;

ALTER TABLE sps_transformaciones_negativos_corridas
    ADD COLUMN IF NOT EXISTS github_run_id      BIGINT,
    ADD COLUMN IF NOT EXISTS github_run_attempt SMALLINT,
    ADD COLUMN IF NOT EXISTS github_job         TEXT,
    ADD COLUMN IF NOT EXISTS github_run_url     TEXT,
    ADD COLUMN IF NOT EXISTS alertas            JSONB;
