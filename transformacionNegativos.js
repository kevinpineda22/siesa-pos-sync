// ============================================================================
//  transformacionNegativos.js - NEGATIVE INVENTORY TRANSFORMATION (I/O orchestrator)
// ============================================================================
//  Clears negative stock of destination meat items: for every negative destination it sends a CEI
//  (entry, destination) and one CSA (exit) per origin chosen by the pure planner
//  (transformacionNegativosPlan.js). Documents go to the same Siesa connector as the tocino job.
//
//  All I/O goes through the injectable `deps` argument so the state machine can be tested with fakes.
//  The tocino job (transformacionCarnes.js) is NOT modified: only its exported helpers are reused and
//  they are pointed at the new tables through injected writers.
//
//  State machine per row: PLANNED -> SENDING -> OK | ERROR | AMBIGUO (+ CANCELADO for stale prior-day rows).
//  See the SDD design (inventory-negative-transformations) for the full rules.
// ============================================================================
const axios = require('axios');
const notifier = require('./notifier');
const {
    fechaBogota, ahoraBogota, validarFechaObjetivo, clasificarErrorSiesa,
    guardarConReintento, registrarCorrida, ENTORNO
} = require('./transformacionCarnes');
const { planificarTransformaciones, UNIDAD_NEGOCIO_POR_DEFECTO } = require('./transformacionNegativosPlan');

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

const TABLA = 'sps_transformaciones_negativos';
const TABLA_CORRIDAS = 'sps_transformaciones_negativos_corridas';
const CONFLICTO = 'entorno,fecha,co,bodega,item_destino,tipo_dto,item_origen';

const MOTIVO_CEI_POSIBLEMENTE_ENVIADO = 'CEI possibly sent, CSAs blocked, manual review';
const INSTRUCCION_AMBIGUO = 'verify manually in Siesa whether the document exists before resending';

const ESTADOS_REINTENTABLES = ['PLANNED', 'ERROR'];

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

function claveDestino(f) {
    return `${f.fecha}|${f.co}|${f.bodega}|${f.item_destino}`;
}

function claveFila(f) {
    return `${f.fecha}|${f.co}|${f.bodega}|${f.item_destino}|${f.tipo_dto}|${f.item_origen}`;
}

function idFila(f) {
    return { fecha: f.fecha, co: f.co, bodega: f.bodega, item_destino: f.item_destino, tipo_dto: f.tipo_dto, item_origen: f.item_origen };
}

function parseLista(raw) {
    if (raw === undefined || raw === null || String(raw).trim() === '') return undefined;
    return String(raw).split(',').map(s => Number(s.trim())).filter(Number.isFinite);
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
        unidadNegocio: opciones.unidadNegocio || process.env.TRANSF_NEG_UNIDAD_NEGOCIO || UNIDAD_NEGOCIO_POR_DEFECTO
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

    const partes = [`mode=${resultado.modo}`, `destinations=${resultado.destinos}`, `documents_ok=${resultado.documentos}`, `failures=${resultado.fallos}`];
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

function sinCamposDeServidor(fila) {
    const { id, created_at, ...resto } = fila;
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

async function cargarFilasDefault({ entorno, desde, hasta }) {
    const sb = getSupabase();
    const TAM = 1000;
    const todas = [];
    for (let desdeFila = 0; ; desdeFila += TAM) {
        const { data, error } = await sb.from(TABLA).select('*')
            .eq('entorno', entorno).gte('fecha', desde).lte('fecha', hasta)
            .order('id', { ascending: true }).range(desdeFila, desdeFila + TAM - 1);
        if (error) throw new Error(`Could not read ${TABLA}: ${error.message}`);
        todas.push(...(data || []));
        if (!data || data.length < TAM) break;
    }
    return todas;
}

async function guardarFilaDefault(fila) {
    const { error } = await getSupabase().from(TABLA).upsert(sinCamposDeServidor(fila), { onConflict: CONFLICTO });
    if (error) throw new Error(`Could not save to ${TABLA}: ${error.message}`);
}

async function guardarLoteDefault(filas) {
    const TAM = 500;
    for (let i = 0; i < filas.length; i += TAM) {
        const { error } = await getSupabase().from(TABLA).upsert(filas.slice(i, i + TAM).map(sinCamposDeServidor), { onConflict: CONFLICTO });
        if (error) throw new Error(`Could not save plan to ${TABLA}: ${error.message}`);
    }
}

async function insertarCorridaDefault(fila) {
    const { error } = await getSupabase().from(TABLA_CORRIDAS).insert(fila);
    if (error) throw new Error(error.message);
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
    cargarFilas: cargarFilasDefault,
    guardarFila: guardarFilaDefault,
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
// Sending of one stored row (SENDING is persisted BEFORE the POST)
// ──────────────────────────────────────────────────────────
// Returns { status, abortada }. `abortada` = persistence failed and the whole run must stop.
async function enviarFila(row, ctx) {
    const { deps, dryRun, detalle, alertas } = ctx;
    const id = idFila(row);
    const etiqueta = `${row.tipo_dto} CO ${row.co} ${row.bodega} dest ${row.item_destino}${row.tipo_dto === 'CSA' ? ` orig ${row.item_origen}` : ''}`;

    if (dryRun) {
        console.log(`   [dry-run] ${etiqueta} qty=${row.cantidad}\n${JSON.stringify(row.payload, null, 2)}`);
        detalle.push({ ...id, cantidad: row.cantidad, resultado: 'DRY_RUN', error: null });
        return { status: 'DRY_RUN', abortada: false };
    }

    // Pre-send marker: if this cannot be persisted, nothing is posted and the run stops.
    const sending = { ...row, status: 'SENDING', intentos: (row.intentos || 0) + 1, updated_at: new Date().toISOString() };
    try {
        await guardarConReintento(sending, deps.guardarFila, deps.esperar);
    } catch (e) {
        console.error(`   Could not persist SENDING for ${etiqueta}: ${e.message}. Nothing was sent; aborting the run.`);
        alertas.erroresGuardado.push({ ...id, fase: 'SENDING', ok: false, error: e.message });
        return { status: row.status, abortada: true, enviado: false };
    }
    Object.assign(row, sending);

    console.log(`   Sending ${etiqueta} qty=${row.cantidad}`);
    let res;
    try {
        res = await deps.enviar(row.payload);
    } catch (e) {
        res = { ok: false, ambiguo: true, respuesta: null, mensaje: e.message };
    }
    const status = res.ok ? 'OK' : (res.ambiguo ? 'AMBIGUO' : 'ERROR');
    const error = res.ok ? null : (res.ambiguo ? `AMBIGUO: ${res.mensaje}` : res.mensaje);
    const final = { ...row, status, respuesta: res.respuesta ?? null, error, updated_at: new Date().toISOString() };

    // Backup in the log BEFORE saving: allows manual reconciliation from CI logs if Supabase fails.
    console.log(`   [BACKUP ${etiqueta}] row to save: ${JSON.stringify({ ...final, payload: undefined })}`);
    console.log(`   [BACKUP ${etiqueta}] Siesa response: ${JSON.stringify(res.respuesta)}`);

    if (status === 'ERROR') {
        console.error(`   ${row.tipo_dto} rejected by Siesa: ${res.mensaje}`);
        alertas.erroresSiesa.push({ ...id, tipo: row.tipo_dto, error: res.mensaje });
    } else if (status === 'AMBIGUO') {
        console.error(`   ${row.tipo_dto} outcome AMBIGUO: ${res.mensaje}. ${INSTRUCCION_AMBIGUO}.`);
        alertas.ambiguos.push({ ...id, tipo: row.tipo_dto, error, previo: false });
    } else {
        console.log(`   ${row.tipo_dto} OK: ${res.mensaje}`);
    }
    detalle.push({ ...id, cantidad: row.cantidad, resultado: status, error });

    try {
        await guardarConReintento(final, deps.guardarFila, deps.esperar);
        Object.assign(row, final);
        return { status, abortada: false, enviado: true };
    } catch (e) {
        // The row stays SENDING in storage (it becomes AMBIGUO on the next run). In memory it is AMBIGUO
        // whenever Siesa may have created the document, so nothing depending on it is sent.
        console.error(`   ${e.message}${res.ok ? ' - Siesa DID accept the document: do NOT resend by hand.' : ''}`);
        alertas.erroresGuardado.push({ ...id, fase: 'RESULTADO', ok: res.ok, error: e.message });
        row.status = res.ok || res.ambiguo ? 'AMBIGUO' : status;
        row.posiblementeEnviado = !!(res.ok || res.ambiguo);
        console.error('   Aborting the rest of the run (no further documents). Reconcile with the BACKUP log lines.');
        return { status: row.status, abortada: true, enviado: true };
    }
}

// ──────────────────────────────────────────────────────────
// Main flow
// ──────────────────────────────────────────────────────────
async function transformacionNegativos(opciones = {}, depsInyectadas = {}) {
    const deps = { ...DEPS_POR_DEFECTO, ...depsInyectadas };
    const ahora = opciones.ahora || new Date();
    const fecha = (opciones.fecha || process.env.TRANSF_FECHA || ahoraBogota(ahora).fecha || fechaBogota()).toString().trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new Error(`Invalid date "${fecha}" (expected YYYY-MM-DD).`);
    const dryRun = opciones.dryRun !== undefined
        ? opciones.dryRun === true
        : ['1', 'true'].includes((process.env.TRANSF_DRY_RUN || '').toLowerCase());

    // 1) Date guard first: a rejection happens before any query or write.
    validarFechaObjetivo(fecha, dryRun, ahora);
    const modo = fecha === ahoraBogota(ahora).fecha ? 'PLANIFICAR' : 'SOLO_REANUDAR';
    const config = leerConfig(opciones);
    if (modo === 'PLANIFICAR' && !config.queryInventario) {
        throw new Error('TRANSF_NEG_QUERY_INVENTARIO is empty: the inventory query name is required to plan.');
    }

    console.log('==========================================');
    console.log('NEGATIVE INVENTORY TRANSFORMATION');
    console.log(`   Date=${fecha} | Entorno=${ENTORNO} | Mode=${modo} | DryRun=${dryRun ? 'YES' : 'no'}`);
    console.log('==========================================');

    const alertas = {
        erroresSiesa: [], ambiguos: [], erroresGuardado: [], bloqueados: [], cancelados: [],
        anomalias: [], omitidos: [], errores: [], reintentosDiasPrevios: []
    };
    const detalle = [];
    const ctx = { deps, dryRun, detalle, alertas };

    // 2) Load stored rows within the lookback window (never beyond the target date).
    const desde = restarDias(fecha, config.diasReanudar);
    let cargadas = [];
    try {
        cargadas = await deps.cargarFilas({ entorno: ENTORNO, desde, hasta: fecha });
    } catch (e) {
        if (!dryRun) throw e; // never send without knowing what was already sent
        console.warn(`[dry-run] Could not read stored rows (${e.message}). Assuming none.`);
    }
    const filas = new Map();
    for (const f of cargadas) {
        const fila = { ...f, fecha: String(f.fecha).slice(0, 10) };
        if (fila.fecha > fecha || fila.fecha < desde) continue;
        filas.set(claveFila(fila), fila);
    }

    const guardar = async (fila) => {
        if (dryRun) return;
        await guardarConReintento(fila, deps.guardarFila, deps.esperar);
    };

    // 3) Rows left in SENDING by a crashed/failed run become AMBIGUO: never resent, never cancelled.
    for (const fila of filas.values()) {
        if (fila.status !== 'SENDING') continue;
        const nueva = {
            ...fila, status: 'AMBIGUO', updated_at: new Date().toISOString(),
            error: `AMBIGUO: left in SENDING by a previous run (crash or failed save). ${INSTRUCCION_AMBIGUO}.`
        };
        await guardar(nueva); // a persistence failure here aborts before anything is sent
        filas.set(claveFila(nueva), nueva);
        alertas.ambiguos.push({ ...idFila(nueva), tipo: nueva.tipo_dto, error: nueva.error, previo: true });
        console.error(`   ${nueva.tipo_dto} CO ${nueva.co} ${nueva.bodega} dest ${nueva.item_destino} was SENDING: now AMBIGUO (not resent).`);
    }

    // 4) Cancel stale prior-day destinations BEFORE planning new ones.
    const porDestino = new Map();
    for (const f of filas.values()) {
        const k = claveDestino(f);
        if (!porDestino.has(k)) porDestino.set(k, []);
        porDestino.get(k).push(f);
    }
    for (const grupo of porDestino.values()) {
        const cei = grupo.find(f => f.tipo_dto === 'CEI');
        if (!cei || cei.fecha >= fecha || cei.status === 'OK') continue;
        const cancelable = (f) => f.status === 'ERROR' || (f.status === 'PLANNED' && (f.intentos || 0) === 0);
        if (!cancelable(cei)) {
            if (cei.status === 'PLANNED') {
                alertas.anomalias.push({ ...idFila(cei), motivo: 'Prior-day CEI is PLANNED with attempts > 0; not cancelled, manual review.' });
            }
            continue; // SENDING/AMBIGUO/CANCELADO: never cancelled
        }
        for (const f of grupo.filter(cancelable)) {
            const nueva = { ...f, status: 'CANCELADO', updated_at: new Date().toISOString(), error: 'CANCELADO: prior-day row not sent and CEI not OK.' };
            await guardar(nueva);
            filas.set(claveFila(nueva), nueva);
            alertas.cancelados.push({ ...idFila(nueva), estadoPrevio: f.status });
        }
    }

    // 5) Plan new destinations (only when the target date is today; a past date is resume-only).
    let destinos = 0;
    let inventarioStats = null;
    if (modo === 'PLANIFICAR') {
        const reglas = await deps.cargarReglas();
        if (config.excluidos !== undefined) reglas.excluidos = config.excluidos;
        const inv = await deps.leerInventario(config.queryInventario);
        const { filas: inventario, descartadas } = mapearInventario(inv.filas, config.columnas);
        inventarioStats = { filas: inv.filas.length, paginas: inv.paginas, descartadas };
        console.log(`   Inventory: ${inv.filas.length} rows in ${inv.paginas} page(s) (${descartadas} discarded as unparseable).`);

        const plan = planificarTransformaciones({
            inventario, reglas, previos: [...filas.values()], fecha, entorno: ENTORNO, unidadNegocio: config.unidadNegocio
        });
        alertas.omitidos = plan.omitidos;
        alertas.errores = plan.errores;
        const nuevas = plan.documentos.map(d => ({
            ...d, status: 'PLANNED', intentos: 0, respuesta: null, error: null, updated_at: new Date().toISOString()
        }));
        destinos = nuevas.filter(d => d.tipo_dto === 'CEI').length;
        console.log(`   Plan: ${destinos} destination(s), ${nuevas.length} document(s), ${plan.omitidos.length} skipped, ${plan.errores.length} error(s).`);

        // The whole plan is persisted BEFORE any send. A failure here throws: nothing has been sent.
        if (!dryRun && nuevas.length > 0) await guardarConReintento(nuevas, deps.guardarLote, deps.esperar);
        for (const n of nuevas) filas.set(claveFila(n), n);
    } else {
        console.log('   Resume-only mode (past date): inventory is not queried and nothing new is planned.');
    }

    // 6) Send / resume, destination by destination (CEI first, CSAs only after CEI OK).
    const grupos = new Map();
    for (const f of filas.values()) {
        const k = claveDestino(f);
        if (!grupos.has(k)) grupos.set(k, []);
        grupos.get(k).push(f);
    }
    const ordenados = [...grupos.values()].sort((a, b) =>
        a[0].fecha.localeCompare(b[0].fecha) ||
        a[0].co.localeCompare(b[0].co, 'en', { numeric: true }) ||
        a[0].bodega.localeCompare(b[0].bodega, 'en', { numeric: true }) ||
        a[0].item_destino - b[0].item_destino
    );

    let abortada = false;
    for (const grupo of ordenados) {
        if (abortada) break;
        const cei = grupo.find(f => f.tipo_dto === 'CEI');
        const csas = grupo.filter(f => f.tipo_dto === 'CSA').sort((a, b) => a.item_origen - b.item_origen);
        if (!cei) {
            alertas.anomalias.push({ ...idFila(grupo[0]), motivo: 'CSA rows without a CEI row; skipped.' });
            continue;
        }
        const esDiaPrevio = cei.fecha < fecha;
        const csasPendientes = () => csas.filter(c => ESTADOS_REINTENTABLES.includes(c.status));
        const bloquear = (motivo) => csasPendientes().forEach(c =>
            alertas.bloqueados.push({ ...idFila(c), cantidad: c.cantidad, motivo }));

        // CEI: only the target-date destinations send their CEI; prior-day CEIs are cancelled or left alone.
        let ceiListo = cei.status === 'OK';
        if (!ceiListo && !esDiaPrevio && ESTADOS_REINTENTABLES.includes(cei.status)) {
            const r = await enviarFila(cei, ctx);
            ceiListo = r.status === 'OK' || r.status === 'DRY_RUN';
            if (r.abortada) {
                abortada = true;
                bloquear(cei.posiblementeEnviado ? MOTIVO_CEI_POSIBLEMENTE_ENVIADO : 'Run aborted after a persistence failure; CSAs not sent.');
                break;
            }
        }

        if (!ceiListo) {
            if (cei.status === 'AMBIGUO') bloquear(MOTIVO_CEI_POSIBLEMENTE_ENVIADO);
            else if (cei.status === 'ERROR') bloquear('CEI failed; CSAs not sent.');
            else if (cei.status !== 'CANCELADO' && csasPendientes().length > 0) bloquear(`CEI is ${cei.status}; CSAs not sent.`);
            continue;
        }

        for (const csa of csas) {
            if (!ESTADOS_REINTENTABLES.includes(csa.status)) continue; // OK, AMBIGUO (already reported), CANCELADO
            const intentosPrevios = csa.intentos || 0;
            const r = await enviarFila(csa, ctx);
            if (esDiaPrevio) {
                alertas.reintentosDiasPrevios.push({
                    ...idFila(csa), cantidad: csa.cantidad, intentosPrevios, resultado: r.abortada && !r.enviado ? 'NO_ENVIADO' : r.status
                });
            }
            if (r.abortada) { abortada = true; break; }
        }
    }
    if (abortada) console.error('Run aborted: remaining destinations were not processed.');

    // 7) Summary.
    const documentos = detalle.filter(d => d.resultado === 'OK').length;
    const fallos = detalle.filter(d => d.resultado === 'ERROR' || d.resultado === 'AMBIGUO').length
        + alertas.ambiguos.filter(a => a.previo).length + alertas.bloqueados.length;
    console.log('\n==========================================');
    console.log(`SUMMARY ${fecha}: destinations=${destinos} | sent OK=${documentos} | failures=${fallos} | skipped=${alertas.omitidos.length} | cancelled=${alertas.cancelados.length}`);
    console.log('==========================================\n');

    const resultado = {
        fecha, entorno: ENTORNO, dryRun, modo, destinos, documentos, fallos, abortada,
        inventario: inventarioStats, detalle, alertas
    };

    if (dryRun) {
        console.log('DRY-RUN: nothing was sent to Siesa, nothing was written to Supabase and no email is sent.');
    } else {
        try {
            await deps.notificar(resultado);
        } catch (e) {
            console.error(`Notification error: ${e.message}`);
        }
        try {
            await registrarCorridaNegativos(resumirCorridaNegativos(resultado, {
                filasInventario: inventarioStats ? inventarioStats.filas : null,
                paginasInventario: inventarioStats ? inventarioStats.paginas : null,
                origen: process.env.GITHUB_EVENT_NAME || 'local'
            }), deps);
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
