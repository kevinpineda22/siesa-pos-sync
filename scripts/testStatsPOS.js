/**
 * testStatsPOS.js — READ-ONLY. Desglosa la consulta de stats del POS para una fecha:
 * por caja y por NIT genérico, para entender el desfase POS vs sincronizado.
 * Solo consulta Connekta (GET). NO toca Siesa.
 *
 *   node scripts/testStatsPOS.js
 *   NIT_FECHA=2026-06-14 node scripts/testStatsPOS.js
 */
require('dotenv').config();
const axios = require('axios');

const CIA = process.env.CIA || '7375';
const queryStats = process.env.QUERY_STATS || 'merkahorro_venta_pos_stats_dev';
const URL = `https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=${queryStats}`;

(async () => {
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    const fecha = process.env.NIT_FECHA || hoy;

    const r = await axios.get(URL, { headers: { ConniKey: process.env.CONNI_KEY, ConniToken: process.env.CONNI_TOKEN } });
    let raw = r.data;
    if (raw.detalle && raw.detalle.Datos) raw = raw.detalle.Datos;
    else if (raw.detalle && raw.detalle.Table) raw = raw.detalle.Table;
    else if (raw.Table) raw = raw.Table;
    const docs = Array.isArray(raw) ? raw : [];

    const delDia = docs.filter(d => (d.FECHA_DOCTO || '').split('T')[0] === fecha);
    const esGen = (d) => (d.NitTercero || '').toString().trim() === '222222222222';

    console.log('==================================================');
    console.log(`🔎 ${queryStats}  fecha=${fecha}  (READ-ONLY)`);
    console.log('==================================================');
    console.log(`Transacciones POS del día: ${delDia.length}  | genéricas: ${delDia.filter(esGen).length}\n`);

    // Desglose por caja (ID_TIPO_DOCTO)
    const porCaja = {};
    delDia.forEach(d => {
        const c = (d.ID_TIPO_DOCTO || 'SIN_CAJA').toString().trim().toUpperCase();
        if (!porCaja[c]) porCaja[c] = { total: 0, generico: 0 };
        porCaja[c].total++;
        if (esGen(d)) porCaja[c].generico++;
    });

    console.log('Por caja (ID_TIPO_DOCTO):');
    console.log('  CAJA      TOTAL   GENÉRICAS   REALES');
    Object.entries(porCaja).sort((a, b) => b[1].total - a[1].total).forEach(([c, v]) => {
        console.log(`  ${c.padEnd(8)}  ${String(v.total).padStart(5)}   ${String(v.generico).padStart(8)}   ${String(v.total - v.generico).padStart(6)}`);
    });

    const z = ['Z01', 'Z02'];
    const enZ = delDia.filter(d => z.includes((d.ID_TIPO_DOCTO || '').toString().trim().toUpperCase()));
    console.log(`\n👉 Solo Z01+Z02: ${enZ.length} transacciones | ${enZ.filter(esGen).length} genéricas | ${enZ.length - enZ.filter(esGen).length} reales`);
    console.log('\n🧪 Solo lectura, no se tocó Siesa.\n');
    process.exit(0);
})().catch(e => { console.error('❌', e.response?.data || e.message); process.exit(1); });
