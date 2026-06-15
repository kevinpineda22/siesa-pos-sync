/**
 * testCarteraCxC.js — Diagnóstico rápido de cartera vs CxC para UN consec.
 * READ-ONLY: solo consulta Connekta, no escribe nada.
 *
 * Uso:
 *   node scripts/testCarteraCxC.js 684
 */
require('dotenv').config();
const axios = require('axios');

const CIA = process.env.CIA || '7375';
const CONSEC = process.argv[2] || '684';
const CO = '001';
const CAJA = 'Z02';

const URLS = {
    ventas: `https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=merkahorro_venta_pos_dev`,
    pagos:  `https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=merkahorro_pagos_pos_dev`,
    impuestos: `https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=merkahorro_imptos_pos_dev`,
};

const headers = {
    'ConniKey': process.env.CONNI_KEY,
    'ConniToken': process.env.CONNI_TOKEN,
};

async function fetch(url, label) {
    const resp = await axios.get(url, { headers, timeout: 180000 });
    let data = resp.data;
    if (data.detalle?.Datos) data = data.detalle.Datos;
    else if (data.detalle?.Table) data = data.detalle.Table;
    else if (data.Table) data = data.Table;
    const arr = Array.isArray(data) ? data : [];
    console.log(`  ${label}: ${arr.length} total`);
    return arr;
}

function fmt(n) { return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0); }

console.log('══════════════════════════════════════════');
console.log(`  CARTERA vs CxC  |  CONSEC=${CONSEC}  CO=${CO}  Caja=${CAJA}`);
console.log('══════════════════════════════════════════\n');

(async () => {
    console.log('📡 Descargando datos de Connekta...');
    const [ventas, pagos, impuestos] = await Promise.all([
        fetch(URLS.ventas, 'Ventas'),
        fetch(URLS.pagos, 'Pagos'),
        fetch(URLS.impuestos, 'Impuestos'),
    ]);

    // Filtrar solo este consec
    const items = ventas.filter(d =>
        String(d.CONSEC_DOCTO || '').trim() === String(CONSEC) &&
        String(d.CoDoc || '').trim().padStart(3, '0') === CO &&
        String(d.ID_TIPO_DOCTO || '').trim().toUpperCase() === CAJA
    );
    const pagosFilt = pagos.filter(p =>
        String(p.CONSEC_DOCTO || '').trim() === String(CONSEC) &&
        String(p.CoDoc || '').trim().padStart(3, '0') === CO &&
        String(p.ID_TIPO_DOCTO || '').trim().toUpperCase() === CAJA
    );
    const impFilt = impuestos.filter(i =>
        String(i.CONSEC_DOCTO || '').trim() === String(CONSEC) &&
        String(i.CoDoc || '').trim().padStart(3, '0') === CO &&
        String(i.ID_TIPO_DOCTO || '').trim().toUpperCase() === CAJA
    );
    // Mostrar nombres de campos del primer pago para depuración
    if (pagosFilt.length > 0) {
        console.log('\n🔍 Campos del primer pago:', JSON.stringify(Object.keys(pagosFilt[0]).slice(0, 20)));
        console.log('   Valores:', JSON.stringify(Object.fromEntries(Object.entries(pagosFilt[0]).slice(0, 15))));
    }
    if (impFilt.length > 0) {
        console.log('\n🔍 Campos del primer impuesto:', JSON.stringify(Object.keys(impFilt[0]).slice(0, 20)));
        console.log('   Valores:', JSON.stringify(Object.fromEntries(Object.entries(impFilt[0]).slice(0, 15))));
    }

    console.log(`\n📦 Items: ${items.length}  |  Pagos: ${pagosFilt.length}  |  Impuestos: ${impFilt.length}\n`);

    if (items.length === 0) {
        console.log('❌ No se encontraron items. El consec puede no estar en la ventana de Connekta.');
        return;
    }

    // Impuestos por RowidMvto
    const imptosPorRowid = {};
    const vistos = new Set();
    impFilt.forEach(imp => {
        const llave = `${imp.RowidMvto}|${String(imp.ID_LLAVE_IMPUESTO || '').trim()}`;
        if (!imp.ID_LLAVE_IMPUESTO || imp.ID_LLAVE_IMPUESTO === 'null') return;
        if (vistos.has(llave)) return;
        vistos.add(llave);
        if (!imptosPorRowid[imp.RowidMvto]) imptosPorRowid[imp.RowidMvto] = [];
        imptosPorRowid[imp.RowidMvto].push(imp);
    });

    // Mostrar items detalle
    let sumaBruto = 0, sumaBase = 0, sumaIva = 0, sumaTotal = 0;
    console.log('Ítem       | BRUTO     | DSCTO     | BASE_NETA | IVA calc. | TOTAL LÍNEA');
    console.log('───────────┼───────────┼───────────┼───────────┼───────────┼─────────────');
    items.forEach((d, i) => {
        const vrBruto = parseFloat(d.VALOR_BRUTO || d.VrBruto || 0);
        const cant = parseFloat(d.CANTIDAD || 0);
        const descuento = parseFloat(d.VALOR_DESCUENTO || 0);
        const baseNeta = vrBruto - descuento;
        const imptos = imptosPorRowid[d.RowidMvto] || [];
        let ivaCalc = 0;
        imptos.forEach(imp => {
            const id = (imp.ID_LLAVE_IMPUESTO || '').trim();
            const tasa = parseFloat(imp.TASA || imp.PORCENTAJE_BASE || 0);
            if (tasa > 0) {
                ivaCalc += Math.round(baseNeta * tasa / 100);
            }
        });
        sumaBruto += vrBruto;
        sumaBase += baseNeta;
        sumaIva += ivaCalc;
        const totalLinea = baseNeta + ivaCalc;
        sumaTotal += totalLinea;
        console.log(
            `${String(d.id_item || d.IdItem || '').padEnd(11)}|` +
            `${fmt(vrBruto).padStart(11)}|` +
            `${fmt(descuento).padStart(11)}|` +
            `${fmt(baseNeta).padStart(11)}|` +
            `${fmt(ivaCalc).padStart(11)}|` +
            `${fmt(totalLinea).padStart(13)}`
        );
    });
    console.log('───────────┼───────────┼───────────┼───────────┼───────────┼─────────────');
    console.log(`TOTAL      |${fmt(sumaBruto).padStart(11)}|${'—'.padStart(11)}|${fmt(sumaBase).padStart(11)}|${fmt(sumaIva).padStart(11)}|${fmt(sumaTotal).padStart(13)}`);

    // Mostrar pagos (campos reales: VLR_MEDIO_PAGO_INGRESO, VLR_MEDIO_PAGO_EGRESO, ID_MEDIOS_PAGO)
    let sumaPagos = 0;
    console.log(`\n💳 Pagos (${pagosFilt.length}):`);
    pagosFilt.forEach(p => {
        const ingreso = parseFloat(p.VLR_MEDIO_PAGO_INGRESO || 0);
        const egreso = parseFloat(p.VLR_MEDIO_PAGO_EGRESO || 0);
        const val = ingreso - egreso;
        const medio = (p.ID_MEDIOS_PAGO || '?').toString().trim();
        console.log(`   ${medio.padEnd(6)} → ingreso=${fmt(ingreso)}  egreso=${fmt(egreso)}  neto=${fmt(val)}`);
        sumaPagos += val;
    });
    console.log(`   ${'TOTAL'.padEnd(6)} → ${fmt(sumaPagos)}`);

    // Diferencia
    const diff = sumaPagos - sumaTotal;
    console.log(`\n══════════════════════════════════════════`);
    console.log(`  Cartera (pagos): ${fmt(sumaPagos)}`);
    console.log(`  CxC (items+IVA): ${fmt(sumaTotal)}`);
    console.log(`  Diferencia:      ${diff >= 0 ? '+' : ''}${fmt(diff)}`);
    console.log(`══════════════════════════════════════════`);

    // Mostrar impuestos detalle
    console.log(`\n📋 Impuestos por ítem:`);
    items.forEach(d => {
        const imptos = imptosPorRowid[d.RowidMvto] || [];
        if (imptos.length === 0) return;
        const baseNeta = parseFloat(d.VALOR_BRUTO || d.VrBruto || 0) - parseFloat(d.VALOR_DESCUENTO || 0);
        console.log(`   Item ${d.id_item || d.IdItem}: base=${fmt(baseNeta)}`);
        imptos.forEach(imp => {
            const id = (imp.ID_LLAVE_IMPUESTO || '').trim();
            const tasa = parseFloat(imp.TASA || imp.PORCENTAJE_BASE || 0);
            const vrOriginal = parseFloat(imp.VALOR_TOTAL || 0);
            const vrRecalc = tasa > 0 ? Math.round(baseNeta * tasa / 100) : vrOriginal;
            const flag = vrOriginal !== vrRecalc ? ' ⟵ RECALC' : '';
            console.log(`      ${id.padEnd(6)} tasa=${tasa}%  original=${fmt(vrOriginal).padStart(10)}  recalculado=${fmt(vrRecalc).padStart(10)}${flag}`);
        });
    });
})().catch(e => {
    console.error('❌ Error:', e.response?.data || e.message);
    process.exit(1);
});
