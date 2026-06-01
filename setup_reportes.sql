-- =============================================================================
-- SIESA POS SYNC — Tablas para el Sistema de Reportes
-- =============================================================================
-- Ejecutar en el SQL Editor de Supabase (Dashboard → SQL Editor)
-- O desde terminal:  psql "$DATABASE_URL" -f setup_reportes.sql
-- =============================================================================

-- 1. Configuración de reportes (correos, programación)
CREATE TABLE IF NOT EXISTS sps_config_reportes (
    id          SERIAL PRIMARY KEY,
    destinatarios TEXT[] NOT NULL DEFAULT '{}',
    programacion TEXT   NOT NULL DEFAULT 'diario',   -- 'diario' | 'semanal'
    hora_envio  TIME   NOT NULL DEFAULT '08:00',
    dia_semana  INTEGER DEFAULT 1,                    -- 1=Lunes…7=Domingo (solo semanal)
    activo      BOOLEAN DEFAULT true,
    ultimo_envio TIMESTAMP,
    created_at  TIMESTAMP DEFAULT now(),
    updated_at  TIMESTAMP DEFAULT now()
);

-- 2. Historial de reportes enviados
CREATE TABLE IF NOT EXISTS sps_historial_reportes (
    id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tipo_periodo  TEXT    NOT NULL,         -- 'diario' | 'semanal'
    fecha_inicio  DATE    NOT NULL,
    fecha_fin     DATE    NOT NULL,
    destinatarios TEXT[]  NOT NULL,
    resumen       JSONB   NOT NULL,         -- { total, ok, fail, pct_exito, total_neto }
    enviado_ok    BOOLEAN DEFAULT true,
    error         TEXT,
    created_at    TIMESTAMP DEFAULT now()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_historial_fecha ON sps_historial_reportes (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_historial_periodo ON sps_historial_reportes (fecha_inicio, fecha_fin);

-- 3. Insertar config por defecto (si no existe)
INSERT INTO sps_config_reportes (destinatarios, programacion, hora_envio, activo)
VALUES ('{}', 'diario', '08:00', false)
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- FIN
-- =============================================================================
