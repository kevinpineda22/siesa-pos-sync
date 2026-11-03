// ============================================================================
//  corridaTraza.js - run traceability for the transformation jobs
// ============================================================================
//  Pure helpers (CommonJS) that build the extra columns stored on the run records of
//  sps_transformaciones_corridas and sps_transformaciones_negativos_corridas (migration 009):
//  GitHub Actions run metadata and a capped `alertas` summary.
//
//  This module MUST stay free of side effects: it does not require the job modules, logger,
//  notifier, dotenv or supabase, so it can be unit tested without .env or network.
//  Everything here is best-effort: building the trace never throws into the Siesa flow.
// ============================================================================

const { ordenarNovedades } = require('./negativosNovedades');

const TRAZA_COLUMNAS = ['github_run_id', 'github_run_attempt', 'github_job', 'github_run_url', 'alertas'];

const MAX_ITEMS = 50;
const MAX_CHARS = 300;
const MAX_BYTES = 64 * 1024;

const LISTAS_TOCINO = [
    'noClasificadas', 'sinConfig', 'advertenciasUM', 'netoNoPositivo',
    'erroresSiesa', 'erroresGuardado', 'ambiguos', 'netoCambiado'
];
const LISTAS_NEGATIVOS = [
    'omitidos', 'errores', 'anomalias', 'cancelados', 'bloqueados',
    'reintentosDiasPrevios', 'erroresSiesa', 'erroresGuardado', 'ambiguos', 'novedades'
];

const GITHUB_NULO = Object.freeze({
    github_run_id: null, github_run_attempt: null, github_job: null, github_run_url: null
});

function aEntero(valor) {
    const n = Number.parseInt(valor, 10);
    return Number.isFinite(n) ? n : null;
}

// Runner-provided metadata. Without GITHUB_RUN_ID (local run) everything is null.
function trazaGithub(env = process.env) {
    const e = env || {};
    const id = aEntero(e.GITHUB_RUN_ID);
    if (id === null) return { ...GITHUB_NULO };
    const repo = e.GITHUB_REPOSITORY;
    const servidor = e.GITHUB_SERVER_URL || 'https://github.com';
    return {
        github_run_id: id,
        github_run_attempt: aEntero(e.GITHUB_RUN_ATTEMPT),
        github_job: e.GITHUB_JOB || null,
        github_run_url: repo ? `${servidor}/${repo}/actions/runs/${id}` : null
    };
}

function acotarTexto(valor) {
    return typeof valor === 'string' && valor.length > MAX_CHARS ? valor.slice(0, MAX_CHARS) : valor;
}

function acotarItem(item) {
    if (typeof item === 'string') return acotarTexto(item);
    if (item && typeof item === 'object' && !Array.isArray(item)) {
        const salida = {};
        for (const [k, v] of Object.entries(item)) salida[k] = acotarTexto(v);
        return salida;
    }
    return item;
}

// Caps a list while keeping the true total.
function capLista(lista) {
    const arr = Array.isArray(lista) ? lista : [];
    return {
        total: arr.length,
        items: arr.slice(0, MAX_ITEMS).map(acotarItem),
        truncada: arr.length > MAX_ITEMS
    };
}

function armarAlertas(job, fuente, nombres, flags) {
    const conteos = {};
    const listas = {};
    for (const nombre of nombres) {
        if (!Array.isArray(fuente[nombre])) continue; // missing keys are omitted
        const capada = capLista(fuente[nombre]);
        conteos[nombre] = capada.total;
        listas[nombre] = capada;
    }
    const alertas = { v: 1, job, conteos, listas, flags };
    // Oversized JSON: drop the items, keep the counts.
    if (JSON.stringify(alertas).length > MAX_BYTES) {
        for (const nombre of Object.keys(listas)) listas[nombre] = { ...listas[nombre], items: [], truncada: true };
        alertas.truncada = true;
    }
    return alertas;
}

function alertasTocino(alertas) {
    const a = alertas || {};
    return armarAlertas('tocino', a, LISTAS_TOCINO, { sinFilas: !!a.sinFilas });
}

// Receives the whole run result (it needs abortada and inventario besides alertas).
function alertasNegativos(resultado) {
    const r = resultado || {};
    const a = r.alertas || {};
    const descartadas = r.inventario ? r.inventario.descartadas : undefined;
    const flags = {
        abortada: !!r.abortada,
        fechaDesfasada: a.fechaDesfasada ? { motivo: a.fechaDesfasada.motivo } : null
    };
    if (Array.isArray(descartadas)) flags.inventarioDescartado = descartadas.length;
    else if (typeof descartadas === 'number') flags.inventarioDescartado = descartadas;
    // novedades are capped like any list: sort first so the cap keeps the ALTA ones.
    const fuente = Array.isArray(a.novedades) ? { ...a, novedades: ordenarNovedades(a.novedades) } : a;
    return armarAlertas('negativos', fuente, LISTAS_NEGATIVOS, flags);
}

// Columns to spread into the run row. NEVER throws: if building alertas fails the github
// columns are kept and alertas is null.
function trazaCorrida(job, src, env = process.env) {
    let github;
    try {
        github = trazaGithub(env);
    } catch (_) {
        github = { ...GITHUB_NULO };
    }
    let alertas = null;
    try {
        if (job === 'tocino' && src) alertas = alertasTocino(src);
        else if (job === 'negativos' && src) alertas = alertasNegativos(src);
    } catch (e) {
        console.warn(`Could not build the run alerts summary: ${e.message}`);
        alertas = null;
    }
    return { ...github, alertas };
}

function esColumnaAusente(e) {
    if (!e) return false;
    if (e.code === 'PGRST204' || e.code === '42703') return true;
    return /column.*(does not exist|schema cache)/i.test(String(e.message || ''));
}

// Inserts the full row; if migration 009 is not applied yet (missing columns) retries ONCE
// with the legacy columns only and warns. Any other error propagates unchanged.
async function insertarTolerante(insertFn, fila, warn = console.warn) {
    try {
        return await insertFn(fila);
    } catch (e) {
        if (!esColumnaAusente(e) || !TRAZA_COLUMNAS.some(c => c in fila)) throw e;
        const legacy = { ...fila };
        for (const c of TRAZA_COLUMNAS) delete legacy[c];
        warn(`Trace columns missing (migration 009 not applied?); saving the run without them: ${e.message}`);
        return await insertFn(legacy);
    }
}

module.exports = {
    TRAZA_COLUMNAS, trazaGithub, capLista, alertasTocino, alertasNegativos, trazaCorrida, insertarTolerante
};
