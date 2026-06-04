/**
 * runReporte.js
 *
 * Reporte diario de facturación (GitHub Actions, 6:00 a.m. Bogotá).
 * Genera y envía por correo el reporte del DÍA ANTERIOR (resumen de Siesa para contabilidad).
 *
 * Corre en el runner de GitHub Actions (Node directo). Lee los datos de Supabase y envía vía SMTP.
 *
 * Variables de entorno:
 *   - SUPABASE_URL, SUPABASE_SERVICE_KEY  (datos)
 *   - SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM  (envío)
 *   - REPORTE_DESTINATARIOS (opcional): correos separados por coma. Si no se pasa, usa los
 *     configurados en Supabase (gestionables desde el dashboard de Reportes).
 *   - REPORTE_FECHA (opcional): YYYY-MM-DD a reportar. Si no se pasa, usa AYER (America/Bogota).
 *
 * Salida: exit 0 si envió o si no había documentos; exit 1 ante error real o si había
 * documentos pero no se pudo enviar (ej. sin destinatarios configurados).
 */
require('dotenv').config();
const reportes = require('../reportes');

(async () => {
    // Fecha de "ayer" en zona America/Bogota. Colombia no usa horario de verano,
    // así que restar 24h y formatear en esa zona da siempre el día anterior correcto.
    const fmt = (d) => d.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    const fecha = (process.env.REPORTE_FECHA || '').trim() || fmt(new Date(Date.now() - 24 * 60 * 60 * 1000));

    const destEnv = (process.env.REPORTE_DESTINATARIOS || '').split(',').map(s => s.trim()).filter(Boolean);

    console.log('==================================================');
    console.log('📊 REPORTE DIARIO DE FACTURACIÓN → correo');
    console.log(`   Día reportado: ${fecha} (resumen del día anterior, America/Bogota)`);
    console.log(`   Destinatarios: ${destEnv.length ? destEnv.join(', ') : '(de la configuración en Supabase)'}`);
    console.log('==================================================');

    try {
        const opts = { fechaInicio: fecha, fechaFin: fecha };
        if (destEnv.length > 0) opts.destinatarios = destEnv;

        const res = await reportes.generarYEnviar(opts);
        console.log('Resultado:', JSON.stringify(res, null, 2));

        // Había documentos pero no se envió (típicamente: sin destinatarios configurados) -> rojo.
        if (res && res.enviado === false && (res.total || 0) > 0) {
            console.error(`⚠️ Había ${res.total} documento(s) pero NO se envió: ${res.message || '(sin detalle)'}`);
            process.exit(1);
        }
        console.log(res && res.enviado ? '✅ Reporte enviado.' : 'ℹ️ Sin documentos en el día; no se envía correo.');
        process.exit(0);
    } catch (e) {
        console.error('❌ Error fatal generando/enviando el reporte:', e.message);
        console.error(e.stack);
        process.exit(1);
    }
})();
