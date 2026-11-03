-- =============================================================
-- Migration 010: Negative inventory transformations, one document per store
-- One row per Siesa document (CEI or CSA) per store (co, bodega) and day.
-- Lines and novedades live in JSONB so a CEI/CSA pair can be persisted
-- atomically and a document can be resent with adjusted quantities.
-- Quantities inside `lineas` are plain numbers with up to 4 decimals.
-- The legacy per-destination table (sps_transformaciones_negativos, 007)
-- is NOT altered: it stays as read-only history.
-- Apply BEFORE deploying the API/panel and BEFORE enabling the new flow.
-- =============================================================

CREATE TABLE IF NOT EXISTS sps_transformaciones_negativos_docs (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entorno         TEXT NOT NULL CHECK (entorno IN ('QA', 'PROD')),
    fecha           DATE NOT NULL,
    co              TEXT NOT NULL,
    bodega          TEXT NOT NULL,
    tipo_dto        TEXT NOT NULL CHECK (tipo_dto IN ('CEI', 'CSA')),
    status          TEXT NOT NULL DEFAULT 'PLANNED'
                    CHECK (status IN ('PLANNED', 'SENDING', 'OK', 'ERROR', 'AMBIGUO', 'CANCELADO')),
    lineas          JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(lineas) = 'array'),
    novedades       JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(novedades) = 'array'),
    cantidad_total  NUMERIC(18,4),
    lineas_activas  INTEGER NOT NULL DEFAULT 0,
    payload         JSONB,
    respuesta       JSONB,
    error           TEXT,
    intentos        INTEGER NOT NULL DEFAULT 0,
    rondas          INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (entorno, fecha, co, bodega, tipo_dto)
);

CREATE INDEX IF NOT EXISTS idx_sps_transformaciones_negativos_docs_entorno_fecha
    ON sps_transformaciones_negativos_docs (entorno, fecha DESC);

CREATE INDEX IF NOT EXISTS idx_sps_transformaciones_negativos_docs_status
    ON sps_transformaciones_negativos_docs (entorno, status);
