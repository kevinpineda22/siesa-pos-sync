/**
 * testPagoConsec.js — READ-ONLY. Muestra la venta y los pagos (EFE) de un consec.
 * Sirve para entender por qué una factura sale con Caja=0 (sin recaudo).
 * Solo consulta Connekta (GET). NO toca Siesa.
 *
 *   node scripts/testPagoConsec.js
 *   PG_CONSEC=1389 PG_CO=001 PG_CAJA=Z02 node scripts/testPagoConsec.js
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

(async () => {
    const CONSEC = process.env.PG_CONSEC || '1389';
    const CO = (process.env.PG_CO || '001').padStart(3, '0');
    const CAJA = (process.env.PG_CAJA || 'Z02').toUpperCase();

    const ventas = await fetch('merkahorro_venta_pos_dev');
    const pagos = await fetch('merkahorro_pagos_pos_dev');

    const coOk = (v) => String(v || '').trim().padStart(3, '0') === CO;
    const cajaOk = (v) => String(v || '').trim().toUpperCase() === CAJA;

    const itemsV = ventas.filter(d => String(d.CONSEC_DOCTO) === String(CONSEC) && coOk(d.CoDoc) && cajaOk(d.ID_TIPO_DOCTO));
    const pagosV = pagos.filter(p => String(p.CONSEC_DOCTO) === String(CONSEC) && coOk(p.CoDoc) && cajaOk(p.ID_TIPO_DOCTO));
    // también pagos del consec SIN filtrar por CO/caja (por si las llaves no casan)
    const pagosConsec = pagos.filter(p => String(p.CONSEC_DOCTO) === String(CONSEC));

    console.log('==================================================');
    console.log(`🔎 consec ${CONSEC} | CO ${CO} | Caja ${CAJA}  (READ-ONLY)`);
    console.log('==================================================');
    console.log(`Ventas (ítems) encontrados: ${itemsV.length}`);
    if (itemsV.length) {
        const neto = itemsV[0].VrNetoDocto;
        console.log(`  Cliente: ${itemsV[0].NitTercero} | Neto doc: ${neto} | CoDoc: ${itemsV[0].CoDoc} | Caja: ${itemsV[0].ID_TIPO_DOCTO}`);
    }

    console.log(`\nPagos EFE para ese consec/CO/caja: ${pagosV.length}`);
    pagosV.forEach((p, i) => {
        console.log(`  ${i + 1}. medio=${p.ID_MEDIOS_PAGO} ingreso=${p.VLR_MEDIO_PAGO_INGRESO} egreso=${p.VLR_MEDIO_PAGO_EGRESO} | CoDoc=${p.CoDoc} Caja=${p.ID_TIPO_DOCTO}`);
    });

    console.log(`\nPagos del consec (sin filtrar CO/caja): ${pagosConsec.length}`);
    pagosConsec.forEach((p, i) => {
        console.log(`  ${i + 1}. medio=${p.ID_MEDIOS_PAGO} ingreso=${p.VLR_MEDIO_PAGO_INGRESO} egreso=${p.VLR_MEDIO_PAGO_EGRESO} | CoDoc=${p.CoDoc} Caja=${p.ID_TIPO_DOCTO}`);
    });

    console.log('\n--------------------------------------------------');
    if (itemsV.length && pagosConsec.length === 0) {
        console.log('🔴 La venta existe pero NO hay NINGÚN pago en la query (filtrada a EFE).');
        console.log('   => o se pagó con un medio != EFE (el filtro lo bota), o no tiene pago registrado.');
        console.log('   => por eso Caja=0 y Siesa rechaza (recaudo 0 vs venta).');
    } else if (pagosConsec.length > 0 && pagosV.length === 0) {
        console.log('🟡 Hay pago del consec pero NO casa por CO/Caja (las llaves CoDoc/ID_TIPO_DOCTO no coinciden).');
    } else if (pagosV.length > 0) {
        console.log('🟢 Sí hay pago EFE que casa. El Caja=0 vendría de otra parte — revisar.');
    }
    console.log('\n🧪 Solo lectura, no se tocó Siesa.\n');
    process.exit(0);
})().catch(e => { console.error('❌', e.response?.data || e.message); process.exit(1); });
