/**
 * testItemMapping.js — READ-ONLY. Verifica cómo se mapea el ítem del error de inventario.
 * Responde: ¿el id_item en Connekta es "2979" (numérico) o "2979A" (alfanumérico)?
 * y ¿el código actual (regex nueva + substring) lo mapea bien?
 * Solo consulta Connekta (GET). NO toca Siesa.
 *
 *   node scripts/testItemMapping.js
 *   FVALOR="Item:0002979A-0002979Bodega:PV001" node scripts/testItemMapping.js
 */
require('dotenv').config();
const axios = require('axios');

const CIA = process.env.CIA || '7375';
const URL = `https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=merkahorro_venta_pos_dev`;

(async () => {
    const fValor = process.env.FVALOR || 'Item:0002979A-0002979Bodega:PV001';

    const r = await axios.get(URL, { headers: { ConniKey: process.env.CONNI_KEY, ConniToken: process.env.CONNI_TOKEN } });
    let d = r.data;
    if (d.detalle && d.detalle.Datos) d = d.detalle.Datos;
    else if (d.detalle && d.detalle.Table) d = d.detalle.Table;
    const arr = Array.isArray(d) ? d : [];

    // Set de id_item de Connekta (como string)
    const ids = new Set();
    arr.forEach(x => { if (x.id_item != null && x.id_item !== '') ids.add(String(x.id_item).trim()); });

    console.log('==================================================');
    console.log('🔎 Mapeo del ítem del error de inventario  (READ-ONLY)');
    console.log('==================================================');
    console.log(`f_valor de prueba: ${fValor}\n`);

    // 1) Regex NUEVA (la que dejamos)
    const m = fValor.match(/Item:(.+?)Bodega:(\w+)/);
    if (!m) { console.log('❌ La regex NO casó (raro).'); process.exit(0); }
    const captura = m[1];
    const bodega = m[2];
    console.log(`Regex captura ítem: "${captura}"   | bodega: "${bodega}"`);

    // 2) Extracción ACTUAL del código (substring(0,7) + strip ceros)
    const errorIdStr = captura.substring(0, 7).replace(/^0+/, '');
    // 3) Extracción ALTERNA consciente del guión (conserva alfa)
    const altIdStr = (captura.includes('-') ? captura.split('-')[0] : captura.substring(0, 7)).replace(/^0+/, '');

    console.log(`\nExtracción ACTUAL  (substring 0-7 + strip): "${errorIdStr}"`);
    console.log(`Extracción ALTERNA (split '-' + strip):     "${altIdStr}"`);

    console.log(`\n¿Connekta tiene id_item = "${errorIdStr}"?  -> ${ids.has(errorIdStr) ? '✅ SÍ' : '❌ NO'}`);
    console.log(`¿Connekta tiene id_item = "${altIdStr}"?     -> ${ids.has(altIdStr) ? '✅ SÍ' : '❌ NO'}`);

    // 4) ¿Qué id_item de Connekta se parecen a "2979"?
    const base = errorIdStr.replace(/[^0-9]/g, '') || '2979';
    const parecidos = [...ids].filter(id => id.includes(base));
    console.log(`\nid_item de Connekta que contienen "${base}": ${parecidos.length ? parecidos.join(', ') : '(ninguno)'}`);

    // 5) ¿Hay items ALFANUMÉRICOS en general? (decide si el refactor a claves string importa)
    const alfanum = [...ids].filter(id => /[a-zA-Z]/.test(id));
    console.log(`\nÍtems alfanuméricos en Connekta (total ${alfanum.length}): ${alfanum.slice(0, 30).join(', ')}${alfanum.length > 30 ? ' …' : ''}`);

    console.log('\n--------------------------------------------------');
    console.log('VEREDICTO:');
    if (ids.has(errorIdStr)) {
        console.log(`  ✅ El ítem es NUMÉRICO ("${errorIdStr}"). El fix de la regex YA BASTA — no se necesita el refactor a claves string.`);
    } else if (ids.has(altIdStr)) {
        console.log(`  ⚠️ El ítem es ALFANUMÉRICO ("${altIdStr}"). HAY que hacer el refactor (extracción consciente del guión + claves string + validar padding del ITEM).`);
    } else {
        console.log(`  🟡 Ninguna extracción mapea directo. Revisar la lista de "parecidos" arriba para ver el id_item real y ajustar.`);
    }
    console.log('\n🧪 Solo lectura, no se tocó Siesa.\n');
    process.exit(0);
})().catch(e => { console.error('❌', e.response?.data || e.message); process.exit(1); });
