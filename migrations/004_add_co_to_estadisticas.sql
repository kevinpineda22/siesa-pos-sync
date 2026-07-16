-- =============================================================
-- Migration 004: Agregar columna co a sps_estadisticas_diarias
-- para poder filtrar stats del POS por centro de operación.
-- =============================================================

-- 1. Agregar columna (nullable inicialmente, luego NOT NULL)
ALTER TABLE sps_estadisticas_diarias ADD COLUMN IF NOT EXISTS co TEXT;

-- 2. Los datos existentes son todos del CO 001
UPDATE sps_estadisticas_diarias SET co = '001' WHERE co IS NULL;

-- 3. Ahora sí NOT NULL
ALTER TABLE sps_estadisticas_diarias ALTER COLUMN co SET NOT NULL;

-- 4. Eliminar la primary key/unique actual sobre fecha sola
--    (el nombre exacto depende de cómo se creó la tabla)
ALTER TABLE sps_estadisticas_diarias DROP CONSTRAINT IF EXISTS sps_estadisticas_diarias_pkey;
ALTER TABLE sps_estadisticas_diarias DROP CONSTRAINT IF EXISTS sps_estadisticas_diarias_fecha_key;

-- 5. Crear nueva PK compuesta (fecha, co)
ALTER TABLE sps_estadisticas_diarias ADD PRIMARY KEY (fecha, co);

-- =============================================================
-- Nota: si el nombre del constraint es otro, ajustarlo.
-- Para ver los constraints actuales:
--   SELECT conname FROM pg_constraint WHERE conrelid = 'sps_estadisticas_diarias'::regclass;
-- =============================================================
