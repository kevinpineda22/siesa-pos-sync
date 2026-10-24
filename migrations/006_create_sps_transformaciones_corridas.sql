-- =============================================================
-- Migration 006: Tabla sps_transformaciones_corridas
-- Registro de CADA corrida no-dry-run del flujo diario de transformacion
-- tocino (15202) -> chicharron (15207), incluso las que no enviaron nada
-- (dias sin ventas, errores fatales).
-- La tabla se escribe SOLO desde siesa-pos-sync y la lee Backend-Carnes.
-- Sin restriccion unica: hay una fila por corrida y se conserva el historial.
-- La vista de Transformaciones usa la ULTIMA corrida por (entorno, fecha).
-- =============================================================

CREATE TABLE IF NOT EXISTS sps_transformaciones_corridas (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    fecha             DATE        NOT NULL,
    entorno           TEXT        NOT NULL CHECK (entorno IN ('QA', 'PROD')),
    resultado         TEXT        NOT NULL CHECK (resultado IN ('PROCESADO', 'SIN_VENTAS', 'CON_FALLO', 'ERROR_FATAL')),
    filas_vivo        INTEGER,
    filas_acum        INTEGER,
    filas_dia         INTEGER,
    grupos            INTEGER     NOT NULL DEFAULT 0,
    unidades          NUMERIC(18,4) NOT NULL DEFAULT 0,
    kilos             NUMERIC(18,4) NOT NULL DEFAULT 0,
    fallos            INTEGER     NOT NULL DEFAULT 0,
    dias_disponibles  JSONB,
    mensaje           TEXT,
    origen            TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sps_transformaciones_corridas_entorno_fecha
    ON sps_transformaciones_corridas (entorno, fecha DESC);

-- Registro manual: 23/10/2026 verificado sin ventas de chicharron (anterior al registro de corridas).
-- Idempotente: no inserta nada si ya existe una corrida (de cualquier origen) para ese dia.
INSERT INTO sps_transformaciones_corridas (fecha, entorno, resultado, grupos, origen, mensaje)
SELECT '2026-10-23', 'PROD', 'SIN_VENTAS', 0, 'manual',
       'Registro manual: verificado sin ventas de chicharron (anterior al registro de corridas)'
WHERE NOT EXISTS (
    SELECT 1 FROM sps_transformaciones_corridas
    WHERE entorno = 'PROD' AND fecha = '2026-10-23'
);
