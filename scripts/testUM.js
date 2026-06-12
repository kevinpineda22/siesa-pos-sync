/**
 * testUM.js — Diagnóstico READ-ONLY de unidades de medida.
 *
 * Trae de Connekta los ítems de un consec/CO/caja y muestra, por ítem, la UM original del
 * POS y la que enviaríamos a Siesa tras normalizarUM (P6/P12/... -> UND). NO envía NADA a
 * Siesa: solo hace un GET de consulta. Sirve para verificar el fix de UM sin reprocesar
 * (reprocesar duplicaría el documento por F_CONSEC_AUTO_REG).
 *
 * Uso (por defecto consec 136 / CO 001 / caja Z02):
 *   node scripts/testUM.js
 * O con overrides:
 *   UM_CONSEC=140 UM_CO=001 UM_CAJA=Z01 node scripts/testUM.js
 */
require('dotenv').config();
const axios = require('axios');

const CIA = process.env.CIA || '7375';
const URL = `https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=merkahorro_venta_pos_dev`;

// MISMO helper que syncVentas.js (mantener en sync si cambia allá).
function normalizarUM(um) {
    const u = (um ?? '').toString().trim();
    if (!u) return 'UND';
    if (/^P\d/i.test(u)) return 'UND'; // P6, P12, P24... -> UND
    return u;
}

(async () => {
    const CONSEC = process.env.UM_CONSEC || '136';
    const CO = (process.env.UM_CO || '001').padStart(3, '0');
    const CAJA = (process.env.UM_CAJA || 'Z02').toUpperCase();

    console.log('==================================================');
    console.log(`🔎 UM check  consec=${CONSEC} | CO=${CO} | Caja=${CAJA}  (READ-ONLY)`);
    console.log('==================================================');

    const r = await axios.get(URL, {
        headers: { ConniKey: process.env.CONNI_KEY, ConniToken: process.env.CONNI_TOKEN },
    });
    let data = r.data;
    if (data.detalle && data.detalle.Datos) data = data.detalle.Datos;
    else if (data.detalle && data.detalle.Table) data = data.detalle.Table;
    const arr = Array.isArray(data) ? data : [];

    const items = arr.filter(
        (d) =>
            String(d.CONSEC_DOCTO) === String(CONSEC) &&
            String(d.CoDoc || '').trim().padStart(3, '0') === CO &&
            String(d.ID_TIPO_DOCTO || '').trim().toUpperCase() === CAJA
    );

    if (items.length === 0) {
        console.log('\n⚠️ No se encontraron ítems para ese consec/CO/caja en la ventana de Connekta.');
        console.log('   (La query trae solo los últimos ~2 días; si el 136 es más viejo, no aparecerá.)\n');
        return;
    }

    console.log(`\n📦 ${items.length} ítem(s):\n`);
    let cambios = 0;
    items.forEach((d, i) => {
        const orig = (d.UNIDAD_MEDIDA ?? '').toString().trim() || '(vacío)';
        const nueva = normalizarUM(d.UNIDAD_MEDIDA);
        const convertida = String(orig) !== String(nueva);
        if (convertida) cambios++;
        const flag = convertida ? '  ⟵ CONVERTIDA' : '';
        console.log(
            `  ${String(i + 1).padStart(2)}. item ${String(d.id_item).padEnd(8)} | ` +
            `CANT=${String(d.CANTIDAD).padEnd(10)} | BRUTO=${String(d.VALOR_BRUTO).padEnd(10)} | ` +
            `UM POS: ${orig.padEnd(6)} -> Siesa: ${nueva}${flag}`
        );
    });

    console.log(`\n${cambios} ítem(s) con UM convertida (P# -> UND).`);
    console.log('🧪 NO se envió nada a Siesa.\n');
})().catch((e) => {
    console.error('❌ Error:', e.response?.data || e.message);
    process.exit(1);
});
