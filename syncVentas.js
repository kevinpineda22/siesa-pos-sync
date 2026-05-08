const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

// Configuraciones de Connekta y Siesa
const CONNI_KEY = process.env.CONNI_KEY;
const CONNI_TOKEN = process.env.CONNI_TOKEN;
const CIA = 7375;

// URLs de Connekta
const URL_VENTAS_DETALLE = `https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=merkahorro_venta_pos_dev`;
const URL_VENTAS_PAGOS = `https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=merkahorro_pagos_pos_dev`;

// URL de Siesa QA (POST) - Documento 242756 (FACTURA_DEV)
const URL_SIESA_POST = `https://serviciosqa.siesacloud.com/api/siesa/v3.1/conectoresimportar?idCompania=${CIA}&idSistema=1&idDocumento=242756&nombreDocumento=FACTURA_DEV`;

async function fetchFromConnekta(url) {
    try {
        const response = await axios.get(url, {
            headers: {
                'conniKey': CONNI_KEY,
                'conniToken': CONNI_TOKEN
            }
        });
        
        console.log(`\n🔍 RESPUESTA DE CONNEKTA PARA: ${url.split('descripcion=')[1]} - STATUS: ${response.data.mensaje}`);

        const detalle = response.data.detalle;
        if (response.data.codigo === 0 && detalle) {
            if (detalle.Datos && detalle.Datos.length > 0) return detalle.Datos;
            if (detalle.Table && detalle.Table.length > 0) return detalle.Table;
        }
        return [];
    } catch (error) {
        console.error(`❌ Error consultando Connekta: ${url}`, error.message);
        if(error.response) console.error(error.response.data);
        return [];
    }
}

function formatDate(isoString) {
    if (!isoString) return "";
    return isoString.split('T')[0].replace(/-/g, '');
}

function formatDecimal(number, isQuantity = false) {
    if (number === null || number === undefined) return isQuantity ? "000000000000000.0000" : "000000000000000.0000";
    return parseFloat(number).toFixed(4).padStart(20, '0');
}

function formatTasa(number) {
    if (number === null || number === undefined) return "000.0000";
    return parseFloat(number).toFixed(4).padStart(8, '0');
}

async function syncVentas() {
    console.log("==========================================");
    console.log("🚀 Iniciando Sincronización de Ventas POS");
    console.log("==========================================");

    const detalles = await fetchFromConnekta(URL_VENTAS_DETALLE);
    const pagosRaw = await fetchFromConnekta(URL_VENTAS_PAGOS);

    if (detalles.length === 0) {
        console.log("⚠️ No hay facturas para sincronizar. (Query vacío)");
        return;
    }

    const enc = detalles[0];

    const cajaConsolidada = {};
    pagosRaw.forEach(p => {
        if (!cajaConsolidada[p.ID_MEDIOS_PAGO]) {
            cajaConsolidada[p.ID_MEDIOS_PAGO] = {
                ...p,
                neto: 0
            };
        }
        cajaConsolidada[p.ID_MEDIOS_PAGO].neto += (p.VLR_MEDIO_PAGO_INGRESO || 0) - (p.VLR_MEDIO_PAGO_EGRESO || 0);
    });

    const pagosProcesados = Object.values(cajaConsolidada).filter(p => p.neto > 0);

    // HOMOLOGACIÓN DE TIPO DE DOCUMENTO PARA SIESA QA
    // P03 = Nota Crédito -> CNC. Cualquier otro (P01, P05) = Factura -> CFE
    const tipoDoctoSiesa = enc.ID_TIPO_DOCTO === 'P03' ? 'CNC' : 'CFE';

    const Docto_ventas_comercial = [];
    const Movimientos = [];
    const Impuestos = [];
    const Descuentos = [];
    const Caja = [];

    Docto_ventas_comercial.push({
        "IND_CONSECUTIVO": "1", // Manual
        "ID_CO": enc.CoDoc,
        "ID_TIPO_DOCTO": tipoDoctoSiesa,
        "CONSEC_DOCTO": enc.CONSEC_DOCTO,
        "FECHA_DOCTO": formatDate(enc.FECHA_DOCTO),
        "ID_TERCERO": enc.NitTercero,
        "ID_CLASE_DOCTO": enc.ID_TIPO_DOCTO === 'P03' ? "525" : "522", // 522=Factura directa, 525=Nota credito
        "SUCURSAL_CLIENTE": "001",
        "id_co_fact": enc.CoDoc,
        "TERCERO_REM": enc.NitTercero,
        // Usamos el nuevo campo IdCondPago que agregaste al query
        "id_cond_pago": enc.IdCondPago || "001",
        "id_caja": "001" // Punto de envío cambiado a 001 a petición del equipo
    });

    detalles.forEach((det, index) => {
        const lineaItem = index + 1;

        Movimientos.push({
            "id_co": enc.CoDoc,
            "id_tipo_docto": tipoDoctoSiesa,
            "consec_docto": enc.CONSEC_DOCTO,
            "nro_registro": lineaItem,
            "BODEGA": det.BODEGA || "MG001",
            "id_concepto": det.ID_TIPO_DOCTO === 'P03' ? "502" : "501", // 501=Venta, 502=Devolucion
            "id_motivo": "01", // Fijo solicitado por el equipo (en vez de det.id_motivo)
            "id_co_movto": enc.CoDoc,
            "UNIDAD_MEDIDA": det.UNIDAD_MEDIDA.trim(),
            "CANTIDAD": formatDecimal(det.CANTIDAD, true),
            "VALOR_BRUTO": formatDecimal(det.VALOR_BRUTO),
            "ind_naturaleza": det.ID_TIPO_DOCTO === 'P03' ? 1 : 2,
            "id_item": det.id_item,
            "id_un_movto": "001"
        });

        // Bloque de Impuestos
        if (det.ID_LLAVE_IMPUESTO && det.ID_LLAVE_IMPUESTO !== 'null') {
            // Siesa exige que la tasa y porcentaje pasen normal, pero VLR_UNI en 0
            if (det.VALOR_TOTAL > 0) {
                Impuestos.push({
                    "ID_CO": enc.CoDoc,
                    "TIPO_DOCTO": tipoDoctoSiesa,
                    "CONSEC_DOCTO": enc.CONSEC_DOCTO,
                    "NRO_REGISTRO": lineaItem,
                    "ID_LLAVE_IMPUESTO": det.ID_LLAVE_IMPUESTO,
                    "PORCENTAJE_BASE": formatTasa(det.PORCENTAJE_BASE), 
                    "TASA": formatTasa(det.TASA),
                    "VLR_UNI": formatDecimal(0), // Fijo en 0 como indicaste
                    "VALOR_TOTAL": formatDecimal(det.VALOR_TOTAL) 
                });
            }
        }

        if (det.vlr_tot_dscto > 0) {
            // Siesa exige que el valor unitario del descuento sea mayor a 0. Si el POS envía 0, lo calculamos:
            const vlrUniDscto = (det.vlr_uni_dscto > 0) ? det.vlr_uni_dscto : (det.vlr_tot_dscto / det.CANTIDAD);

            Descuentos.push({
                "id_co": enc.CoDoc,
                "id_tipo_docto": tipoDoctoSiesa,
                "consec_docto": enc.CONSEC_DOCTO,
                "nro_registro": lineaItem,
                "vlr_uni": formatDecimal(vlrUniDscto),
                "vlr_tot": formatDecimal(det.vlr_tot_dscto)
            });
        }
    });

    pagosProcesados.forEach((pago) => {
        Caja.push({
            "ID_CO": enc.CoDoc,
            "ID_TIPO_DOCTO": tipoDoctoSiesa,
            "CONSEC_DOCTO": enc.CONSEC_DOCTO,
            "ID_MEDIOS_PAGO": pago.ID_MEDIOS_PAGO,
            "VLR_MEDIO_PAGO": formatDecimal(pago.neto),
            "NRO_CUENTA": pago.NRO_CUENTA || "",
            "COD_SEGURIDAD": pago.COD_SEGURIDAD || 1,
            "NRO_AUTORIZACION": pago.NRO_AUTORIZACION || "",
            "FECHA_VCTO": formatDate(pago.FECHA_VCTO)
        });
    });

    const payload = {
        "Docto. ventas comercial": Docto_ventas_comercial,
        "Movimientos": Movimientos
    };
    
    // Si los arreglos tienen datos, los agregamos al payload.
    // Si están vacíos, NO los enviamos para evitar errores de validación.
    if (Impuestos.length > 0) payload["Impuestos"] = Impuestos;
    if (Descuentos.length > 0) payload["Descuentos"] = Descuentos;
    if (Caja.length > 0) payload["Caja"] = Caja;

    fs.writeFileSync('factura_generada.json', JSON.stringify(payload, null, 2));
    console.log("💾 JSON generado y guardado en 'factura_generada.json'");

    console.log("🚀 Enviando Factura a Siesa QA...");
    try {
        const response = await axios.post(URL_SIESA_POST, payload, {
            headers: {
                'conniKey': CONNI_KEY,
                'conniToken': CONNI_TOKEN,
                'Content-Type': 'application/json'
            }
        });

        console.log("✅ Respuesta de Siesa:");
        console.log(JSON.stringify(response.data, null, 2));
        return response.data;
    } catch (error) {
        console.error("❌ Error enviando a Siesa:");
        if (error.response) {
            console.error(JSON.stringify(error.response.data, null, 2));
            throw new Error(JSON.stringify(error.response.data));
        } else {
            console.error(error.message);
            throw error;
        }
    }
}

// Exportamos la función en lugar de llamarla directamente
module.exports = { syncVentas };