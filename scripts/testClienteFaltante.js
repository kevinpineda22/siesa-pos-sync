/**
 * testClienteFaltante.js — READ-ONLY. Busca un NIT en la maestra de clientes del POS
 * (merkahorro_Cliente_pos_dev) y en la venta, para entender por qué el auto-alta no lo
 * encuentra ("Cliente o sucursal no existe en Siesa"). Solo GET a Connekta. NO toca Siesa.
 *
 *   node scripts/testClienteFaltante.js
 *   CL_NIT=900421601 CL_CONSEC=669 CL_CAJA=Z01 node scripts/testClienteFaltante.js
 */
require('dotenv').config();
const axios = require('axios');

const CIA = process.env.CIA || '7375';
const BASE = (q, pag) =>
    `https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=${q}` +
    (pag ? `&paginacion=numPag=${pag}|tamPag=1000` : '');

async function fetchAll(q, paginar) {
    const todos = [];
    for (let p = 1; p <= (paginar ? 50 : 1); p++) {
        const r = await axios.get(BASE(q, paginar ? p : null), {
            headers: { ConniKey: process.env.CONNI_KEY, ConniToken: process.env.CONNI_TOKEN },
            timeout: 60000,
        });
        let d = r.data;
        if (d.detalle && d.detalle.Datos) d = d.detalle.Datos;
        else if (d.detalle && d.detalle.Table) d = d.detalle.Table;
        const reg = Array.isArray(d) ? d : [];
        if (!reg.length) break;
        todos.push(...reg);
        if (!paginar || reg.length < 1000) break;
    }
    return todos;
}

(async () => {
    const NIT = String(process.env.CL_NIT || '900421601').trim();
    const CONSEC = process.env.CL_CONSEC || '669';
    const CAJA = (process.env.CL_CAJA || 'Z01').toUpperCase();

    console.log('==================================================');
    console.log(`🔎 Cliente faltante NIT ${NIT} (consec ${CONSEC}, Caja ${CAJA})  (READ-ONLY)`);
    console.log('==================================================');

    // 1) Venta: ¿qué NIT exacto trae la factura?
    const ventas = await fetchAll('merkahorro_venta_pos_dev', false);
    const itemsV = ventas.filter(d => String(d.CONSEC_DOCTO) === String(CONSEC) &&
        String(d.ID_TIPO_DOCTO || '').toUpperCase() === CAJA);
    if (itemsV.length) {
        console.log(`\n🧾 Venta consec ${CONSEC}: NitTercero = "${itemsV[0].NitTercero}" | Neto ${itemsV[0].VrNetoDocto}`);
    } else {
        console.log(`\n🧾 No se encontró la venta consec ${CONSEC} en Caja ${CAJA} (puede ser de otra fecha).`);
    }

    // 2) Maestra de clientes: ¿está el NIT? (exacto y parcial)
    const clientes = await fetchAll('merkahorro_Cliente_pos_dev', true);
    console.log(`\n👥 Clientes en maestra POS: ${clientes.length}`);

    const exacto = clientes.filter(c => String(c.NIT).trim() === NIT);
    const parcial = clientes.filter(c => String(c.NIT).trim().includes(NIT) && String(c.NIT).trim() !== NIT);

    console.log(`\n¿Coincidencia EXACTA con "${NIT}"? → ${exacto.length}`);
    exacto.forEach(c => console.log(`   ✔ NIT=${c.NIT} | ${c.RAZON_SOCIAL || c.NOMBRES || ''} | tipoIdent=${c.ID_TIPO_IDENT}`));

    console.log(`\n¿Coincidencia PARCIAL (contiene "${NIT}", p.ej. con DV)? → ${parcial.length}`);
    parcial.forEach(c => console.log(`   ≈ NIT=${c.NIT} | ${c.RAZON_SOCIAL || c.NOMBRES || ''} | tipoIdent=${c.ID_TIPO_IDENT}`));

    console.log('\n--------------------------------------------------');
    if (exacto.length) {
        console.log('🟢 El NIT SÍ está en la maestra. El auto-alta debería haberlo creado — revisar.');
    } else if (parcial.length) {
        console.log('🟡 El NIT está pero con OTRO formato (DV/guion). Es un descuadre de formato:');
        console.log('   la venta trae uno y la maestra otro → por eso el filtro no casa.');
    } else {
        console.log('🔴 El NIT NO está en la maestra de clientes del POS.');
        console.log('   => Esa consulta filtra/no incluye a este cliente, o nunca se registró como cliente.');
        console.log('   => No hay registro origen para crearlo en Siesa → la factura no puede sincronizar.');
    }
    console.log('\n🧪 Solo lectura, no se tocó Siesa.\n');
    process.exit(0);
})().catch(e => { console.error('❌', e.response?.data || e.message); process.exit(1); });
