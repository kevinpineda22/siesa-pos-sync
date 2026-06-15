/**
 * testImpuestos.js — Diagnóstico READ-ONLY de impuestos / dedup para un consec.
 *
 * Para el consec/CO/caja dado, muestra por cada línea (movimiento) los impuestos que trae
 * Connekta, marca los DUPLICADOS (mismo RowidMvto + ID_LLAVE_IMPUESTO), y calcula el IVA total
 * de dos formas:
 *   - CON dedup   (lo que ENVIAMOS hoy)         -> debería dar la CxC nuestra.
 *   - SIN dedup   (sumando los duplicados)      -> si esto da la "cartera" de Siesa, el dedup
 *                                                  estaría quitando un IVA que Siesa sí cuenta.
 * También recalcula el IVA por línea como round(base_neta × tasa) (Opción A), que es lo que
 * realmente mandamos. NO envía NADA a Siesa.
 *
 * Uso (por defecto consec 684 / CO 001 / todas las cajas):
 *   node scripts/testImpuestos.js
 *   UM_CONSEC=684 UM_CO=001 UM_CAJA=Z02 node scripts/testImpuestos.js
 */
require('dotenv').config();
const axios = require('axios');

const CIA = process.env.CIA || '7375';
const BASE = `https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=`;

async function fetchConnekta(desc) {
    const r = await axios.get(BASE + desc, {
        headers: { ConniKey: process.env.CONNI_KEY, ConniToken: process.env.CONNI_TOKEN },
    });
    let d = r.data;
    if (d.detalle && d.detalle.Datos) d = d.detalle.Datos;
    else if (d.detalle && d.detalle.Table) d = d.detalle.Table;
    return Array.isArray(d) ? d : [];
}

(async () => {
    const CONSEC = process.env.UM_CONSEC || '684';
    const CO = (process.env.UM_CO || '001').padStart(3, '0');
    const CAJA = (process.env.UM_CAJA || '').toUpperCase(); // vacío = todas

    console.log('==================================================');
    console.log(`🔎 Impuestos/dedup  consec=${CONSEC} | CO=${CO} | Caja=${CAJA || '(todas)'}  (READ-ONLY)`);
    console.log('==================================================');

    const ventas = await fetchConnekta('merkahorro_venta_pos_dev');
    const imptos = await fetchConnekta('merkahorro_imptos_pos_dev');

    const items = ventas.filter(
        (d) =>
            String(d.CONSEC_DOCTO) === String(CONSEC) &&
            String(d.CoDoc || '').trim().padStart(3, '0') === CO &&
            (!CAJA || String(d.ID_TIPO_DOCTO || '').trim().toUpperCase() === CAJA)
    );
    if (items.length === 0) {
        console.log('\n⚠️ No se encontraron ítems para ese consec/CO/caja (¿fuera de la ventana de 2 días?).\n');
        return;
    }

    // impuestos indexados por RowidMvto (todos, sin dedup)
    const impPorRowid = {};
    imptos.forEach((imp) => {
        if (imp.ID_LLAVE_IMPUESTO && imp.ID_LLAVE_IMPUESTO !== 'null' && imp.VALOR_TOTAL > 0) {
            (impPorRowid[imp.RowidMvto] = impPorRowid[imp.RowidMvto] || []).push(imp);
        }
    });

    let baseTotal = 0, dsctoTotal = 0;
    let ivaConDedup = 0, ivaSinDedup = 0, ivaRecalc = 0;
    let duplicados = 0;

    console.log(`\n📦 ${items.length} línea(s):\n`);
    items.forEach((det, i) => {
        const base = parseFloat(det.VALOR_BRUTO) || 0;
        const dscto = parseFloat(det.vlr_tot_dscto) || 0;
        baseTotal += base;
        dsctoTotal += dscto;

        const lista = impPorRowid[det.RowidMvto] || [];
        const vistos = new Set();
        const dedup = [];
        lista.forEach((imp) => {
            const k = `${imp.RowidMvto}|${String(imp.ID_LLAVE_IMPUESTO).trim()}`;
            ivaSinDedup += parseFloat(imp.VALOR_TOTAL) || 0;
            if (vistos.has(k)) { duplicados++; return; }
            vistos.add(k);
            dedup.push(imp);
            ivaConDedup += parseFloat(imp.VALOR_TOTAL) || 0;
        });

        // IVA recalculado (Opción A) por línea: round(base_neta × tasa) para TASA>0
        let ivaLinea = 0;
        dedup.forEach((imp) => {
            const tasa = parseFloat(imp.TASA) || 0;
            if (tasa > 0) ivaLinea += Math.round((base - dscto) * tasa / 100);
        });
        ivaRecalc += ivaLinea;

        const keys = lista.map((imp) => String(imp.ID_LLAVE_IMPUESTO).trim());
        const dupFlag = lista.length !== dedup.length ? `  ⚠️ ${lista.length - dedup.length} DUPLICADO(S)` : '';
        console.log(
            `  ${String(i + 1).padStart(2)}. item ${String(det.id_item).padEnd(8)} | Rowid ${String(det.RowidMvto).slice(0, 12)} | ` +
            `BRUTO=${String(base).padEnd(9)} dscto=${String(dscto).padEnd(6)} | imptos: [${keys.join(', ') || '—'}]${dupFlag}`
        );
    });

    const cxcConDedup = baseTotal - dsctoTotal + ivaRecalc;       // lo que enviamos (Opción A + dedup)
    const cxcSinDedup = baseTotal - dsctoTotal + ivaSinDedup;     // si NO dedupáramos (raw)

    console.log('\n==================================================');
    console.log('  TOTALES');
    console.log('==================================================');
    console.log(`  Base total:                 ${baseTotal}`);
    console.log(`  Descuentos:                 ${dsctoTotal}`);
    console.log(`  IVA con dedup (raw):        ${ivaConDedup}`);
    console.log(`  IVA sin dedup (raw):        ${ivaSinDedup}   (duplicados sumados: ${duplicados})`);
    console.log(`  IVA recalculado (Opción A): ${ivaRecalc}   <- lo que realmente enviamos`);
    console.log('');
    console.log(`  CxC que enviamos (base - dscto + IVA recalc): ${cxcConDedup}`);
    console.log(`  Neto SIN dedup (base - dscto + IVA sin dedup): ${cxcSinDedup}`);
    console.log('');
    console.log('  Siesa reportó:  cartera = 110068  |  CxC = 107560  (gap 2508)');
    console.log('');
    if (Math.abs(cxcSinDedup - 110068) <= 5) {
        console.log('  🔴 El neto SIN dedup ≈ la CARTERA de Siesa (110068).');
        console.log('     => Siesa SÍ cuenta el impuesto duplicado en la cartera. El dedup lo está quitando.');
        console.log('        El problema NO es el dedup en sí, sino que esas filas NO eran un duplicado real.');
    } else if (Math.abs(cxcConDedup - 107560) <= 5) {
        console.log('  🟢 Nuestra CxC (con dedup) ≈ la CxC de Siesa (107560). El dedup está bien.');
        console.log('     El gap de 2508 viene por OTRO lado (revisar descuento/UM/línea sin impuesto).');
    } else {
        console.log('  🟡 Ninguno calza exacto: el gap viene de otra parte. Revisar línea por línea arriba.');
    }
    console.log('\n🧪 NO se envió nada a Siesa.\n');
})().catch((e) => {
    console.error('❌ Error:', e.response?.data || e.message);
    process.exit(1);
});
