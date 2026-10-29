-- =============================================================
-- Migration 007: Negative inventory transformations
-- Isolated tables for the nightly job that clears negative stock of
-- destination meat items by sending CEI (entry, destination) plus
-- CSA (exit, origins) documents to Siesa.
-- Does NOT touch sps_transformaciones / sps_transformaciones_corridas.
-- Seed data lives in 008_seed_transformaciones.sql.
-- =============================================================

-- Business equivalences: which origin item can feed which destination item.
CREATE TABLE IF NOT EXISTS sps_transformaciones_equivalencias (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    item_origen   INTEGER NOT NULL,
    item_destino  INTEGER NOT NULL,
    corte         TEXT,
    descripcion   TEXT,
    activo        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (item_origen, item_destino)
);

-- Global origin priority (lower orden = consumed first).
CREATE TABLE IF NOT EXISTS sps_transformaciones_prioridad (
    item_origen  INTEGER PRIMARY KEY,
    orden        INTEGER NOT NULL UNIQUE,
    activo       BOOLEAN NOT NULL DEFAULT TRUE
);

-- Persisted plan: one CEI row per destination plus one CSA row per origin.
-- CEI rows use item_origen = 0. The payload is stored verbatim and resent
-- as-is on resume (the CEI zeroes the destination, so the CSA cannot be
-- regenerated from a fresh inventory query).
CREATE TABLE IF NOT EXISTS sps_transformaciones_negativos (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entorno              TEXT NOT NULL CHECK (entorno IN ('QA', 'PROD')),
    fecha                DATE NOT NULL,
    co                   TEXT NOT NULL,
    bodega               TEXT NOT NULL,
    item_destino         INTEGER NOT NULL,
    tipo_dto             TEXT NOT NULL CHECK (tipo_dto IN ('CEI', 'CSA')),
    item_origen          INTEGER NOT NULL DEFAULT 0,
    status               TEXT NOT NULL DEFAULT 'PLANNED'
                         CHECK (status IN ('PLANNED', 'SENDING', 'OK', 'ERROR', 'AMBIGUO', 'CANCELADO')),
    cantidad             NUMERIC(18,2),
    costo_unitario       NUMERIC(18,4),
    um                   TEXT,
    disponible_snapshot  NUMERIC(18,4),
    payload              JSONB,
    respuesta            JSONB,
    error                TEXT,
    intentos             INTEGER NOT NULL DEFAULT 0,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (entorno, fecha, co, bodega, item_destino, tipo_dto, item_origen)
);

CREATE INDEX IF NOT EXISTS idx_sps_transformaciones_negativos_entorno_fecha
    ON sps_transformaciones_negativos (entorno, fecha DESC);

CREATE INDEX IF NOT EXISTS idx_sps_transformaciones_negativos_status
    ON sps_transformaciones_negativos (entorno, status);

-- One row per non-dry-run job execution (history is kept, no unique key).
CREATE TABLE IF NOT EXISTS sps_transformaciones_negativos_corridas (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    fecha      DATE NOT NULL,
    entorno    TEXT NOT NULL CHECK (entorno IN ('QA', 'PROD')),
    resultado  TEXT NOT NULL CHECK (resultado IN ('PROCESADO', 'SIN_NEGATIVOS', 'CON_FALLO', 'ERROR_FATAL')),
    destinos   INTEGER NOT NULL DEFAULT 0,
    documentos INTEGER NOT NULL DEFAULT 0,
    omitidos   INTEGER NOT NULL DEFAULT 0,
    ambiguos   INTEGER NOT NULL DEFAULT 0,
    fallos     INTEGER NOT NULL DEFAULT 0,
    mensaje    TEXT,
    origen     TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sps_transformaciones_negativos_corridas_entorno_fecha
    ON sps_transformaciones_negativos_corridas (entorno, fecha DESC);
