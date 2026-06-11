const axios = require('axios');
require('dotenv').config();

const CIA = process.env.CIA || '7375';
const CONNI_KEY = process.env.CONNI_KEY;
const CONNI_TOKEN = process.env.CONNI_TOKEN;

const URL_VENTAS = `https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=merkahorro_venta_pos_dev`;
const URL_PAGOS = `https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=merkahorro_pagos_pos_dev`;
const URL_IMPTOS = `https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=merkahorro_imptos_pos_dev`;

async function consultar(url, nombre) {
    console.log(`🔍 Consultando ${nombre}...`);
    const res = await axios.get(url, {
        headers: { 'ConniKey': CONNI_KEY, 'ConniToken': CONNI_TOKEN }
    });
    let data = res.data;
    if (data.detalle && data.detalle.Datos) data = data.detalle.Datos;
    else if (data.detalle && data.detalle.Table) data = data.detalle.Table;
    else if (data.Table) data = data.Table;
    return Array.isArray(data) ? data : [];
}

async function test() {
    console.log('==============================================');
    console.log('🧪 TEST: Validar fix VLR_UNITARIO (v2)');
    console.log('   Verifica si hay riesgo de doble descuento');
    console.log('   NO envía nada a Siesa — solo lectura');
    console.log('==============================================\n');

    const items = await consultar(URL_VENTAS, 'merkahorro_venta_pos_dev');
    const pagos = await consultar(URL_PAGOS, 'merkahorro_pagos_pos_dev');

    if (!items.length) {
        console.log('\n❌ No se encontraron items en Connekta.');
        return;
    }

    const muestra = items.slice(0, 80);
    let discrepanciasGrandes = 0;
    let discrepanciasChicas = 0;
    let enRiesgoDobleDscto = 0;
    let seguras = 0;

    console.log('=== Items con PrecioUnitDet × CANT != VALOR_BRUTO ===\n');

    muestra.forEach((det, i) => {
        const cant = parseFloat(det.CANTIDAD || det.cant_1 || 1);
        const vrBruto = parseFloat(det.VALOR_BRUTO || 0);
        const precioOrig = parseFloat(det.PrecioUnitDet || 0);
        const multiOrig = cant * precioOrig;
        const diff = Math.abs(multiOrig - vrBruto);
        const vlrDscto = parseFloat(det.vlr_tot_dscto || 0);
        const rowid = (det.RowidMvto || '').toString().slice(0, 12);

        if (diff <= 0.01) return;
        seguras++;

        // Clasificar
        const esChica = diff <= 2;
        const diffPrecioVsBruto = Math.abs(precioOrig - (vrBruto / cant));

        let tieneDscto = '';
        let riesgo = '';

        if (vlrDscto > 0) {
            // Hay descuento en este item
            tieneDscto = `SI (vlr_tot_dscto=${vlrDscto})`;
            // PrecioUnitDet - vrBruto debería ser ≈ vlr_tot_dscto si el descuento ya está en BRUTO
            const diffEsperada = Math.abs((precioOrig * cant - vrBruto) - vlrDscto);
            if (diffEsperada < 1 && !esChica) {
                // ⚠️ PrecioUnitDet tiene el precio pre-descuento, y ademas hay línea de descuento
                // Con el fix, VLR_UNITARIO = vrBruto/cant = post-descuento + línea descuento = DOBLE
                riesgo = '⚠️ POSIBLE DOBLE DESCUENTO';
                enRiesgoDobleDscto++;
            } else if (esChica) {
                riesgo = '✅ descuento + redondeo chico, seguro';
            } else {
                riesgo = '✅ descuento no relacionado, seguro';
            }
        } else {
            tieneDscto = 'NO';
            riesgo = '✅ sin descuento, fix seguro';
        }

        if (esChica) {
            discrepanciasChicas++;
        } else {
            discrepanciasGrandes++;
        }

        const icon = riesgo.includes('DOBLE') ? '🔴' : (esChica ? '🟡' : '🟢');
        console.log(`${icon} Item ${i+1} | CANT=${cant} | BRUTO=${vrBruto} | PrecioUnit=${precioOrig} | DIF=${diff.toFixed(2)}`);
        console.log(`   Desc cuento: ${tieneDscto}`);
        console.log(`   Rowid: ${rowid}`);
        console.log(`   New VLR_UNI = ${(vrBruto / cant).toFixed(4)} | CANT×NEW = ${(cant * vrBruto / cant).toFixed(2)}`);
        console.log(`   ${riesgo}\n`);
    });

    console.log('==============================================');
    console.log('             R E S U M E N');
    console.log('==============================================');
    console.log(`  Total items analizados: ${muestra.length}`);
    console.log(`  Discrepancias chicas (≤$2): ${discrepanciasChicas}  → fix seguro ✅`);
    console.log(`  Discrepancias grandes (>$2): ${discrepanciasGrandes}`);
    console.log(`  De ellas, con descuento + relación: ${enRiesgoDobleDscto}  🔴`);
    console.log(`  De ellas, sin riesgo: ${discrepanciasGrandes - enRiesgoDobleDscto}  🟢`);

    if (enRiesgoDobleDscto > 0) {
        console.log(`\n🔴 RIESGO DETECTADO: ${enRiesgoDobleDscto} item(s) tienen`);
        console.log(`   PrecioUnitDet = precio pre-descuento Y`);
        console.log(`   vlr_tot_dscto está poblado (línea de descuento).`);
        console.log(`   Con el fix actual se aplicaría DOBLE descuento.`);
        console.log(`\n💡 Solución: aplicar vrBruto/cant SOLO cuando`);
        console.log(`   |PrecioUnitDet×CANT - VALOR_BRUTO| ≤ 2 (redondeo chico).`);
        console.log(`   Para diferencias grandes, mantener PrecioUnitDet.`);
    } else {
        console.log(`\n✅ SIN RIESGO de doble descuento.`);
        console.log(`   El fix es seguro para todos los items.`);
    }

    console.log('\n==============================================');
    console.log('🧪 Prueba completada — no se envió nada a Siesa');
    console.log('==============================================');
}

test().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
