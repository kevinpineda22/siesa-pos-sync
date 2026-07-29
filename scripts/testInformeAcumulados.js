/**
 * testInformeAcumulados.js — Consulta merkahorro_informe_acumulados y muestra la estructura.
 * READ-ONLY. No modifica nada.
 */
require('dotenv').config();
const axios = require('axios');

const CIA = process.env.CIA || '7375';
const URL = `https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=merkahorro_informe_acumulados`;

(async () => {
    console.log('🔍 Consultando merkahorro_informe_acumulados...');
    const r = await axios.get(URL, {
        headers: { ConniKey: process.env.CONNI_KEY, ConniToken: process.env.CONNI_TOKEN },
    });
    let d = r.data;
    if (d.detalle && d.detalle.Datos) d = d.detalle.Datos;
    else if (d.detalle && d.detalle.Table) d = d.detalle.Table;
    const arr = Array.isArray(d) ? d : [];
    console.log(`Total registros: ${arr.length}`);
    if (arr.length > 0) {
        console.log('\nPrimer registro (keys):');
        console.log(JSON.stringify(Object.keys(arr[0]), null, 2));
        console.log('\nPrimer registro (data):');
        console.log(JSON.stringify(arr[0], null, 2));
        if (arr.length > 1) {
            console.log('\nSegundo registro:');
            console.log(JSON.stringify(arr[1], null, 2));
        }
        // Check which fields have non-zero values
        const keys = Object.keys(arr[0]);
        const nonZero = keys.filter(k => {
            const v = arr[0][k];
            return v !== null && v !== '' && v !== 0 && v !== '0';
        });
        console.log('\nCampos con valores (primer registro):');
        nonZero.forEach(k => console.log(`  ${k}: ${arr[0][k]}`));
    }
})().catch(e => {
    console.error('Error:', e.response?.data || e.message);
    process.exit(1);
});
