const axios = require('axios');
const { syncPOS } = require('./syncPOS');
const logger = require('./logger');
require('dotenv').config();

const CIA = process.env.CIA || '7375';

// URLs de Connekta
const URL_VENTAS_DETALLE = `https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=merkahorro_venta_pos_dev`;
const URL_VENTAS_PAGOS = `https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=merkahorro_pagos_pos_dev`;
const URL_VENTAS_IMPUESTOS = `https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=merkahorro_imptos_pos_dev`;
const URL_CAJAS = `https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=merkahorro_cajas_pos_dev`;
const URL_CONSULTA_INVENTARIO_BASE = `https://serviciosqa.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=merkahorro_consulta_inventario`;
const INVENTARIO_TAM_PAGINA = parseInt(process.env.INVENTARIO_TAM_PAGINA || '1000');
const INVENTARIO_MAX_PAGINAS = parseInt(process.env.INVENTARIO_MAX_PAGINAS || '100');

// URL de Siesa QA (POST) - Documento 242756 (FACTURA_DEV)
const URL_SIESA_POST = `https://serviciosqa.siesacloud.com/api/siesa/v3.1/conectoresimportar?idCompania=${CIA}&idSistema=1&idDocumento=242756&nombreDocumento=FACTURA_DEV`;

// URL de Siesa QA (POST) - Documento 241913 (AJUSTE_INVENTARIO_DEV)
const URL_AJUSTE_INVENTARIO = `https://serviciosqa.siesacloud.com/api/siesa/v3.1/conectoresimportar?idCompania=${CIA}&idSistema=1&idDocumento=241913&nombreDocumento=AJUSTE_INVENTARIO_DEV`;

async function fetchFromConnekta(url) {
    try {
        const response = await axios.get(url, {
            headers: {
                'ConniKey': process.env.CONNI_KEY,
                'ConniToken': process.env.CONNI_TOKEN
            }
        });
        
        let data = response.data;
        if (data.detalle && data.detalle.Datos) {
            data = data.detalle.Datos;
        } else if (data.detalle && data.detalle.Table) {
            data = data.detalle.Table;
        } else if (data.Table) {
            data = data.Table;
        }

        console.log(`\n🔍 RESPUESTA DE CONNEKTA PARA: ${url.split('descripcion=')[1]} - STATUS: ${response.data.mensaje}`);

        return Array.isArray(data) ? data : [];
    } catch (error) {
        console.error(`❌ Error consultando a Connekta en ${url}:`, error.message);
        if (error.response) {
            console.error(error.response.data);
        }
        return [];
    }
}

async function fetchInventarioCompleto() {
    // Carga el inventario página por página de forma SECUENCIAL.
    // Connekta de Siesa devuelve 400/ECONNRESET cuando se le piden varias páginas en paralelo,
    // así que vamos despacio pero seguros. Cada página son 1000 registros máx.
    const todas = [];
    let pagina = 1;
    let totalPaginasReales = INVENTARIO_MAX_PAGINAS;
    let reintentosConsecutivos = 0;
    const MAX_REINTENTOS = 3;

    while (pagina <= totalPaginasReales && pagina <= INVENTARIO_MAX_PAGINAS) {
        const url = `${URL_CONSULTA_INVENTARIO_BASE}&paginacion=numPag=${pagina}|tamPag=${INVENTARIO_TAM_PAGINA}`;
        
        try {
            const response = await axios.get(url, {
                headers: { 'ConniKey': process.env.CONNI_KEY, 'ConniToken': process.env.CONNI_TOKEN },
                timeout: 60000
            });
            
            const data = response.data;
            let registros = [];
            if (data.detalle && data.detalle.Datos) {
                registros = data.detalle.Datos;
                // Buscamos total_páginas de forma robusta (la "á" puede causar problemas).
                // Inspeccionamos todas las claves del detalle.
                const detalleKeys = Object.keys(data.detalle);
                if (pagina === 1) {
                    console.log(`   🔎 [debug] Claves de respuesta: ${JSON.stringify(detalleKeys)}`);
                }
                const keyTotalPag = detalleKeys.find(k => k.toLowerCase().includes('total') && k.toLowerCase().includes('gina'));
                if (keyTotalPag && data.detalle[keyTotalPag]) {
                    totalPaginasReales = parseInt(data.detalle[keyTotalPag]);
                    if (pagina === 1) console.log(`   🔎 [debug] total_páginas detectado: ${totalPaginasReales}`);
                }
            } else if (data.detalle && data.detalle.Table) {
                registros = data.detalle.Table;
            } else if (data.Table) {
                registros = data.Table;
            }

            if (!registros || registros.length === 0) {
                console.log(`   📦 Página ${pagina}: vacía, fin.`);
                break;
            }

            todas.push(...registros);
            reintentosConsecutivos = 0;
            
            if (pagina % 5 === 0 || pagina === totalPaginasReales) {
                console.log(`   📦 Página ${pagina}/${totalPaginasReales}: ${registros.length} registros (acumulado=${todas.length})`);
            }
            
            if (registros.length < INVENTARIO_TAM_PAGINA) {
                console.log(`   📦 Página ${pagina}: última (${registros.length} < ${INVENTARIO_TAM_PAGINA}).`);
                break;
            }
            
            pagina++;
        } catch (error) {
            reintentosConsecutivos++;
            console.warn(`⚠️ Error en página ${pagina} (intento ${reintentosConsecutivos}/${MAX_REINTENTOS}): ${error.message}`);
            if (reintentosConsecutivos >= MAX_REINTENTOS) {
                console.error(`❌ Página ${pagina} falló ${MAX_REINTENTOS} veces. Avanzando.`);
                reintentosConsecutivos = 0;
                pagina++;
            } else {
                // Esperar antes de reintentar
                await new Promise(r => setTimeout(r, 1500));
            }
        }
    }

    return todas;
}

async function ajustarInventario(errores, itemsFactura, consecDocto) {
    const fecha = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const baseConsec = parseInt(consecDocto) || 99999;
    const itemsMap = {};
    itemsFactura.forEach(det => { itemsMap[det.id_item] = det; });

    // Consultar inventario para obtener disponibilidad por bodega
    let inventarioDatos = [];
    try {
        console.log("🔍 Consultando inventario en Siesa (merkahorro_consulta_inventario, paginado)...");
        inventarioDatos = await fetchInventarioCompleto();
        console.log(`✅ Inventario cargado: ${inventarioDatos.length} registros totales`);
    } catch (e) {
        console.warn("⚠️ No se pudo obtener el inventario.");
    }
    const inventarioMap = {};
    inventarioDatos.forEach(inv => {
        const itemId = inv.iditem || inv.IdItem || inv.id_item;
        if (itemId) {
            const itemStr = itemId.toString();
            const bodegaVal = inv.idbodega || inv.IdBodega;
            const bodegaStr = bodegaVal ? bodegaVal.toString().trim() : 'DEFAULT';
            const cantDisp = inv.CantidadDisponible !== undefined ? parseFloat(inv.CantidadDisponible) : (inv.Cantidad !== undefined ? parseFloat(inv.Cantidad) : 0);
            
            if (!inventarioMap[itemStr]) inventarioMap[itemStr] = {};
            inventarioMap[itemStr][bodegaStr] = {
                disponible: cantDisp,
                costo: parseFloat(inv.CostoProm || inv.costoprom || inv.Costo_Promedio || 0)
            };
        }
    });

    const movimientos = [];
    const bodegas = new Set();
    let nroRegistro = 0;

    errores.forEach(err => {
        const match = err.f_valor && err.f_valor.match(/Item:(\d+)Bodega:(\w+)/);
        const faltanteMatch = err.f_detalle && err.f_detalle.match(/Faltante Inv\.:\s*(-?[\d.]+)/);
        if (!match) return;

        const bodega = match[2];
        bodegas.add(bodega);

        // El error de Siesa reporta el f_valor en el formato "Item:00050645064Bodega:PV001"
        // Siesa concatena el ID rellenado a 7 ceros con el ID otra vez (ej: 0005064 + 5064).
        // Tomaremos los primeros 7 caracteres de los dígitos del item.
        const errorIdStr = match[1].substring(0, 7).replace(/^0+/, '');
        
        let idItem = null;
        if (itemsMap[errorIdStr] || itemsMap[parseInt(errorIdStr)]) {
            idItem = parseInt(errorIdStr);
        } else {
            // Fallback por si la estructura cambia
            const connektaIds = Object.keys(itemsMap).sort((a, b) => b.length - a.length);
            for (const cid of connektaIds) {
                const cidStr = String(cid);
                if (match[1].replace(/^0+/, '').includes(cidStr)) {
                    idItem = parseInt(cid);
                    break;
                }
            }
        }
        console.log(`🔎 [CPE] Error Siesa item raw: ${match[1]}, errorIdStr: ${errorIdStr}, itemsMap keys (top 5): ${Object.keys(itemsMap).slice(0,5).join(',')}`);
        console.log(`🔎 [CPE] Match test - itemsMap["${errorIdStr}"]=${itemsMap[errorIdStr]!==undefined}, itemsMap[${parseInt(errorIdStr)}]=${itemsMap[parseInt(errorIdStr)]!==undefined}`);
        console.log(`Procesando error item Siesa: ${match[1]}, encontrado idItem Connekta: ${idItem}`);
        if (!idItem) {
            console.warn(`⚠️ No se pudo mapear el item ${errorIdStr} a un id_item de Connekta.`);
            return;
        }

        // Saltar items cuyo ID exceda 7 caracteres (límite del campo ITEM en Siesa)
        const idItemStr = String(idItem);
        if (idItemStr.length > 7) {
            console.warn(`⚠️ Item ${idItem} excede 7 caracteres, se omite del ajuste de inventario.`);
            return;
        }

        nroRegistro++;
        const faltante = faltanteMatch ? Math.abs(parseFloat(faltanteMatch[1])) : 10;
        const det = itemsMap[idItem];
        const unidad = det ? det.UNIDAD_MEDIDA.trim() : "UND";

        // Buscar costo real desde inventarioMap (CostoProm de merkahorro_consulta_inventario)
        let costo = 0;
        if (inventarioMap[idItemStr]) {
            const bodegasDisponibles = Object.keys(inventarioMap[idItemStr]);
            const bodegasPrioritarias = [bodega, 'PV001', '00301', '00201', '00701'];
            const ordenBusqueda = [...new Set([...bodegasPrioritarias, ...bodegasDisponibles])];
            for (const bod of ordenBusqueda) {
                const entry = inventarioMap[idItemStr][bod];
                if (entry && entry.costo > 0) {
                    costo = entry.costo;
                    console.log(`💰 Costo item ${idItemStr} bodega ${bod}: ${costo}`);
                    break;
                }
            }
        }

        if (!costo || costo <= 0) {
            console.warn(`⚠️ Sin costo real para item ${idItemStr}. Se omite del ajuste de inventario.`);
            return;
        }

        const inyectar = faltanteMatch ? Math.abs(parseFloat(faltanteMatch[1])) : 10;
        const inyectarFinal = unidad === 'UND' ? Math.ceil(inyectar) : inyectar;
        const costoFinal = Math.round(Math.max(costo, 1));

        movimientos.push({
            "C.O.": "001",
            "f470_id_tipo_docto": "CPE",
            "f470_consec_docto": 0,
            "f470_nro_registro": nroRegistro,
            "BODEGA": bodega,
            "f470_id_concepto": 601,
            "f470_id_motivo": "03",
            "ind_naturaleza": 1,
            "C.O MOVIMIENTO": "001",
            "UNIDAD_MEDIDA": unidad,
            "CANTIDAD": formatDecimal(inyectarFinal, true),
            "ITEM": idItemStr.padStart(7, '0'),
            "UNIDAD_NEGOCIO": "001",
            "COSTO_PROMEDIO": formatDecimal(costoFinal)
        });
    });

    if (movimientos.length === 0) return;

    const payload = {
        "Documentos": [{
            "f350_id_co": "001",
            "f350_id_tipo_docto": "CPE",
            "f350_id_clase_docto": 61,
            "f450_id_concepto": 601,
            "f350_consec_docto": "0",
            "FECHA_DOCTO": fecha,
            "BODEGA": [...bodegas][0]
        }],
        "Movimientos": movimientos
    };

    console.log("📦 Inyectando inventario automáticamente...");
    try {
        const response = await axios.post(URL_AJUSTE_INVENTARIO, payload, {
            headers: {
                'ConniKey': process.env.CONNI_KEY,
                'ConniToken': process.env.CONNI_TOKEN,
                'Content-Type': 'application/json'
            }
        });
        console.log(`✅ Inventario inyectado: ${response.data.mensaje}`);
    } catch (error) {
        console.error("❌ Error en ajuste de inventario:");
        if (error.response) {
            console.error("[AJUSTE] Status:", error.response.status);
            console.error("[AJUSTE] Payload enviado:", JSON.stringify(payload, null, 2));
            console.error("[AJUSTE] Respuesta Siesa:", JSON.stringify(error.response.data, null, 2));
        } else if (error.request) {
            console.error("[AJUSTE] Sin respuesta del servidor (timeout/red).");
            console.error("[AJUSTE] Code:", error.code, "Message:", error.message);
        } else {
            console.error("[AJUSTE] Error JS:", error.message);
            console.error(error.stack);
        }
        throw error;
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

function formatNegCantidad(valor) {
    const absStr = Math.abs(valor).toFixed(4);
    const parts = absStr.split('.');
    const intPart = parts[0].padStart(14, '0');
    return '-' + intPart + '.' + parts[1];
}

function formatTasa(number) {
    if (number === null || number === undefined) return "000.0000";
    return parseFloat(number).toFixed(4).padStart(8, '0');
}

async function ejecutarPaso(pasoActual, consecsOverride = null) {
    console.log("==========================================");
    console.log("🚀 Iniciando Sincronización de Ventas POS");
    console.log("==========================================");

    const detalles = await fetchFromConnekta(URL_VENTAS_DETALLE);
    const pagosRaw = await fetchFromConnekta(URL_VENTAS_PAGOS);
    const impuestosRaw = await fetchFromConnekta(URL_VENTAS_IMPUESTOS);
    const cajasRaw = await fetchFromConnekta(URL_CAJAS);

    if (detalles.length === 0) {
        console.log("⚠️ No hay facturas para sincronizar. (Query vacío)");
        return;
    }

    // MAPEO DE CAJAS POR CO
    const cajaPorCo = {};
    if (cajasRaw && cajasRaw.length > 0) {
        cajasRaw.forEach(c => {
            const co = c.f291_id_co ? c.f291_id_co.toString().trim() : '001';
            const idCaja = c.f291_id ? c.f291_id.toString().trim() : '001';
            if (!cajaPorCo[co]) cajaPorCo[co] = idCaja;
        });
    }

    // AGRUPAR POR FACTURA Y CRUZAR DATOS
    const facturas = {};
    detalles.forEach(det => {
        const consec = det.CONSEC_DOCTO;
        if (!facturas[consec]) facturas[consec] = { items: [], pagos: [] };
        facturas[consec].items.push(det);
    });

    pagosRaw.forEach(p => {
        const consec = p.CONSEC_DOCTO;
        if (facturas[consec]) facturas[consec].pagos.push(p);
    });

    // Mapear impuestos por RowidMvto para búsqueda rápida
    const impuestosPorRowid = {};
    impuestosRaw.forEach(imp => {
        if (imp.ID_LLAVE_IMPUESTO && imp.ID_LLAVE_IMPUESTO !== 'null' && imp.VALOR_TOTAL > 0) {
            if (!impuestosPorRowid[imp.RowidMvto]) impuestosPorRowid[imp.RowidMvto] = [];
            impuestosPorRowid[imp.RowidMvto].push(imp);
        }
    });

    // ORDENAR FACTURAS: dentro de cada paso, las más recientes primero
    // (sort DESC por consec; el orden CFE/CNC entre pasos lo controla el caller)
    const todasLasFacturas = Object.keys(facturas).sort((a, b) => parseInt(b) - parseInt(a));

    // APLICAR FILTRO POR CONSECS ESPECÍFICOS.
    // Prioridad: 1) parámetro `consecsOverride` (vía HTTP), 2) variable de entorno CONSEC_ESPECIFICOS.
    // Útil para reprocesar facturas puntuales sin depender del rango de fechas.
    const consecsEnv = (process.env.CONSEC_ESPECIFICOS || '').trim();
    const consecsActivos = Array.isArray(consecsOverride) && consecsOverride.length > 0
        ? consecsOverride.map(c => String(c).trim()).filter(Boolean).join(',')
        : consecsEnv;
    let facturasFiltradas = todasLasFacturas;
    let modoEspecificos = false;
    if (consecsActivos.length > 0) {
        const lista = consecsActivos.split(',').map(c => c.trim()).filter(Boolean);
        const setConsecs = new Set(lista);
        facturasFiltradas = todasLasFacturas.filter(c => setConsecs.has(String(c)));
        modoEspecificos = true;

        // Avisar si alguno solicitado no se encontró en el pool de Connekta.
        const encontrados = new Set(facturasFiltradas);
        const faltantes = lista.filter(c => !encontrados.has(c));
        if (pasoActual === 3 && faltantes.length > 0) {
            console.warn(`⚠️ Consecs solicitados que NO están en el rango de Connekta: ${faltantes.join(', ')}`);
        }
    }

    // APLICAR LÍMITE de facturas a procesar (solo en modo normal; en modo específicos respetamos la lista exacta).
    const LIMITE = parseInt(process.env.LIMITE_FACTURAS || '1');
    const facturasOrdenadas = modoEspecificos ? facturasFiltradas : facturasFiltradas.slice(0, LIMITE);

    // MOSTRAR LISTADO DE FACTURAS DETECTADAS (solo en el primer paso para no duplicar log)
    if (pasoActual === 3) {
        const modoLabel = modoEspecificos
            ? `modo CONSEC_ESPECIFICOS: ${facturasOrdenadas.length} consec(s) puntuales`
            : `procesando ${facturasOrdenadas.length} de ${todasLasFacturas.length} disponibles`;
        console.log("\n==========================================");
        console.log(`📋 FACTURAS DETECTADAS (${modoLabel})`);
        console.log("==========================================");
        facturasOrdenadas.forEach((c, i) => {
            const f = facturas[c];
            const e = f.items[0];
            const fecha = e.FECHA_DOCTO ? e.FECHA_DOCTO.split('T')[0] : 'N/A';
            console.log(`  ${i + 1}. Consec ${c} | Fecha ${fecha} | Tipo ${e.ID_TIPO_DOCTO} | Cliente: ${e.NitTercero} | Items: ${f.items.length} | Neto: $${e.VrNetoDocto}`);
        });
        console.log("==========================================\n");
    }

    // Genera el payload completo para UNA SOLA factura (devuelve objeto listo para POST a Siesa).
    const generarPayloadDocumento = (fac, enc, tipoDocumentoSimulado) => {
        // Arrays LOCALES a esta factura - cada factura genera su propio payload independiente.
        const Docto_ventas_comercial = [];
        const Movimientos = [];
        const Impuestos = [];
        const Descuentos = [];
        const Caja = [];

        const esSimulacionCNC = (tipoDocumentoSimulado === 'CNC');
        const tipoDoctoSiesa = esSimulacionCNC ? 'CNC' : (enc.ID_TIPO_DOCTO === 'P03' ? 'CNC' : 'CFE');
        // Para diferenciar las consecuciones y que Siesa no se confunda, a la simulacion le ponemos el mismo consecutivo
        // Ya que ID_TIPO_DOCTO es distinto, Siesa las agrupa por separado.
        const consecDoc = enc.CONSEC_DOCTO; 

        Docto_ventas_comercial.push({
            "ID_CO": enc.CoDoc,
            "ID_TIPO_DOCTO": tipoDoctoSiesa,
            "CONSEC_DOCTO": consecDoc,
            "FECHA_DOCTO": formatDate(enc.FECHA_DOCTO),
            "ID_TERCERO": enc.NitTercero,
            "ID_CLASE_DOCTO": esSimulacionCNC ? 525 : (enc.ID_TIPO_DOCTO === 'P03' ? 525 : 522),
            "SUCURSAL_CLIENTE": "001",
            "id_co_fact": enc.CoDoc,
            "TERCERO_REM": enc.NitTercero,
            "F_CONSEC_AUTO_REG": "1",
            "id_cond_pago": enc.id_cond_pago ? enc.id_cond_pago.toString().trim().padStart(3, '0') : "000",
            "id_caja": (cajaPorCo[enc.CoDoc.trim()] || (enc.CoDoc.trim() === "003" ? "03 " : enc.CoDoc.trim().padStart(3, '0'))).padEnd(3, ' ')
        });

        fac.items.forEach((det, index) => {
            const lineaItem = index + 1;

            Movimientos.push({
                "id_co": enc.CoDoc,
                "id_tipo_docto": tipoDoctoSiesa,
                "consec_docto": consecDoc,
                "nro_registro": lineaItem,
                "BODEGA": det.BODEGA || "MG001",
                "id_concepto": esSimulacionCNC ? 502 : (({"1201": 501, "1202": 502}[det.Concepto]) || (det.ID_TIPO_DOCTO === 'P03' ? 502 : 501)),
                "id_motivo": "01",
                "ind_naturaleza": esSimulacionCNC ? 1 : (det.ID_TIPO_DOCTO === 'P03' ? 1 : 2),
                "id_co_movto": enc.CoDoc,
                "UNIDAD_MEDIDA": det.UNIDAD_MEDIDA ? det.UNIDAD_MEDIDA.trim() : "UND",
                "CANTIDAD": formatDecimal(det.CANTIDAD || det.cant_1, true),
                "VALOR_BRUTO": formatDecimal(det.VALOR_BRUTO),
                "id_item": det.id_item,
                "id_un_movto": "001"
            });

            // CRUCE DE IMPUESTOS POR ROWIDMVTO
            const imptosItem = impuestosPorRowid[det.RowidMvto] || [];
            imptosItem.forEach(imp => {
                Impuestos.push({
                    "ID_CO": enc.CoDoc,
                    "TIPO_DOCTO": tipoDoctoSiesa,
                    "CONSEC_DOCTO": consecDoc,
                    "NRO_REGISTRO": lineaItem,
                    "ID_LLAVE_IMPUESTO": imp.ID_LLAVE_IMPUESTO,
                    "PORCENTAJE_BASE": formatTasa(imp.PORCENTAJE_BASE), 
                    "TASA": formatTasa(imp.TASA),
                    "VLR_UNI": formatDecimal(0),
                    "VALOR_TOTAL": formatDecimal(imp.VALOR_TOTAL) 
                });
            });

            // DESCUENTOS
            if (det.vlr_tot_dscto > 0) {
                const totalDescuentoItem = det.vlr_tot_dscto;
                const vlrUniDscto = (det.vlr_uni_dscto > 0) ? det.vlr_uni_dscto : (totalDescuentoItem / (det.CANTIDAD || det.cant_1 || 1));
                
                Descuentos.push({
                    "id_co": enc.CoDoc,
                    "id_tipo_docto": tipoDoctoSiesa,
                    "consec_docto": consecDoc,
                    "nro_registro": lineaItem,
                    "vlr_uni": formatDecimal(vlrUniDscto),
                    "vlr_tot": formatDecimal(totalDescuentoItem)
                });
            }
        });

        // PROCESAR PAGOS DE ESTA FACTURA
        const cajaConsolidada = {};
        fac.pagos.forEach(p => {
            if (!cajaConsolidada[p.ID_MEDIOS_PAGO]) {
                cajaConsolidada[p.ID_MEDIOS_PAGO] = { ...p, neto: 0 };
            }
            cajaConsolidada[p.ID_MEDIOS_PAGO].neto += (p.VLR_MEDIO_PAGO_INGRESO || 0) - (p.VLR_MEDIO_PAGO_EGRESO || 0);
        });

                                // PATCH RECALCULO IMPUESTOS: recalculamos cada impuesto sobre la base neta
        // (VALOR_BRUTO - descuento de la línea) aplicando su TASA. Mantenemos los decimales
        // sin redondear por línea para que la sumatoria total cuadre al peso con lo que
        // calcula Siesa internamente. ICO con tasa 0 sale en 0 naturalmente; si tuviera
        // tasa > 0 también se calcula. Líneas sin impuesto (TASA null) se ignoran.
        Impuestos.forEach(i => {
            if (i.CONSEC_DOCTO === consecDoc && i.TIPO_DOCTO === tipoDoctoSiesa) {
                const m = Movimientos.find(x => x.nro_registro === i.NRO_REGISTRO && x.consec_docto === consecDoc && x.id_tipo_docto === tipoDoctoSiesa);
                if (m && i.TASA !== null && i.TASA !== undefined) {
                    const dscLinea = Descuentos.find(d => d.consec_docto === consecDoc && d.id_tipo_docto === tipoDoctoSiesa && d.nro_registro === i.NRO_REGISTRO);
                    const dsctoVal = dscLinea ? parseFloat(dscLinea.vlr_tot || 0) : 0;
                    const baseNeta = parseFloat(m.VALOR_BRUTO) - dsctoVal;
                    const tasa = parseFloat(i.TASA);
                    // Calcular con todos los decimales; formatDecimal recortará a 4 al serializar.
                    const valorImpuesto = baseNeta * tasa / 100;
                    i.VALOR_TOTAL = formatDecimal(valorImpuesto);
                }
            }
        });

        // PASO 2: Calcular el total REAL que se está enviando en el JSON (bruto - descuentos + impuestos)
        // usando el VALOR_TOTAL ya sobreescrito, y compararlo contra la caja para detectar el descuadre real.
        let siesaBruto = 0, siesaImp = 0, siesaDscto = 0, posCaja = 0;
        
        Movimientos.filter(m => m.consec_docto === consecDoc && m.id_tipo_docto === tipoDoctoSiesa).forEach(d => {
            siesaBruto += parseFloat(d.VALOR_BRUTO||0);
        });
        
        Impuestos.forEach(i => {
            if(i.CONSEC_DOCTO === consecDoc && i.TIPO_DOCTO === tipoDoctoSiesa) {
                siesaImp += parseFloat(i.VALOR_TOTAL||0);
            }
        });

        Descuentos.forEach(d => {
            if (d.consec_docto === consecDoc && d.id_tipo_docto === tipoDoctoSiesa) {
                siesaDscto += parseFloat(d.vlr_tot || 0);
            }
        });
        
        Object.values(cajaConsolidada).filter(p => p.neto > 0).forEach(p => posCaja += p.neto);
        
        // Total Siesa = bruto - descuentos + impuestos (igual al pie de la factura en el ERP).
        // Con los impuestos del POS sin tocar, totalSiesa debería coincidir con posCaja al peso.
        // Si por cualquier razón aparece un descuadre pequeño (<=5 pesos), se ajusta sobre el
        // EFE original (solo restas - sumas positivas como línea adicional). Mayor -> warning.
        const totalSiesa = siesaBruto - siesaDscto + siesaImp;
        let dif = Math.round(totalSiesa - posCaja);

        let ajusteEfeExtra = null;
        if (Math.abs(dif) > 0 && Math.abs(dif) <= 5) {
            if (dif > 0) {
                ajusteEfeExtra = dif;
                console.log(`💰 AJUSTE CAJA [${tipoDoctoSiesa}] consec ${consecDoc}: +${dif} pesos en línea EFE de ajuste (independiente). Total ${totalSiesa} vs Caja ${posCaja}.`);
            } else {
                // dif < 0: caja paga más que el total -> restar del medio de pago.
                // Preferir EFE; si no hay, usar el primer medio de pago disponible.
                if (cajaConsolidada["EFE"]) {
                    cajaConsolidada["EFE"].neto += dif;
                    console.log(`💰 AJUSTE CAJA [${tipoDoctoSiesa}] consec ${consecDoc}: ${dif} pesos restados del EFE original. Total ${totalSiesa} vs Caja ${posCaja}.`);
                } else {
                    const medios = Object.values(cajaConsolidada).filter(p => p.neto > 0);
                    if (medios.length > 0) {
                        medios[0].neto += dif;
                        console.log(`💰 AJUSTE CAJA [${tipoDoctoSiesa}] consec ${consecDoc}: ${dif} pesos restados del medio de pago ${medios[0].ID_MEDIOS_PAGO} (no había EFE). Total ${totalSiesa} vs Caja ${posCaja}.`);
                    } else {
                        console.warn(`⚠️ Descuadre negativo (${dif}) en ${tipoDoctoSiesa} consec ${consecDoc} pero no hay medios de pago para ajustar.`);
                    }
                }
            }
        } else if (Math.abs(dif) > 5) {
            console.warn(`⚠️ Descuadre superior a la tolerancia (${dif} pesos) en ${tipoDoctoSiesa} consec ${consecDoc}. Total Siesa ${totalSiesa} vs Caja ${posCaja}. No se aplica ajuste automático.`);
        } else {
            console.log(`✅ Cuadre exacto [${tipoDoctoSiesa}] consec ${consecDoc}: Total ${totalSiesa} = Caja ${posCaja}.`);
        }

        Object.values(cajaConsolidada).filter(p => p.neto > 0).forEach(pago => {
            Caja.push({
                "ID_CO": enc.CoDoc,
                "ID_TIPO_DOCTO": tipoDoctoSiesa,
                "CONSEC_DOCTO": consecDoc,
                "ID_MEDIOS_PAGO": esSimulacionCNC ? "EFE" : pago.ID_MEDIOS_PAGO,
                "VLR_MEDIO_PAGO": formatDecimal(pago.neto),
                "NRO_CUENTA": pago.NRO_CUENTA || "1",
                "NRO_CHEQUE": "1",
                "REFERENCIA": "1",
                "COD_SEGURIDAD": pago.COD_SEGURIDAD || 1,
                "NRO_AUTORIZACION": pago.NRO_AUTORIZACION || "1",
                "FECHA_VCTO": formatDate(pago.FECHA_VCTO)
            });
        });

        // Línea EFE independiente para absorber el redondeo de impuestos de Siesa.
        // Solo se crea cuando dif > 0 (Siesa espera más que la caja del POS).
        // CRÍTICO: debe replicar EXACTAMENTE el formato de la línea EFE original (FECHA_VCTO, etc.)
        // para que Siesa la consolide al medio de pago y no la deje "por aplicar".
        if (ajusteEfeExtra !== null && ajusteEfeExtra > 0) {
            const plantillaEfe = cajaConsolidada["EFE"];
            const fechaVcto = plantillaEfe ? formatDate(plantillaEfe.FECHA_VCTO) : formatDate(enc.FECHA);
            Caja.push({
                "ID_CO": enc.CoDoc,
                "ID_TIPO_DOCTO": tipoDoctoSiesa,
                "CONSEC_DOCTO": consecDoc,
                "ID_MEDIOS_PAGO": "EFE",
                "VLR_MEDIO_PAGO": formatDecimal(ajusteEfeExtra),
                "NRO_CUENTA": plantillaEfe?.NRO_CUENTA || "1",
                "NRO_CHEQUE": "1",
                "REFERENCIA": "1",
                "COD_SEGURIDAD": plantillaEfe?.COD_SEGURIDAD || 1,
                "NRO_AUTORIZACION": plantillaEfe?.NRO_AUTORIZACION || "1",
                "FECHA_VCTO": fechaVcto
            });
        }

        // Armar y devolver el payload aislado de ESTA factura.
        const payload = {
            "Docto. ventas comercial": Docto_ventas_comercial,
            "Movimientos": Movimientos
        };
        if (Impuestos.length > 0) payload["Impuestos"] = Impuestos;
        if (Descuentos.length > 0) payload["Descuentos"] = Descuentos;
        if (Caja.length > 0) payload["Caja"] = Caja;
        return payload;
    };

    // Función que envía 1 factura a Siesa con reintento automático ante cliente/inventario faltante.
    const enviarFacturaASiesa = async (consecutivo, payload, detallesFactura, tipoDoctoSiesa, meta) => {
        const automatizaciones = [];
        const registrar = async (resultado) => {
            await logger.registrarResultado(resultado, { ...meta, automatizaciones });
            return resultado;
        };
        try {
            const responseSiesa = await axios.post(URL_SIESA_POST, payload, {
                headers: {
                    'ConniKey': process.env.CONNI_KEY,
                    'ConniToken': process.env.CONNI_TOKEN,
                    'Content-Type': 'application/json'
                }
            });

            return await registrar({ consecutivo, tipo: tipoDoctoSiesa, ok: true, mensaje: responseSiesa.data.mensaje || 'OK' });
        } catch (error) {
            if (error.response && error.response.data && error.response.data.detalle) {
                const errores = error.response.data.detalle;
                const faltaCliente = Array.isArray(errores) && errores.some(e => e.f_detalle && (
                    e.f_detalle.toLowerCase().includes('cliente no existe') ||
                    e.f_detalle.toLowerCase().includes('sucursal del cliente') ||
                    e.f_detalle.toLowerCase().includes('sucursal de la')
                ));
                const faltaInventario = Array.isArray(errores) && errores.some(e => e.f_detalle && e.f_detalle.includes('Item sin cantidad disponible'));

                if (faltaCliente) {
                    console.log(`⚠️ [${tipoDoctoSiesa} ${consecutivo}] Cliente no existe en Siesa. Ejecutando syncPOS()...`);
                    // Extraer los NITs específicos que Siesa reportó como faltantes.
                    // Siesa devuelve el NIT en el campo `f_valor` (ej. "42683051"),
                    // mientras que `f_detalle` solo contiene el mensaje genérico
                    // "Documento venta comercial: El cliente no existe.".
                    const nitsFaltantes = [...new Set(
                        errores
                            .filter(e => e.f_detalle && (
                                e.f_detalle.toLowerCase().includes('cliente no existe') ||
                                e.f_detalle.toLowerCase().includes('sucursal del cliente') ||
                                e.f_detalle.toLowerCase().includes('sucursal de la')
                            ))
                            .map(e => {
                                // f_valor puede venir como "42683051" o "42683051-001" (NIT-sucursal).
                                // Nos quedamos solo con el NIT base (antes del primer guión).
                                const raw = String(e.f_valor || '').trim();
                                if (!raw) return null;
                                return raw.split('-')[0].trim();
                            })
                            .filter(Boolean)
                    )];
                    console.log(`🎯 [${tipoDoctoSiesa} ${consecutivo}] NIT(s) faltante(s) detectado(s): ${nitsFaltantes.join(', ') || '(ninguno extraído)'}`);
                    automatizaciones.push(`sync_cliente:${nitsFaltantes.join(',') || 'all'}`);
                    try { await syncPOS(nitsFaltantes.length > 0 ? nitsFaltantes : null); } catch (syncError) {
                        console.error(`❌ [${tipoDoctoSiesa} ${consecutivo}] Error en syncPOS:`, syncError.message);
                    }
                }
                if (faltaInventario) {
                    console.log(`⚠️ [${tipoDoctoSiesa} ${consecutivo}] Inventario insuficiente. Inyectando stock...`);
                    automatizaciones.push(`ajuste_inventario:${consecutivo}`);
                    try {
                        const consecAjuste = parseInt(Date.now().toString().slice(-7));
                        await ajustarInventario(errores, detallesFactura, consecAjuste);
                    } catch (ajusteError) {
                        console.error(`❌ [${tipoDoctoSiesa} ${consecutivo}] Error en ajuste de inventario:`, ajusteError.message);
                    }
                }

                if (faltaCliente || faltaInventario) {
                    console.log(`🔁 [${tipoDoctoSiesa} ${consecutivo}] Reintentando envío...`);
                    try {
                        const retryResponse = await axios.post(URL_SIESA_POST, payload, {
                            headers: {
                                'ConniKey': process.env.CONNI_KEY,
                                'ConniToken': process.env.CONNI_TOKEN,
                                'Content-Type': 'application/json'
                            }
                        });
                        return await registrar({ consecutivo, tipo: tipoDoctoSiesa, ok: true, mensaje: (retryResponse.data.mensaje || 'OK') + ' (tras automatización)' });
                    } catch (retryError) {
                        const detalle = retryError.response?.data ? JSON.stringify(retryError.response.data) : retryError.message;
                        return await registrar({ consecutivo, tipo: tipoDoctoSiesa, ok: false, mensaje: `Reintento falló: ${detalle}` });
                    }
                }
                return await registrar({ consecutivo, tipo: tipoDoctoSiesa, ok: false, mensaje: JSON.stringify(error.response.data) });
            }
            return await registrar({ consecutivo, tipo: tipoDoctoSiesa, ok: false, mensaje: error.message });
        }
    };

    // Construir la lista de tareas (1 por factura aplicable a este paso).
    // Aplica idempotencia: si una factura YA está como OK en Supabase
    // (para este tipo CFE/CNC), se omite silenciosamente. Las que están en FALLO sí se reintentan.
    const consecsExitosos = await logger.obtenerConsecsExitosos();
    const omitidas = [];
    const tareas = [];
    facturasOrdenadas.forEach(consecutivo => {
        const fac = facturas[consecutivo];
        const enc = fac.items[0];
        const meta = {
            fecha_factura: enc.FECHA_DOCTO ? enc.FECHA_DOCTO.split('T')[0] : null,
            cliente_nit: enc.NitTercero,
            items: fac.items.length,
            neto: enc.VrNetoDocto
        };

        if (pasoActual === 1) {
            // CNC: la simulación CNC corre para TODAS (las P01 también se simulan como CNC).
            const tipoDocto = 'CNC';
            if (consecsExitosos.has(`${tipoDocto}:${consecutivo}`)) {
                omitidas.push(`${tipoDocto} ${consecutivo}`);
                return;
            }
            const payload = generarPayloadDocumento(fac, enc, 'CNC');
            tareas.push({ consecutivo, payload, detalles: fac.items, tipo: tipoDocto, meta });
        } else if (pasoActual === 3) {
            // CFE: solo facturas P01 (no P03).
            if (enc.ID_TIPO_DOCTO !== 'P03') {
                if (consecsExitosos.has(`CFE:${consecutivo}`)) {
                    omitidas.push(`CFE ${consecutivo}`);
                    return;
                }
                const payload = generarPayloadDocumento(fac, enc, 'CFE');
                tareas.push({ consecutivo, payload, detalles: fac.items, tipo: 'CFE', meta });
            }
        }
    });

    if (omitidas.length > 0) {
        console.log(`⏭️ Omitidas por idempotencia (ya procesadas OK): ${omitidas.length} -> ${omitidas.join(', ')}`);
    }

    if (tareas.length === 0) {
        console.log(`ℹ️ Paso ${pasoActual === 3 ? 'CFE' : 'CNC'}: no hay facturas aplicables.`);
        return [];
    }

    // Se omite respaldo local (ahora todo se persiste en Supabase via logger.js)

    // Procesar con pool de concurrencia configurable.
    const CONCURRENCIA = Math.max(1, parseInt(process.env.CONCURRENCIA || '2'));
    console.log(`\n🚀 Enviando ${tareas.length} factura(s) al paso ${pasoActual === 3 ? 'CFE' : 'CNC'} con concurrencia=${CONCURRENCIA}...`);

    const resultados = [];
    for (let i = 0; i < tareas.length; i += CONCURRENCIA) {
        const lote = tareas.slice(i, i + CONCURRENCIA);
        const resLote = await Promise.allSettled(
            lote.map(t => enviarFacturaASiesa(t.consecutivo, t.payload, t.detalles, t.tipo, t.meta))
        );
        for (let idx = 0; idx < resLote.length; idx++) {
            const r = resLote[idx];
            if (r.status === 'fulfilled') {
                resultados.push(r.value);
                const icon = r.value.ok ? '✅' : '❌';
                console.log(`${icon} [${r.value.tipo} ${r.value.consecutivo}] ${r.value.mensaje}`);
            } else {
                const t = lote[idx];
                const fallo = { consecutivo: t.consecutivo, tipo: t.tipo, ok: false, mensaje: r.reason?.message || 'Error desconocido' };
                await logger.registrarResultado(fallo, t.meta);
                resultados.push(fallo);
                console.log(`❌ [${t.tipo} ${t.consecutivo}] ${r.reason?.message || 'Error desconocido'}`);
            }
        }
    }

    return resultados;
}

module.exports = { syncVentas: async (opciones = {}) => {
    // opciones.consecs: array opcional de consecs específicos para reprocesar.
    // Si se pasa, ignora LIMITE_FACTURAS y CONSEC_ESPECIFICOS del .env.
    const consecsOverride = Array.isArray(opciones.consecs) ? opciones.consecs : null;

    // opciones.limite: sobrescribe LIMITE_FACTURAS solo para esta corrida.
    // Útil para que el dashboard pida "procesar las próximas N facturas".
    // Se restablece al valor original al terminar (incluso si hay error).
    const limiteOverride = Number.isFinite(Number(opciones.limite)) && Number(opciones.limite) > 0
        ? String(parseInt(opciones.limite, 10))
        : null;
    const limiteOriginal = process.env.LIMITE_FACTURAS;
    if (limiteOverride) {
        process.env.LIMITE_FACTURAS = limiteOverride;
        console.log(`🎛️  Override LIMITE_FACTURAS=${limiteOverride} (solo esta corrida)`);
    }

    // Si el dashboard pidió un "limite" (modo cantidad) o no pasó consecs explícitos,
    // ignoramos CONSEC_ESPECIFICOS del .env para esta corrida. Así el .env deja de
    // "secuestrar" las corridas normales. Se restaura en el finally.
    const consecEnvOriginal = process.env.CONSEC_ESPECIFICOS;
    const ignorarConsecEnv = limiteOverride !== null || !consecsOverride;
    if (ignorarConsecEnv && consecEnvOriginal) {
        process.env.CONSEC_ESPECIFICOS = '';
        console.log(`🎛️  CONSEC_ESPECIFICOS del .env ignorado (solo esta corrida)`);
    }
    try {

    // Orden nuevo: primero CFE (facturas), después CNC (notas crédito).
    // Esto evita que las CNC devuelvan stock antes de tiempo y que el
    // ajuste de inventario tenga que pelearse contra movimientos de entrada
    // posteriores en el mismo lote.
    const resCFE = (await ejecutarPaso(3, consecsOverride)) || []; // CFE - Facturas de venta
    const resCNC = (await ejecutarPaso(1, consecsOverride)) || []; // CNC - Notas crédito

    const todos = [...resCFE, ...resCNC];
    const okCount = todos.filter(r => r.ok).length;
    const failCount = todos.length - okCount;

    console.log("\n==========================================");
    console.log("📊 RESUMEN FINAL");
    console.log("==========================================");
    console.log(`Total procesadas: ${todos.length}  |  ✅ OK: ${okCount}  |  ❌ Fallidas: ${failCount}`);
    todos.forEach(r => {
        const icon = r.ok ? '✅' : '❌';
        const msg = r.mensaje && r.mensaje.length > 150 ? r.mensaje.slice(0, 150) + '...' : r.mensaje;
        console.log(`  ${icon} [${r.tipo} ${r.consecutivo}] ${msg}`);
    });
    console.log("==========================================\n");

    // Snapshot de la corrida y reporte de maestras faltantes (Siesa contable/inventario).
    try {
        const idCorrida = await logger.guardarCorrida({
            total: todos.length,
            ok: okCount,
            fail: failCount,
            detalle: todos
        });
        await logger.generarReporteMaestras();
        console.log(`📝 Logs actualizados en Supabase:`);
        console.log(`   - Corrida ID: ${idCorrida}`);
        console.log(`   - Histórico de facturas actualizado`);
        console.log(`   - Maestras Siesa faltantes sincronizadas\n`);
    } catch (e) {
        console.warn(`⚠️ Error guardando logs: ${e.message}`);
    }

    return { total: todos.length, ok: okCount, fail: failCount, detalle: todos };
    } finally {
        // Restaurar LIMITE_FACTURAS al valor original aunque haya habido error.
        if (limiteOverride) {
            if (limiteOriginal === undefined) delete process.env.LIMITE_FACTURAS;
            else process.env.LIMITE_FACTURAS = limiteOriginal;
        }
        // Restaurar CONSEC_ESPECIFICOS al valor original.
        if (ignorarConsecEnv && consecEnvOriginal) {
            process.env.CONSEC_ESPECIFICOS = consecEnvOriginal;
        }
    }
}};