/**
 * checkMiddayReport.js
 *
 * Verifica a las 12M y 5PM si hay facturas registradas hoy.
 * Usa el query de Connekta (merkahorro_venta_pos_stats_dev) que contiene
 * TODOS los documentos POS (reales + genéricos 222222222222), al igual
 * que el dashboard, para contar correctamente por CO sin duplicar CNZ/CFZ.
 *
 * Envía alerta por correo si ALGUNA categoría (reales o genéricas) está en 0.
 *
 * Uso:
 *   node scripts/checkMiddayReport.js
 *
 * Variables de entorno usadas:
 *   - CONNI_KEY, CONNI_TOKEN, CIA (conexión Connekta)
 *   - SUPABASE_URL, SUPABASE_SERVICE_KEY (fallback a sps_estadisticas_diarias)
 *   - NOTIFY_ERROR_EMAILS (destinatarios)
 *   - CO_FILTER (opcional, para filtrar por CO)
 *   - SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, SMTP_FROM
 */
require('dotenv').config();
const axios = require('axios');
const logger = require('../logger');
const { sendSilentMiddayNotification } = require('../notifier');

const ES_GENERICO = (nit) => (nit || '').toString().trim() === '222222222222';

(async () => {
    const ahora = new Date();
    const hoy = ahora.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    const horaCol = parseInt(ahora.toLocaleString('en-US', { timeZone: 'America/Bogota', hour: 'numeric', hour12: false }), 10);
    const checkLabel = horaCol >= 17 ? '5:00 PM' : '12:00 M';
    const coFilter = process.env.CO_FILTER || '';
    const cosFiltro = coFilter ? coFilter.split(',').map(c => c.trim()).filter(Boolean) : [];

    console.log(`🕐 Check silencio — ${checkLabel} — ${hoy} — CO(s): ${cosFiltro.length ? cosFiltro.join(',') : 'todos'}`);

    // ── 1. OBTENER DATOS POS DESDE CONNEKTA ──────────────
    let posDocs = [];

    try {
        const CIA = process.env.CIA || '7375';
        const queryStats = process.env.QUERY_STATS || 'merkahorro_venta_pos_stats_dev';
        const URL_STATS = `https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=${queryStats}`;

        const resp = await axios.get(URL_STATS, {
            headers: {
                'ConniKey': process.env.CONNI_KEY,
                'ConniToken': process.env.CONNI_TOKEN
            },
            timeout: 30000
        });

        let raw = resp.data;
        if (raw.detalle && raw.detalle.Datos) raw = raw.detalle.Datos;
        else if (raw.detalle && raw.detalle.Table) raw = raw.detalle.Table;
        else if (raw.Table) raw = raw.Table;
        posDocs = Array.isArray(raw) ? raw : [];

        console.log(`   Connekta: ${posDocs.length} documentos POS totales`);
    } catch (e) {
        console.error(`⚠️ Error consultando Connekta stats: ${e.message}`);
    }

    // ── 2. AGRUPAR POR CO ──────────────────────────────────
    const grupos = {};
    const esNitGenerico = (nit) => !nit || (nit || '').toString().trim() === '222222222222';

    // Si no hay datos de Connekta, intentar fallback a sps_estadisticas_diarias
    let desdeDB = false;

    if (posDocs.length === 0) {
        console.log('   Sin datos de Connekta. Intentando sps_estadisticas_diarias...');
        const cosConsultar = cosFiltro.length ? cosFiltro : ['001', '011', '003'];

        for (const co of cosConsultar) {
            try {
                const { data } = await logger.supabase
                    .from('sps_estadisticas_diarias')
                    .select('*')
                    .eq('fecha', hoy)
                    .eq('co', co)
                    .single();

                if (data) {
                    const porNit = data.por_nit || {};
                    const reales = (porNit.real?.transacciones || 0);
                    const genericas = (porNit.generico?.transacciones || 0);
                    const total = reales + genericas;
                    const coOk = reales > 0 && genericas > 0;

                    grupos[co] = { co, total, reales, genericas, ok: coOk, ultimaFactura: null };
                    console.log(`   ${desdeDB ? ' ' : 'DB'}CO ${co}: total=${total} | reales=${reales} | genéricas=${genericas} ${coOk ? '✅' : '⚠️'}`);
                }
            } catch (e) {
                console.log(`   Sin datos en sps_estadisticas_diarias para CO ${co}`);
            }
        }
        desdeDB = true;
    } else {
        // Filtrar solo docs de hoy
        const delDia = posDocs.filter(d => (d.FECHA_DOCTO || '').split('T')[0] === hoy);
        console.log(`   Documentos de hoy: ${delDia.length}`);

        delDia.forEach(d => {
            const co = (d.CoDoc || '001').toString().padStart(3, '0');
            if (cosFiltro.length && !cosFiltro.includes(co)) return; // filtrar por CO si hay filtro
            if (!grupos[co]) grupos[co] = { co, total: 0, reales: 0, genericas: 0, docs: [] };
            grupos[co].total++;
            if (esNitGenerico(d.NitTercero)) {
                grupos[co].genericas++;
            } else {
                grupos[co].reales++;
            }
            grupos[co].docs.push(d);
        });
    }

    // ── 3. ARMAR RESULTADOS ────────────────────────────────
    const resultados = Object.values(grupos).map(g => ({
        co: g.co,
        total: g.total,
        reales: g.reales,
        genericas: g.genericas,
        ok: g.reales > 0 && g.genericas > 0,
        ultimaFactura: null, // omitimos el detalle de última factura para simplificar
    }));

    if (resultados.length === 0) {
        console.log('⚠️ No hay datos POS para ningún CO. Saliendo sin alerta.');
        process.exit(0);
    }

    let hayAlerta = false;
    resultados.forEach(r => {
        const ok = r.reales > 0 && r.genericas > 0;
        if (!ok) hayAlerta = true;
        console.log(`   CO ${r.co}: total=${r.total} | reales=${r.reales} | genéricas=${r.genericas} ${ok ? '✅' : '⚠️'}`);
    });

    // ── 4. SI TODOS BIEN, SALIR ──────────────────────────
    if (!hayAlerta) {
        console.log('✅ Todos los COs con reales y genéricas > 0. No se envía alerta.');
        process.exit(0);
    }

    // ── 5. ALGÚN CO CON NOVEDAD → ENVIAR ALERTA ─────────
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
