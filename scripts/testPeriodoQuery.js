/**
 * testPeriodoQuery.js — Muestra el rango de fechas que cubre el query.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');

const CIA = process.env.CIA || '7375';
const BASE_URL = `https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=merkahorro_informe_acumulados`;
const TAM_PAGINA = parseInt(process.env.INVENTARIO_TAM_PAGINA || '1000');
const MAX_PAGINAS = parseInt(process.env.INVENTARIO_MAX_PAGINAS || '200');

async function fetchPagina(pag) {
    const url = `${BASE_URL}&paginacion=numPag=${pag}|tamPag=${TAM_PAGINA}`;
    const r = await axios.get(url, {
        headers: { ConniKey: process.env.CONNI_KEY, ConniToken: process.env.CONNI_TOKEN },
        timeout: 120000
    });
    let data = r.data;
    let registros = [];
    let totalPaginas = null;
    if (data.detalle && data.detalle.Datos) {
        registros = data.detalle.Datos;
        const keys = Object.keys(data.detalle);
        const keyTotal = keys.find(k => k.toLowerCase().includes('total_p') || k.toLowerCase().includes('pagina'));
        if (keyTotal && data.detalle[keyTotal]) totalPaginas = parseInt(data.detalle[keyTotal]);
    } else if (data.detalle && data.detalle.Table) registros = data.detalle.Table;
    else if (data.Table) registros = data.Table;
    return { registros: Array.isArray(registros) ? registros : [], totalPaginas };
}

(async () => {
    console.log('🔍 Fetching (paginado)...\n');
    
    // Página 1
    const p1 = await fetchPagina(1);
    let all = [...p1.registros];
    let totalPaginas = p1.totalPaginas && p1.totalPaginas > 0 ? p1.totalPaginas : 1;
    totalPaginas = Math.min(totalPaginas, MAX_PAGINAS);
    console.log(`Página 1: ${p1.registros.length} registros, total páginas: ${totalPaginas}`);

    // Resto de páginas
    for (let p = 2; p <= totalPaginas; p++) {
        const result = await fetchPagina(p);
        all.push(...result.registros);
        if (p % 10 === 0 || p === totalPaginas) console.log(`Hasta pág ${p}: ${all.length} registros`);
        if (result.registros.length === 0) break;
    }

    console.log(`\nTotal registros: ${all.length}\n`);

    // Fechas
    const fechas = {};
    all.forEach(d => {
        const f = (d.FECHA_DOCTO || '').split('T')[0];
        if (!fechas[f]) fechas[f] = { lineas: 0, docs: new Set() };
        fechas[f].lineas++;
        fechas[f].docs.add(`${d.CoDoc}|${d.CONSEC_DOCTO}`);
    });
    const fechasOrdenadas = Object.keys(fechas).sort();
    console.log('📅 Periodo del query:');
    console.log(`  Desde: ${fechasOrdenadas[0]}`);
    console.log(`  Hasta: ${fechasOrdenadas[fechasOrdenadas.length - 1]}`);
    console.log(`  Total días: ${fechasOrdenadas.length}\n`);

    // Cajas
    const cajas = {};
    all.forEach(d => {
        const caja = (d.ID_TIPO_DOCTO || '').trim().toUpperCase();
        if (!cajas[caja]) cajas[caja] = { lineas: 0, docs: new Set() };
        cajas[caja].lineas++;
        cajas[caja].docs.add(`${d.CoDoc}|${d.CONSEC_DOCTO}`);
    });
    console.log('📦 Cajas:');
    Object.entries(cajas).sort((a, b) => b[1].lineas - a[1].lineas).forEach(([caja, info]) => {
        console.log(`  ${caja}: ${info.lineas} líneas, ${info.docs.size} docs`);
    });

    console.log('\n✅ OK');
})().catch(e => {
    console.error('❌ Error:', e.response?.data || e.message);
    process.exit(1);
});
