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
const URL_CONSULTA_INVENTARIO_BASE = `https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=merkahorro_consulta_inventario`;
// QA: serviciosqa.siesacloud.com
// OJO: el costo promedio se lee de PRODUCCIÓN (servicios, no serviciosqa) a propósito: solo se
// CONSULTA (GET, no escribe nada) para tener el costo real.
const URL_COSTO_PROMEDIO_BASE = `https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=merkahorro_costo_promedio_dev`;
const INVENTARIO_TAM_PAGINA = parseInt(process.env.INVENTARIO_TAM_PAGINA || '1000');
const INVENTARIO_MAX_PAGINAS = parseInt(process.env.INVENTARIO_MAX_PAGINAS || '100');

// URL de Siesa PROD (POST) - Documento 242756 (FACTURA_DEV)
const URL_SIESA_POST = `https://servicios.siesacloud.com/api/siesa/v3.1/conectoresimportar?idCompania=${CIA}&idSistema=1&idDocumento=242756&nombreDocumento=FACTURA_DEV`;
// QA: serviciosqa.siesacloud.com

// URL de Siesa PROD (POST) - Documento 241913 (AJUSTE_INVENTARIO_DEV)
const URL_AJUSTE_INVENTARIO = `https://servicios.siesacloud.com/api/siesa/v3.1/conectoresimportar?idCompania=${CIA}&idSistema=1&idDocumento=241913&nombreDocumento=AJUSTE_INVENTARIO_DEV`;
// QA: serviciosqa.siesacloud.com

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

// Descarga UNA página de un query paginado de Connekta. Devuelve { registros, totalPaginas }.
async function fetchPagina(baseUrl, pagina) {
    const url = `${baseUrl}&paginacion=numPag=${pagina}|tamPag=${INVENTARIO_TAM_PAGINA}`;
    const response = await axios.get(url, {
        headers: { 'ConniKey': process.env.CONNI_KEY, 'ConniToken': process.env.CONNI_TOKEN },
        timeout: 60000
    });
    const data = response.data;
    let registros = [];
    let totalPaginas = null;
    if (data.detalle && data.detalle.Datos) {
        registros = data.detalle.Datos;
        // total_páginas: la "á" puede traer problemas de encoding -> búsqueda robusta por substring.
        const detalleKeys = Object.keys(data.detalle);
        const keyTotalPag = detalleKeys.find(k => k.toLowerCase().includes('total_p') || k.toLowerCase().includes('página') || k.toLowerCase().includes('pagina'));
        if (keyTotalPag && data.detalle[keyTotalPag]) totalPaginas = parseInt(data.detalle[keyTotalPag]);
    } else if (data.detalle && data.detalle.Table) {
        registros = data.detalle.Table;
    } else if (data.Table) {
        registros = data.Table;
    }
    return { registros: registros || [], totalPaginas };
}

// Descarga una página con reintento + backoff. NUNCA lanza: si agota reintentos
// devuelve registros vacíos (para no tumbar toda la descarga por una página).
async function fetchPaginaConReintento(baseUrl, pagina, etiqueta) {
    const MAX_REINTENTOS = 3;
    for (let intento = 1; intento <= MAX_REINTENTOS; intento++) {
        try {
            return await fetchPagina(baseUrl, pagina);
        } catch (error) {
            console.warn(`⚠️ ${etiqueta} pág ${pagina} (intento ${intento}/${MAX_REINTENTOS}): ${error.message}`);
            if (intento === MAX_REINTENTOS) {
                console.error(`❌ ${etiqueta} pág ${pagina} falló ${MAX_REINTENTOS} veces. Se omite esa página.`);
                return { registros: [], totalPaginas: null };
            }
            await new Promise(r => setTimeout(r, 1000 * intento)); // backoff incremental
        }
    }
    return { registros: [], totalPaginas: null };
}

// Descarga TODO un query paginado de Connekta.
// Estrategia: 1) página 1 secuencial para conocer el total; 2) páginas 2..N en
// POOL de concurrencia acotada (configurable con PAGINACION_CONCURRENCIA, default 4).
// El orden de los registros no importa (luego se indexan por item/bodega), así que
// el paralelismo es seguro para la correctitud. El reintento+backoff por página
// garantiza que ninguna página se pierda aunque Connekta dé ECONNRESET puntual.
async function fetchPaginadoCompleto(baseUrl, etiqueta) {
    const CONC = Math.max(1, parseInt(process.env.PAGINACION_CONCURRENCIA || '4'));
    const TOPE_PAGINAS = 2000; // tope duro de seguridad

    // 1) Página 1 (secuencial) -> nos dice el total de páginas.
    const primera = await fetchPaginaConReintento(baseUrl, 1, etiqueta);
    const todas = [...primera.registros];

    if (primera.registros.length === 0) {
        console.log(`   📦 ${etiqueta}: página 1 vacía, fin.`);
        return todas;
    }
    if (primera.registros.length < INVENTARIO_TAM_PAGINA) {
        console.log(`   📦 ${etiqueta}: única página (${primera.registros.length} registros).`);
        return todas;
    }

    // total_páginas reportado por Connekta; si no vino, caemos a INVENTARIO_MAX_PAGINAS.
    let totalPaginas = primera.totalPaginas && primera.totalPaginas > 0 ? primera.totalPaginas : INVENTARIO_MAX_PAGINAS;
    totalPaginas = Math.min(totalPaginas, TOPE_PAGINAS);
    console.log(`   📦 ${etiqueta}: ${totalPaginas} páginas estimadas, descargando 2..${totalPaginas} con concurrencia=${CONC}...`);

    // 2) Páginas 2..total en lotes concurrentes.
    let cursor = 2;
    while (cursor <= totalPaginas) {
        const lote = [];
        for (let k = 0; k < CONC && cursor <= totalPaginas; k++, cursor++) lote.push(cursor);
        const resultados = await Promise.all(lote.map(p => fetchPaginaConReintento(baseUrl, p, etiqueta)));
        let registrosLote = 0;
        for (const r of resultados) {
            if (r.registros.length > 0) { todas.push(...r.registros); registrosLote += r.registros.length; }
        }
        console.log(`   📦 ${etiqueta}: lote hasta pág ${cursor - 1}/${totalPaginas} (+${registrosLote}, acumulado=${todas.length})`);

        // Corte temprano: si el total reportado no era confiable y el lote completo vino
        // vacío, no tiene sentido seguir pidiendo páginas inexistentes.
        if (registrosLote === 0) {
            console.log(`   📦 ${etiqueta}: lote vacío, se asume fin de datos.`);
            break;
        }
    }

    console.log(`   ✅ ${etiqueta}: descarga completa, ${todas.length} registros.`);
    return todas;
}

// Wrappers con los nombres usados por el resto del código.
async function fetchInventarioCompleto() {
    return fetchPaginadoCompleto(URL_CONSULTA_INVENTARIO_BASE, 'Inventario');
}

async function fetchCostoPromedioCompleto() {
    return fetchPaginadoCompleto(URL_COSTO_PROMEDIO_BASE, 'Costo');
}

// Caché global para evitar descargas masivas concurrentes
let _inventarioPromise = null;
let _inventarioData = null;
let _inventarioTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

async function getInventarioCached() {
    if (_inventarioData && (Date.now() - _inventarioTimestamp < CACHE_TTL)) {
        console.log("♻️ Usando caché de inventario (válido por 5 min)...");
        return _inventarioData;
    }
    if (!_inventarioPromise) {
        console.log("🔍 Consultando inventario en Siesa (merkahorro_consulta_inventario, paginado)...");
        _inventarioPromise = fetchInventarioCompleto().then(data => {
            _inventarioData = data;
            _inventarioTimestamp = Date.now();
            _inventarioPromise = null;
            return data;
        }).catch(err => {
            _inventarioPromise = null;
            throw err;
        });
    } else {
        console.log("⏳ Esperando descarga de inventario en curso...");
    }
    return _inventarioPromise;
}

let _costoPromise = null;
let _costoData = null;
let _costoTimestamp = 0;

async function getCostoCached() {
    if (_costoData && (Date.now() - _costoTimestamp < CACHE_TTL)) {
        console.log("♻️ Usando caché de costos promedio (válido por 5 min)...");
        return _costoData;
    }
    if (!_costoPromise) {
        console.log("🔍 Consultando costos promedio en Siesa (merkahorro_costo_promedio_dev, paginado)...");
        _costoPromise = fetchCostoPromedioCompleto().then(data => {
            _costoData = data;
            _costoTimestamp = Date.now();
            _costoPromise = null;
            return data;
        }).catch(err => {
            _costoPromise = null;
            throw err;
        });
    } else {
        console.log("⏳ Esperando descarga de costos promedio en curso...");
    }
    return _costoPromise;
}

async function ajustarInventario(errores, itemsFactura, consecDocto) {
    const fecha = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const baseConsec = parseInt(consecDocto) || 99999;
    const itemsMap = {};
    itemsFactura.forEach(det => { itemsMap[det.id_item] = det; });

    const mapBodegaAInstalacion = (bodega) => {
        if (!bodega) return null;
        const raw = bodega.toString().trim();
        if (/^\d{5}$/.test(raw)) return raw.substring(0, 3);
        if (/^PV\d{3}$/i.test(raw)) return raw.substring(2, 5);
        return raw.substring(0, 3);
    };

    // Consultar inventario para obtener disponibilidad por bodega
    let inventarioDatos = [];
    try {
        // El conteo ya se loguea en fetchPaginadoCompleto (descarga real) o en getInventarioCached
        // (cache hit). No re-loguear aquí para no duplicar la salida cuando varias facturas
        // concurrentes consumen la misma caché.
        inventarioDatos = await getInventarioCached();
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

    // Consultar costos promedio por instalación (fallback cuando inventario no trae costo)
    let costosDatos = [];
    try {
        // Mismo criterio que el inventario: el conteo se loguea en la capa de caché/descarga.
        costosDatos = await getCostoCached();
    } catch (e) {
        console.warn("⚠️ No se pudo obtener costos promedio.");
    }

    const costoMap = {};
    costosDatos.forEach(c => {
        const itemId = c.IdItem || c.iditem || c.id_item;
        const instId = c.IdInstalacion || c.id_instalacion || c.idinstalacion;
        if (!itemId || !instId) return;
        const itemStr = itemId.toString().trim();
        const instStr = instId.toString().trim().padStart(3, '0');
        if (!costoMap[itemStr]) costoMap[itemStr] = {};
        const costo = parseFloat(c.CostoPromInst || c.costo_prom_inst || c.CostoProm || 0);
        if (costo > 0) costoMap[itemStr][instStr] = costo;
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

        // Buscar costo REAL siempre desde merkahorro_costo_promedio_dev (NUNCA de merkahorro_consulta_inventario).
        // PRIORIDAD: el costo de la instalación = CO de la factura que estamos procesando va PRIMERO.
        // Solo si ese CO no tiene costo para el ítem se buscan otras instalaciones.
        let costo = 0;
        let instElegida = null;
        // CO de la factura (la instalación en t132 coincide con el CO: PV001 → CO 001 → instalación 001).
        const coFactura = (itemsFactura[0] && itemsFactura[0].CoDoc != null)
            ? itemsFactura[0].CoDoc.toString().trim().padStart(3, '0')
            : null;
        const instBodega = mapBodegaAInstalacion(bodega); // fallback: instalación de la bodega del error de Siesa
        const prioridad = ['001', '003', '002', '007'];
        const costosItem = costoMap[idItemStr] || {};
        const candidatos = [];
        if (coFactura) candidatos.push(coFactura);                                       // 1) CO de la factura -> PRIMERO
        if (instBodega && !candidatos.includes(instBodega)) candidatos.push(instBodega); // 2) instalación de la bodega
        prioridad.forEach(p => { if (!candidatos.includes(p)) candidatos.push(p); });    // 3) prioridad fija
        Object.keys(costosItem).forEach(inst => { if (!candidatos.includes(inst)) candidatos.push(inst); }); // 4) cualquier otra

        for (const inst of candidatos) {
            if (costosItem[inst] && costosItem[inst] > 0) {
                costo = costosItem[inst];
                instElegida = inst;
                const origen = inst === coFactura ? 'CO de la factura'
                    : (inst === instBodega ? 'instalacion de la bodega' : 'fallback otra instalacion');
                console.log(`💰 Costo item ${idItemStr} instalacion ${inst} (${origen}): ${costo} (t132). CO factura=${coFactura}. Disponibles: ${JSON.stringify(costosItem)}`);
                break;
            }
        }

        if (!costo || costo <= 0) {
            console.warn(`⚠️ Sin costo real para item ${idItemStr} (bodega ${bodega}, CO factura ${coFactura}, inst bodega ${instBodega}). costoMap[${idItemStr}]=${JSON.stringify(costosItem)}. Se omite del ajuste de inventario.`);
            return;
        }

        // Cross-check defensivo: comparar el costo por instalación (t132) con el costo por
        // bodega (t400 / consulta_inventario) que ya descargamos en inventarioMap. Si difieren
        // de forma significativa, lo avisamos para detectar divergencias como 5894 vs 5975.
        const costoBodega = inventarioMap[idItemStr] && inventarioMap[idItemStr][bodega]
            ? inventarioMap[idItemStr][bodega].costo
            : null;
        if (costoBodega && costoBodega > 0 && Math.abs(costoBodega - costo) > 1) {
            console.warn(`⚠️ [DIVERGENCIA COSTO] item ${idItemStr} bodega ${bodega}: t132(inst ${instElegida})=${costo} vs t400(bodega)=${costoBodega}. Se usa el de t132 (${costo}).`);
        }

        const inyectar = faltanteMatch ? Math.abs(parseFloat(faltanteMatch[1])) : 10;
        const inyectarFinal = unidad === 'UND' ? Math.ceil(inyectar) : inyectar;
        const costoFinal = Math.round(Math.max(costo, 1));

        // UNIDAD_NEGOCIO debe ser la que pertenece al ítem (según su tipo_inv_serv). Si no está
        // mapeada (o el campo llega vacío), NO inyectamos con una UN incorrecta ni null:
        // se omite el ítem y se avisa para agregarlo al CASE en la query de Connekta.
        const tipoInvServ = (det?.tipo_inv_serv ?? '').trim();
        // Los SERVICIOS (tipo_inv_serv que empieza por "S-") no manejan stock → no aplica ajuste
        // de inventario. Se omiten del CPE de forma silenciosa (no es un error, no llevan UN).
        if (tipoInvServ.toUpperCase().startsWith('S-')) {
            console.log(`ℹ️ Item ${idItemStr}: tipo_inv_serv "${tipoInvServ}" es un SERVICIO → no aplica ajuste de inventario, se omite del CPE.`);
            return;
        }
        const un = (det?.unidad_de_negocio ?? '').trim();
        if (!un) {
            console.warn(`⚠️ Item ${idItemStr}: tipo_inv_serv "${tipoInvServ || '—'}" SIN unidad de negocio mapeada → se OMITE del CPE (no se envía UN incorrecta). Agregar al CASE en la query merkahorro_venta_pos_dev.`);
            return;
        }
        console.log(`🧾 [CPE movimiento] ITEM ${idItemStr.padStart(7, '0')} | BODEGA ${bodega} | inst ${instElegida} | costo crudo ${costo} | COSTO_PROMEDIO enviado ${formatDecimal(costoFinal)} (${costoFinal}) | CANTIDAD ${inyectarFinal} | UN ${un}`);

        movimientos.push({
            "C.O.": "001",
            "f470_id_tipo_docto": "CPE",
            "f470_consec_docto": 0,
            "f470_nro_registro": nroRegistro,
            "BODEGA": bodega,
            "f470_id_concepto": 601,
            "f470_id_motivo": "17",
            "ind_naturaleza": 2,
            "C.O MOVIMIENTO": coFactura || "001",
            "UNIDAD_MEDIDA": unidad,
            "CANTIDAD": formatDecimal(inyectarFinal, true),
            "ITEM": idItemStr.padStart(7, '0'),
            "UNIDAD_NEGOCIO": un,
            "COSTO_PROMEDIO": formatDecimal(costoFinal)
        });
    });

    if (movimientos.length === 0) return [];

    const payload = {
        "Documentos": [{
            "f350_id_co": "001",
            "f350_id_tipo_docto": "CPE",
            "f350_id_clase_docto": 61,
            "f450_id_concepto": 601,
            "f350_consec_docto": "0",
            "F_CONSEC_AUTO_REG": "1",
            "FECHA_DOCTO": fecha,
            "BODEGA": [...bodegas][0]
        }],
        "Movimientos": movimientos
    };

    let intentosAjuste = 0;
    const MAX_INTENTOS_AJUSTE = 3;
    let ajusteExitoso = false;

    while (intentosAjuste < MAX_INTENTOS_AJUSTE && !ajusteExitoso) {
        intentosAjuste++;
        console.log(`📦 Inyectando inventario automáticamente (Intento ${intentosAjuste}/${MAX_INTENTOS_AJUSTE})...`);
        // Trazabilidad: qué ENVIAMOS exactamente (motivo/concepto/clase + items).
        const _doc = payload.Documentos[0] || {};
        const _mov0 = payload.Movimientos[0] || {};
        console.log(`📤 [CPE payload] Documento: clase=${_doc.f350_id_clase_docto} concepto_doc=${_doc.f450_id_concepto} | Movimiento: motivo=${_mov0.f470_id_motivo} concepto=${_mov0.f470_id_concepto} naturaleza=${_mov0.ind_naturaleza}`);
        console.log(`📤 [CPE items] ${payload.Movimientos.map(m => `${m.ITEM}:cost=${m.COSTO_PROMEDIO}:cant=${m.CANTIDAD}:mot=${m.f470_id_motivo}`).join(' | ')}`);
        try {
            const response = await axios.post(URL_AJUSTE_INVENTARIO, payload, {
                headers: {
                    'ConniKey': process.env.CONNI_KEY,
                    'ConniToken': process.env.CONNI_TOKEN,
                    'Content-Type': 'application/json'
                }
            });
            console.log(`✅ Inventario inyectado: ${response.data.mensaje}`);
            ajusteExitoso = true;
        } catch (error) {
            if (error.response && error.response.data && error.response.data.detalle) {
                const erroresAjuste = error.response.data.detalle;
                let recalculoHecho = false;
                
                // Buscar si Siesa nos rechazó el ajuste por seguir debiendo inventario
                if (Array.isArray(erroresAjuste)) {
                    erroresAjuste.forEach(errAjuste => {
                        const matchFaltante = errAjuste.f_detalle && errAjuste.f_detalle.match(/Faltante Inv\.:\s*(-?[\d.]+)/);
                        const matchItem = errAjuste.f_valor && errAjuste.f_valor.match(/Item:(\d+)Bodega:(\w+)/);
                        
                        if (matchFaltante && matchItem) {
                            const errorIdStr = matchItem[1].substring(0, 7).replace(/^0+/, '');
                            const faltanteAdicional = Math.abs(parseFloat(matchFaltante[1]));
                            
                            // Buscar el movimiento en el payload y sumarle el faltante adicional
                            const movToUpdate = payload.Movimientos.find(m => m.ITEM.replace(/^0+/, '') === errorIdStr);
                            if (movToUpdate && faltanteAdicional > 0) {
                                const cantidadActual = parseFloat(movToUpdate.CANTIDAD);
                                const nuevaCantidad = cantidadActual + faltanteAdicional;
                                const isUnd = movToUpdate.UNIDAD_MEDIDA.trim() === 'UND';
                                const cantidadFinalFormateada = isUnd ? Math.ceil(nuevaCantidad) : nuevaCantidad;
                                
                                movToUpdate.CANTIDAD = formatDecimal(cantidadFinalFormateada, true);
                                console.log(`🔄 Auto-corrección de Ajuste Siesa: Ítem ${errorIdStr} requiere ${faltanteAdicional} adicionales. Nueva cantidad a inyectar: ${movToUpdate.CANTIDAD}`);
                                recalculoHecho = true;
                            }
                        }
                    });
                }

                if (recalculoHecho && intentosAjuste < MAX_INTENTOS_AJUSTE) {
                    console.log(`⚠️ Siesa demandó más stock. Reintentando inyección con cantidades actualizadas...`);
                    continue; // Pasa a la siguiente iteración del while para reintentar con el payload modificado
                }
            }

            console.error("❌ Error en ajuste de inventario (abortado tras reintentos):");
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
            throw error; // Propaga el error para que la factura principal sepa que la inyección falló
        }
    }
    // Retornar los items inyectados para trazabilidad en frontend
    return payload.Movimientos.map(m => ({
        item: m.ITEM.replace(/^0+/, ''),
        bodega: m.BODEGA,
        cantidad: parseFloat(m.CANTIDAD),
        un: m.UNIDAD_NEGOCIO,
        costo: parseFloat(m.COSTO_PROMEDIO)
    }));
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
    const num = parseFloat(number);
    if (isNaN(num)) return "000.0000";
    return num.toFixed(4).padStart(8, '0');
}

// Convierte un string "001,002" en array ["001","002"].
// Prioridad: 1) valor explícito, 2) variable de entorno, 3) array vacío (sin filtro).
function parseFilterParam(val, envKey) {
    const raw = (val !== null && val !== undefined) ? String(val) : (process.env[envKey] || '');
    return raw.split(',').map(s => s.trim()).filter(Boolean);
}

async function ejecutarPaso(pasoActual, consecsOverride = null, filtros = {}) {
    console.log("==========================================");
    console.log("🚀 Iniciando Sincronización de Ventas POS");
    console.log("==========================================");

    const detallesRaw = await fetchFromConnekta(URL_VENTAS_DETALLE);
    const pagosRaw = await fetchFromConnekta(URL_VENTAS_PAGOS);
    const impuestosRaw = await fetchFromConnekta(URL_VENTAS_IMPUESTOS);
    const cajasRaw = await fetchFromConnekta(URL_CAJAS);

    // --- FILTROS DINÁMICOS CO / CAJA / HOY ---
    // Si la corrida es por CONSECS específicos, NO se aplican filtros CO/Caja/hoy: el consec debe
    // encontrarse en SU PROPIO CO/Caja, sin que un filtro lo excluya. (El usuario puede dejar el
    // filtro puesto en el panel y aun así el consec se busca donde realmente está.)
    const consecsEnvActivos = (process.env.CONSEC_ESPECIFICOS || '').trim();
    const hayConsecsEspecificos = (Array.isArray(consecsOverride) && consecsOverride.length > 0) || consecsEnvActivos.length > 0;

    let detalles = detallesRaw;
    if (hayConsecsEspecificos) {
        console.log('🎯 Modo consec específico: se IGNORAN los filtros CO/Caja/hoy (el consec se busca en su propio CO/Caja).');
    } else {
        // CO: normalizamos AMBOS lados a 3 dígitos (ej. "1" → "001") para evitar fallos por padding.
        const coList = parseFilterParam(filtros.co, 'CO_FILTER').map(c => c.padStart(3, '0'));
        // Caja: normalizamos a MAYÚSCULAS en ambos lados (ej. "p05" → "P05").
        const cajaList = parseFilterParam(filtros.caja, 'CAJA_FILTER').map(c => c.toUpperCase());
        if (coList.length > 0) {
            detalles = detalles.filter(d => coList.includes((d.CoDoc ?? '').toString().trim().padStart(3, '0')));
            console.log(`🔍 Filtrando por CO: ${coList.join(', ')} → ${detalles.length} registros de facturas`);
        }
        if (cajaList.length > 0) {
            detalles = detalles.filter(d => cajaList.includes((d.ID_TIPO_DOCTO ?? '').toString().trim().toUpperCase()));
            console.log(`🔍 Filtrando por Caja: ${cajaList.join(', ')} → ${detalles.length} registros de facturas`);
        }
        // Filtro "solo hoy": facturas cuya FECHA_DOCTO sea hoy en America/Bogota.
        // 'en-CA' da formato YYYY-MM-DD para comparar directo contra FECHA_DOCTO ("2026-06-03T00:00:00" → "2026-06-03").
        if (filtros.soloHoy) {
            const hoyBogota = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
            detalles = detalles.filter(d => (d.FECHA_DOCTO || '').toString().split('T')[0] === hoyBogota);
            console.log(`🔍 Filtrando por fecha = hoy (${hoyBogota}, America/Bogota) → ${detalles.length} registros de facturas`);
        }
    }
    if (detalles.length === 0) {
        console.log("⚠️ No hay facturas para sincronizar. (Filtros CO/Caja sin resultados)");
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

    // Correcciones de CxC guardadas entre ejecuciones (cartera vs CxC)
    let correccionesCxC = new Map();

    // AGRUPAR POR CO | CAJA | CONSEC (cada grupo solo tiene items y pagos de una caja)
    const buildKey = (co, caja, consec) => `${(co || '').trim() || '001'}|${(caja || '').trim() || '000'}|${consec}`;
    const facturas = {};
    detalles.forEach(det => {
        const key = buildKey(det.CoDoc, det.ID_TIPO_DOCTO, det.CONSEC_DOCTO);
        if (!facturas[key]) facturas[key] = { items: [], pagos: [] };
        facturas[key].items.push(det);
    });

    const facturasKeysValidas = new Set(detalles.map(d => buildKey(d.CoDoc, d.ID_TIPO_DOCTO, d.CONSEC_DOCTO)));
    const pagosRawFiltrados = pagosRaw.filter(p => facturasKeysValidas.has(buildKey(p.CoDoc, p.ID_TIPO_DOCTO, p.CONSEC_DOCTO)));
    const impuestosRawFiltrados = impuestosRaw;

    pagosRawFiltrados.forEach(p => {
        const key = buildKey(p.CoDoc, p.ID_TIPO_DOCTO, p.CONSEC_DOCTO);
        if (facturas[key]) facturas[key].pagos.push(p);
    });

    // Mapear impuestos por RowidMvto para búsqueda rápida
    const impuestosPorRowid = {};
    impuestosRawFiltrados.forEach(imp => {
        if (imp.ID_LLAVE_IMPUESTO && imp.ID_LLAVE_IMPUESTO !== 'null' && imp.VALOR_TOTAL > 0) {
            if (!impuestosPorRowid[imp.RowidMvto]) impuestosPorRowid[imp.RowidMvto] = [];
            impuestosPorRowid[imp.RowidMvto].push(imp);
        }
    });

    // ORDENAR FACTURAS: dentro de cada paso, las más recientes primero
    // (sort DESC por consec; el orden CFZ/CNZ entre pasos lo controla el caller)
    const parseKey = key => { const [co, caja, consec] = key.split('|'); return { co, caja, consec }; };
    const todasLasFacturas = Object.keys(facturas).sort((a, b) => parseInt(b.split('|')[2], 10) - parseInt(a.split('|')[2], 10));

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
        facturasFiltradas = todasLasFacturas.filter(key => setConsecs.has(parseKey(key).consec));
        modoEspecificos = true;

        // Avisar si alguno solicitado no se encontró en el pool de Connekta.
        const encontradosConsecs = new Set(facturasFiltradas.map(k => parseKey(k).consec));
        const faltantes = lista.filter(c => !encontradosConsecs.has(c));
        if (pasoActual === 3 && faltantes.length > 0) {
            console.warn(`⚠️ Consecs solicitados que NO están en el rango de Connekta: ${faltantes.join(', ')}`);
        }
    }

    // APLICAR LÍMITE de facturas a procesar.
    // - modo específicos (consecs puntuales): respetamos la lista exacta.
    // - filtros.todas (job automático): procesamos TODAS las filtradas (idempotencia evita repetir OK).
    // - modo normal: tope LIMITE_FACTURAS (las más recientes).
    const LIMITE = parseInt(process.env.LIMITE_FACTURAS || '1');
    const sinTope = modoEspecificos || filtros.todas === true;
    const facturasOrdenadas = sinTope ? facturasFiltradas : facturasFiltradas.slice(0, LIMITE);

    // MOSTRAR LISTADO DE FACTURAS DETECTADAS (solo en el primer paso para no duplicar log)
    if (pasoActual === 3) {
        const modoLabel = modoEspecificos
            ? `modo CONSEC_ESPECIFICOS: ${facturasOrdenadas.length} grupos`
            : `procesando ${facturasOrdenadas.length} de ${todasLasFacturas.length} disponibles`;
        console.log("\n==========================================");
        console.log(`📋 FACTURAS DETECTADAS (${modoLabel})`);
        console.log("==========================================");
        facturasOrdenadas.forEach((key, i) => {
            const { co, caja, consec } = parseKey(key);
            const f = facturas[key];
            const e = f.items[0];
            const fecha = e.FECHA_DOCTO ? e.FECHA_DOCTO.split('T')[0] : 'N/A';
            console.log(`  ${i + 1}. CO ${co} | Caja ${caja} | Consec ${consec} | Fecha ${fecha} | Cliente: ${e.NitTercero} | Items: ${f.items.length} | Neto: $${e.VrNetoDocto}`);
        });
        console.log("==========================================\n");
    }

    // Genera el payload completo para UNA SOLA factura (devuelve objeto listo para POST a Siesa).
    const generarPayloadDocumento = (fac, enc, tipoDocumentoSimulado, co = '', caja = '') => {
        // Arrays LOCALES a esta factura - cada factura genera su propio payload independiente.
        const Docto_ventas_comercial = [];
        const Movimientos = [];
        const Impuestos = [];
        const Descuentos = [];
        const Caja = [];

        const esSimulacionCNZ = (tipoDocumentoSimulado === 'CNZ');
        const tipoDoctoSiesa = esSimulacionCNZ ? 'CNZ' : 'CFZ';
        // Para diferenciar las consecuciones y que Siesa no se confunda, a la simulacion le ponemos el mismo consecutivo
        // Ya que ID_TIPO_DOCTO es distinto, Siesa las agrupa por separado.
        const consecDoc = enc.CONSEC_DOCTO; 

        const absIfCNZ = (val) => {
            if (val === null || val === undefined) return val;
            return esSimulacionCNZ ? Math.abs(parseFloat(val)) : parseFloat(val);
        };

        Docto_ventas_comercial.push({
            "ID_CO": enc.CoDoc,
            "ID_TIPO_DOCTO": tipoDoctoSiesa,
            "CONSEC_DOCTO": consecDoc,
            "FECHA_DOCTO": formatDate(enc.FECHA_DOCTO),
            "ID_TERCERO": enc.NitTercero,
            "ID_CLASE_DOCTO": esSimulacionCNZ ? 525 : 522,
            "SUCURSAL_CLIENTE": "001",
            "id_co_fact": enc.CoDoc,
            "TERCERO_REM": enc.NitTercero,
            "F_CONSEC_AUTO_REG": "1",
            "id_cond_pago": enc.id_cond_pago ? enc.id_cond_pago.toString().trim().padStart(3, '0') : "000",
            "id_caja": (cajaPorCo[enc.CoDoc.trim()] || (enc.CoDoc.trim() === "003" ? "03 " : enc.CoDoc.trim().padStart(3, '0'))).padEnd(3, ' ')
        });

        fac.items.forEach((det, index) => {
            const lineaItem = index + 1;
            const cant = absIfCNZ(det.CANTIDAD || det.cant_1);
            const vrBruto = absIfCNZ(det.VALOR_BRUTO);
            const precioUnit = Number(cant) > 0 ? vrBruto / cant : 0;

            Movimientos.push({
                "id_co": enc.CoDoc,
                "id_tipo_docto": tipoDoctoSiesa,
                "consec_docto": consecDoc,
                "nro_registro": lineaItem,
                "BODEGA": det.BODEGA || "MG001",
                "id_concepto": esSimulacionCNZ ? 502 : ({"1201": 501, "1202": 502}[det.Concepto] || 501),
                "id_motivo": "03",
                "ind_naturaleza": esSimulacionCNZ ? 1 : 2,
                "id_co_movto": enc.CoDoc,
                "UNIDAD_MEDIDA": det.UNIDAD_MEDIDA ? det.UNIDAD_MEDIDA.trim() : "UND",
                "CANTIDAD": formatDecimal(cant, true),
                "VALOR_BRUTO": formatDecimal(vrBruto),
                "id_item": det.id_item,
                "id_un_movto": (det?.unidad_de_negocio ?? '').trim() || "001",
                "VLR_UNITARIO": formatDecimal(precioUnit)
            });

            // CRUCE DE IMPUESTOS POR ROWIDMVTO
            const imptosItem = impuestosPorRowid[det.RowidMvto] || [];
            imptosItem.forEach(imp => {
                Impuestos.push({
                    "ID_CO": enc.CoDoc,
                    "TIPO_DOCTO": tipoDoctoSiesa,
                    "CONSEC_DOCTO": consecDoc,
                    "NRO_REGISTRO": lineaItem,
                    "ID_LLAVE_IMPUESTO": (imp.ID_LLAVE_IMPUESTO || '').trim(),
                    "PORCENTAJE_BASE": formatTasa(imp.PORCENTAJE_BASE), 
                    "TASA": formatTasa(imp.TASA),
                    "VLR_UNI": formatDecimal(imp.VLR_UNI != null ? imp.VLR_UNI : 0),
                    "VALOR_TOTAL": formatDecimal(absIfCNZ(imp.VALOR_TOTAL) || (Number(imp.VLR_UNI || 0) * Number(cant || 0))) 
                });
            });

            // DESCUENTOS
            if (det.vlr_tot_dscto && Math.abs(parseFloat(det.vlr_tot_dscto)) > 0) {
                const totalDescuentoItem = parseFloat(det.vlr_tot_dscto);
                const vlrUniDscto = (det.vlr_uni_dscto && Math.abs(parseFloat(det.vlr_uni_dscto)) > 0) ? parseFloat(det.vlr_uni_dscto) : (totalDescuentoItem / parseFloat(det.CANTIDAD || det.cant_1 || 1));
                
                Descuentos.push({
                    "id_co": enc.CoDoc,
                    "id_tipo_docto": tipoDoctoSiesa,
                    "consec_docto": consecDoc,
                    "nro_registro": lineaItem,
                    "vlr_uni": formatDecimal(absIfCNZ(vlrUniDscto)),
                    "vlr_tot": formatDecimal(absIfCNZ(totalDescuentoItem))
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

        // RECÁLCULO DE IMPUESTOS (Opción A) — alinear el IVA por línea con el redondeo de Siesa.
        // Para cada línea con TASA > 0, recalculamos VALOR_TOTAL = round(base_neta × tasa) AL PESO,
        // que es exactamente como Siesa recalcula el impuesto al derivar la "cartera". Si en cambio
        // enviáramos el IVA del POS (que a veces redondea distinto, ej. 239.4 → 240 en vez de 239),
        // la CxC (usa nuestro IVA) y la cartera (Siesa recalcula) difieren 1-N pesos y el documento
        // rebota con "El valor de la cartera debe ser igual al valor de las CxC".
        //   base_neta = VALOR_BRUTO − descuento de la línea.
        //   Math.round coincide con el redondeo half-up de Siesa (verificado con datos reales:
        //   4398.69 → 4399, 1444.95 → 1445, 940.45 → 940, 239.4 → 239).
        // ICO (TASA = 0) NO se toca: su VALOR_TOTAL viene de VLR_UNI × CANT y se respeta tal cual.
        Impuestos.forEach(i => {
            if (i.CONSEC_DOCTO === consecDoc && i.TIPO_DOCTO === tipoDoctoSiesa) {
                const m = Movimientos.find(x => x.nro_registro === i.NRO_REGISTRO && x.consec_docto === consecDoc && x.id_tipo_docto === tipoDoctoSiesa);
                if (m && i.TASA !== null && i.TASA !== undefined && parseFloat(i.TASA) > 0) {
                    const dscLinea = Descuentos.find(d => d.consec_docto === consecDoc && d.id_tipo_docto === tipoDoctoSiesa && d.nro_registro === i.NRO_REGISTRO);
                    const dsctoVal = dscLinea ? parseFloat(dscLinea.vlr_tot || 0) : 0;
                    const baseNeta = parseFloat(m.VALOR_BRUTO) - dsctoVal;
                    const tasa = parseFloat(i.TASA);
                    const valorImpuesto = Math.round(baseNeta * tasa / 100);
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
        
        Object.values(cajaConsolidada).filter(p => esSimulacionCNZ ? Math.abs(p.neto) > 0 : p.neto > 0).forEach(p => posCaja += absIfCNZ(p.neto));
        
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
                    const medios = Object.values(cajaConsolidada).filter(p => esSimulacionCNZ ? Math.abs(p.neto) > 0 : p.neto > 0);
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

        Object.values(cajaConsolidada).filter(p => esSimulacionCNZ ? Math.abs(p.neto) > 0 : p.neto > 0).forEach(pago => {
            Caja.push({
                "ID_CO": enc.CoDoc,
                "ID_TIPO_DOCTO": tipoDoctoSiesa,
                "CONSEC_DOCTO": consecDoc,
                "ID_MEDIOS_PAGO": esSimulacionCNZ ? "EFE" : pago.ID_MEDIOS_PAGO,
                "VLR_MEDIO_PAGO": formatDecimal(absIfCNZ(pago.neto)),
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

        // Aplicar corrección de CxC guardada de ejecución anterior (cartera vs CxC)
        const keyCorr = `${tipoDoctoSiesa}:${(co || '').trim()}:${(caja || '').trim()}:${consecDoc}`;
        const cxcVal = correccionesCxC.get(keyCorr);
        if (cxcVal) {
            console.log(`💡 [${tipoDoctoSiesa} ${consecDoc}] Aplicando cxc_valor=${cxcVal} de ejecución anterior.`);
            Caja.length = 0;
            Caja.push({
                "ID_CO": enc.CoDoc,
                "ID_TIPO_DOCTO": tipoDoctoSiesa,
                "CONSEC_DOCTO": consecDoc,
                "ID_MEDIOS_PAGO": "EFE",
                "VLR_MEDIO_PAGO": formatDecimal(cxcVal),
                "NRO_CUENTA": "1",
                "NRO_CHEQUE": "1",
                "REFERENCIA": "1",
                "COD_SEGURIDAD": 1,
                "NRO_AUTORIZACION": "1",
                "FECHA_VCTO": formatDate(enc.FECHA_DOCTO)
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
            // Incluir co/caja en el resultado para que el snapshot de corrida (sps_corridas)
            // y el Historial del frontend puedan mostrar de qué CO/Caja es cada CNZ/CFZ.
            return { ...resultado, co: meta.co, caja: meta.caja };
        };
        // Bucle acotado de automatización: reintenta el envío mientras el error siga siendo
        // "automatizable" (cliente faltante o inventario insuficiente), inyectando en CADA
        // ronda lo NUEVO que Siesa reporte (sirve igual para CNZ y CFZ, y cubre el caso de
        // que un reintento revele una falta adicional). Tope de rondas para evitar bucles infinitos.
        const MAX_RONDAS = Math.max(1, parseInt(process.env.MAX_RONDAS_AJUSTE || '3'));
        let clientesSincronizados = false;
        let fallosInyeccion = 0; // fallos CONSECUTIVOS del ajuste de inventario
        for (let ronda = 0; ronda <= MAX_RONDAS; ronda++) {
            try {
                const responseSiesa = await axios.post(URL_SIESA_POST, payload, {
                    headers: {
                        'ConniKey': process.env.CONNI_KEY,
                        'ConniToken': process.env.CONNI_TOKEN,
                        'Content-Type': 'application/json'
                    }
                });
                const sufijo = automatizaciones.length > 0 ? ' (tras automatización)' : '';
                return await registrar({ consecutivo, tipo: tipoDoctoSiesa, ok: true, mensaje: (responseSiesa.data.mensaje || 'OK') + sufijo });
            } catch (error) {
                // Error sin detalle estructurado de Siesa (red, timeout, 500, etc.) -> no automatizable.
                if (!(error.response && error.response.data && error.response.data.detalle)) {
                    const msg = error.response?.data ? JSON.stringify(error.response.data) : error.message;
                    return await registrar({ consecutivo, tipo: tipoDoctoSiesa, ok: false, mensaje: msg });
                }

                const errores = error.response.data.detalle;
                const faltaCliente = Array.isArray(errores) && errores.some(e => e.f_detalle && (
                    e.f_detalle.toLowerCase().includes('cliente no existe') ||
                    e.f_detalle.toLowerCase().includes('sucursal del cliente') ||
                    e.f_detalle.toLowerCase().includes('sucursal de la')
                ));
                const faltaInventario = Array.isArray(errores) && errores.some(e => e.f_detalle && e.f_detalle.includes('Item sin cantidad disponible'));

                let accionTomada = false;

                // Error no automatizable (maestras, valor inválido, etc.) -> fallo definitivo.
                if (!faltaCliente && !faltaInventario) {
                    // Salvo que sea error de cartera vs CxC con diferencia de 1-2 pesos:
                    // se guarda el valor CxC en DB para que la próxima ejecución lo use.
                    const errorCarteraCxC = Array.isArray(errores) && errores.find(e =>
                        e.f_detalle && e.f_detalle.includes('Valor cartera:')
                    );
                    if (errorCarteraCxC) {
                        const match = errorCarteraCxC.f_detalle.match(/Valor cartera:\s*([\d.]+).*?Valor CxC:\s*([\d.]+)/);
                        if (match) {
                            const cartera = parseFloat(match[1]);
                            const cxc = parseFloat(match[2]);
                            const diff = Math.abs(cartera - cxc);
                            if (diff > 0 && diff <= 2) {
                                console.log(`💾 [${tipoDoctoSiesa} ${consecutivo}] Guardando corrección CxC: cartera ${cartera} → CxC ${cxc} (dif ${diff}). Se aplicará en próxima ejecución.`);
                                await logger.guardarCorreccionCxC(meta.co, meta.caja, consecutivo, cxc);
                            }
                        }
                    }
                    return await registrar({ consecutivo, tipo: tipoDoctoSiesa, ok: false, mensaje: JSON.stringify(error.response.data) });
                }

                // Sin rondas restantes y Siesa sigue pidiendo automatización -> fallo.
                if (ronda >= MAX_RONDAS) {
                    return await registrar({ consecutivo, tipo: tipoDoctoSiesa, ok: false, mensaje: `Agotadas ${MAX_RONDAS} ronda(s) de automatización: ${JSON.stringify(error.response.data)}` });
                }

                if (faltaCliente && !clientesSincronizados) {
                    console.log(`⚠️ [${tipoDoctoSiesa} ${consecutivo}] Cliente no existe en Siesa. Ejecutando syncPOS()...`);
                    // Siesa devuelve el NIT en `f_valor` (ej. "42683051" o "42683051-001"); nos
                    // quedamos con el NIT base (antes del guión). `f_detalle` solo trae el mensaje genérico.
                    const nitsFaltantes = [...new Set(
                        errores
                            .filter(e => e.f_detalle && (
                                e.f_detalle.toLowerCase().includes('cliente no existe') ||
                                e.f_detalle.toLowerCase().includes('sucursal del cliente') ||
                                e.f_detalle.toLowerCase().includes('sucursal de la')
                            ))
                            .map(e => {
                                const raw = String(e.f_valor || '').trim();
                                if (!raw) return null;
                                return raw.split('-')[0].trim();
                            })
                            .filter(Boolean)
                    )];
                    console.log(`🎯 [${tipoDoctoSiesa} ${consecutivo}] NIT(s) faltante(s) detectado(s): ${nitsFaltantes.join(', ') || '(ninguno extraído)'}`);
                    automatizaciones.push(`sync_cliente:${nitsFaltantes.join(',') || 'all'}`);
                    try {
                        await syncPOS(nitsFaltantes.length > 0 ? nitsFaltantes : null);
                        clientesSincronizados = true; // no reintentar syncPOS en rondas siguientes
                        accionTomada = true;
                    } catch (syncError) {
                        console.error(`❌ [${tipoDoctoSiesa} ${consecutivo}] Error en syncPOS:`, syncError.message);
                    }
                }

                if (faltaInventario) {
                    console.log(`⚠️ [${tipoDoctoSiesa} ${consecutivo}] Inventario insuficiente (ronda ${ronda + 1}/${MAX_RONDAS}). Inyectando lo que reporta Siesa...`);
                    automatizaciones.push(`ajuste_inventario:${consecutivo}`);
                    try {
                        const consecAjuste = parseInt(Date.now().toString().slice(-7));
                        const itemsInyectados = await ajustarInventario(errores, detallesFactura, consecAjuste) || [];
                        if (itemsInyectados.length > 0) {
                            meta.cpeItems = [...(meta.cpeItems || []), ...itemsInyectados];
                        }
                        accionTomada = true;
                        fallosInyeccion = 0;
                    } catch (ajusteError) {
                        console.error(`❌ [${tipoDoctoSiesa} ${consecutivo}] Error en ajuste de inventario:`, ajusteError.message);
                        // El ajuste LANZÓ, pero el stock pudo haberse inyectado parcialmente, o por
                        // otra factura concurrente del mismo lote. Damos un reintento del documento
                        // (puede que el stock ya esté), salvo que la inyección haya fallado 2 veces
                        // seguidas -> ahí sí lo tratamos como irrecuperable en esta corrida.
                        fallosInyeccion++;
                        if (fallosInyeccion < 2) {
                            accionTomada = true;
                            console.log(`↻ [${tipoDoctoSiesa} ${consecutivo}] Reintento de cortesía: el stock pudo haberse inyectado de todos modos.`);
                        }
                    }
                }

                // Si en esta ronda no se pudo hacer nada nuevo (ej. cliente ya sincronizado pero
                // sigue rebotando, o el ajuste falló), no tiene sentido seguir reintentando.
                if (!accionTomada) {
                    return await registrar({ consecutivo, tipo: tipoDoctoSiesa, ok: false, mensaje: `Sin más automatización posible: ${JSON.stringify(error.response.data)}` });
                }

                console.log(`🔁 [${tipoDoctoSiesa} ${consecutivo}] Reintentando envío (ronda ${ronda + 1})...`);
                // El for vuelve a iterar -> nuevo POST con el inventario/cliente ya corregido.
            }
        }

        // Salvaguarda (no debería alcanzarse): salimos del for sin retornar.
        return await registrar({ consecutivo, tipo: tipoDoctoSiesa, ok: false, mensaje: 'No se pudo enviar tras agotar reintentos.' });
    };

    // Construir la lista de tareas (1 por factura aplicable a este paso).
    // Aplica idempotencia: si una factura YA está como OK en Supabase
    // (para este tipo CFZ/CNZ), se omite silenciosamente. Las que están en FALLO sí se reintentan.
    const consecsExitosos = await logger.obtenerConsecsExitosos();
    correccionesCxC = await logger.obtenerCorreccionesCxC();
    const omitidas = [];
    const tareas = [];
    facturasOrdenadas.forEach(key => {
        const { co, caja, consec: consecutivo } = parseKey(key);
        const fac = facturas[key];
        const enc = fac.items[0];
        const meta = {
            fecha_factura: enc.FECHA_DOCTO ? enc.FECHA_DOCTO.split('T')[0] : null,
            cliente_nit: enc.NitTercero,
            items: fac.items.length,
            neto: enc.VrNetoDocto,
            co,
            caja
        };

        if (pasoActual === 1) {
            const tipoDocto = 'CNZ';
            const keyCNZ = `${tipoDocto}:${co}:${caja}:${consecutivo}`;
            if (consecsExitosos.has(keyCNZ)) {
                omitidas.push(`${tipoDocto} ${consecutivo}`);
                return;
            }
            const payload = generarPayloadDocumento(fac, enc, 'CNZ', co, caja);
            tareas.push({ consecutivo, payload, detalles: fac.items, tipo: tipoDocto, meta });
        } else if (pasoActual === 3) {
            const tipoDoc = 'CFZ';
            const keyCFZ = `${tipoDoc}:${co}:${caja}:${consecutivo}`;
            if (consecsExitosos.has(keyCFZ)) {
                omitidas.push(`${tipoDoc} ${consecutivo}`);
                return;
            }
            const payload = generarPayloadDocumento(fac, enc, 'CFZ', co, caja);
            tareas.push({ consecutivo, payload, detalles: fac.items, tipo: tipoDoc, meta });
        }
    });

    if (omitidas.length > 0) {
        console.log(`⏭️ Omitidas por idempotencia (ya procesadas OK): ${omitidas.length} -> ${omitidas.join(', ')}`);
    }

    if (tareas.length === 0) {
        console.log(`ℹ️ Paso ${pasoActual === 3 ? 'CFZ' : 'CNZ'}: no hay facturas aplicables.`);
        return [];
    }

    // Se omite respaldo local (ahora todo se persiste en Supabase via logger.js)

    // Procesar con pool de concurrencia configurable.
    const CONCURRENCIA = Math.max(1, parseInt(process.env.CONCURRENCIA || '2'));
    console.log(`\n🚀 Enviando ${tareas.length} factura(s) al paso ${pasoActual === 3 ? 'CFZ' : 'CNZ'} con concurrencia=${CONCURRENCIA}...`);

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
                const fallo = { consecutivo: t.consecutivo, tipo: t.tipo, ok: false, mensaje: r.reason?.message || 'Error desconocido', co: t.meta.co, caja: t.meta.caja };
                await logger.registrarResultado(fallo, t.meta);
                resultados.push(fallo);
                console.log(`❌ [${t.tipo} ${t.consecutivo}] ${r.reason?.message || 'Error desconocido'}`);
            }
        }
    }

    return resultados;
}

module.exports = { syncVentas: async (opciones = {}) => {
    // Resetear caché de inventario y costos al inicio de cada corrida
    _inventarioPromise = null;
    _inventarioData = null;
    _inventarioTimestamp = 0;
    _costoPromise = null;
    _costoData = null;
    _costoTimestamp = 0;
    // opciones.consecs: array opcional de consecs específicos para reprocesar.
    // Si se pasa, ignora LIMITE_FACTURAS y CONSEC_ESPECIFICOS del .env.
    const consecsOverride = Array.isArray(opciones.consecs) ? opciones.consecs : null;

    // opciones.co: string "001,003" para filtrar por CO (sobrescribe CO_FILTER del .env).
    // opciones.caja: string "P05,P03" para filtrar por tipo de caja (sobrescribe CAJA_FILTER del .env).
    // opciones.todas: true -> procesa TODAS las facturas filtradas (ignora LIMITE_FACTURAS).
    //   Pensado para el job automático: la idempotencia evita reprocesar las que ya están OK.
    // opciones.soloHoy: true -> solo facturas cuya FECHA_DOCTO sea HOY (zona America/Bogota).
    const filtrosCOCaja = {};
    if (opciones.co !== undefined && opciones.co !== null) filtrosCOCaja.co = opciones.co;
    if (opciones.caja !== undefined && opciones.caja !== null) filtrosCOCaja.caja = opciones.caja;
    if (opciones.todas === true) filtrosCOCaja.todas = true;
    if (opciones.soloHoy === true) filtrosCOCaja.soloHoy = true;

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

    // Orden de ejecución: en AMBOS entornos se procesa primero la Nota Crédito (CNZ,
    // simulación / paso 1) y luego la Factura real (CFZ, paso 3).
    const entornoSiesa = (process.env.ENTORNO_SIESA || 'QA').toUpperCase();
    
    let resCFZ = [];
    let resCNZ = [];
    
    if (entornoSiesa === 'PROD') {
        console.log("🌍 Entorno: PROD -> Ejecutando primero Notas Crédito (CNZ) y luego Facturas (CFZ)");
        resCNZ = (await ejecutarPaso(1, consecsOverride, filtrosCOCaja)) || []; // CNZ - Notas crédito
        resCFZ = (await ejecutarPaso(3, consecsOverride, filtrosCOCaja)) || []; // CFZ - Facturas de venta
    } else {
        console.log("🌍 Entorno: QA -> Ejecutando primero Notas Crédito (CNZ) y luego Facturas (CFZ)");
        resCNZ = (await ejecutarPaso(1, consecsOverride, filtrosCOCaja)) || []; // CNZ - Notas crédito
        resCFZ = (await ejecutarPaso(3, consecsOverride, filtrosCOCaja)) || []; // CFZ - Facturas de venta
    }

    // Orden del resumen = orden de ejecución (CNZ primero, luego CFZ) en ambos entornos.
    const todos = [...resCNZ, ...resCFZ];
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
