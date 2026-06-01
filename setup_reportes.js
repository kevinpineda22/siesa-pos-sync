/**
 * setup_reportes.js
 *
 * Crea las tablas necesarias para el sistema de reportes en Supabase.
 * Uso:  node setup_reportes.js
 *
 * Requiere DATABASE_URL en .env (connection string de PostgreSQL).
 * Si no está configurada, muestra las instrucciones para hacerlo manualmente.
 */

require('dotenv').config();

const SQL = `
CREATE TABLE IF NOT EXISTS sps_config_reportes (
    id          SERIAL PRIMARY KEY,
    destinatarios TEXT[] NOT NULL DEFAULT '{}',
    programacion TEXT   NOT NULL DEFAULT 'diario',
    hora_envio  TIME   NOT NULL DEFAULT '08:00',
    dia_semana  INTEGER DEFAULT 1,
    activo      BOOLEAN DEFAULT true,
    ultimo_envio TIMESTAMP,
    created_at  TIMESTAMP DEFAULT now(),
    updated_at  TIMESTAMP DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sps_historial_reportes (
    id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    tipo_periodo  TEXT    NOT NULL,
    fecha_inicio  DATE    NOT NULL,
    fecha_fin     DATE    NOT NULL,
    destinatarios TEXT[]  NOT NULL,
    resumen       JSONB   NOT NULL,
    enviado_ok    BOOLEAN DEFAULT true,
    error         TEXT,
    created_at    TIMESTAMP DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_historial_fecha ON sps_historial_reportes (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_historial_periodo ON sps_historial_reportes (fecha_inicio, fecha_fin);

INSERT INTO sps_config_reportes (destinatarios, programacion, hora_envio, activo)
VALUES ('{}', 'diario', '08:00', false)
ON CONFLICT (id) DO NOTHING;
`;

async function main() {
    const dbUrl = process.env.DATABASE_URL;

    if (!dbUrl) {
        console.log('');
        console.log('⚠️  DATABASE_URL no está configurada en el archivo .env');
        console.log('');
        console.log('Para configurarla:');
        console.log('  1. Ve a https://supabase.com/dashboard/project/pitpougbnibmfrjyk/settings/database');
        console.log('  2. Copia el "Connection string" (URI)');
        console.log('  3. Pégalo en tu .env como:');
        console.log('     DATABASE_URL=postgresql://postgres:****@db.pitpougbnibmfrjyk.supabase.co:5432/postgres');
        console.log('');
        console.log('O puedes ejecutar el SQL manualmente desde el Dashboard de Supabase:');
        console.log('  SQL Editor → pegar el contenido de setup_reportes.sql → Ejecutar');
        console.log('');
        process.exit(1);
    }

    try {
        const { Client } = require('pg');
        const client = new Client({ connectionString: dbUrl });
        await client.connect();
        console.log('✅ Conectado a Supabase PostgreSQL');

        await client.query(SQL);
        console.log('✅ Tablas creadas/verificadas correctamente');
        console.log('   - sps_config_reportes');
        console.log('   - sps_historial_reportes');

        await client.end();
        console.log('✅ Setup completado.');
    } catch (err) {
        console.error('❌ Error al crear las tablas:', err.message);
        console.log('');
        console.log('Intenta ejecutar el SQL manualmente desde el Dashboard de Supabase:');
        console.log('  SQL Editor → pegar el contenido de setup_reportes.sql → Ejecutar');
        process.exit(1);
    }
}

main();
