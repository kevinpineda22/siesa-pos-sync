// Pure orchestration helpers of the negative inventory job (per-store documents).
// No I/O, no env access: persistence is injected, so everything here is unit testable without Siesa/Supabase.
// transformacionNegativos.js wires these helpers to the real Supabase / Connekta / Siesa I/O.

const { parsearCosFiltro, normCo } = require('./transformacionNegativosPlan');
const { ordenarNovedades } = require('./negativosNovedades');

const INSTRUCCION_AMBIGUO = 'verify manually in Siesa whether the document exists before resending';
const MAX_PARES_POR_LOTE = 50;
const MAX_BYTES_POR_LOTE = 256 * 1024;
const MAX_INTENTOS_LOTE = 3;

const fechaCorta = (f) => String(f).slice(0, 10);
const clonar = (x) => JSON.parse(JSON.stringify(x));

function claveTienda(d) {
    return `${fechaCorta(d.fecha)}|${d.co}|${d.bodega}`;
}

function idDoc(d) {
    return { fecha: fechaCorta(d.fecha), co: d.co, bodega: d.bodega, tipo_dto: d.tipo_dto };
}

// Map<fecha|co|bodega, { fecha, co, bodega, cei, csa }> (cei/csa are null when the row does not exist).
function agruparPorTienda(docs = []) {
    const mapa = new Map();
    for (const d of docs) {
        const k = claveTienda(d);
        if (!mapa.has(k)) mapa.set(k, { fecha: fechaCorta(d.fecha), co: d.co, bodega: d.bodega, cei: null, csa: null });
        const t = mapa.get(k);
        if (d.tipo_dto === 'CEI') t.cei = d;
        else if (d.tipo_dto === 'CSA') t.csa = d;
    }
    return mapa;
}

// CO filter (TRANSF_NEG_COS): comma list or array; empty = every store. Leading zeros are tolerated.
function coPermitido(co, cos) {
    const permitidos = parsearCosFiltro(cos).map(normCo);
    return permitidos.length === 0 || permitidos.includes(normCo(co));
}

// ──────────────────────────────────────────────────────────
// Plan persistence: whole store pairs per call
// ──────────────────────────────────────────────────────────
function esErrorTamano(e) {
    if (!e) return false;
    return e.status === 413 || e.code === '54000'
        || /payload too large|request entity too large|statement too large|too large|\b413\b/i.test(String(e.message || ''));
}

function esTablaFaltante(e) {
    if (!e) return false;
    return e.code === '42P01' || /relation .* does not exist|could not find the table/i.test(String(e.message || ''));
}

// Splits documents in batches made of WHOLE store pairs (CEI + CSA of one store never travel in different calls,
// so the pair stays atomic). A batch closes by pair count or by serialized size; one oversize pair goes alone.
function partirEnLotes(docs = [], { maxPares = MAX_PARES_POR_LOTE, maxBytes = MAX_BYTES_POR_LOTE } = {}) {
    return partirPares(agruparPares(docs), { maxPares, maxBytes }).map(l => l.flat());
}

function agruparPares(docs) {
    const pares = new Map();
    for (const d of docs) {
        const k = claveTienda(d);
        if (!pares.has(k)) pares.set(k, []);
        pares.get(k).push(d);
    }
    return [...pares.values()];
}

function partirPares(pares, { maxPares, maxBytes }) {
    const lotes = [];
    let actual = [];
    let bytes = 0;
    for (const par of pares) {
        const b = JSON.stringify(par).length;
        if (actual.length > 0 && (actual.length + 1 > maxPares || bytes + b > maxBytes)) {
            lotes.push(actual);
            actual = [];
            bytes = 0;
        }
        actual.push(par);
        bytes += b;
    }
    if (actual.length > 0) lotes.push(actual);
    return lotes;
}

// upsert(rows) -> Promise (rejects on failure; errors carry `code` / `status` when known).
//  - transient errors: 3 attempts (1s, 2s backoff)
//  - size errors: the batch is halved (whole pairs) down to one pair; a single oversize pair is a persistence failure
//  - 42P01: persistence failure telling to apply migration 010 (never retried; nothing has been sent yet)
async function guardarPlanPorPares(docs, upsert, opciones = {}) {
    const esperar = opciones.esperar || ((ms) => new Promise(r => setTimeout(r, ms)));
    const maxPares = opciones.maxPares || MAX_PARES_POR_LOTE;
    const maxBytes = opciones.maxBytes || MAX_BYTES_POR_LOTE;

    async function conReintento(rows) {
        for (let intento = 1; intento <= MAX_INTENTOS_LOTE; intento++) {
            try {
                return await upsert(rows);
            } catch (e) {
                if (esTablaFaltante(e) || esErrorTamano(e) || intento === MAX_INTENTOS_LOTE) throw e;
                await esperar(1000 * intento);
            }
        }
        return undefined;
    }

    async function subir(pares) {
        try {
            await conReintento(pares.flat());
        } catch (e) {
            if (esTablaFaltante(e)) {
                throw Object.assign(new Error('Table sps_transformaciones_negativos_docs does not exist: apply migration 010 before running (nothing was sent).'), { code: 'MIGRACION_010' });
            }
            if (esErrorTamano(e)) {
                if (pares.length === 1) {
                    const t = pares[0][0];
                    throw Object.assign(
                        new Error(`Could not persist the plan of store CO ${t.co} bodega ${t.bodega}: the document pair exceeds the request size limit.`),
                        { code: 'TIENDA_DEMASIADO_GRANDE', tienda: `${t.co}|${t.bodega}` }
                    );
                }
                const mitad = Math.ceil(pares.length / 2);
                await subir(pares.slice(0, mitad));
                await subir(pares.slice(mitad));
                return;
            }
            throw e;
        }
    }

    for (const lote of partirPares(agruparPares(docs), { maxPares, maxBytes })) await subir(lote);
}

// ──────────────────────────────────────────────────────────
// Resume (PS-8, PS-9)
// ──────────────────────────────────────────────────────────
const cancelable = (d) => d.status === 'ERROR' || (d.status === 'PLANNED' && (d.intentos || 0) === 0);

// docs: stored rows of the lookback window. Returns a new list (inputs are never mutated) plus:
//   cambios   rows that must be persisted (SENDING -> AMBIGUO, prior-day cancellations)
//   ambiguos  { ...id, tipo, error, previo:true } for every row found in SENDING
//   cancelados, anomalias
// 1) SENDING left by a crashed run becomes AMBIGUO (never resent, never cancelled).
// 2) A prior-day store whose CEI is not OK: cancelable CEI (ERROR, or PLANNED with no attempts) and the pending CSA
//    become CANCELADO; a PLANNED CEI with attempts > 0 is an anomaly; SENDING/AMBIGUO/CANCELADO are never cancelled.
function planificarReanudacion({ docs = [], fecha, ahora = new Date() } = {}) {
    const iso = ahora.toISOString();
    const filas = docs.map(d => ({ ...d, fecha: fechaCorta(d.fecha) }));
    const cambiados = new Set();
    const ambiguos = [];
    const cancelados = [];
    const anomalias = [];

    for (let i = 0; i < filas.length; i++) {
        if (filas[i].status !== 'SENDING') continue;
        filas[i] = {
            ...filas[i], status: 'AMBIGUO', updated_at: iso,
            error: `AMBIGUO: left in SENDING by a previous run (crash or failed save). ${INSTRUCCION_AMBIGUO}.`
        };
        cambiados.add(i);
        ambiguos.push({ ...idDoc(filas[i]), tipo: filas[i].tipo_dto, error: filas[i].error, previo: true });
    }

    const porTienda = new Map();
    filas.forEach((d, i) => {
        const k = claveTienda(d);
        if (!porTienda.has(k)) porTienda.set(k, []);
        porTienda.get(k).push(i);
    });
    for (const indices of porTienda.values()) {
        const iCei = indices.find(i => filas[i].tipo_dto === 'CEI');
        if (iCei === undefined) continue;
        const cei = filas[iCei];
        if (cei.fecha >= fecha || cei.status === 'OK') continue;
        if (!cancelable(cei)) {
            if (cei.status === 'PLANNED') {
                anomalias.push({ ...idDoc(cei), motivo: 'Prior-day CEI is PLANNED with attempts > 0; not cancelled, manual review.' });
            }
            continue;
        }
        for (const i of indices.filter(j => cancelable(filas[j]))) {
            const previo = filas[i].status;
            filas[i] = { ...filas[i], status: 'CANCELADO', updated_at: iso, error: 'CANCELADO: prior-day document not sent and CEI not OK.' };
            cambiados.add(i);
            cancelados.push({ ...idDoc(filas[i]), estadoPrevio: previo });
        }
    }
    return { docs: filas, cambios: [...cambiados].sort((a, b) => a - b).map(i => filas[i]), ambiguos, cancelados, anomalias };
}

// Defensive: a CEI with origins but no CSA row means a partial plan save. Pairs are upserted in one call, so this
// should never happen; if it does the store is not sent and the job is red.
function detectarPlanIncompleto(docs = []) {
    const anomalias = [];
    const tiendas = new Set();
    for (const [k, t] of agruparPorTienda(docs)) {
        if (!t.cei || t.csa || t.cei.status === 'CANCELADO') continue;
        const conOrigen = (t.cei.lineas || []).some(l => Array.isArray(l.origenes) && l.origenes.length > 0);
        if (!conOrigen) continue;
        tiendas.add(k);
        anomalias.push({
            ...idDoc(t.cei), tipoAnomalia: 'PLAN_INCOMPLETO',
            motivo: 'plan incompleto: CEI has origins but the store has no CSA row; not sent, manual review.'
        });
    }
    return { anomalias, tiendas };
}

// ──────────────────────────────────────────────────────────
// Job colour (NV-3)
// ──────────────────────────────────────────────────────────
// RED = AMBIGUO (new + leftover SENDING), CSAs blocked behind an AMBIGUO CEI, PLAN_INCOMPLETO, fechaDesfasada and
// a systemic failure. (Persistence failures and aborts are red through erroresGuardado / abortada.)
// Novedades (even ALTA), CSAs blocked behind a CEI ERROR/CANCELADO and legacy leftovers are green.
function calcularFallos({ alertas, sistemico = false }) {
    const a = alertas || {};
    return (a.ambiguos || []).length
        + (a.bloqueados || []).filter(b => b.causa === 'CEI_AMBIGUO').length
        + (a.anomalias || []).filter(x => x.tipoAnomalia === 'PLAN_INCOMPLETO').length
        + (a.fechaDesfasada ? 1 : 0)
        + (sistemico ? 1 : 0);
}

// Exit decision of the cron entry point: { codigo, mensajes }.
function decidirSalidaCron(res) {
    const a = res.alertas || {};
    const erroresGuardado = (a.erroresGuardado || []).length;
    if ((res.fallos || 0) > 0 || erroresGuardado > 0 || res.abortada) {
        return {
            codigo: 1,
            mensajes: [`${res.fallos} failure(s), ${erroresGuardado} save error(s)${res.abortada ? ', run aborted' : ''} -> the job is RED.`]
        };
    }
    const mensajes = [];
    const novedades = a.novedades || [];
    if (novedades.length > 0) {
        const altas = novedades.filter(n => n.severidad === 'ALTA').length;
        mensajes.push(`${novedades.length} novedad(es) reported (${altas} ALTA). Review the email and the log. The job is NOT marked red.`);
    }
    const otras = ['omitidos', 'errores', 'cancelados', 'reintentosDiasPrevios', 'anomalias', 'bloqueados'].filter(k => (a[k] || []).length > 0);
    if (otras.length > 0) {
        mensajes.push(`There are alerts (${otras.join(', ')}). Review the email and the log. The job is NOT marked red.`);
    }
    return { codigo: 0, mensajes };
}

// ──────────────────────────────────────────────────────────
// Reporting
// ──────────────────────────────────────────────────────────
function claveNovedad(n) {
    return [n.codigo, n.co, n.bodega, n.tipo_dto, n.item_destino, n.item_origen, n.ronda, n.cantidad].join('|');
}

// Novedades of the given documents, deduplicated and sorted ALTA > MEDIA > INFO.
function recolectarNovedades(docs = []) {
    const vistas = new Set();
    const lista = [];
    for (const d of docs) {
        for (const n of d.novedades || []) {
            const k = claveNovedad(n);
            if (vistas.has(k)) continue;
            vistas.add(k);
            lista.push(n);
        }
    }
    return ordenarNovedades(lista);
}

function filaDetalle(d, resultado) {
    return {
        ...idDoc(d), lineas_activas: d.lineas_activas, cantidad_total: d.cantidad_total,
        rondas: d.rondas || 0, resultado, error: d.error ?? null
    };
}

const lista = (items, f) => (items || []).map(f).join(', ');

// Human readable summary of a planned document (used by the dry-run review and the logs).
function describirDocumento(d) {
    const salida = [`${d.tipo_dto} CO ${d.co} bodega ${d.bodega} (${fechaCorta(d.fecha)}): ${d.lineas_activas ?? '?'} line(s), total ${d.cantidad_total ?? '?'} [${d.status}]`];
    for (const l of d.lineas || []) {
        const estado = l.estado && l.estado !== 'ACTIVA' ? ` ${l.estado}` : '';
        if (d.tipo_dto === 'CEI') {
            salida.push(`   - item ${l.item} qty ${l.cantidad} ${l.um || ''}${estado} <- origins: ${lista(l.origenes, o => `${o.item}=${o.cantidad}`) || 'none'}`);
        } else {
            salida.push(`   - item ${l.item} qty ${l.cantidad} ${l.um || ''}${estado} -> destinations: ${lista(l.atribucion, a => `${a.item_destino}=${a.cantidad}`) || 'none'}`);
        }
    }
    for (const n of ordenarNovedades(d.novedades || [])) salida.push(`   ! [${n.severidad}] ${n.mensaje}`);
    return salida;
}

module.exports = {
    INSTRUCCION_AMBIGUO,
    agruparPorTienda,
    claveTienda,
    coPermitido,
    esErrorTamano,
    esTablaFaltante,
    partirEnLotes,
    guardarPlanPorPares,
    planificarReanudacion,
    detectarPlanIncompleto,
    calcularFallos,
    decidirSalidaCron,
    recolectarNovedades,
    describirDocumento,
    filaDetalle,
    idDoc,
    clonar
};
