/**
 * testResumenImpuestos.js — Test del endpoint /api/logs/resumen-impuestos con el nuevo query.
 * Levanta un servidor Express mínimo, llama al endpoint, y muestra los resultados.
 * READ-ONLY. No modifica nada.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const axios = require('axios');

// ── Copiar el endpoint tal cual de server.js ──
const CIA = process.env.CIA || '7375';
const CONNEKTA_DOMAIN = process.env.CONNEKTA_DOMAIN || 'servicios.siesacloud.com';
const queryName = process.env.QUERY_ACUMULADOS || 'merkahorro_informe_acumulados';
const URL_ACUMULADOS = `https://${CONNEKTA_DOMAIN}/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=${queryName}`;

const DESCRIPCIONES = {
    'IV02': 'IVA 5% BIENES',
    'IV03': 'IVA 19% BIENES',
    'IV07': 'IVA 19% CERVEZA',
    'IV08': 'IVA DEL 19% EN GASEOSAS',
    'ICO': 'IMPUESTO AL CONSUMO',
    'OTROS': 'OTROS IMPUESTOS'
};

const TAX_COLUMNS = [
    { llave: 'IV03', base: 'IV03_Porcentaje_Base', tasa: 'IV03_Tasa', valorTot: 'IV03_Vlr_Tot' },
    { llave: 'IV02', base: 'IV02_Porcentaje_Base', tasa: 'IV02_Tasa', valorTot: 'IV02_Vlr_Tot' },
    { llave: 'ICO',  base: 'ICO_Porcentaje_Base',  tasa: 'ICO_Tasa',  valorTot: 'ICO_Vlr_Tot' },
    { llave: 'IV08', base: 'IV08_Porcentaje_Base', tasa: 'IV08_Tasa', valorTot: 'IV08_Vlr_Tot' },
    { llave: 'IV07', base: 'IV07_Porcentaje_Base', tasa: 'IV07_Tasa', valorTot: 'IV07_Vlr_Tot' },
    { llave: 'IV01', base: 'IV01_Porcentaje_Base', tasa: 'IV01_Tasa', valorTot: 'IV01_Vlr_Tot' },
];

function aggregateTaxes(lines) {
    const porLlave = {};
    const docsPorLlave = {};
    let totalBase = 0;
    let totalLineas = 0;
    const docsUnicos = new Set();

    lines.forEach(d => {
        const bruto = parseFloat(d.VALOR_BRUTO) || 0;
        const dscto = parseFloat(d.vlr_tot_dscto) || 0;
        const baseNeta = bruto - dscto;
        totalBase += bruto;
        totalLineas++;

        const docKey = `${d.CoDoc}|${d.ID_TIPO_DOCTO}|${d.CONSEC_DOCTO}`;
        docsUnicos.add(docKey);

        TAX_COLUMNS.forEach(col => {
            const valorTot = parseFloat(d[col.valorTot]) || 0;
            if (Math.abs(valorTot) < 0.01) return;
            const porcentajeBase = parseFloat(d[col.base]) || 100;
            const baseGravableLinea = baseNeta * (porcentajeBase / 100);
            if (!porLlave[col.llave]) {
                porLlave[col.llave] = { llave: col.llave, descripcion: DESCRIPCIONES[col.llave] || col.llave, valorTotal: 0, baseGravable: 0, count: 0 };
                docsPorLlave[col.llave] = new Set();
            }
            porLlave[col.llave].valorTotal += valorTot;
            porLlave[col.llave].baseGravable += baseGravableLinea;
            porLlave[col.llave].count++;
            docsPorLlave[col.llave].add(docKey);
        });

        const otrosTot = parseFloat(d.Otros_Impuestos_Vlr_Tot) || 0;
        if (Math.abs(otrosTot) >= 0.01) {
            if (!porLlave['OTROS']) {
                porLlave['OTROS'] = { llave: 'OTROS', descripcion: 'OTROS IMPUESTOS', valorTotal: 0, baseGravable: 0, count: 0 };
                docsPorLlave['OTROS'] = new Set();
            }
            porLlave['OTROS'].valorTotal += otrosTot;
            porLlave['OTROS'].baseGravable += baseNeta;
            porLlave['OTROS'].count++;
            docsPorLlave['OTROS'].add(docKey);
        }
    });

    const arr = Object.values(porLlave)
        .map(item => ({ ...item, count: docsPorLlave[item.llave] ? docsPorLlave[item.llave].size : item.count }))
        .sort((a, b) => b.valorTotal - a.valorTotal);

    return {
        porLlave: arr,
        totalImpuestos: Math.round(arr.reduce((s, v) => s + v.valorTotal, 0)),
        totalBaseGravable: Math.round(arr.reduce((s, v) => s + v.baseGravable, 0)),
        totalLineas,
        totalDocumentos: docsUnicos.size
    };
}

function fmt(n) { return '$' + Math.round(n).toLocaleString('es-CO'); }

(async () => {
    console.log('🔍 Fetching merkahorro_informe_acumulados...\n');
    // Fetch paginado
    const TAM_PAGINA = 1000;
    const urlPag1 = `${URL_ACUMULADOS}&paginacion=numPag=1|tamPag=${TAM_PAGINA}`;
    const r1 = await axios.get(urlPag1, {
        headers: { ConniKey: process.env.CONNI_KEY, ConniToken: process.env.CONNI_TOKEN },
        timeout: 120000
    });
    let data1 = r1.data;
    let arr = [];
    if (data1.detalle && data1.detalle.Datos) arr = data1.detalle.Datos;
    else if (data1.detalle && data1.detalle.Table) arr = data1.detalle.Table;
    arr = Array.isArray(arr) ? arr : [];
    let totalPaginas = 1;
    if (data1.detalle) {
        const keys = Object.keys(data1.detalle);
        const keyTotal = keys.find(k => k.toLowerCase().includes('total_p') || k.toLowerCase().includes('pagina'));
        if (keyTotal && data1.detalle[keyTotal]) totalPaginas = parseInt(data1.detalle[keyTotal]);
    }
    totalPaginas = Math.min(totalPaginas, 200);
    console.log(`Página 1: ${arr.length} registros, ${totalPaginas} páginas totales`);
    // Páginas 2..N en lotes concurrentes
    const CONC = 4;
    let cursor = 2;
    while (cursor <= totalPaginas) {
        const lote = [];
        for (let k = 0; k < CONC && cursor <= totalPaginas; k++, cursor++) lote.push(cursor);
        const resultados = await Promise.all(lote.map(async (p) => {
            const url = `${URL_ACUMULADOS}&paginacion=numPag=${p}|tamPag=${TAM_PAGINA}`;
            try {
                const r = await axios.get(url, {
                    headers: { ConniKey: process.env.CONNI_KEY, ConniToken: process.env.CONNI_TOKEN },
                    timeout: 120000
                });
                let d = r.data;
                if (d.detalle && d.detalle.Datos) return d.detalle.Datos;
                if (d.detalle && d.detalle.Table) return d.detalle.Table;
                if (d.Table) return d.Table;
                return [];
            } catch (e) { return []; }
        }));
        for (const reg of resultados) {
            if (Array.isArray(reg) && reg.length > 0) arr.push(...reg);
        }
        if (cursor % 20 === 0 || cursor > totalPaginas) console.log(`  pág ${cursor - 1}/${totalPaginas} (${arr.length} reg)`);
    }
    console.log(`Total registros: ${arr.length}\n`);

    // Filtrar todo el rango (desde junio 10 hasta hoy)
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    const desde = '2026-06-10';
    const filtrados = arr.filter(d => {
        const f = (d.FECHA_DOCTO || '').split('T')[0];
        return f >= desde && f <= hoy;
    });
    console.log(`Registros filtrados (${desde} ~ ${hoy}): ${filtrados.length}\n`);

    // 1) TOTAL
    const total = aggregateTaxes(filtrados);
    console.log('═══════════════════════════════════════');
    console.log('  TOTAL (todos los impuestos)');
    console.log('═══════════════════════════════════════');
    console.log(`  Líneas: ${total.totalLineas} | Docs: ${total.totalDocumentos} | Impuestos: ${fmt(total.totalImpuestos)}`);
    total.porLlave.forEach(t => {
        console.log(`  ${t.llave.padEnd(6)} ${t.descripcion.padEnd(30)} Valor: ${fmt(t.valorTotal).padStart(14)}  Base: ${fmt(t.baseGravable).padStart(14)}  (${t.count} reg)`);
    });

    // 2) REALES vs GENÉRICOS
    const GENERIC_NIT = '222222222222';
    const reales = filtrados.filter(d => (d.NitTercero || '').trim() !== GENERIC_NIT);
    const genericos = filtrados.filter(d => (d.NitTercero || '').trim() === GENERIC_NIT);
    const impReales = aggregateTaxes(reales);
    const impGen = aggregateTaxes(genericos);

    console.log('\n═══════════════════════════════════════');
    console.log('  REALES');
    console.log('═══════════════════════════════════════');
    console.log(`  Líneas: ${impReales.totalLineas} | Docs: ${impReales.totalDocumentos} | Impuestos: ${fmt(impReales.totalImpuestos)}`);
    impReales.porLlave.forEach(t => {
        console.log(`  ${t.llave.padEnd(6)} ${t.descripcion.padEnd(30)} Valor: ${fmt(t.valorTotal).padStart(14)}  Base: ${fmt(t.baseGravable).padStart(14)}  (${t.count} reg)`);
    });

    console.log('\n═══════════════════════════════════════');
    console.log('  GENÉRICOS (222222222222)');
    console.log('═══════════════════════════════════════');
    console.log(`  Líneas: ${impGen.totalLineas} | Docs: ${impGen.totalDocumentos} | Impuestos: ${fmt(impGen.totalImpuestos)}`);
    impGen.porLlave.forEach(t => {
        console.log(`  ${t.llave.padEnd(6)} ${t.descripcion.padEnd(30)} Valor: ${fmt(t.valorTotal).padStart(14)}  Base: ${fmt(t.baseGravable).padStart(14)}  (${t.count} reg)`);
    });

    // 3) POR CAJA (solo Z01, Z02)
    const cajaFilterEnv = (process.env.CAJA_FILTER || '').trim();
    const cajasPermitidas = cajaFilterEnv ? cajaFilterEnv.split(',').map(c => c.trim().toUpperCase()) : null;
    console.log('\n═══════════════════════════════════════');
    console.log(`  POR CAJA (${cajasPermitidas ? cajasPermitidas.join(', ') : 'todas'})`);
    console.log('═══════════════════════════════════════');
    const cajaGroups = {};
    filtrados.forEach(d => {
        const caja = (d.ID_TIPO_DOCTO || '').trim().toUpperCase() || 'SIN_CAJA';
        if (cajasPermitidas && !cajasPermitidas.includes(caja)) return;
        if (!cajaGroups[caja]) cajaGroups[caja] = [];
        cajaGroups[caja].push(d);
    });
    for (const [caja, lines] of Object.entries(cajaGroups).sort((a, b) => b[1].length - a[1].length)) {
        const imp = aggregateTaxes(lines);
        console.log(`\n  📦 ${caja} — Líneas: ${imp.totalLineas} | Docs: ${imp.totalDocumentos} | Impuestos: ${fmt(imp.totalImpuestos)}`);
        imp.porLlave.forEach(t => {
            console.log(`     ${t.llave.padEnd(6)} Valor: ${fmt(t.valorTotal).padStart(14)}  Base: ${fmt(t.baseGravable).padStart(14)}  (${t.count} reg)`);
        });
    }

    console.log('\n✅ Test completo.');
})().catch(e => {
    console.error('❌ Error:', e.response?.data || e.message);
    process.exit(1);
});
