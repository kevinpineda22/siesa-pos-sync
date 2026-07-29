/**
 * testAcumuladosBreakdown.js — Analiza la estructura de merkahorro_informe_acumulados
 * para ver cajas, NITs, y cómo se distribuyen los impuestos. READ-ONLY.
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
    console.log(`Total registros: ${arr.length}\n`);

    // 1) Cajas únicas
    const cajas = {};
    arr.forEach(d => {
        const caja = (d.ID_TIPO_DOCTO || '').trim();
        if (!cajas[caja]) cajas[caja] = { lineas: 0, docs: new Set() };
        cajas[caja].lineas++;
        cajas[caja].docs.add(`${d.CoDoc}|${d.CONSEC_DOCTO}`);
    });
    console.log('📦 Cajas (ID_TIPO_DOCTO):');
    Object.entries(cajas).sort((a, b) => b[1].lineas - a[1].lineas).forEach(([caja, info]) => {
        console.log(`  ${caja}: ${info.lineas} líneas, ${info.docs.size} docs únicos`);
    });

    // 2) NITs únicos
    const nits = {};
    arr.forEach(d => {
        const nit = (d.NitTercero || '').trim();
        if (!nits[nit]) nits[nit] = { lineas: 0, docs: new Set(), razon: '' };
        nits[nit].lineas++;
        nits[nit].docs.add(`${d.CoDoc}|${d.CONSEC_DOCTO}`);
        if (!nits[nit].razon) nits[nit].razon = (d.RazonSocial || '').trim();
    });
    console.log('\n👤 NITs:');
    Object.entries(nits).sort((a, b) => b[1].lineas - a[1].lineas).slice(0, 15).forEach(([nit, info]) => {
        console.log(`  ${nit}: ${info.lineas} líneas, ${info.docs.size} docs — ${info.razon}`);
    });

    // 3) COs
    const cos = {};
    arr.forEach(d => {
        const co = (d.CoDoc || '').trim();
        if (!cos[co]) cos[co] = { lineas: 0, docs: new Set() };
        cos[co].lineas++;
        cos[co].docs.add(`${d.CoDoc}|${d.CONSEC_DOCTO}`);
    });
    console.log('\n🏢 COs (CoDoc):');
    Object.entries(cos).sort((a, b) => b[1].lineas - a[1].lineas).forEach(([co, info]) => {
        console.log(`  ${co}: ${info.lineas} líneas, ${info.docs.size} docs únicos`);
    });

    // 4) Impuestos por caja (top 3 cajas)
    const topCajas = Object.entries(cajas).sort((a, b) => b[1].lineas - a[1].lineas).slice(0, 3);
    console.log('\n💰 Impuestos por caja (top 3):');
    topCajas.forEach(([caja]) => {
        const lines = arr.filter(d => (d.ID_TIPO_DOCTO || '').trim() === caja);
        const imp03 = lines.reduce((s, d) => s + (parseFloat(d.IV03_Vlr_Tot) || 0), 0);
        const imp02 = lines.reduce((s, d) => s + (parseFloat(d.IV02_Vlr_Tot) || 0), 0);
        const impICO = lines.reduce((s, d) => s + (parseFloat(d.ICO_Vlr_Tot) || 0), 0);
        const imp08 = lines.reduce((s, d) => s + (parseFloat(d.IV08_Vlr_Tot) || 0), 0);
        const imp07 = lines.reduce((s, d) => s + (parseFloat(d.IV07_Vlr_Tot) || 0), 0);
        const imp01 = lines.reduce((s, d) => s + (parseFloat(d.IV01_Vlr_Tot) || 0), 0);
        const otros = lines.reduce((s, d) => s + (parseFloat(d.Otros_Impuestos_Vlr_Tot) || 0), 0);
        console.log(`  ${caja}: IV03=${imp03} IV02=${imp02} ICO=${impICO} IV08=${imp08} IV07=${imp07} IV01=${imp01} Otros=${otros}`);
    });

    // 5) Impuestos reales vs genéricos
    const reales = arr.filter(d => (d.NitTercero || '').trim() !== '222222222222');
    const genericos = arr.filter(d => (d.NitTercero || '').trim() === '222222222222');
    const calcImp = (data) => ({
        IV03: data.reduce((s, d) => s + (parseFloat(d.IV03_Vlr_Tot) || 0), 0),
        IV02: data.reduce((s, d) => s + (parseFloat(d.IV02_Vlr_Tot) || 0), 0),
        ICO: data.reduce((s, d) => s + (parseFloat(d.ICO_Vlr_Tot) || 0), 0),
        IV08: data.reduce((s, d) => s + (parseFloat(d.IV08_Vlr_Tot) || 0), 0),
        IV07: data.reduce((s, d) => s + (parseFloat(d.IV07_Vlr_Tot) || 0), 0),
        IV01: data.reduce((s, d) => s + (parseFloat(d.IV01_Vlr_Tot) || 0), 0),
        Otros: data.reduce((s, d) => s + (parseFloat(d.Otros_Impuestos_Vlr_Tot) || 0), 0),
    });
    const impReales = calcImp(reales);
    const impGen = calcImp(genericos);
    console.log('\n🔴 Impuestos REALES:');
    console.log(`  Líneas: ${reales.length} | IV03=${impReales.IV03} IV02=${impReales.IV02} ICO=${impReales.ICO} IV08=${impReales.IV08} IV07=${impReales.IV07} IV01=${impReales.IV01} Otros=${impReales.Otros}`);
    console.log('\n🟡 Impuestos GENÉRICOS (222222222222):');
    console.log(`  Líneas: ${genericos.length} | IV03=${impGen.IV03} IV02=${impGen.IV02} ICO=${impGen.ICO} IV08=${impGen.IV08} IV07=${impGen.IV07} IV01=${impGen.IV01} Otros=${impGen.Otros}`);

    console.log('\n✅ Análisis completo.');
})().catch(e => {
    console.error('Error:', e.response?.data || e.message);
    process.exit(1);
});
