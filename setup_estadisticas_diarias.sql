-- Tabla de estadísticas diarias POS (para Resumen Diario)
-- Creada: 2026-06-12
-- Uso: almacena snapshot diario de total_pos, por_caja, por_nit
--       para poder consultar días anteriores aunque Connekta purgue datos.
-- Migration: ALTER TABLE sps_estadisticas_diarias ADD COLUMN IF NOT EXISTS por_nit JSONB NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS sps_estadisticas_diarias (
    fecha          DATE PRIMARY KEY,
    total_pos      INTEGER NOT NULL DEFAULT 0,
    total_sync     INTEGER NOT NULL DEFAULT 0,
    genericas      INTEGER NOT NULL DEFAULT 0,
    reales         INTEGER NOT NULL DEFAULT 0,
    neto_total     NUMERIC NOT NULL DEFAULT 0,
    por_caja       JSONB NOT NULL DEFAULT '{}',
    por_nit        JSONB NOT NULL DEFAULT '{}',
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
