/**
 * dumpPlano.js
 *
 * Lee una factura real de Connekta y genera el payload EXACTO que se enviaría a Siesa,
 * guardándolo en un archivo JSON legible para inspección.
 *
 * Uso:
 *   node scripts/dumpPlano.js <consecutivo> [tipo]
 *
 * Ejemplos:
 *   node scripts/dumpPlano.js 4381          # CFZ del consec 4381 (default)
 *   node scripts/dumpPlano.js 4381 CNZ      # CNZ del consec 4381
 *   node scripts/dumpPlano.js 4098 CFZ      # CFZ del consec 4098
 *
 * Salida: genera plano_<consec>_<tipo>.json en la raíz del proyecto.
 */
require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CIA = process.env.CIA || '7375';

// ============================================================
// 1. URLs de Connekta (igual que syncVentas.js)
// ============================================================
const URL_VENTAS_DETALLE = `https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=merkahorro_venta_pos_dev`;
const URL_VENTAS_PAGOS = `https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=merkahorro_pagos_pos_dev`;
const URL_VENTAS_IMPUESTOS = `https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=merkahorro_imptos_pos_dev`;
const URL_CAJAS = `https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=merkahorro_cajas_pos_dev`;

// ============================================================
// 2. Helpers (copiados de syncVentas.js)
// ============================================================
function formatDate(fecha) {
    if (!fecha) return '';
    const d = new Date(fecha);
    if (isNaN(d.getTime())) return String(fecha).split('T')[0].replace(/-/g, '');
    return d.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }).replace(/-/g, '');
}

function truncar(valor, max) {
    if (valor === null || valor === undefined) return '';
    return String(valor).normalize('NFD').replace(/[\u0300-\u036f]/g, '').substring(0, max).trim();
}

async function fetchFromConnekta(url) {
    try {
        const response = await axios.get(url, {
            headers: {
                'ConniKey': process.env.CONNI_KEY,
                'ConniToken': process.env.CONNI_TOKEN
            },
            timeout: 60000
        });
        let data = response.data;
        if (data.detalle && data.detalle.Datos) data = data.detalle.Datos;
        else if (data.detalle && data.detalle.Table) data = data.detalle.Table;
        else if (data.Table) data = data.Table;
        return Array.isArray(data) ? data : [];
    } catch (error) {
        console.error(`❌ Error consultando Connekta: ${error.message}`);
        return [];
    }
}

// ============================================================
// 3. Generar payload (igual que syncVentas.js)
// ============================================================
function generarPayload(factura, tipoDocto, cajaPorCo) {
    const enc = factura.items[0];
    const consecDoc = enc.CONSEC_DOCTO;
    const esCNZ = tipoDocto === 'CNZ';

    const absIfCNZ = (val) => {
        if (val === null || val === undefined) return val;
        return esCNZ ? Math.abs(parseFloat(val)) : parseFloat(val);
    };

    const Docto_ventas_comercial = [{
        "ID_CO": enc.CoDoc,
        "ID_TIPO_DOCTO": tipoDocto,
        "CONSEC_DOCTO": consecDoc,
        "FECHA_DOCTO": formatDate(enc.FECHA_DOCTO),
        "ID_TERCERO": enc.NitTercero,
        "ID_CLASE_DOCTO": esCNZ ? 525 : 522,
        "SUCURSAL_CLIENTE": "001",
        "id_co_fact": enc.CoDoc,
        "TERCERO_REM": enc.NitTercero,
        "F_CONSEC_AUTO_REG": "1",
        "id_cond_pago": enc.id_cond_pago ? enc.id_cond_pago.toString().trim().padStart(3, '0') : "000",
        "id_caja": (cajaPorCo[enc.CoDoc.trim()] || (enc.CoDoc.trim() === "003" ? "03 " : enc.CoDoc.trim().padStart(3, '0'))).padEnd(3, ' ')
    }];

    const Movimientos = [];
    const Impuestos = [];
    const Descuentos = [];

    factura.items.forEach((det, index) => {
        const linea = index + 1;
        const cant = absIfCNZ(det.CANTIDAD || det.cant_1);
        const vrBruto = absIfCNZ(det.VALOR_BRUTO);
        const precioUnit = Number(cant) > 0 ? vrBruto / cant : 0;

        const totalDesc = absIfCNZ(det.vlr_tot_dscto) || 0;
        const porcDesc = (vrBruto > 0) ? ((totalDesc / vrBruto) * 100).toFixed(4) : "0.0000";

        Movimientos.push({
            "id_co": enc.CoDoc,
            "id_tipo_docto": tipoDocto,
            "consec_docto": consecDoc,
            "nro_registro": linea,
            "BODEGA": det.BODEGA || "MG001",
            "id_concepto": esCNZ ? 502 : ({ "1201": 501, "1202": 502 }[det.Concepto] || 501),
            "ID_ITEM": truncar(det.ID_ITEM || det.id_item, 30),
            "CANTIDAD": Number(cant).toFixed(4).padStart(15, '0'),
            "VR_BRUTO_UNI": Number(precioUnit).toFixed(4).padStart(19, '0'),
            "VR_TOT_DESC": Number(totalDesc).toFixed(4).padStart(19, '0'),
            "VR_TOT_IVA": Number(absIfCNZ(det.vlr_impoconsumo_anticipado || det.vlr_iva) || 0).toFixed(4).padStart(19, '0'),
            "VR_TOT_IMPOCONSUMO": Number(absIfCNZ(det.vlr_impoconsumo || det.vlr_impoconsumo_anticipado) || 0).toFixed(4).padStart(19, '0'),
            "CANT_UND": Number(cant).toFixed(4).padStart(15, '0'),
            "ID_UM": (det.ID_UM || 'UND').toString().trim().padEnd(3, ' '),
            "PORC_DESC": porcDesc.padStart(10, '0'),
            "VR_TOT_NETO": Number(absIfCNZ(det.VALOR_BRUTO - totalDesc)).toFixed(4).padStart(19, '0'),
            "VR_PRECIO_VENTA": Number(precioUnit).toFixed(4).padStart(19, '0')
        });
    });

    // Impuestos
    if (factura._impuestos) {
        factura._impuestos.forEach(imp => {
            Impuestos.push({
                "id_co": enc.CoDoc,
                "id_tipo_docto": tipoDocto,
                "consec_docto": consecDoc,
                "nro_registro": imp.NRO_REGISTRO,
                "ID_LLAVE_IMPUESTO": imp.ID_LLAVE_IMPUESTO,
                "BASE_GRAVABLE": imp.BASE_GRAVABLE,
                "PORCENTAJE_BASE": imp.PORCENTAJE_BASE || "100.0000",
                "TASA": imp.TASA,
                "VALOR_TOTAL": imp.VALOR_TOTAL,
            });
        });
    }

    // Pagos (consolidados por medio de pago, igual que syncVentas.js)
    const Caja = [];
    const cajaConsolidada = {};
    if (factura.pagos) {
        factura.pagos.forEach(p => {
            if (!cajaConsolidada[p.ID_MEDIOS_PAGO]) {
                cajaConsolidada[p.ID_MEDIOS_PAGO] = { ...p, neto: 0 };
            }
            cajaConsolidada[p.ID_MEDIOS_PAGO].neto += (p.VLR_MEDIO_PAGO_INGRESO || 0) - (p.VLR_MEDIO_PAGO_EGRESO || 0);
        });
        Object.values(cajaConsolidada).filter(p => esCNZ ? Math.abs(p.neto) > 0 : p.neto > 0).forEach(pago => {
            Caja.push({
                "ID_CO": enc.CoDoc,
                "ID_TIPO_DOCTO": tipoDocto,
                "CONSEC_DOCTO": consecDoc,
                "ID_MEDIOS_PAGO": esCNZ ? "EFE" : pago.ID_MEDIOS_PAGO,
                "VLR_MEDIO_PAGO": Number(absIfCNZ(pago.neto)).toFixed(4).padStart(19, '0'),
                "NRO_CUENTA": pago.NRO_CUENTA || "1",
                "NRO_CHEQUE": "1",
                "REFERENCIA": "1",
                "COD_SEGURIDAD": pago.COD_SEGURIDAD || 1,
                "NRO_AUTORIZACION": pago.NRO_AUTORIZACION || "1",
                "FECHA_VCTO": formatDate(pago.FECHA_VCTO)
            });
        });
    }

    const payloadCompleto = {
        "idSistema": 1,
        "idDocumento": 242756,
        "nombreDocumento": "FACTURA_DEV",
        "Documentos": {
            "Docto_ventas_comercial": Docto_ventas_comercial,
            "Movimientos": Movimientos,
            "Impuestos": Impuestos,
            "Descuentos": Descuentos,
            "Caja": Caja
        }
    };

    return payloadCompleto;
}

// ============================================================
// 4. MAIN
// ============================================================
(async () => {
    const consec = process.argv[2];
    const tipoDocto = (process.argv[3] || 'CFZ').toUpperCase();

    if (!consec) {
        console.error('❌ Uso: node scripts/dumpPlano.js <consecutivo> [CFZ|CNZ]');
        console.error('   Ej:  node scripts/dumpPlano.js 4381');
        console.error('        node scripts/dumpPlano.js 4098 CNZ');
        process.exit(1);
    }

    console.log(`📋 Generando plano para consec ${consec}, tipo ${tipoDocto}...`);
    console.log('');

    // 1. Fetch data from Connekta
    console.log('🔍 Consultando Connekta...');
    const [detallesRaw, pagosRaw, impuestosRaw, cajasRaw] = await Promise.all([
        fetchFromConnekta(URL_VENTAS_DETALLE),
        fetchFromConnekta(URL_VENTAS_PAGOS),
        fetchFromConnekta(URL_VENTAS_IMPUESTOS),
        fetchFromConnekta(URL_CAJAS),
    ]);

    // 2. Filtrar por consec
    const detalles = detallesRaw.filter(d => String(d.CONSEC_DOCTO) === String(consec));
    if (detalles.length === 0) {
        console.error(`❌ Consecutivo ${consec} no encontrado en Connekta.`);
        console.log('   Los datos de facturas viejas pueden haber sido purgados.');
        process.exit(1);
    }
    console.log(`   ✓ ${detalles.length} línea(s) de detalle encontradas`);

    // 3. CajaPorCo mapping
    const cajaPorCo = {};
    if (cajasRaw && cajasRaw.length > 0) {
        cajasRaw.forEach(c => {
            const co = c.f291_id_co ? c.f291_id_co.toString().trim() : '001';
            const idCaja = c.f291_id ? c.f291_id.toString().trim() : '001';
            if (!cajaPorCo[co]) cajaPorCo[co] = idCaja;
        });
    }

    // 4. Agrupar factura
    const buildKey = (co, caja, consec) => `${(co || '').trim() || '001'}|${(caja || '').trim() || '000'}|${consec}`;
    const facturas = {};
    detalles.forEach(det => {
        const key = buildKey(det.CoDoc, det.ID_TIPO_DOCTO, det.CONSEC_DOCTO);
        if (!facturas[key]) facturas[key] = { items: [], pagos: [], _impuestos: [] };
        facturas[key].items.push({ ...det });
    });

    // 5. Asignar pagos
    const facturasKeysValidas = new Set(detalles.map(d => buildKey(d.CoDoc, d.ID_TIPO_DOCTO, d.CONSEC_DOCTO)));
    pagosRaw
        .filter(p => facturasKeysValidas.has(buildKey(p.CoDoc, p.ID_TIPO_DOCTO, p.CONSEC_DOCTO)))
        .forEach(p => {
            const key = buildKey(p.CoDoc, p.ID_TIPO_DOCTO, p.CONSEC_DOCTO);
            if (facturas[key]) facturas[key].pagos.push(p);
        });

    // 6. Asignar impuestos (mapear por RowidMvto igual que syncVentas)
    const impVistos = new Set();
    impuestosRaw.forEach(imp => {
        if (imp.ID_LLAVE_IMPUESTO && imp.ID_LLAVE_IMPUESTO !== 'null' && parseFloat(imp.VALOR_TOTAL || 0) > 0) {
            const llave = `${imp.RowidMvto}|${String(imp.ID_LLAVE_IMPUESTO).trim()}`;
            if (impVistos.has(llave)) return;
            impVistos.add(llave);
            // Asignar a la factura correspondiente buscando el RowidMvto en sus items
            for (const key of Object.keys(facturas)) {
                const item = facturas[key].items.find(i => i.RowidMvto === imp.RowidMvto);
                if (item) {
                    facturas[key]._impuestos.push({
                        NRO_REGISTRO: facturas[key].items.indexOf(item) + 1,
                        ID_LLAVE_IMPUESTO: String(imp.ID_LLAVE_IMPUESTO).trim(),
                        BASE_GRAVABLE: String(imp.BASE_GRAVABLE || '0'),
                        PORCENTAJE_BASE: String(imp.PORCENTAJE_BASE || '100.0000'),
                        TASA: String(imp.TASA || '0'),
                        VALOR_TOTAL: String(imp.VALOR_TOTAL || '0'),
                    });
                    break;
                }
            }
        }
    });

    // 7. Buscar la factura por consec (ignoramos el tipo porque en Connekta viene como Z02, no CFZ/CNZ)
    const keysDisponibles = Object.keys(facturas).filter(k => k.endsWith(`|${consec}`));
    if (keysDisponibles.length === 0) {
        console.error(`❌ Consecutivo ${consec} no encontrado en Connekta.`);
        process.exit(1);
    }
    // Preferir la que tenga tipo de docto Siesa (CFZ > CNZ) si hay varias
    const keyBuscada = keysDisponibles.find(k => {
        const parts = k.split('|');
        return parts[1] === 'CFZ' || parts[1] === 'CNZ';
    }) || keysDisponibles[0];

    const factura = facturas[keyBuscada];
    const enc = factura.items[0];

    console.log(`   CO: ${enc.CoDoc}`);
    console.log(`   Caja: ${enc.ID_TIPO_DOCTO}`);
    console.log(`   Cliente: ${enc.NitTercero}`);
    console.log(`   Items: ${factura.items.length}`);
    console.log(`   Pagos: ${factura.pagos.length}`);
    console.log(`   Fecha: ${enc.FECHA_DOCTO}`);
    console.log('');

    // 8. Generar payload completo
    console.log('📦 Generando payload para Siesa...');
    const payload = generarPayload(factura, tipoDocto, cajaPorCo);

    // 9. Guardar a archivo
    const filename = `plano_${consec}_${tipoDocto}.json`;
    const filepath = path.resolve(__dirname, '..', filename);
    fs.writeFileSync(filepath, JSON.stringify(payload, null, 2), 'utf8');
    console.log(`✅ Plano guardado en: ${filepath}`);
    console.log('');

    // 10. Mostrar resumen
    const header = payload.Documentos.Docto_ventas_comercial[0];
    console.log('═══ RESUMEN DEL PLANO ═══');
    console.log(`ID_CO:          ${header.ID_CO}`);
    console.log(`TIPO_DOCTO:     ${header.ID_TIPO_DOCTO}`);
    console.log(`CONSECUTIVO:    ${header.CONSEC_DOCTO}`);
    console.log(`FECHA:          ${header.FECHA_DOCTO}`);
    console.log(`CLIENTE NIT:    ${header.ID_TERCERO}`);
    console.log(`SUCURSAL:       ${header.SUCURSAL_CLIENTE}`);
    console.log(`F_CONSEC_AUTO:  ${header.F_CONSEC_AUTO_REG}`);
    console.log(`ID_CAJA:        ${header.id_caja}`);
    console.log(`ID_CLASE_DOCTO: ${header.ID_CLASE_DOCTO} (${header.ID_TIPO_DOCTO === 'CNZ' ? 'Nota Crédito' : 'Factura'})`);
    console.log('');
    console.log(`MOVIMIENTOS:    ${payload.Documentos.Movimientos.length} línea(s)`);
    console.log(`IMPUESTOS:      ${payload.Documentos.Impuestos.length} registro(s)`);
    console.log(`PAGOS/CAJA:     ${payload.Documentos.Caja.length} registro(s)`);
    console.log(`DESCUENTOS:     ${payload.Documentos.Descauentos?.length || 0} registro(s)`);
    console.log('');

    // 11. Mostrar primeros items como preview
    console.log('═══ VISTA PREVIA ITEMS (primeros 3) ═══');
    payload.Documentos.Movimientos.slice(0, 3).forEach(m => {
        const cant = parseFloat(m.CANTIDAD);
        const precio = parseFloat(m.VR_BRUTO_UNI);
        const neto = parseFloat(m.VR_TOT_NETO);
        console.log(`  ${m.nro_registro}. ${m.ID_ITEM.trim()} | ${cant} x $${precio.toFixed(0)} = $${neto.toFixed(0)} | UM: ${m.ID_UM.trim()} | Desc: ${m.PORC_DESC.trim()}%`);
    });

    console.log('═══════════════════════════════════════');
    console.log(`📁 Archivo completo: ${filename}`);
})();
