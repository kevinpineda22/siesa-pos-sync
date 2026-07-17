/**
 * checkMiddayReport.js
 *
 * Verifica a las 12M y 5PM si hay facturas registradas hoy.
 * Envía alerta por correo si ALGUNA categoría (reales o genéricas) está en 0:
 *   - reales = 0  → hay genéricas pero no ventas a cliente real
 *   - genéricas = 0 → hay reales pero no facturas con NIT 222222222222
 *   - ambas = 0 → no hay ninguna factura (POS/sync podría estar caído)
 *
 * Uso:
 *   node scripts/checkMiddayReport.js
 *
 * Variables de entorno usadas:
 *   - SUPABASE_URL, SUPABASE_SERVICE_KEY (conexión)
 *   - NOTIFY_ERROR_EMAILS (destinatarios)
 *   - CO_FILTER (opcional, para mostrarlo en la alerta)
 *   - SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM (para el correo)
 */
require('dotenv').config();
const logger = require('../logger');
const { sendSilentMiddayNotification } = require('../notifier');

(async () => {
    const ahora = new Date();
    const hoy = ahora.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    const horaCol = parseInt(ahora.toLocaleString('en-US', { timeZone: 'America/Bogota', hour: 'numeric', hour12: false }), 10);
    const checkLabel = horaCol >= 17 ? '5:00 PM' : '12:00 M';
    const coFilter = process.env.CO_FILTER || '';
    const cos = coFilter ? coFilter.split(',').map(c => c.trim()).filter(Boolean) : [];

    console.log(`🕐 Check silencio — ${checkLabel} — ${hoy} — CO(s): ${cos.length ? cos.join(',') : 'todos'}`);

    // ── 1. Consultar sps_facturas de hoy por CO ──────────
    const resultados = [];
    let hayAlerta = false;

    for (const co of cos) {
        const { data: facturas, error } = await logger.supabase
            .from('sps_facturas')
            .select('consec, tipo, cliente_nit, estado, co, fecha_factura, ultima_corrida')
            .eq('fecha_factura', hoy)
            .eq('co', co)
            .order('ultima_corrida', { ascending: false });

        if (error) {
            console.error(`❌ Error consultando sps_facturas para CO ${co}: ${error.message}`);
            process.exit(1);
        }

        const total = facturas ? facturas.length : 0;
        const genericas = facturas ? facturas.filter(f => (f.cliente_nit || '').toString().trim() === '222222222222').length : 0;
        const reales = total - genericas;
        const ultimaFactura = facturas && facturas.length > 0
            ? { tipo: facturas[0].tipo || 'CNZ', consecutivo: facturas[0].consec || '—', cliente_nit: facturas[0].cliente_nit || '—' }
            : null;

        const coOk = reales > 0 && genericas > 0;
        if (!coOk) hayAlerta = true;

        resultados.push({ co, total, reales, genericas, ok: coOk, ultimaFactura });
        console.log(`   CO ${co}: total=${total} | reales=${reales} | genéricas=${genericas} ${coOk ? '✅' : '⚠️'}`);
    }

    // ── 2. Si todos los COs están bien, salir ────────────
    if (!hayAlerta) {
        console.log('✅ Todos los COs con reales y genéricas > 0. No se envía alerta.');
        process.exit(0);
    }

    // ── 3. Algún CO con novedad → enviar alerta ─────────
    console.log(`⚠️  Hay CO(s) con categorías en 0. Enviando alerta...`);

    await sendSilentMiddayNotification({
        resultados,
        checkTime: checkLabel,
    });

    console.log('✅ Alerta enviada.');
    process.exit(0);
})().catch(e => {
    console.error('❌ Error fatal:', e.message);
    console.error(e.stack);
    process.exit(1);
});
