// ============================================================================
//  transformacionNegativos.js - NEGATIVE INVENTORY TRANSFORMATION (I/O orchestrator)
// ============================================================================
//  Clears negative stock of destination meat items. For every STORE (co, bodega) with negative destination items it
//  sends ONE CEI document (entry, one line per negative destination) and ONE CSA document (exit, one line per origin
//  item, aggregated across the destinations of the store). Both are built by the pure per-store planner
//  (transformacionNegativosPlan.js) and sent by the per-document sender (transformacionNegativosEnvio.js), which
//  corrects Siesa "Faltante Inv." rejections (adjust, then drop lines). Documents go to the same Siesa connector as
//  the tocino job.
//
//  All I/O goes through the injectable `deps` argument so the state machine can be tested with fakes; the pure
//  decisions (resume, batching, colour of the job) live in transformacionNegativosFlujo.js.
//  The tocino job (transformacionCarnes.js) is NOT modified: only its exported helpers are reused.
//
//  State machine per document row (table sps_transformaciones_negativos_docs, migration 010):
//  PLANNED -> SENDING -> OK | ERROR | AMBIGUO (+ CANCELADO for stale prior-day documents).
//  The legacy per-destination table (sps_transformaciones_negativos) is read-only history: it is only read to
//  skip/block destinations the legacy flow already owns (cutover), never written.
// ============================================================================
const axios = require('axios');
const notifier = require('./notifier');
const { trazaCorrida, insertarTolerante } = require('./corridaTraza');
const {
    fechaBogota, ahoraBogota, validarFechaObjetivo, clasificarErrorSiesa, registrarCorrida, ENTORNO
} = require('./transformacionCarnes');
const {
    planificarNegativosPorTienda, UNIDAD_NEGOCIO_POR_DEFECTO, resolverPermitirDiaEnCurso, parsearCosFiltro
} = require('./transformacionNegativosPlan');
const { enviarTienda, falloSistemico, guardarConReintento } = require('./transformacionNegativosEnvio');
const {
    INSTRUCCION_AMBIGUO, agruparPorTienda, coPermitido, esTablaFaltante, guardarPlanPorPares, planificarReanudacion,
    detectarPlanIncompleto, calcularFallos, recolectarNovedades, describirDocumento, filaDetalle, idDoc
} = require('./transformacionNegativosFlujo');

const CIA = process.env.CIA || '7375';
const SIESA_DOMAIN = ENTORNO === 'QA' ? 'serviciosqa.siesacloud.com' : 'servicios.siesacloud.com';
const CONNEKTA_DOMAIN = 'servicios.siesacloud.com'; // read-only queries always hit PROD
const ID_DOCUMENTO = process.env.TRANSF_ID_DOCUMENTO || '259946';
const NOMBRE_DOCUMENTO = process.env.TRANSF_NOMBRE_DOCUMENTO || 'TRANSFORMACIONES_CARNES_DEV';
const URL_SIESA_TRANSF = `https://${SIESA_DOMAIN}/api/siesa/v3.1/conectoresimportar?idCompania=${CIA}&idSistema=1&idDocumento=${ID_DOCUMENTO}&nombreDocumento=${NOMBRE_DOCUMENTO}`;

const QUERY_INVENTARIO_POR_DEFECTO = 'merkahorro_items_inventario_costo_dev_transformaciones';
const COLUMNAS_POR_DEFECTO = {
    co: 'IDCO', bodega: 'IdBodega', item: 'CodigoItem',
    disponible: 'CantidadDisponible', costo: 'CostoPromUnitInst', um: 'UM'
};
const DIAS_REANUDAR_POR_DEFECTO = 7;
const TAM_PAGINA = parseInt(process.env.TRANSF_TAM_PAGINA || '1000');
const TOPE_PAGINAS = 2000;

const TABLA_LEGADO = 'sps_transformaciones_negativos';          // read-only history (legacy per-destination rows)
const TABLA_DOCS = 'sps_transformaciones_negativos_docs';       // per-store documents (migration 010)
const TABLA_CORRIDAS = 'sps_transformaciones_negativos_corridas';
const CONFLICTO_DOCS = 'entorno,fecha,co,bodega,tipo_dto';

const MOTIVO_CEI_POSIBLEMENTE_ENVIADO = 'CEI possibly sent, CSAs blocked, manual review';
const ESTADOS_ENVIABLES = ['PLANNED', 'ERROR'];

// ──────────────────────────────────────────────────────────
// Pure helpers
// ──────────────────────────────────────────────────────────
function numero(v) {
    if (v === null || v === undefined || String(v).trim() === '') return NaN;
    return Number(v);
}

// Maps raw Connekta rows to the planner shape { co, bodega, item, disponible, costo, um }.
// Column names are isolated in `columnas` (override with TRANSF_NEG_COLUMNAS).
function mapearInventario(filas, columnas = {}) {
    const c = { ...COLUMNAS_POR_DEFECTO, ...columnas };
    const resultado = [];
    let descartadas = 0;
    for (const r of filas || []) {
        const item = numero(r[c.item]);
        const disponible = numero(r[c.disponible]);
        if (!Number.isFinite(item) || !Number.isFinite(disponible)) { descartadas++; continue; }
        const costo = numero(r[c.costo]);
        resultado.push({
            co: String(r[c.co] ?? '').trim().padStart(3, '0'),
            bodega: String(r[c.bodega] ?? '').trim(),
            item,
            disponible,
            costo: Number.isFinite(costo) ? costo : null,
            um: String(r[c.um] ?? '').trim()
        });
    }
    return { filas: resultado, descartadas };
}

function restarDias(fecha, dias) {
    const d = new Date(`${fecha}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - dias);
    return d.toISOString().slice(0, 10);
}


// TRANSF_NEG_ITEMS_EXCLUIDOS: comma separated integer item codes that ADD to the default exclusions.
// A token that is not an integer item code is a configuration error (fail fast, never silently dropped).
function parseLista(raw) {
    if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
    return String(raw).split(',').map(s => s.trim()).filter(s => s !== '').map(t => {
        if (!/^\d+$/.test(t) || !Number.isSafeInteger(Number(t))) {
            throw new Error(`TRANSF_NEG_ITEMS_EXCLUIDOS has an invalid item code "${t}": expected comma separated integers.`);
        }
        return Number(t);
    });
}

function leerConfig(opciones) {
    let columnas = opciones.columnas;
    if (columnas === undefined && process.env.TRANSF_NEG_COLUMNAS) {
        try {
            columnas = JSON.parse(process.env.TRANSF_NEG_COLUMNAS);
        } catch (e) {
            throw new Error(`TRANSF_NEG_COLUMNAS is not valid JSON: ${e.message}`);
        }
    }
    // The env var wins over the default; an explicitly blank value is a configuration error (fail fast).
    let queryInventario = opciones.queryInventario;
    if (queryInventario === undefined) {
        queryInventario = process.env.TRANSF_NEG_QUERY_INVENTARIO !== undefined
            ? process.env.TRANSF_NEG_QUERY_INVENTARIO
            : QUERY_INVENTARIO_POR_DEFECTO;
    }
    const dias = opciones.diasReanudar !== undefined
        ? opciones.diasReanudar
        : parseInt(process.env.TRANSF_NEG_DIAS_REANUDAR || String(DIAS_REANUDAR_POR_DEFECTO));
    return {
        queryInventario: String(queryInventario).trim(),
        columnas: columnas || {},
        excluidos: opciones.excluidos !== undefined ? opciones.excluidos : parseLista(process.env.TRANSF_NEG_ITEMS_EXCLUIDOS),
        diasReanudar: Number.isFinite(dias) && dias >= 0 ? dias : DIAS_REANUDAR_POR_DEFECTO,
        unidadNegocio: opciones.unidadNegocio || process.env.TRANSF_NEG_UNIDAD_NEGOCIO || UNIDAD_NEGOCIO_POR_DEFECTO,
        // TRANSF_NEG_COS: comma separated CO ids to process (empty = every store). Used for the first limited send.
        cos: parsearCosFiltro(opciones.cos !== undefined ? opciones.cos : process.env.TRANSF_NEG_COS)
    };
}

// Pure: builds the run record row (table sps_transformaciones_negativos_corridas).
// The table has no pages/rows columns, so the inventory read stats travel in `mensaje`.
function resumirCorridaNegativos(resultado, meta = {}) {
    const a = resultado.alertas || {};
    let estado;
    if ((resultado.fallos || 0) > 0 || (a.erroresGuardado || []).length > 0) estado = 'CON_FALLO';
    else if ((resultado.destinos || 0) === 0 && (resultado.documentos || 0) === 0) estado = 'SIN_NEGATIVOS';
    else estado = 'PROCESADO';

    const partes = [`mode=${resultado.modo}`, `destinations=${resultado.destinos}`, `documents_ok=${resultado.documentos}`, `failures=${resultado.fallos}`, `novedades=${(a.novedades || []).length}`];
    if (meta.filasInventario !== undefined && meta.filasInventario !== null) {
        partes.push(`inventory_rows=${meta.filasInventario}`, `inventory_pages=${meta.paginasInventario}`);
    }
    if (resultado.abortada) partes.push('ABORTED');
    return {
        fecha: resultado.fecha,
        entorno: resultado.entorno,
        resultado: estado,
        destinos: resultado.destinos || 0,
        documentos: resultado.documentos || 0,
        omitidos: (a.omitidos || []).length + (a.errores || []).length,
        ambiguos: (a.ambiguos || []).length,
        fallos: resultado.fallos || 0,
        mensaje: partes.join(' | ').slice(0, 500),
        origen: meta.origen ?? null
    };
}

// ──────────────────────────────────────────────────────────
// Default I/O (Supabase / Connekta / Siesa). Lazy so the module can be imported without credentials.
// ──────────────────────────────────────────────────────────
function getSupabase() {
    return require('./logger').supabase;
}

// Server-managed and in-memory-only fields never travel in an upsert.
function sinCamposDeServidor(fila) {
    const { id, created_at, posiblementeEnviado, ...resto } = fila;
    return resto;
}

async function cargarReglasDefault() {
    const sb = getSupabase();
    const eq = await sb.from('sps_transformaciones_equivalencias').select('item_origen,item_destino,activo');
    if (eq.error) throw new Error(`Could not read equivalences: ${eq.error.message}`);
    const pr = await sb.from('sps_transformaciones_prioridad').select('item_origen,orden,activo');
    if (pr.error) throw new Error(`Could not read priority: ${pr.error.message}`);
    return { equivalencias: eq.data || [], prioridad: pr.data || [] };
}

async function leerVentanaPaginada(tabla, { entorno, desde, hasta }) {
    const sb = getSupabase();
    const TAM = 1000;
    const todas = [];
    for (let desdeFila = 0; ; desdeFila += TAM) {
        const { data, error } = await sb.from(tabla).select('*')
            .eq('entorno', entorno).gte('fecha', desde).lte('fecha', hasta)
            .order('id', { ascending: true }).range(desdeFila, desdeFila + TAM - 1);
        if (error) throw Object.assign(new Error(`Could not read ${tabla}: ${error.message}`), { code: error.code });
        todas.push(...(data || []));
        if (!data || data.length < TAM) break;
    }
    return todas;
}

const cargarDocsDefault = (ventana) => leerVentanaPaginada(TABLA_DOCS, ventana);
// Legacy per-destination rows: read-only, used only for the cutover rules.
const cargarLegadoDefault = (ventana) => leerVentanaPaginada(TABLA_LEGADO, ventana);

async function upsertDocs(filas) {
    const { error, status } = await getSupabase().from(TABLA_DOCS).upsert(filas.map(sinCamposDeServidor), { onConflict: CONFLICTO_DOCS });
    if (error) throw Object.assign(new Error(`Could not save to ${TABLA_DOCS}: ${error.message}`), { code: error.code, status });
}

// One document row (state changes during the send loop).
const guardarDocDefault = (fila) => upsertDocs([fila]);

// One upsert call with a batch of whole store pairs; batching/halving is done by guardarPlanPorPares.
const guardarLoteDefault = (filas) => upsertDocs(filas);

async function insertarCorridaDefault(fila) {
    // Tolerant to migration 009 not being applied yet (retries once without the trace columns).
    await insertarTolerante(async (f) => {
        const { error } = await getSupabase().from(TABLA_CORRIDAS).insert(f);
        if (error) throw Object.assign(new Error(error.message), { code: error.code });
    }, fila);
}

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
    const MAX = 3;
    for (let intento = 1; intento <= MAX; intento++) {
        try {
            return await fetchPagina(baseUrl, pagina);
        } catch (error) {
            console.warn(`${etiqueta} page ${pagina} (attempt ${intento}/${MAX}): ${error.message}`);
            if (intento === MAX) throw new Error(`${etiqueta}: Connekta failed on page ${pagina} after ${MAX} attempts (${error.message}).`);
            await new Promise(r => setTimeout(r, 1000 * intento));
        }
    }
    return [];
}

// Pages the whole query. Returns the rows and the number of pages read (observability only).
async function leerInventarioDefault(nombreQuery) {
    const baseUrl = `https://${CONNEKTA_DOMAIN}/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=${nombreQuery}`;
    const filas = [];
    let paginas = 0;
    for (let pagina = 1; pagina <= TOPE_PAGINAS; pagina++) {
        const registros = await fetchPaginaConReintento(baseUrl, pagina, 'Inventory');
        paginas++;
        filas.push(...registros);
        if (registros.length < TAM_PAGINA) break;
    }
    return { filas, paginas };
}

async function enviarDefault(payload) {
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
        return clasificarErrorSiesa(error);
    }
}

async function notificarDefault(resultado) {
    if (typeof notifier.sendTransformacionNegativosNotification !== 'function') {
        console.warn('Notifier function sendTransformacionNegativosNotification is not available; skipping email.');
        return;
    }
    await notifier.sendTransformacionNegativosNotification(resultado);
}

const DEPS_POR_DEFECTO = {
    cargarReglas: cargarReglasDefault,
    leerInventario: leerInventarioDefault,
    cargarDocs: cargarDocsDefault,
    cargarLegado: cargarLegadoDefault,
    guardarDoc: guardarDocDefault,
    guardarLote: guardarLoteDefault,
    insertarCorrida: insertarCorridaDefault,
    enviar: enviarDefault,
    notificar: notificarDefault,
    esperar: (ms) => new Promise(r => setTimeout(r, ms))
};

// Best-effort run record into the NEW corridas table (never throws).
function registrarCorridaNegativos(fila, deps = {}) {
    return registrarCorrida(fila, {
        insertar: deps.insertarCorrida || insertarCorridaDefault,
        ...(deps.esperar ? { esperar: deps.esperar } : {})
    });
}

// ──────────────────────────────────────────────────────────
// Main flow
// ──────────────────────────────────────────────────────────
const ordenTiendas = (a, b) =>
    a.fecha.localeCompare(b.fecha) ||
    a.co.localeCompare(b.co, 'en', { numeric: true }) ||
    a.bodega.localeCompare(b.bodega, 'en', { numeric: true });

const MENSAJE_MIGRACION = 'Table sps_transformaciones_negativos_docs is missing: apply migration 010 before running.';

function sumarCeiLineas(docs) {
    return docs.filter(d => d.tipo_dto === 'CEI').reduce((acc, d) => acc + (d.lineas_activas || 0), 0);
}

// Dry-run review: prints, per store, the documents that WOULD be sent (summary, lines, attribution, novedades and the
// exact payload). Nothing is sent or written.
function imprimirDryRun(tienda, esDiaPrevio, detalle) {
    const enviables = (d) => d && ESTADOS_ENVIABLES.includes(d.status);
    const ceiOk = tienda.cei.status === 'OK';
    const aEnviar = [];
    if (!esDiaPrevio && enviables(tienda.cei)) aEnviar.push(tienda.cei);
    if (enviables(tienda.csa) && (ceiOk || (!esDiaPrevio && enviables(tienda.cei)))) aEnviar.push(tienda.csa);
    for (const d of aEnviar) {
        for (const linea of describirDocumento(d)) console.log(`   [dry-run] ${linea}`);
        console.log(`   [dry-run] payload ${d.tipo_dto} CO ${d.co} ${d.bodega}:\n${JSON.stringify(d.payload, null, 2)}`);
        detalle.push(filaDetalle(d, 'DRY_RUN'));
    }
}

async function transformacionNegativos(opciones = {}, depsInyectadas = {}) {
    const deps = { ...DEPS_POR_DEFECTO, ...depsInyectadas };
    const ahora = opciones.ahora || new Date();
    const fecha = (opciones.fecha || process.env.TRANSF_FECHA || ahoraBogota(ahora).fecha || fechaBogota()).toString().trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new Error(`Invalid date "${fecha}" (expected YYYY-MM-DD).`);
    const dryRun = opciones.dryRun !== undefined
        ? opciones.dryRun === true
        : ['1', 'true'].includes((process.env.TRANSF_DRY_RUN || '').toLowerCase());

    // Manual early-close override (negativos-only dispatch): skips ONLY the "today before 21:30 COT" guard.
    // It is NOT a dry run (dryRun stays the real value) and never applies to scheduled runs.
    const evento = opciones.evento !== undefined ? opciones.evento : process.env.GITHUB_EVENT_NAME;
    const permitirDiaEnCurso = resolverPermitirDiaEnCurso({
        opcion: opciones.permitirDiaEnCurso, env: process.env.TRANSF_NEG_PERMITIR_DIA_EN_CURSO, evento
    });

    // 1) Date guard first: a rejection happens before any query or write. Future dates are always rejected.
    validarFechaObjetivo(fecha, dryRun || permitirDiaEnCurso, ahora);
    const modo = fecha === ahoraBogota(ahora).fecha ? 'PLANIFICAR' : 'SOLO_REANUDAR';
    const config = leerConfig(opciones);
    if (modo === 'PLANIFICAR' && !config.queryInventario) {
        throw new Error('TRANSF_NEG_QUERY_INVENTARIO is empty: the inventory query name is required to plan.');
    }

    console.log('==========================================');
    console.log('NEGATIVE INVENTORY TRANSFORMATION (one CEI + one CSA per store)');
    console.log(`   Date=${fecha} | Entorno=${ENTORNO} | Mode=${modo} | DryRun=${dryRun ? 'YES' : 'no'}`);
    console.log('==========================================');
    if (permitirDiaEnCurso) console.log('   Same-day override active (manual early-close run): 21:30 COT guard skipped.');
    if (config.cos.length > 0) console.log(`   CO filter active (TRANSF_NEG_COS): only CO ${config.cos.join(', ')} are planned and sent.`);

    const alertas = {
        erroresSiesa: [], ambiguos: [], erroresGuardado: [], bloqueados: [], cancelados: [],
        anomalias: [], omitidos: [], errores: [], reintentosDiasPrevios: [], novedades: []
    };
    // A scheduled run must always target today's Bogota date. If it lands on a past date (GitHub delayed the
    // cron past Bogota midnight) it would silently degrade to resume-only and plan nothing: raise it as a failure.
    if (modo === 'SOLO_REANUDAR' && evento === 'schedule') {
        const hoy = ahoraBogota(ahora).fecha;
        alertas.fechaDesfasada = {
            fecha, hoy,
            motivo: `Scheduled run targeted ${fecha} but today (Bogota) is ${hoy}: resume-only, nothing was planned. Re-run manually for ${hoy} after 21:30 COT.`
        };
        console.error(`   ${alertas.fechaDesfasada.motivo}`);
    }
    const detalle = [];

    const guardar = async (fila) => {
        if (dryRun) return;
        await guardarConReintento(fila, deps.guardarDoc, deps.esperar);
    };

    // 2) Load stored documents within the lookback window (never beyond the target date).
    const desde = restarDias(fecha, config.diasReanudar);
    let cargados = [];
    try {
        cargados = await deps.cargarDocs({ entorno: ENTORNO, desde, hasta: fecha });
    } catch (e) {
        if (!dryRun) throw esTablaFaltante(e) ? Object.assign(new Error(MENSAJE_MIGRACION), { code: 'MIGRACION_010' }) : e; // never send without knowing what was already sent
        console.warn(`[dry-run] Could not read stored documents (${e.message}). Assuming none.`);
    }
    const enVentana = cargados
        .map(d => ({ ...d, fecha: String(d.fecha).slice(0, 10) }))
        .filter(d => d.fecha <= fecha && d.fecha >= desde);

    // 3) Resume decisions: SENDING -> AMBIGUO (never resent), prior-day stores with a CEI not OK -> CANCELADO.
    //    A persistence failure here throws before anything is sent.
    const reanudacion = planificarReanudacion({ docs: enVentana, fecha, ahora: new Date() });
    for (const fila of reanudacion.cambios) await guardar(fila);
    alertas.ambiguos.push(...reanudacion.ambiguos);
    alertas.cancelados.push(...reanudacion.cancelados);
    alertas.anomalias.push(...reanudacion.anomalias);
    for (const a of reanudacion.ambiguos) console.error(`   ${a.tipo_dto} CO ${a.co} ${a.bodega} was SENDING: now AMBIGUO (not resent).`);
    for (const c of reanudacion.cancelados) console.log(`   ${c.tipo_dto} CO ${c.co} ${c.bodega} (${c.fecha}) CANCELADO (was ${c.estadoPrevio}).`);
    let actuales = reanudacion.docs;

    // 4) Plan new stores (only when the target date is today; a past date is resume-only).
    let inventarioStats = null;
    let nuevos = [];
    if (modo === 'PLANIFICAR') {
        const reglas = await deps.cargarReglas();
        if (config.excluidos !== undefined) reglas.excluidos = config.excluidos;
        const inv = await deps.leerInventario(config.queryInventario);
        const { filas: inventario, descartadas } = mapearInventario(inv.filas, config.columnas);
        inventarioStats = { filas: inv.filas.length, paginas: inv.paginas, descartadas };
        console.log(`   Inventory: ${inv.filas.length} rows in ${inv.paginas} page(s) (${descartadas} discarded as unparseable).`);

        // Legacy per-destination history (read-only) drives the cutover rules inside the planner.
        let legado = [];
        try {
            legado = (await deps.cargarLegado({ entorno: ENTORNO, desde, hasta: fecha }))
                .map(r => ({ ...r, fecha: String(r.fecha).slice(0, 10) }));
        } catch (e) {
            if (!dryRun) throw e; // planning without knowing the legacy rows could process a destination twice
            console.warn(`[dry-run] Could not read legacy rows (${e.message}). Assuming none.`);
        }

        const plan = planificarNegativosPorTienda({
            inventario, reglas, previos: { docs: actuales, legado }, fecha, entorno: ENTORNO,
            unidadNegocio: config.unidadNegocio, cos: config.cos
        });
        alertas.omitidos = plan.omitidos;
        alertas.errores = plan.errores;
        const iso = new Date().toISOString();
        nuevos = plan.documentos.map(d => ({
            ...d, status: 'PLANNED', intentos: 0, rondas: 0, respuesta: null, error: null, updated_at: iso
        }));
        const nTiendas = new Set(nuevos.map(d => `${d.co}|${d.bodega}`)).size;
        console.log(`   Plan: ${nTiendas} store(s), ${nuevos.length} document(s), ${sumarCeiLineas(nuevos)} destination line(s), ${plan.omitidos.length} skipped, ${plan.errores.length} error(s).`);

        // The whole plan is persisted BEFORE any send, whole CEI+CSA pairs per call. A failure throws: nothing sent.
        if (!dryRun && nuevos.length > 0) await guardarPlanPorPares(nuevos, deps.guardarLote, { esperar: deps.esperar });
        actuales = [...actuales, ...nuevos];
    } else {
        console.log('   Resume-only mode (past date): inventory is not queried and nothing new is planned.');
    }
    const destinos = sumarCeiLineas(nuevos);

    // Defensive: a CEI with origins and no CSA row means a partial plan save; that store is never sent.
    const incompleto = detectarPlanIncompleto(actuales);
    for (const a of incompleto.anomalias) console.error(`   PLAN_INCOMPLETO CO ${a.co} ${a.bodega}: ${a.motivo}`);
    alertas.anomalias.push(...incompleto.anomalias);

    // 5) Send / resume store by store (CEI first, CSA only after the CEI is OK).
    const depsEnvio = {
        guardar: deps.guardarDoc, enviar: deps.enviar, esperar: deps.esperar,
        unidadNegocio: config.unidadNegocio, log: (m) => console.log(`   ${m}`)
    };
    const tiendas = [...agruparPorTienda(actuales).entries()]
        .map(([k, t]) => ({ k, ...t }))
        .filter(t => coPermitido(t.co, config.cos))
        .sort(ordenTiendas);
    const resultados = [];
    const procesados = [];
    const bloquear = (csa, motivo, causa) => {
        if (csa && ESTADOS_ENVIABLES.includes(csa.status)) {
            alertas.bloqueados.push({ ...idDoc(csa), cantidad: csa.cantidad_total, motivo, causa });
        }
    };

    let abortada = false;
    for (const t of tiendas) {
        if (abortada) break;
        if (!t.cei) {
            alertas.anomalias.push({ ...idDoc(t.csa), motivo: 'CSA document without a CEI document; skipped.' });
            continue;
        }
        if (incompleto.tiendas.has(t.k)) { bloquear(t.csa, 'plan incompleto; CSA not sent.', 'PLAN_INCOMPLETO'); continue; }
        const esDiaPrevio = t.fecha < fecha;

        if (dryRun) { imprimirDryRun(t, esDiaPrevio, detalle); continue; }

        // A prior-day CEI that is not OK is never sent again (it was cancelled or needs manual review).
        if (esDiaPrevio && t.cei.status !== 'OK') {
            if (t.cei.status === 'AMBIGUO') bloquear(t.csa, MOTIVO_CEI_POSIBLEMENTE_ENVIADO, 'CEI_AMBIGUO');
            else bloquear(t.csa, `Prior-day CEI is ${t.cei.status}; CSA not sent.`, `CEI_${t.cei.status}`);
            continue;
        }

        const ceiEnviable = ESTADOS_ENVIABLES.includes(t.cei.status);
        const csaEnviable = !!t.csa && ESTADOS_ENVIABLES.includes(t.csa.status);
        const intentosPreviosCsa = t.csa ? (t.csa.intentos || 0) : 0;
        console.log(`   Store CO ${t.co} bodega ${t.bodega} (${t.fecha}): CEI ${t.cei.status}${t.csa ? `, CSA ${t.csa.status}` : ''}`);
        const r = await enviarTienda({ cei: t.cei, csa: t.csa }, depsEnvio);

        for (const [res, enviable] of [[r.cei, ceiEnviable], [r.csa, csaEnviable]]) {
            if (!res || !enviable) continue;
            const d = res.doc;
            procesados.push(d);
            resultados.push({ status: res.status, causa: res.causa, posts: res.posts });
            const id = idDoc(d);
            for (const e of res.erroresGuardado) alertas.erroresGuardado.push({ ...id, ...e });
            if (res.status === 'ERROR') {
                console.error(`   ${d.tipo_dto} CO ${d.co} ${d.bodega} rejected by Siesa: ${d.error}`);
                alertas.erroresSiesa.push({ ...id, tipo: d.tipo_dto, error: d.error });
            } else if (res.status === 'AMBIGUO') {
                const motivo = d.error || 'POST accepted but its result could not be saved';
                console.error(`   ${d.tipo_dto} CO ${d.co} ${d.bodega} outcome AMBIGUO: ${motivo}. ${INSTRUCCION_AMBIGUO}.`);
                alertas.ambiguos.push({ ...id, tipo: d.tipo_dto, error: motivo, previo: false });
            } else {
                console.log(`   ${d.tipo_dto} CO ${d.co} ${d.bodega} ${res.status} (${res.posts} POST(s), ${d.lineas_activas} line(s)).`);
            }
            detalle.push(filaDetalle(d, res.status));
            if (esDiaPrevio && d.tipo_dto === 'CSA') {
                alertas.reintentosDiasPrevios.push({
                    ...id, cantidad: d.cantidad_total, intentosPrevios: intentosPreviosCsa, resultado: res.status
                });
            }
        }

        if (r.bloqueo && csaEnviable) {
            const motivo = r.bloqueo === 'CEI_AMBIGUO' ? MOTIVO_CEI_POSIBLEMENTE_ENVIADO : `CEI ${r.bloqueo.replace('CEI_', '')}; CSA not sent.`;
            bloquear(t.csa, motivo, r.bloqueo);
        }
        if (r.abortada) {
            abortada = true;
            if (!r.csa) bloquear(t.csa, 'Run aborted after a persistence failure; CSA not sent.', 'ABORTADA');
        }
    }
    if (abortada) console.error('Run aborted: remaining stores were not processed.');

    // 6) Summary and job colour.
    const sistemico = falloSistemico(resultados);
    if (sistemico) {
        console.error('SYSTEMIC FAILURE: every document sent in this run ended in ERROR for a non-Faltante reason (auth, connector or payload). The job is RED.');
    }
    alertas.novedades = recolectarNovedades([...nuevos, ...procesados]);
    const documentos = detalle.filter(d => d.resultado === 'OK').length;
    const fallos = calcularFallos({ alertas, sistemico });
    console.log('\n==========================================');
    console.log(`SUMMARY ${fecha}: destination lines=${destinos} | docs sent OK=${documentos} | failures=${fallos} | novedades=${alertas.novedades.length} | skipped=${alertas.omitidos.length} | cancelled=${alertas.cancelados.length}`);
    console.log('==========================================\n');

    const resultado = {
        fecha, entorno: ENTORNO, dryRun, modo, destinos, documentos, fallos, abortada,
        sistemico, inventario: inventarioStats, detalle, alertas
    };

    if (dryRun) {
        if (alertas.novedades.length > 0) {
            console.log('[dry-run] NOVEDADES (review before the first real send):');
            for (const n of alertas.novedades) console.log(`   [dry-run] [${n.severidad}] CO ${n.co} bodega ${n.bodega} ${n.tipo_dto}: ${n.mensaje}`);
        }
        console.log('DRY-RUN: nothing was sent to Siesa, nothing was written to Supabase and no email is sent.');
    } else {
        try {
            await deps.notificar(resultado);
        } catch (e) {
            console.error(`Notification error: ${e.message}`);
        }
        try {
            await registrarCorridaNegativos({
                ...resumirCorridaNegativos(resultado, {
                    filasInventario: inventarioStats ? inventarioStats.filas : null,
                    paginasInventario: inventarioStats ? inventarioStats.paginas : null,
                    origen: process.env.GITHUB_EVENT_NAME || 'local'
                }),
                ...trazaCorrida('negativos', resultado)
            }, deps);
        } catch (e) {
            console.warn(`Could not build the run record: ${e.message}`);
        }
    }
    return resultado;
}

module.exports = {
    transformacionNegativos,
    registrarCorridaNegativos,
    resumirCorridaNegativos,
    mapearInventario,
    QUERY_INVENTARIO_POR_DEFECTO,
    COLUMNAS_POR_DEFECTO,
    MOTIVO_CEI_POSIBLEMENTE_ENVIADO,
    ENTORNO
};
