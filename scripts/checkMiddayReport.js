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
    const coFilter = process.env.CO_FILTER || '(todos)';
    const checkLabel = horaCol >= 17 ? '5:00 PM' : '12:00 M';

    console.log(`🕐 Check silencio — ${checkLabel} — ${hoy}`);

    // ── 1. Consultar sps_facturas de hoy ──────────────────
    let query = logger.supabase
        .from('sps_facturas')
        .select('consec, tipo, cliente_nit, estado, co, fecha_factura, ultima_corrida')
        .eq('fecha_factura', hoy);

    if (process.env.CO_FILTER) {
        const cos = process.env.CO_FILTER.split(',').map(c => c.trim()).filter(Boolean);
        if (cos.length === 1) {
            query = query.eq('co', cos[0]);
        } else {
            query = query.in('co', cos);
        }
    }

    const { data: facturas, error } = await query.order('ultima_corrida', { ascending: false });

    if (error) {
        console.error(`❌ Error consultando sps_facturas: ${error.message}`);
        process.exit(1);
    }

    const total = facturas ? facturas.length : 0;
    const genericas = facturas ? facturas.filter(f => (f.cliente_nit || '').toString().trim() === '222222222222').length : 0;
    const reales = total - genericas;
    const ultimaFactura = facturas && facturas.length > 0 ? facturas.sort((a, b) => (b.ultima_corrida || '').localeCompare(a.ultima_corrida || ''))[0] : null;

    console.log(`   Total facturas hoy: ${total} | Reales: ${reales} | Genéricas: ${genericas}`);

    // ── 2. Si ambas categorías tienen datos, todo bien ────
    if (reales > 0 && genericas > 0) {
        console.log(`✅ Ambas categorías con facturas (reales=${reales}, genéricas=${genericas}). No se envía alerta.`);
        process.exit(0);
    }

    // ── 3. Si alguna está en 0 → enviar alerta ────────────
    console.log(`⚠️  Una categoría está vacía a las ${checkLabel}. Enviando alerta...`);

    await sendSilentMiddayNotification({
        co: coFilter,
        totalFacturasHoy: total,
        reales,
        genericas,
        checkTime: checkLabel,
        ultimaFactura: ultimaFactura
            ? {
                tipo: ultimaFactura.tipo || 'CNZ',
                consecutivo: ultimaFactura.consec || '—',
                cliente_nit: ultimaFactura.cliente_nit || '—',
            }
            : null,
    });

    console.log('✅ Alerta enviada.');
    process.exit(0);
})().catch(e => {
    console.error('❌ Error fatal:', e.message);
    console.error(e.stack);
    process.exit(1);
});
