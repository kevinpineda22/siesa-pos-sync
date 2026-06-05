-- Agregar columna cpe_items a sps_facturas para trazabilidad de ajustes de inventario
ALTER TABLE sps_facturas ADD COLUMN IF NOT EXISTS cpe_items JSONB DEFAULT NULL;
