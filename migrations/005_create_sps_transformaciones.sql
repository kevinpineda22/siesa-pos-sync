-- =============================================================
-- Migration 005: Tabla sps_transformaciones
-- Idempotencia y trazabilidad del flujo diario de transformacion
-- tocino (15202) -> chicharron (15207). Una fila por documento
-- enviado a Siesa (CEI = entrada, CSA = salida).
-- Clave unica: (entorno, fecha, co, bodega, item_venta, tipo_dto).
-- El entorno va en la clave: un envio OK en QA no debe bloquear el envio a PROD.
-- =============================================================

CREATE TABLE IF NOT EXISTS sps_transformaciones (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    fecha           DATE        NOT NULL,
    co              TEXT        NOT NULL,
    bodega          TEXT        NOT NULL,
    item_venta      INTEGER     NOT NULL,
    tipo_dto        TEXT        NOT NULL CHECK (tipo_dto IN ('CEI', 'CSA')),
    status          TEXT        NOT NULL CHECK (status IN ('OK', 'ERROR')),
    unidades_netas  NUMERIC(18,4) NOT NULL,
    cantidad        NUMERIC(18,4) NOT NULL,
    payload         JSONB,
    respuesta       JSONB,
    error           TEXT,
    intentos        INTEGER     NOT NULL DEFAULT 1,
    entorno         TEXT        NOT NULL CHECK (entorno IN ('QA', 'PROD')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT sps_transformaciones_uk UNIQUE (entorno, fecha, co, bodega, item_venta, tipo_dto)
);

CREATE INDEX IF NOT EXISTS idx_sps_transformaciones_fecha ON sps_transformaciones (fecha DESC);
