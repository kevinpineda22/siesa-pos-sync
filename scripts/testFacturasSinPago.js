/**
 * testFacturasSinPago.js — READ-ONLY. Lista las facturas de HOY (CO 001, Z01/Z02) que NO
 * tienen pago EFE que case (Caja = 0) → las que fallarían con "cartera vs CxC" por recaudo 0.
 * Solo consulta Connekta (GET). NO toca Siesa.
 *
 *   node scripts/testFacturasSinPago.js
 *   SP_FECHA=2026-06-17 node scripts/testFacturasSinPago.js
 */
require('dotenv').config();
const axios = require('axios');

const CIA = process.env.CIA || '7375';
const U = (q) => `https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=${q}`;
async function fetch(q) {
    const r = await axios.get(U(q), { headers: { ConniKey: process.env.CONNI_KEY, ConniToken: process.env.CONNI_TOKEN } });
    let d = r.data;
    if (d.detalle && d.detalle.Datos) d = d.detalle.Datos;
    else if (d.detalle && d.detalle.Table) d = d.detalle.Table;
    return Array.isArray(d) ? d : [];
}
const key = (co, caja, consec) => `${String(co || '').trim().padStart(3, '0')}|${String(caja || '').trim().toUpperCase()}|${consec}`;

(async () => {
    const fecha = process.env.SP_FECHA || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    const ventas = await fetch('merkahorro_venta_pos_dev');
    const pagos = await fetch('merkahorro_pagos_pos_dev');

    const delDia = ventas.filter(d =>
        String(d.CoDoc || '').trim().padStart(3, '0') === '001' &&
        ['Z01', 'Z02'].includes(String(d.ID_TIPO_DOCTO || '').trim().toUpperCase()) &&
        (d.FECHA_DOCTO || '').split('T')[0] === fecha
    );

    // pago neto por factura (suma ingreso - egreso de los EFE que casan)
    const pagoPorFac = {};
    pagos.forEach(p => {
        const k = key(p.CoDoc, p.ID_TIPO_DOCTO, p.CONSEC_DOCTO);
        pagoPorFac[k] = (pagoPorFac[k] || 0) + ((p.VLR_MEDIO_PAGO_INGRESO || 0) - (p.VLR_MEDIO_PAGO_EGRESO || 0));
    });

    // agrupar ventas por factura
    const facs = {};
    delDia.forEach(d => {
        const k = key(d.CoDoc, d.ID_TIPO_DOCTO, d.CONSEC_DOCTO);
        if (!facs[k]) facs[k] = { consec: d.CONSEC_DOCTO, caja: d.ID_TIPO_DOCTO, neto: parseFloat(d.VrNetoDocto || 0), items: 0, cliente: d.NitTercero };
        facs[k].items++;
    });

    const lista = Object.entries(facs).map(([k, f]) => ({ ...f, pago: pagoPorFac[k] || 0 }));
    const sinPago = lista.filter(f => Math.abs(f.neto) > 0 && Math.abs(f.pago) === 0);

    console.log('==================================================');
    console.log(`🔎 Facturas de ${fecha} (CO 001, Z01/Z02) SIN pago EFE  (READ-ONLY)`);
    console.log('==================================================');
    console.log(`Total facturas del día: ${lista.length} | sin pago EFE: ${sinPago.length}\n`);
    if (sinPago.length === 0) {
        console.log('🟢 Todas tienen pago EFE. (El Caja=0 vendría de otra fecha/consec.)');
    } else {
        console.log('Consec   Caja   Items   Neto         Cliente        Pago EFE');
        sinPago.sort((a, b) => Math.abs(b.neto) - Math.abs(a.neto)).forEach(f => {
            console.log(`${String(f.consec).padEnd(8)} ${f.caja.padEnd(5)} ${String(f.items).padStart(5)}   ${String(Math.round(f.neto)).padStart(10)}   ${String(f.cliente).padEnd(13)}  ${f.pago}`);
        });
        console.log('\n=> Estas fallan con "cartera vs CxC" porque el recaudo (Caja) es 0.');
        console.log('   Casi seguro se pagaron con un medio != EFE (el filtro de la query lo bota), o no tienen pago.');
    }
    console.log('\n🧪 Solo lectura, no se tocó Siesa.\n');
    process.exit(0);
})().catch(e => { console.error('❌', e.response?.data || e.message); process.exit(1); });
