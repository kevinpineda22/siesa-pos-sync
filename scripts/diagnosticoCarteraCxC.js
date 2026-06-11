// Diagnóstico: ¿por qué cartera ≠ CxC?
// Ejecuta: node scripts/diagnosticoCarteraCxC.js [CONSEC]
// READ-ONLY: solo consulta Connekta, no escribe nada.

require('dotenv').config();
const axios = require('axios');

const CIA = process.env.CIA || '7375';
const CONSEC_BUSCADO = process.argv[2] || '11';
// CO y Caja del filtro actual
const CO_LIST = ['001'];
const CAJA_LIST = ['Z01', 'Z02'];

const URLS = {
    ventas: `https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=merkahorro_venta_pos_dev`,
    pagos:  `https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=merkahorro_pagos_pos_dev`,
    impuestos: `https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=merkahorro_imptos_pos_dev`,
};

const headers = {
    'ConniKey': process.env.CONNI_KEY,
    'ConniToken': process.env.CONNI_TOKEN,
    'Content-Type': 'application/json'
};

async function fetchFromConnekta(url, label) {
    try {
        const resp = await axios.get(url, { headers });
        let data = resp.data;
        if (data.detalle?.Datos) data = data.detalle.Datos;
        else if (data.detalle?.Table) data = data.detalle.Table;
        else if (data.Table) data = data.Table;
        const arr = Array.isArray(data) ? data : [];
        console.log(`  ${label}: ${arr.length} registros`);
        return arr;
    } catch (err) {
        console.error(`  ❌ ${label}: ${err.message}`);
        return [];
    }
}

function roundPeso(val) {
    return Math.round(parseFloat(val || 0));
}

console.log('══════════════════════════════════════════');
console.log('  DIAGNÓSTICO cartera vs CxC');
console.log('  Buscando facturas CONSEC_DOCTO =', CONSEC_BUSCADO);
console.log('══════════════════════════════════════════\n');

(async () => {
    // 1) Descargar datos
    console.log('📡 Consultando Connekta...');
    const [ventas, pagos, impuestos] = await Promise.all([
        fetchFromConnekta(URLS.ventas, 'Ventas'),
        fetchFromConnekta(URLS.pagos, 'Pagos'),
        fetchFromConnekta(URLS.impuestos, 'Impuestos'),
    ]);

    // 2) Filtrar por CO, Caja y consecutivo
    const coSet = new Set(CO_LIST);
    const cajaSet = new Set(CAJA_LIST);
    const items = ventas.filter(d =>
        coSet.has((d.CoDoc ?? '').toString().trim().padStart(3, '0')) &&
        cajaSet.has((d.ID_TIPO_DOCTO ?? '').toString().trim().toUpperCase()) &&
        (d.CONSEC_DOCTO ?? '').toString().trim() === CONSEC_BUSCADO
    );
    const pagosFiltrados = pagos.filter(p =>
        coSet.has((p.CoDoc ?? '').toString().trim().padStart(3, '0')) &&
        cajaSet.has((p.ID_TIPO_DOCTO ?? '').toString().trim().toUpperCase()) &&
        (p.CONSEC_DOCTO ?? '').toString().trim() === CONSEC_BUSCADO
    );
    const impuestosFiltrados = impuestos.filter(i =>
        (i.CONSEC_DOCTO ?? '').toString().trim() === CONSEC_BUSCADO
    );

    // 2b) Ver qué facturas hay (sin filtrar por consec) para entender el agrupamiento
    const todasLasCoincidentes = ventas.filter(d =>
        coSet.has((d.CoDoc ?? '').toString().trim().padStart(3, '0')) &&
        cajaSet.has((d.ID_TIPO_DOCTO ?? '').toString().trim().toUpperCase())
    );
    const grupos = new Set();
    todasLasCoincidentes.forEach(d => {
        grupos.add(`${d.CoDoc}|${d.ID_TIPO_DOCTO}|${d.CONSEC_DOCTO}`);
    });
    console.log(`\n📋 Grupos CO|Caja|Consec disponibles (${grupos.size} total):`);
    [...grupos].sort().forEach(g => console.log(`   ${g}`));

    if (items.length === 0) {
        console.log(`\n❌ No se encontraron items para CONSEC_DOCTO=${CONSEC_BUSCADO}`);
        console.log('Revisa que la factura esté en el rango de Connekta (últimos 180 días).');
        return;
    }

    // 3) Mostrar items encontrados
    console.log(`\n📦 Items encontrados: ${items.length}`);
    console.log('──────────────────────────────────────');
    let baseTotal = 0;
    let ivaTotal = 0;
    let icoTotal = 0;
    let dsctoTotal = 0;
    let totalOriginal = 0; // VrNetoDocto from header

    // Mapa de encabezados (VrNetoDocto está en cualquier item)
    const encabezados = {};
    items.forEach(d => {
        const key = `${d.CoDoc}|${d.ID_TIPO_DOCTO}|${d.CONSEC_DOCTO}`;
        encabezados[key] = d;
    });

    // Mapa de impuestos por RowidMvto (todos, incluso VALOR_TOTAL=0)
    const impuestosPorRowid = {};
    impuestosFiltrados.forEach(imp => {
        if (imp.RowidMvto) {
            if (!impuestosPorRowid[imp.RowidMvto]) impuestosPorRowid[imp.RowidMvto] = [];
            impuestosPorRowid[imp.RowidMvto].push(imp);
        }
    });

    const porLineaConDatos = []; // para ruta de redondeo por línea
    const porLineaRound = [];

    items.forEach((d, idx) => {
        const rowid = d.RowidMvto || '(sin rowid)';
        const idItem = d.id_item || d.ID_ITEM || '?';
        const cant = parseFloat(d.CANTIDAD || d.cant_1 || 0);
        const vrBruto = parseFloat(d.VALOR_BRUTO || 0);
        const concepto = d.Concepto || '?';
        const bodega = d.BODEGA || '?';
        const un = (d.unidad_de_negocio || '').trim() || '(sin UN)';
        const tipoInvServ = (d.tipo_inv_serv || '').trim() || '?';

        // Descuento del item
        const dsctoItem = parseFloat(d.vlr_tot_dscto || 0);
        const dsctoUni = parseFloat(d.vlr_uni_dscto || 0);

        // Impuestos asociados a este RowidMvto
        const imptos = impuestosPorRowid[rowid] || [];
        let ivaItem = 0;
        let icoItem = 0;
        let icoVlrUni = 0;
        imptos.forEach(imp => {
            const tasa = parseFloat(imp.TASA || 0);
            const vlrUni = parseFloat(imp.VLR_UNI || 0);
            const valTotal = parseFloat(imp.VALOR_TOTAL || 0);
            if (tasa > 0) {
                // IVA: usar VALOR_TOTAL si existe, si no calcular
                ivaItem += valTotal > 0 ? valTotal : (vlrUni * cant);
            } else if (vlrUni > 0) {
                // ICO: TASA=0, VLR_UNI > 0
                icoItem += valTotal > 0 ? valTotal : (vlrUni * cant);
                icoVlrUni += vlrUni * cant;
            }
        });

        baseTotal += vrBruto;
        ivaTotal += ivaItem;
        icoTotal += icoItem;
        dsctoTotal += dsctoItem;

        // PrecioUnitDet de Connekta (lo que usábamos antes del fix)
        const precioUnitDet = parseFloat(d.PrecioUnitDet || 0);
        const precioUnitCalc = cant > 0 ? vrBruto / cant : 0;
        const diffPrecio = precioUnitDet > 0 ? Math.abs(precioUnitCalc - precioUnitDet) : 0;

        const netoItem = vrBruto - dsctoItem + ivaItem + icoItem;
        porLineaConDatos.push({
            vrBruto, dsctoItem, ivaItem, icoItem, netoItem,
            cant, idItem, rowid
        });
        porLineaRound.push(roundPeso(netoItem));

        console.log(`  Item ${idx+1}:`);
        console.log(`    Rowid: ${rowid} | Item: ${idItem} | Concepto: ${concepto}`);
        console.log(`    Bodega: ${bodega} | UN: ${un} | tipo_inv_serv: ${tipoInvServ}`);
        console.log(`    CANT=${cant} | VALOR_BRUTO=$${vrBruto} | PrecioUnitDet=$${precioUnitDet}`);
        console.log(`    VLR_UNIT (calc)=$${precioUnitCalc.toFixed(4)} | diff vs PrecioUnitDet: $${diffPrecio.toFixed(4)}`);
        console.log(`    Descuento: $${dsctoItem} (unit: $${dsctoUni})`);
        console.log(`    IVA: $${ivaItem} | ICO: $${icoItem}`);
        console.log(`    Neto item (base - dscto + IVA + ICO): $${netoItem.toFixed(4)}`);
        console.log(`    Neto redondeado: $${roundPeso(netoItem)}`);
        console.log('');
    });

    // 4) Totales
    console.log('══════════════════════════════════════════');
    console.log('  RESUMEN DE TOTALES');
    console.log('══════════════════════════════════════════');
    console.log(`  Base total (Σ VALOR_BRUTO):           $${baseTotal.toFixed(4)}`);
    console.log(`  IVA total:                            $${ivaTotal.toFixed(4)}`);
    console.log(`  ICO total (VLR_UNI × CANT):           $${icoTotal.toFixed(4)}`);
    console.log(`  Descuentos total:                     $${dsctoTotal.toFixed(4)}`);
    console.log('');
    const netoCalc = baseTotal - dsctoTotal + ivaTotal + icoTotal;
    console.log(`  Neto calculado (base - dscto + IVA + ICO): $${netoCalc.toFixed(4)}`);

    // VrNetoDocto del header (el primer item lo tiene)
    const primerItem = items[0];
    const vrNetoDocto = parseFloat(primerItem?.VrNetoDocto || 0);
    console.log(`  VrNetoDocto del encabezado:            $${vrNetoDocto.toFixed(4)}`);

    // 5) Comparar con los valores reportados por Siesa (args: node script.js CONSEC CARTERA CXC)
    const carteraSiesa = parseFloat(process.argv[3]) || 0;
    const cxcSiesa = parseFloat(process.argv[4]) || 0;
    console.log('');
    console.log('  VALORES REPORTADOS POR SIESA:');
    if (carteraSiesa) console.log(`  Cartera:                              $${carteraSiesa}`);
    if (cxcSiesa) console.log(`  CxC:                                  $${cxcSiesa}`);
    if (carteraSiesa && cxcSiesa) console.log(`  Gap (CxC - cartera):                  $${cxcSiesa - carteraSiesa}`);
    if (!carteraSiesa && !cxcSiesa) console.log('  (no proporcionados, pasar como args: node script.js CONSEC CARTERA CxC)');

    // 6) Rutas de redondeo
    console.log('');
    console.log('══════════════════════════════════════════');
    console.log('  RUTAS DE REDONDEO');
    console.log('══════════════════════════════════════════');

    // Ruta A: Sumar neto calculado sin redondear, luego redondear al final
    const documentoRound = roundPeso(netoCalc);
    console.log(`  Ruta "documento" (round(Σ líneas completas)): $${documentoRound}`);
    console.log(`    cartera - documentoRound: $${carteraSiesa - documentoRound}`);

    // Ruta B: Redondear cada línea, sumar redondeos
    const porLineaSum = porLineaRound.reduce((a, b) => a + b, 0);
    console.log(`  Ruta "por línea" (Σ round(neto_i)):         $${porLineaSum}`);
    console.log(`    cartera - porLineaSum: $${carteraSiesa - porLineaSum}`);

    // 7) Análisis de cartera
    console.log('');
    console.log('══════════════════════════════════════════');
    console.log('  ANÁLISIS DE CARTERA');
    console.log('══════════════════════════════════════════');
    // cartera = Σ(VLR_UNIT × CANT). Con el fix, VLR_UNIT = VALOR_BRUTO / CANT
    // → cartera_calculada = Σ(VALOR_BRUTO) = baseTotal
    console.log(`  Carrera estimada (Σ base):              $${baseTotal.toFixed(4)}`);
    console.log(`  Cartera Siesa:                          $${carteraSiesa}`);
    console.log(`  Diferencia:                             $${(carteraSiesa - baseTotal).toFixed(4)}`);

    // Si cartera Siesa ≈ baseTotal, entonces cartera = Σ VALOR_BRUTO (correcto)
    const diffBaseCartera = Math.abs(carteraSiesa - baseTotal);
    if (diffBaseCartera <= 5) {
        console.log(`  ✅ Cartera ≈ baseTotal (dif $${diffBaseCartera}): cartera = Σ VALOR_BRUTO`);
    } else {
        console.log(`  ⚠️ Cartera difiere de baseTotal en $${diffBaseCartera}: hay otra fuente de cartera`);
    }

    // 8) Análisis de CxC
    console.log('');
    console.log('══════════════════════════════════════════');
    console.log('  ANÁLISIS DE CxC');
    console.log('══════════════════════════════════════════');
    // ¿CxC = baseTotal - dsctoTotal + ivaTotal + icoTotal?
    console.log(`  H1: CxC = base - dscto + IVA + ICO:`);
    console.log(`       $${netoCalc.toFixed(4)} vs CxC=$${cxcSiesa} → dif $${(cxcSiesa - netoCalc).toFixed(4)}`);
    // ¿CxC = baseTotal - dsctoTotal (sin IVA/ICO)?
    const sinImpuestos = baseTotal - dsctoTotal;
    console.log(`  H2: CxC = base - dscto (sin IVA/ICO):`);
    console.log(`       $${sinImpuestos.toFixed(4)} vs CxC=$${cxcSiesa} → dif $${(cxcSiesa - sinImpuestos).toFixed(4)}`);
    // ¿CxC = neto documental (VrNetoDocto)?
    console.log(`  H3: CxC = VrNetoDocto:`);
    console.log(`       $${vrNetoDocto} vs CxC=$${cxcSiesa} → dif $${(cxcSiesa - vrNetoDocto).toFixed(4)}`);

    // 9) Pagos (Caja)
    console.log('');
    console.log('══════════════════════════════════════════');
    console.log('  PAGOS (Caja)');
    console.log('══════════════════════════════════════════');
    let totalPagos = 0;
    const pagosDetalle = {};
    pagosFiltrados.forEach(p => {
        const medio = p.ID_MEDIOS_PAGO || '?';
        const neto = (parseFloat(p.VLR_MEDIO_PAGO_INGRESO || 0)) - (parseFloat(p.VLR_MEDIO_PAGO_EGRESO || 0));
        totalPagos += neto;
        if (!pagosDetalle[medio]) pagosDetalle[medio] = 0;
        pagosDetalle[medio] += neto;
        console.log(`  ${medio}: ingreso=$${p.VLR_MEDIO_PAGO_INGRESO || 0} egreso=$${p.VLR_MEDIO_PAGO_EGRESO || 0} neto=$${neto}`);
    });
    console.log(`  Total pagos (Caja POS):               $${totalPagos}`);

    // ¿Cuál es el efecto del ajuste de redondeo?
    const totalSiesa = baseTotal - dsctoTotal + ivaTotal + icoTotal;
    const ajuste = Math.round(totalSiesa - totalPagos);
    console.log(`  Total Siesa calculado:                 $${totalSiesa.toFixed(4)}`);
    console.log(`  Ajuste automático (totalSiesa - pagos): $${ajuste}`);
    console.log(`  Caja después de ajuste:                $${(totalPagos + ajuste)}`);

    // 10) Verificar ICO como posible causa
    console.log('');
    console.log('══════════════════════════════════════════');
    console.log('  HIPÓTESIS: ICO');
    console.log('══════════════════════════════════════════');
    console.log(`  ICO total:                             $${icoTotal.toFixed(4)}`);
    console.log(`  Gap real (CxC - cartera):              $${cxcSiesa - carteraSiesa}`);
    if (Math.abs(icoTotal - (cxcSiesa - carteraSiesa)) <= 2) {
        console.log(`  🔍 ICO ≈ gap: el ICO sin incluir en items podría ser la causa`);
    } else {
        console.log(`  ❌ ICO ≠ gap: el ICO no explica la diferencia`);
    }

    // 11) Comparación PrecioUnitDet vs calculado (el fix)
    console.log('');
    console.log('══════════════════════════════════════════');
    console.log('  VALIDACIÓN DEL FIX VLR_UNITARIO');
    console.log('══════════════════════════════════════════');
    let discrepancias = 0;
    items.forEach((d, idx) => {
        const cant = parseFloat(d.CANTIDAD || d.cant_1 || 0);
        const vrBruto = parseFloat(d.VALOR_BRUTO || 0);
        const precioUnitDet = parseFloat(d.PrecioUnitDet || 0);
        const precioUnitCalc = cant > 0 ? vrBruto / cant : 0;
        if (precioUnitDet > 0 && Math.abs(precioUnitCalc - precioUnitDet) > 0.01) {
            discrepancias++;
            console.log(`  ⚠️ Item ${idx+1}: PrecioUnitDet=$${precioUnitDet} vs VALOR_BRUTO/CANT=$${precioUnitCalc.toFixed(4)} (dif $${Math.abs(precioUnitCalc - precioUnitDet).toFixed(4)})`);
        }
    });
    if (discrepancias === 0) {
        console.log(`  ✅ Todos los items: PrecioUnitDet ≈ VALOR_BRUTO / CANT`);
    } else {
        console.log(`  ⚠️ ${discrepancias} item(s) con discrepancia entre PrecioUnitDet y VALOR_BRUTO/CANT`);
    }

    // 12) Análisis de IVA recalculado (Math.round como Siesa)
    console.log('');
    console.log('══════════════════════════════════════════');
    console.log('  IVA RECALCULADO (Math.round como Siesa)');
    console.log('══════════════════════════════════════════');
    let ivaRecalcTotal = 0;
    let divergenciasIVA = 0;
    porLineaConDatos.forEach((item, idx) => {
        const imptos = impuestosPorRowid[item.rowid] || [];
        imptos.forEach(imp => {
            const tasa = parseFloat(imp.TASA || 0);
            if (tasa > 0) {
                const baseNeta = item.vrBruto - item.dsctoItem;
                const ivaRecalc = Math.round(baseNeta * tasa / 100);
                const ivaPos = item.ivaItem;
                ivaRecalcTotal += ivaRecalc;
                if (ivaRecalc !== ivaPos) {
                    divergenciasIVA++;
                    console.log(`  ⚠️ Item ${idx+1}: POS envió $${ivaPos}, Siesa recalcula $${ivaRecalc} (Δ $${ivaPos - ivaRecalc}) — base_neta=$${baseNeta} tasa=${tasa}%`);
                }
            }
        });
    });
    console.log(`  IVA enviado (POS):              $${ivaTotal}`);
    console.log(`  IVA recalculado (Siesa):        $${ivaRecalcTotal}`);
    console.log(`  Diferencia:                     $${ivaTotal - ivaRecalcTotal}`);
    console.log(`  Líneas divergentes:             ${divergenciasIVA}`);

    // Calcular cartera con IVA recalculado
    const carteraConIvaRecalc = baseTotal - dsctoTotal + ivaRecalcTotal;
    console.log(`  Cartera si enviamos IVA recalc:  $${carteraConIvaRecalc}`);
    console.log(`  Cartera Siesa reportada:        $${carteraSiesa}`);
    const difIvaRecalc = Math.abs(carteraSiesa - carteraConIvaRecalc);
    console.log(`  Diferencia vs Siesa:            $${difIvaRecalc <= 2 ? '✅ ' + difIvaRecalc : '❌ ' + difIvaRecalc}`);

    // 13) Resumen
    console.log('');
    console.log('══════════════════════════════════════════');
    console.log('  CONCLUSIÓN');
    console.log('══════════════════════════════════════════');

    // Determinar la causa más probable
    const gapReportado = cxcSiesa - carteraSiesa;
    console.log(`  Gap reportado por Siesa: cartera=$${carteraSiesa} CxC=$${cxcSiesa} dif=$${gapReportado}`);
    console.log(`  Base total: $${baseTotal}`);
    console.log(`  IVA total: $${ivaTotal.toFixed(2)}`);
    console.log(`  IVA recalculado (Math.round): $${ivaRecalcTotal}`);
    console.log(`  ICO total: $${icoTotal.toFixed(2)}`);
    console.log(`  Descuentos: $${dsctoTotal}`);
    console.log(`  Neto calc (base - dscto + IVA + ICO): $${netoCalc.toFixed(4)}`);
    console.log(`  Neto calc con IVA recalc: $${(netoCalc - ivaTotal + ivaRecalcTotal).toFixed(4)}`);
    console.log(`  VrNetoDocto: $${vrNetoDocto}`);
    console.log(`  Total pagos: $${totalPagos}`);
    console.log(`  Documento round: $${documentoRound}`);
    console.log(`  Por línea round: $${porLineaSum}`);
    console.log(`  Dif cartera vs base: $${(carteraSiesa - baseTotal).toFixed(4)}`);
    console.log(`  Dif CxC vs VrNetoDocto: $${(cxcSiesa - vrNetoDocto).toFixed(4)}`);
    console.log(`  Dif CxC vs netoCalc: $${(cxcSiesa - netoCalc).toFixed(4)}`);
    console.log(`  Dif CxC vs netoCalc+IVA_recalc: $${(cxcSiesa - (netoCalc - ivaTotal + ivaRecalcTotal)).toFixed(4)}`);
    console.log(`  Ajuste automático que se aplicaría: $${ajuste}`);

    // Hipótesis final
    const posibles = [];
    if (Math.abs((cxcSiesa - carteraSiesa) - icoTotal) <= 2) {
        posibles.push('ICO no incluido en items');
    }
    if (Math.abs(carteraSiesa - baseTotal) <= 2) {
        posibles.push('Cartera = Σ base (correcto)');
    }
    if (Math.abs(cxcSiesa - porLineaSum) <= 2) {
        posibles.push('CxC = Σ round(neto_i) (redondeo por línea)');
    }
    if (Math.abs(cxcSiesa - documentoRound) <= 2) {
        posibles.push('CxC = round(Σ neto_i) (redondeo documental)');
    }
    if (Math.abs(cxcSiesa - netoCalc) <= 2) {
        posibles.push('CxC = netoCalc (base - dscto + IVA + ICO sin redondeo)');
    }
    if (Math.abs(cxcSiesa - vrNetoDocto) <= 2) {
        posibles.push('CxC = VrNetoDocto');
    }
    if (difIvaRecalc <= 2 && divergenciasIVA > 0) {
        posibles.push(`Cartera coincide con IVA recalculado (${divergenciasIVA} línea(s) divergente(s))`);
    }

    console.log('\n  Hipótesis compatibles con los datos:');
    posibles.forEach(h => console.log(`   • ${h}`));
    if (posibles.length === 0) {
        console.log('   ❌ Ninguna hipótesis coincide exactamente.');
        console.log('   Posible causa mixta o dato faltante.');
    }

    console.log('\n══════════════════════════════════════════\n');
})();
