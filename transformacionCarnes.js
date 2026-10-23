// ============================================================================
//  transformacionCarnes.js — TRANSFORMACIÓN DIARIA TOCINO → CHICHARRÓN
// ============================================================================
//  Corre 1 vez al día (10pm COT). Toma las unidades NETAS vendidas del ítem 15207
//  (CHICHARRON MERKAHORRO, se vende por unidad) y registra en Siesa la transformación
//  de tocino (15202) a chicharrón por cada (fecha, CO, bodega):
//     1) ENTRADA (CEI): suma las unidades de chicharrón al inventario.
//     2) SALIDA  (CSA): descuenta el tocino consumido (unidades × factor, en KL).
//  Se envían como DOS llamadas separadas al conector 259946 (TRANSFORMACIONES_CARNES_DEV),
//  SIEMPRE la entrada primero.
//
//  Lectura de ventas: DOS queries de Connekta (Connekta falla con UNION ALL):
//     - merkahorro_venta_transformacion      (tablas vivas del POS, solo el día en curso)
//     - merkahorro_venta_transformacion_acum (tablas de acumulados, últimos 3 días)
//  Se concatenan y se deduplican por RowidMvto (un día puede estar en ambas durante el cierre).
//
//  Idempotencia: tabla Supabase `sps_transformaciones`, clave (fecha, co, bodega, item_venta,
//  tipo_dto). Un documento ya OK nunca se reenvía; si la entrada quedó OK y la salida falló,
//  el reintento envía solo la salida.
//
//  Ver DOCUMENTACION.md §26 para reglas de negocio, payload y variables de entorno.
// ============================================================================
const axios = require('axios');
const notifier = require('./notifier');
require('dotenv').config();

const CIA = process.env.CIA || '7375';

// ──────────────────────────────────────────────────────────
// ENTORNO DE ESCRITURA (switch propio, independiente de los otros flujos):
//   PROD → servicios.siesacloud.com
//   QA   → serviciosqa.siesacloud.com
// Default = QA. Para pasar ESTE flujo a producción: ENTORNO_SIESA_TRANSF=PROD.
// Connekta (lectura) SIEMPRE apunta a PRODUCCIÓN: es solo SELECT, los datos reales están ahí.
// ──────────────────────────────────────────────────────────
const ENTORNO = (process.env.ENTORNO_SIESA_TRANSF || 'QA').toUpperCase();
const SIESA_DOMAIN = ENTORNO === 'QA' ? 'serviciosqa.siesacloud.com' : 'servicios.siesacloud.com';
const CONNEKTA_DOMAIN = 'servicios.siesacloud.com'; // siempre PROD para lectura POS

// Conector de Siesa (configurable). 259946 = TRANSFORMACIONES_CARNES_DEV.
const ID_DOCUMENTO = process.env.TRANSF_ID_DOCUMENTO || '259946';
const NOMBRE_DOCUMENTO = process.env.TRANSF_NOMBRE_DOCUMENTO || 'TRANSFORMACIONES_CARNES_DEV';
const URL_SIESA_TRANSF = `https://${SIESA_DOMAIN}/api/siesa/v3.1/conectoresimportar?idCompania=${CIA}&idSistema=1&idDocumento=${ID_DOCUMENTO}&nombreDocumento=${NOMBRE_DOCUMENTO}`;

// Queries de Connekta (lectura). Ambas devuelven las mismas columnas.
const QUERY_VIVO = process.env.TRANSF_QUERY_VIVO || 'merkahorro_venta_transformacion';
const QUERY_ACUM = process.env.TRANSF_QUERY_ACUM || 'merkahorro_venta_transformacion_acum';
const urlConnekta = (descripcion) => `https://${CONNEKTA_DOMAIN}/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=${descripcion}`;

const TAM_PAGINA = parseInt(process.env.TRANSF_TAM_PAGINA || '1000');
const TOPE_PAGINAS = 2000; // tope duro de seguridad

const TABLA = 'sps_transformaciones';

// Clasificación de filas (se usan AMBOS campos juntos):
//   Venta:      ind_naturaleza = 2 y clase de documento 1231
//   Devolución: ind_naturaleza = 1 y clase de documento 1250 (nota crédito, tipo PN7)
const NATURALEZA_VENTA = 2;
const CLASE_VENTA = 1231;
const NATURALEZA_DEVOLUCION = 1;
const CLASE_DEVOLUCION = 1250;

// Parámetros fijos de cada documento enviado a Siesa.
const DOC_ENTRADA = { tipoDto: 'CEI', claseDto: '61', concepto: '601', motivo: '06' };
const DOC_SALIDA = { tipoDto: 'CSA', claseDto: '62', concepto: '602', motivo: '10' };

const MAPA_POR_DEFECTO = [
    { itemVenta: 15207, insumo: 15202, factor: 0.38, umVenta: 'UND', umInsumo: 'KL', unidadNegocio: '003', costoUnitario: 9873 }
];

console.log(`🌍 [transformacion] ENTORNO_SIESA_TRANSF=${ENTORNO} | Connekta=${CONNEKTA_DOMAIN} (lectura PROD) | Siesa=${SIESA_DOMAIN} (escritura)`);

// ──────────────────────────────────────────────────────────
// Utilidades puras
// ──────────────────────────────────────────────────────────
function formatDecimal(number) {
    if (number === null || number === undefined) return "000000000000000.0000";
    return parseFloat(number).toFixed(4).padStart(20, '0');
}

function redondear4(n) {
    return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

// Fecha de HOY en America/Bogota (NUNCA la fecha del servidor).
function fechaBogota() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
}

// Fecha y minutos-del-día actuales en America/Bogota, a partir de un instante dado (inyectable para pruebas).
function ahoraBogota(ahora = new Date()) {
    const partes = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
    }).formatToParts(ahora);
    const v = (tipo) => partes.find(p => p.type === tipo).value;
    return { fecha: `${v('year')}-${v('month')}-${v('day')}`, minutos: Number(v('hour')) * 60 + Number(v('minute')) };
}

// Antes de esta hora (COT) el día en curso está incompleto: procesarlo fijaría un neto parcial.
const MINUTO_MINIMO_DIA_EN_CURSO = 21 * 60 + 30;

// Guardia de fecha objetivo. Fechas pasadas: siempre OK. Futuras: error. Hoy (Bogotá) antes de las
// 21:30 COT: error, salvo dry-run.
function validarFechaObjetivo(fecha, dryRun, ahora = new Date()) {
    const hoy = ahoraBogota(ahora);
    if (fecha > hoy.fecha) {
        throw new Error(`Fecha futura ${fecha} (hoy en Bogotá es ${hoy.fecha}): no se procesa.`);
    }
    if (!dryRun && fecha === hoy.fecha && hoy.minutos < MINUTO_MINIMO_DIA_EN_CURSO) {
        throw new Error('no se procesa el día en curso antes de las 21:30 COT: el día está incompleto');
    }
}

// Filas sin RowidMvto: no se pueden deduplicar entre la query viva y la de acumulados.
function filasSinRowid(filas) {
    return filas.filter(f => f.RowidMvto === undefined || f.RowidMvto === null || String(f.RowidMvto).trim() === '');
}

function soloFecha(fechaDocto) {
    return (fechaDocto || '').toString().split('T')[0].trim();
}

function padItem(id) {
    return String(id).trim().padStart(7, '0');
}

// Lee y VALIDA el mapa de transformaciones. Falla de forma explícita si es inválido.
function cargarMapa(raw = process.env.TRANSF_MAPA) {
    let mapa;
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        mapa = MAPA_POR_DEFECTO;
    } else {
        try {
            mapa = JSON.parse(raw);
        } catch (e) {
            throw new Error(`TRANSF_MAPA no es un JSON válido: ${e.message}`);
        }
    }
    if (!Array.isArray(mapa) || mapa.length === 0) {
        throw new Error('TRANSF_MAPA debe ser un arreglo con al menos una transformación.');
    }
    const vistos = new Set();
    mapa.forEach((m, i) => {
        const ctx = `TRANSF_MAPA[${i}]`;
        if (!m || typeof m !== 'object') throw new Error(`${ctx} debe ser un objeto.`);
        for (const campo of ['itemVenta', 'insumo']) {
            if (!Number.isInteger(m[campo]) || m[campo] <= 0) throw new Error(`${ctx}.${campo} debe ser un entero positivo.`);
            if (String(m[campo]).length > 7) throw new Error(`${ctx}.${campo} excede 7 dígitos (límite del campo ITEM).`);
        }
        if (typeof m.factor !== 'number' || !Number.isFinite(m.factor) || m.factor <= 0) throw new Error(`${ctx}.factor debe ser un número mayor a 0.`);
        // Costo unitario de la ENTRADA (CEI): lo define contabilidad. Sin él Siesa rechaza con 46033
        // cuando el ítem no tiene costo promedio en la bodega.
        if (typeof m.costoUnitario !== 'number' || !Number.isFinite(m.costoUnitario) || m.costoUnitario <= 0) throw new Error(`${ctx}.costoUnitario debe ser un número mayor a 0.`);
        for (const campo of ['umVenta', 'umInsumo', 'unidadNegocio']) {
            if (typeof m[campo] !== 'string' || m[campo].trim() === '') throw new Error(`${ctx}.${campo} debe ser un texto no vacío.`);
        }
        if (vistos.has(m.itemVenta)) throw new Error(`${ctx}.itemVenta ${m.itemVenta} está repetido.`);
        vistos.add(m.itemVenta);
    });
    return mapa.map(m => ({
        nombre: (typeof m.nombre === 'string' && m.nombre.trim()) ? m.nombre.trim() : 'chicharron',
        itemVenta: m.itemVenta,
        insumo: m.insumo,
        factor: m.factor,
        costoUnitario: m.costoUnitario,
        umVenta: m.umVenta.trim(),
        umInsumo: m.umInsumo.trim(),
        unidadNegocio: m.unidadNegocio.trim()
    }));
}

// Deduplica por RowidMvto (el mismo movimiento puede venir de la query viva y de la de acumulados).
// Filas sin RowidMvto no se pueden deduplicar: se conservan todas.
function deduplicarPorRowid(filas) {
    const vistos = new Set();
    const resultado = [];
    for (const f of filas) {
        const clave = f.RowidMvto === undefined || f.RowidMvto === null ? null : String(f.RowidMvto).trim();
        if (clave) {
            if (vistos.has(clave)) continue;
            vistos.add(clave);
        }
        resultado.push(f);
    }
    return resultado;
}

function filtrarPorFecha(filas, fecha) {
    return filas.filter(f => soloFecha(f.FECHA_DOCTO) === fecha);
}

// 'VENTA' | 'DEVOLUCION' | null (no clasificable)
function clasificarFila(fila) {
    const naturaleza = Number(fila.ind_naturaleza);
    const clase = Number(fila.ID_CLASE_DOCTO);
    if (naturaleza === NATURALEZA_VENTA && clase === CLASE_VENTA) return 'VENTA';
    if (naturaleza === NATURALEZA_DEVOLUCION && clase === CLASE_DEVOLUCION) return 'DEVOLUCION';
    return null;
}

// Agrupa por (fecha, CoDoc, BODEGA, ítem) y calcula unidades netas = ventas − devoluciones.
// NO filtra por tipo de documento ni por cliente; suma líneas (nunca deduplica por documento).
function agruparNetos(filas, mapa) {
    const porItem = new Map(mapa.map(m => [m.itemVenta, m]));
    const grupos = new Map();
    const noClasificadas = [];
    const sinConfig = [];
    const advertenciasUM = [];

    for (const f of filas) {
        const cfg = porItem.get(Number(f.id_item));
        if (!cfg) { sinConfig.push(f); continue; }

        const clase = clasificarFila(f);
        if (!clase) { noClasificadas.push(f); continue; }

        const cantidad = Number(f.CANTIDAD);
        if (!Number.isFinite(cantidad)) { noClasificadas.push(f); continue; }

        const um = (f.UNIDAD_MEDIDA ?? '').toString().trim();
        if (um && um.toUpperCase() !== cfg.umVenta.toUpperCase()) advertenciasUM.push(f);

        const fecha = soloFecha(f.FECHA_DOCTO);
        const co = (f.CoDoc ?? '').toString().trim().padStart(3, '0');
        const bodega = (f.BODEGA ?? '').toString().trim();
        const clave = `${fecha}|${co}|${bodega}|${cfg.itemVenta}`;
        if (!grupos.has(clave)) {
            grupos.set(clave, { fecha, co, bodega, cfg, ventas: 0, devoluciones: 0, lineasVenta: 0, lineasDevolucion: 0 });
        }
        const g = grupos.get(clave);
        if (clase === 'VENTA') { g.ventas += cantidad; g.lineasVenta++; }
        else { g.devoluciones += cantidad; g.lineasDevolucion++; }
    }

    const lista = [...grupos.values()].map(g => ({
        ...g,
        ventas: redondear4(g.ventas),
        devoluciones: redondear4(g.devoluciones),
        neto: redondear4(g.ventas - g.devoluciones)
    })).sort((a, b) => (a.co + a.bodega).localeCompare(b.co + b.bodega));

    return { grupos: lista, noClasificadas, sinConfig, advertenciasUM };
}

function limpiarNumero(n) {
    return String(Number(redondear4(n)));
}

// Arma los dos documentos (entrada y salida) de un grupo. No envía nada.
// opciones.netoSalida: neto con el que se calcula la SALIDA (kg). Se usa cuando el CEI ya quedó OK
// en una corrida previa: el CSA debe corresponder a lo que realmente se registró en la entrada.
function construirPayloads(grupo, opciones = {}) {
    const { fecha, co, bodega, cfg, neto } = grupo;
    const fechaSiesa = fecha.replace(/-/g, '');
    const netoSalida = Number.isFinite(opciones.netoSalida) ? opciones.netoSalida : neto;
    const kilos = redondear4(netoSalida * cfg.factor);
    const base = `Transformacion ${cfg.nombre} ${fecha} CO ${co}`;

    // `extra`: campos adicionales del movimiento. El conector exige COSTO_PROMEDIO_UNITARIO en TODOS los
    // movimientos (CEI y CSA comparten conector): la entrada envía el costo real; la salida envía 0 y
    // Siesa la valoriza con el costo promedio del insumo.
    const armar = (def, item, um, cantidad, nota, extra = {}) => ({
        Documentos: [{
            "TIPO_DTO": def.tipoDto,
            "FECHA_DOCUMENTO=8 (AAAAMMDD)": fechaSiesa,
            "CLASE_DTO": def.claseDto,
            "NOTA": nota,
            "CONCEPTO": def.concepto
        }],
        Movimientos: [{
            "TIPO_DTO": def.tipoDto,
            "CONSECUTIVO": "0",
            "NRO_REGISTRO": "1",
            "BODEGA": bodega,
            "CONCEPTO": def.concepto,
            "MOTIVO": def.motivo,
            "CENTRO_OPERA_MOVIMIENTO": co,
            "UNIDAD_MEDIDA": um,
            "CANTIDAD": formatDecimal(cantidad),
            "ITEM": padItem(item),
            "UNIDAD_NEGOCIO": cfg.unidadNegocio,
            ...extra
        }]
    });

    return {
        entrada: {
            tipoDto: DOC_ENTRADA.tipoDto,
            cantidad: neto,
            payload: armar(DOC_ENTRADA, cfg.itemVenta, cfg.umVenta, neto, `${base} - ${limpiarNumero(neto)} ${cfg.umVenta.toLowerCase()}`,
                { "COSTO_PROMEDIO_UNITARIO": formatDecimal(cfg.costoUnitario) })
        },
        salida: {
            tipoDto: DOC_SALIDA.tipoDto,
            cantidad: kilos,
            payload: armar(DOC_SALIDA, cfg.insumo, cfg.umInsumo, kilos, `${base} - ${limpiarNumero(kilos)} ${cfg.umInsumo.toLowerCase()}`,
                { "COSTO_PROMEDIO_UNITARIO": formatDecimal(0) })
        }
    };
}

// ──────────────────────────────────────────────────────────
// Lectura de Connekta (paginada completa, secuencial)
// ──────────────────────────────────────────────────────────
async function fetchPagina(baseUrl, pagina) {
    const url = `${baseUrl}&paginacion=numPag=${pagina}|tamPag=${TAM_PAGINA}`;
    const response = await axios.get(url, {
        headers: { 'ConniKey': process.env.CONNI_KEY, 'ConniToken': process.env.CONNI_TOKEN },
        timeout: 60000
    });
    const data = response.data;
    if (data.detalle && data.detalle.Datos) return data.detalle.Datos;
    if (data.detalle && data.detalle.Table) return data.detalle.Table;
    if (data.Table) return data.Table;
    return [];
}

async function fetchPaginaConReintento(baseUrl, pagina, etiqueta) {
    const MAX_REINTENTOS = 3;
    for (let intento = 1; intento <= MAX_REINTENTOS; intento++) {
        try {
            return await fetchPagina(baseUrl, pagina);
        } catch (error) {
            console.warn(`⚠️ ${etiqueta} pág ${pagina} (intento ${intento}/${MAX_REINTENTOS}): ${error.message}`);
            if (intento === MAX_REINTENTOS) {
                // Un total parcial produciría unidades netas incorrectas: se aborta, no se omite la página.
                throw new Error(`${etiqueta}: Connekta falló en la página ${pagina} tras ${MAX_REINTENTOS} intentos (${error.message}).`);
            }
            await new Promise(r => setTimeout(r, 1000 * intento));
        }
    }
    return [];
}

async function fetchPaginadoCompleto(baseUrl, etiqueta) {
    const todas = [];
    for (let pagina = 1; pagina <= TOPE_PAGINAS; pagina++) {
        const registros = await fetchPaginaConReintento(baseUrl, pagina, etiqueta);
        todas.push(...registros);
        if (registros.length < TAM_PAGINA) break; // última página (o vacía)
    }
    console.log(`   📦 ${etiqueta}: ${todas.length} registros.`);
    return todas;
}

// ──────────────────────────────────────────────────────────
// Persistencia (Supabase) — se carga de forma perezosa para que las funciones puras
// puedan usarse sin credenciales.
// ──────────────────────────────────────────────────────────
function getSupabase() {
    return require('./logger').supabase;
}

async function cargarEstadoDia(fecha) {
    const { data, error } = await getSupabase().from(TABLA).select('*').eq('fecha', fecha).eq('entorno', ENTORNO);
    if (error) throw new Error(`No se pudo leer ${TABLA}: ${error.message}`);
    const mapa = new Map();
    (data || []).forEach(r => mapa.set(`${r.co}|${r.bodega}|${r.item_venta}|${r.tipo_dto}`, r));
    return mapa;
}

async function guardarResultado(fila) {
    const { error } = await getSupabase().from(TABLA).upsert(fila, { onConflict: 'entorno,fecha,co,bodega,item_venta,tipo_dto' });
    if (error) throw new Error(`No se pudo guardar en ${TABLA}: ${error.message}`);
}

// Guardado con reintentos (3 intentos, espera 1s y 2s entre ellos). Si el último falla, lanza.
// `guardar` y `esperar` son inyectables para pruebas.
async function guardarConReintento(fila, guardar = guardarResultado, esperar = (ms) => new Promise(r => setTimeout(r, ms))) {
    const MAX_INTENTOS = 3;
    for (let intento = 1; intento <= MAX_INTENTOS; intento++) {
        try {
            return await guardar(fila);
        } catch (e) {
            console.warn(`   ⚠️ Guardado en ${TABLA} falló (intento ${intento}/${MAX_INTENTOS}): ${e.message}`);
            if (intento === MAX_INTENTOS) throw e;
            await esperar(1000 * intento);
        }
    }
}

// ──────────────────────────────────────────────────────────
// Envío a Siesa
// ──────────────────────────────────────────────────────────
const MARCA_AMBIGUO = 'AMBIGUO';
const INSTRUCCION_AMBIGUO = 'verificar manualmente en Siesa si el documento existe antes de reenviar; borrar la fila de sps_transformaciones para permitir el reenvío';

// Clasifica un error de axios al POST a Siesa.
//   DEFINITIVO (Siesa rechazó, el documento NO se creó): hay respuesta Y (status 4xx O detalle estructurado no vacío).
//   AMBIGUO (no sabemos si Siesa lo creó): sin respuesta, timeout, ECONNRESET, 5xx sin detalle estructurado.
function clasificarErrorSiesa(error) {
    const response = error && error.response;
    const data = response && response.data;
    const detalleEstructurado = !!data && Array.isArray(data.detalle) && data.detalle.length > 0;
    const status = response ? Number(response.status) : null;
    const definitivo = !!response && ((status >= 400 && status <= 499) || detalleEstructurado);

    let mensaje = error && error.message ? error.message : String(error);
    if (data) {
        mensaje = detalleEstructurado
            ? data.detalle.map(d => [d.f_detalle, d.f_valor].filter(Boolean).join(' ')).join(' | ')
            : (typeof data === 'string' ? data : JSON.stringify(data));
    }
    return { ok: false, ambiguo: !definitivo, respuesta: data || null, mensaje };
}

async function enviarASiesa(payload) {
    try {
        const response = await axios.post(URL_SIESA_TRANSF, payload, {
            headers: {
                'ConniKey': process.env.CONNI_KEY,
                'ConniToken': process.env.CONNI_TOKEN,
                'Content-Type': 'application/json'
            },
            timeout: 120000
        });
        return { ok: true, ambiguo: false, respuesta: response.data, mensaje: (response.data && response.data.mensaje) || 'OK' };
    } catch (error) {
        // PENDIENTE: decisión de negocio sobre tocino insuficiente (Siesa rechaza con
        // "Item sin cantidad disponible"). Hoy NO hay manejo especial: se registra el error
        // y se notifica. Definir si se inyecta stock (como el CPE del flujo 011) o se omite.
        return clasificarErrorSiesa(error);
    }
}

// ──────────────────────────────────────────────────────────
// Flujo principal
// ──────────────────────────────────────────────────────────
async function transformacionCarnes(opciones = {}) {
    const fecha = (opciones.fecha || process.env.TRANSF_FECHA || fechaBogota()).toString().trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new Error(`Fecha inválida "${fecha}" (se espera YYYY-MM-DD).`);
    const dryRun = opciones.dryRun === true || ['1', 'true'].includes((process.env.TRANSF_DRY_RUN || '').toLowerCase());
    // Guardia de fecha: antes de leer/enviar nada (opciones.ahora permite inyectar la hora en pruebas).
    validarFechaObjetivo(fecha, dryRun, opciones.ahora || new Date());
    const mapa = cargarMapa();

    console.log("==========================================");
    console.log("🥓 TRANSFORMACIÓN TOCINO → CHICHARRÓN");
    console.log(`   Fecha=${fecha} | Entorno=${ENTORNO} | DryRun=${dryRun ? 'SÍ' : 'no'}`);
    console.log(`   Mapa=${JSON.stringify(mapa)}`);
    console.log("==========================================");

    // 1) Leer ventas (dos queries, concatenar, deduplicar por RowidMvto).
    const vivo = await fetchPaginadoCompleto(urlConnekta(QUERY_VIVO), 'TransfVivo');
    const acum = await fetchPaginadoCompleto(urlConnekta(QUERY_ACUM), 'TransfAcum');
    const todas = [...(Array.isArray(vivo) ? vivo : []), ...(Array.isArray(acum) ? acum : [])];
    const unicas = deduplicarPorRowid(todas);
    console.log(`📊 Filas: vivo=${vivo.length} + acum=${acum.length} = ${todas.length} → ${unicas.length} únicas por RowidMvto`);

    const alertas = { sinFilas: false, noClasificadas: [], sinConfig: [], advertenciasUM: [], netoNoPositivo: [], erroresSiesa: [], erroresGuardado: [], ambiguos: [], netoCambiado: [] };
    // El notifier solo renderiza listas conocidas: los casos `ambiguos` y `netoCambiado` se reflejan
    // además en `erroresSiesa` con un mensaje explícito (sin tocar notifier.js).

    if (unicas.length === 0) {
        alertas.sinFilas = true;
        console.warn('⚠️ Las dos queries devolvieron 0 filas.');
        console.warn('   Causa probable: el POS ya cerró el día y vació las tablas vivas, y la query de acumulados aún no lo trae.');
    }

    // 2) Filtrar por día objetivo y agrupar.
    const delDia = filtrarPorFecha(unicas, fecha);
    if (unicas.length > 0 && delDia.length === 0) {
        const dias = [...new Set(unicas.map(f => soloFecha(f.FECHA_DOCTO)).filter(Boolean))].sort();
        console.warn(`⚠️ Hay filas pero ninguna del día ${fecha}. Días disponibles: ${dias.join(', ')}`);
    }
    // Sin RowidMvto la deduplicación queda deshabilitada para esas filas → riesgo de doble conteo.
    const sinRowid = filasSinRowid(delDia);
    if (sinRowid.length > 0) {
        const msg = `${sinRowid.length} fila(s) del día ${fecha} sin RowidMvto (no se pueden deduplicar entre la query viva y la de acumulados).`;
        if (!dryRun) throw new Error(`${msg} No se envía nada para evitar doble conteo.`);
        console.warn(`⚠️ [dry-run] ${msg}`);
    }
    const { grupos, noClasificadas, sinConfig, advertenciasUM } = agruparNetos(delDia, mapa);
    alertas.noClasificadas = noClasificadas;
    alertas.sinConfig = sinConfig;
    alertas.advertenciasUM = advertenciasUM;

    console.log(`🧮 Filas del día=${delDia.length} | Grupos=${grupos.length} | No clasificadas=${noClasificadas.length} | Ítem sin config=${sinConfig.length}`);
    noClasificadas.forEach(f => console.warn(`   ⚠️ NO CONTADA: ${f.ID_TIPO_DOCTO} ${f.CONSEC_DOCTO} item ${f.id_item} naturaleza=${f.ind_naturaleza} clase=${f.ID_CLASE_DOCTO} cant=${f.CANTIDAD}`));

    // 3) Estado previo (idempotencia).
    let estado = new Map();
    try {
        estado = await cargarEstadoDia(fecha);
    } catch (e) {
        if (!dryRun) throw e; // en producción NO se envía sin saber qué ya se envió
        console.warn(`⚠️ [dry-run] No se pudo leer el estado previo (${e.message}). Se asume vacío.`);
    }

    // 4) Procesar cada grupo.
    const detalle = [];
    let abortarCorrida = false; // se activa si Siesa aceptó pero no se pudo registrar: no se envía nada más
    for (const g of grupos) {
        if (abortarCorrida) break;
        const resumen = {
            fecha: g.fecha, co: g.co, bodega: g.bodega, item: g.cfg.itemVenta,
            ventas: g.ventas, devoluciones: g.devoluciones, unidades: g.neto,
            kilos: redondear4(g.neto * g.cfg.factor), entrada: 'NO_ENVIADO', salida: 'NO_ENVIADO', error: null
        };
        detalle.push(resumen);
        console.log(`\n📦 [CO ${g.co} | ${g.bodega} | item ${g.cfg.itemVenta}] ventas=${g.ventas} devoluciones=${g.devoluciones} neto=${g.neto} und → ${resumen.kilos} ${g.cfg.umInsumo}`);

        if (g.neto <= 0) {
            resumen.entrada = resumen.salida = 'NETO_NO_POSITIVO';
            alertas.netoNoPositivo.push(resumen);
            console.warn(`   ⚠️ Neto ≤ 0: no se envía nada para este grupo.`);
            continue;
        }

        // S1: si el CEI ya quedó OK en una corrida previa, el CSA se calcula con el neto de ESE CEI
        // (no con el neto actual), para que la salida de tocino corresponda a la entrada registrada.
        const previoCei = estado.get(`${g.co}|${g.bodega}|${g.cfg.itemVenta}|${DOC_ENTRADA.tipoDto}`);
        const netoCeiPrevio = previoCei && previoCei.status === 'OK' ? Number(previoCei.unidades_netas) : NaN;
        const docs = construirPayloads(g, { netoSalida: netoCeiPrevio });
        resumen.kilos = docs.salida.cantidad;
        for (const [rol, doc] of [['entrada', docs.entrada], ['salida', docs.salida]]) {
            const claveEstado = `${g.co}|${g.bodega}|${g.cfg.itemVenta}|${doc.tipoDto}`;
            const previo = estado.get(claveEstado);

            if (previo && previo.status === 'OK') {
                resumen[rol] = 'YA_OK';
                console.log(`   ⏭️ ${doc.tipoDto} ya estaba OK (${previo.unidades_netas} und). No se reenvía.`);
                if (Number(previo.unidades_netas) !== g.neto) {
                    const msg = `Las unidades netas cambiaron desde el envío de ${doc.tipoDto} (${previo.unidades_netas} → ${g.neto} und). No se corrige automáticamente: revisar a mano.`;
                    console.warn(`   ⚠️ ${msg}`);
                    alertas.netoCambiado.push({ co: g.co, bodega: g.bodega, tipo: doc.tipoDto, previo: Number(previo.unidades_netas), actual: g.neto });
                    alertas.erroresSiesa.push({ co: g.co, bodega: g.bodega, tipo: `${doc.tipoDto} (AVISO, no es rechazo)`, error: msg });
                }
                continue;
            }

            // Resultado ambiguo de una corrida previa: NO se reenvía solo (podría duplicar el documento).
            if (previo && previo.status === 'ERROR' && String(previo.error || '').startsWith(MARCA_AMBIGUO)) {
                resumen[rol] = 'AMBIGUO';
                resumen.error = `${doc.tipoDto}: ${previo.error}`;
                const msg = `AMBIGUO (corrida previa): ${INSTRUCCION_AMBIGUO}. Detalle: ${String(previo.error).slice(0, 150)}`;
                console.error(`   🚨 ${doc.tipoDto} quedó con resultado AMBIGUO en una corrida previa. No se reenvía: ${INSTRUCCION_AMBIGUO}.`);
                alertas.ambiguos.push({ co: g.co, bodega: g.bodega, tipo: doc.tipoDto, error: previo.error, previo: true });
                alertas.erroresSiesa.push({ co: g.co, bodega: g.bodega, tipo: `${doc.tipoDto} AMBIGUO`, error: msg });
                continue;
            }

            // La salida solo se envía si la entrada quedó OK (ahora o en una corrida previa).
            if (rol === 'salida' && !['OK', 'YA_OK'].includes(resumen.entrada) && !dryRun) {
                resumen.salida = 'OMITIDO_ENTRADA_FALLO';
                console.warn(`   ⚠️ Se omite ${doc.tipoDto}: la entrada no quedó OK.`);
                continue;
            }

            console.log(`   📤 ${doc.tipoDto} cantidad=${doc.payload.Movimientos[0].CANTIDAD} bodega=${g.bodega}`);
            if (dryRun) {
                resumen[rol] = 'DRY_RUN';
                console.log(`   🧪 [dry-run] Payload ${doc.tipoDto}:\n${JSON.stringify(doc.payload, null, 2)}`);
                continue;
            }

            const res = await enviarASiesa(doc.payload);
            resumen[rol] = res.ok ? 'OK' : (res.ambiguo ? 'AMBIGUO' : 'ERROR');
            // Texto que se guarda en la columna `error` (la marca AMBIGUO vive aquí, sin migración).
            const errorGuardado = res.ok ? null : (res.ambiguo ? `${MARCA_AMBIGUO}: ${res.mensaje}` : res.mensaje);
            if (res.ok) {
                console.log(`   ✅ ${doc.tipoDto} OK: ${res.mensaje}`);
            } else if (res.ambiguo) {
                console.error(`   🚨 ${doc.tipoDto} resultado AMBIGUO (sin respuesta definitiva de Siesa): ${res.mensaje}`);
                console.error(`   🚨 ${INSTRUCCION_AMBIGUO}.`);
                resumen.error = `${doc.tipoDto}: ${errorGuardado}`;
                alertas.ambiguos.push({ co: g.co, bodega: g.bodega, tipo: doc.tipoDto, error: errorGuardado, previo: false });
                alertas.erroresSiesa.push({
                    co: g.co, bodega: g.bodega, tipo: `${doc.tipoDto} AMBIGUO`,
                    error: `AMBIGUO: ${INSTRUCCION_AMBIGUO}. Detalle: ${String(res.mensaje).slice(0, 150)}`
                });
            } else {
                console.error(`   ❌ ${doc.tipoDto} rechazado por Siesa: ${res.mensaje}`);
                resumen.error = `${doc.tipoDto}: ${res.mensaje}`;
                alertas.erroresSiesa.push({ co: g.co, bodega: g.bodega, tipo: doc.tipoDto, error: res.mensaje });
            }

            const filaGuardar = {
                fecha: g.fecha, co: g.co, bodega: g.bodega, item_venta: g.cfg.itemVenta, tipo_dto: doc.tipoDto,
                status: res.ok ? 'OK' : 'ERROR',
                unidades_netas: g.neto, cantidad: doc.cantidad,
                payload: doc.payload, respuesta: res.respuesta,
                error: errorGuardado,
                intentos: (previo ? previo.intentos : 0) + 1,
                entorno: ENTORNO,
                updated_at: new Date().toISOString()
            };
            // Respaldo en el log ANTES de guardar: permite conciliar a mano desde GitHub si Supabase falla.
            console.log(`   🧾 [RESPALDO ${doc.tipoDto} CO ${g.co} ${g.bodega}] fila a guardar: ${JSON.stringify(filaGuardar)}`);
            console.log(`   🧾 [RESPALDO ${doc.tipoDto} CO ${g.co} ${g.bodega}] respuesta Siesa: ${JSON.stringify(res.respuesta)}`);

            try {
                await guardarConReintento(filaGuardar);
            } catch (e) {
                // Crítico: si Siesa aceptó (o el resultado es ambiguo) y no se pudo registrar, un reintento
                // duplicaría el documento. Se detiene TODO el resto de la corrida.
                const riesgoDuplicado = res.ok || res.ambiguo;
                console.error(`   🚨 ${e.message}${res.ok ? ' — Siesa SÍ aceptó el documento: NO reenviar a mano.' : ''}`);
                alertas.erroresGuardado.push({ co: g.co, bodega: g.bodega, tipo: doc.tipoDto, ok: res.ok, error: e.message });
                if (riesgoDuplicado) {
                    abortarCorrida = true;
                    console.error('   🛑 Se aborta el resto de la corrida (no se envía ningún documento más). Conciliar con las líneas RESPALDO del log.');
                    break;
                }
            }
        }
    }
    if (abortarCorrida) {
        const pendientes = grupos.length - detalle.length;
        if (pendientes > 0) console.error(`🛑 Corrida abortada: ${pendientes} grupo(s) sin procesar.`);
    }

    // 5) Resumen y notificación.
    const fallos = detalle.filter(d => ['ERROR', 'AMBIGUO'].includes(d.entrada) || ['ERROR', 'AMBIGUO', 'OMITIDO_ENTRADA_FALLO'].includes(d.salida)).length;
    const totalUnidades = redondear4(detalle.reduce((s, d) => s + (d.unidades > 0 ? d.unidades : 0), 0));
    const totalKilos = redondear4(detalle.reduce((s, d) => s + (d.unidades > 0 ? d.kilos : 0), 0));
    console.log("\n==========================================");
    console.log(`📊 RESUMEN TRANSFORMACIÓN ${fecha}: grupos=${detalle.length} | unidades=${totalUnidades} | kg=${totalKilos} | con fallo=${fallos}`);
    detalle.forEach(d => console.log(`  [CO ${d.co} ${d.bodega}] ${d.unidades} und → ${d.kilos} kg | CEI=${d.entrada} CSA=${d.salida}${d.error ? ' | ' + d.error : ''}`));
    console.log("==========================================\n");

    const resultado = { fecha, entorno: ENTORNO, dryRun, grupos: detalle.length, fallos, totalUnidades, totalKilos, detalle, alertas };

    if (dryRun) {
        console.log('🧪 DRY-RUN: no se envió nada a Siesa, no se escribió en Supabase y no se envía correo.');
    } else {
        try {
            await notifier.sendTransformacionNotification(resultado);
        } catch (e) {
            console.error(`⚠️ Error en notificación de transformación: ${e.message}`);
        }
    }
    return resultado;
}

module.exports = {
    transformacionCarnes,
    // Funciones puras exportadas para verificación
    cargarMapa,
    deduplicarPorRowid,
    filtrarPorFecha,
    clasificarFila,
    agruparNetos,
    construirPayloads,
    formatDecimal,
    fechaBogota,
    ahoraBogota,
    validarFechaObjetivo,
    filasSinRowid,
    clasificarErrorSiesa,
    guardarConReintento,
};
