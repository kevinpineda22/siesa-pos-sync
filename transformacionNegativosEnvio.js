// Per-document sender for the negative inventory job (one CEI and one CSA per store).
// Pure-ish: every side effect (persisting, posting, waiting, logging) is injected through `deps`, and this module
// requires no env, HTTP client, database or notifier, so it can be unit tested without touching Siesa.
//
// deps = {
//   guardar(row)          upserts one document row (rejects on failure),
//   enviar(payload)       -> { ok, ambiguo, respuesta, mensaje }   (never throws for HTTP errors; a throw is AMBIGUO),
//   esperar(ms)           backoff between save retries,
//   unidadNegocio,        business unit written in every Movimiento,
//   log?(msg)             optional, used for the BACKUP line printed before a result save
// }
//
// State machine of a document (see design): PLANNED|ERROR -> SENDING (persisted with the exact payload BEFORE every
// POST) -> OK | AMBIGUO (stop, never resent) | definitive rejection:
//   Faltante Inv. rejections are corrected for up to MAX_RONDAS_AJUSTE rounds (CEI line += ceil(X), CSA line -=
//   ceil(X) floored at 0), then the still-failing named lines are dropped for up to MAX_RONDAS_DESCARTE rounds.
//   Hard cap: 1 initial + 5 adjust + 5 drop = 11 POSTs per document.

const { faltantesAplicables } = require('./siesaFaltantes');
const { crearNovedad } = require('./negativosNovedades');
const {
    UNIDADES, aUnidades, aUnidadesCeil, resumenLineas, construirPayloadDocumento, notaDocumento,
    DOC_ENTRADA, DOC_SALIDA
} = require('./transformacionNegativosPlan');

const MAX_RONDAS_AJUSTE = 5;
const MAX_RONDAS_DESCARTE = 5;
const MAX_POSTS_POR_DOCUMENTO = 1 + MAX_RONDAS_AJUSTE + MAX_RONDAS_DESCARTE;
const MAX_RONDAS_TRAZA = 12;
const MAX_INTENTOS_GUARDADO = 3;
const ESTADOS_ENVIABLES = new Set(['PLANNED', 'ERROR']);
const ESTADOS_LINEA_ACTIVA = new Set(['ACTIVA', 'AJUSTADA']);

const DEFINICIONES = { CEI: DOC_ENTRADA, CSA: DOC_SALIDA };

const clonar = (x) => JSON.parse(JSON.stringify(x));
const esperarPorDefecto = (ms) => new Promise(r => setTimeout(r, ms));

// Save with bounded retries (3 attempts, 1s and 2s backoff), like the legacy enviarFila. Throws on the last failure.
async function guardarConReintento(fila, guardar, esperar) {
    for (let intento = 1; intento <= MAX_INTENTOS_GUARDADO; intento++) {
        try {
            return await guardar(fila);
        } catch (e) {
            if (intento === MAX_INTENTOS_GUARDADO) throw e;
            await esperar(1000 * intento);
        }
    }
}

// ──────────────────────────────────────────────────────────
// CEI drop -> CSA recomputation (pure, idempotent)
// ──────────────────────────────────────────────────────────
// For every DESCARTADA CEI destination D, subtracts ONLY D's share (atribucion) from each CSA line and removes
// that attribution entry. A line shared with other destinations keeps their shares; it is DESCARTADA only when its
// quantity reaches 0. Inputs are never mutated. `vacia` = no active CSA line left.
function aplicarDescartesCei(lineasCei = [], lineasCsa = []) {
    const descartados = new Set(lineasCei.filter(l => l.estado === 'DESCARTADA').map(l => String(l.item)));
    const lineas = clonar(lineasCsa);
    for (const l of lineas) {
        if (l.estado === 'DESCARTADA' || !Array.isArray(l.atribucion)) continue;
        const quitar = l.atribucion.filter(a => descartados.has(String(a.item_destino)));
        if (quitar.length === 0) continue;
        const restante = Math.max(0, aUnidades(l.cantidad) - quitar.reduce((acc, a) => acc + aUnidades(a.cantidad), 0));
        l.atribucion = l.atribucion.filter(a => !descartados.has(String(a.item_destino)));
        l.cantidad = restante / UNIDADES;
        if (restante === 0) l.estado = 'DESCARTADA';
    }
    return { lineas, vacia: resumenLineas(lineas).lineas_activas === 0 };
}

// ──────────────────────────────────────────────────────────
// Line corrections (mutate the working copy of the document)
// ──────────────────────────────────────────────────────────
function ajustarLineaCei(d, linea, faltante, ronda) {
    const anterior = aUnidades(linea.cantidad);
    const nueva = anterior + aUnidadesCeil(faltante);
    linea.cantidad = nueva / UNIDADES;
    linea.estado = 'AJUSTADA';
    linea.ajustes.push({ ronda, faltante, anterior: anterior / UNIDADES, nueva: nueva / UNIDADES });
    return [{ codigo: 'LINEA_AJUSTADA', item_destino: linea.item, ronda, anterior: anterior / UNIDADES, nueva: nueva / UNIDADES }];
}

// CSA: the line shrinks by ceil(X) (floored at 0); the cut is taken from the attribution of the highest `orden`
// (lowest-priority destinations) first, which is reported per destination as SIN_STOCK.
function ajustarLineaCsa(d, linea, faltante, ronda) {
    const anterior = aUnidades(linea.cantidad);
    const corte = Math.min(anterior, aUnidadesCeil(faltante));
    const nueva = anterior - corte;
    const novedades = [];

    const atribucion = Array.isArray(linea.atribucion) ? linea.atribucion : [];
    const indices = atribucion.map((_, i) => i).sort((a, b) => (atribucion[b].orden - atribucion[a].orden) || (b - a));
    let porCortar = corte;
    const cantidades = atribucion.map(a => aUnidades(a.cantidad));
    for (const i of indices) {
        if (porCortar <= 0) break;
        const t = Math.min(cantidades[i], porCortar);
        if (t <= 0) continue;
        cantidades[i] -= t;
        porCortar -= t;
        novedades.push({ codigo: 'SIN_STOCK', item_destino: atribucion[i].item_destino, item_origen: linea.item, cantidad: t / UNIDADES });
    }
    linea.atribucion = atribucion
        .map((a, i) => ({ ...a, cantidad: cantidades[i] / UNIDADES }))
        .filter((a, i) => cantidades[i] > 0);

    linea.cantidad = nueva / UNIDADES;
    linea.ajustes.push({ ronda, faltante, anterior: anterior / UNIDADES, nueva: nueva / UNIDADES });
    if (nueva === 0) {
        linea.estado = 'DESCARTADA';
        novedades.push({ codigo: 'LINEA_DESCARTADA', item_origen: linea.item, ronda });
    } else {
        linea.estado = 'AJUSTADA';
        novedades.push({ codigo: 'LINEA_AJUSTADA', item_origen: linea.item, ronda, anterior: anterior / UNIDADES, nueva: nueva / UNIDADES });
    }
    return novedades;
}

function descartarLinea(d, linea, ronda) {
    linea.estado = 'DESCARTADA';
    return [d.tipo_dto === 'CEI'
        ? { codigo: 'LINEA_DESCARTADA', item_destino: linea.item, ronda }
        : { codigo: 'LINEA_DESCARTADA', item_origen: linea.item, ronda }];
}

// ──────────────────────────────────────────────────────────
// One document
// ──────────────────────────────────────────────────────────
// Returns { status, doc, posts, causa, abortada, erroresGuardado }
//   causa: null | 'NO_CORREGIBLE' (definitive rejection with nothing correctable: auth, connector, payload shape...)
//          | 'FALTANTE_AGOTADO' (Faltante caps exhausted)
//   abortada: a persistence failure happened and the whole run must stop.
async function enviarDocumento(docEntrada, deps) {
    const { guardar, enviar, unidadNegocio } = deps;
    const esperar = deps.esperar || esperarPorDefecto;
    const log = deps.log || (() => {});
    const def = DEFINICIONES[docEntrada.tipo_dto];
    if (!def) throw new Error(`Unknown tipo_dto "${docEntrada.tipo_dto}"`);

    const d = clonar(docEntrada);
    d.lineas = d.lineas || [];
    d.novedades = d.novedades || [];
    d.intentos = d.intentos || 0;
    const resultado = { status: d.status, doc: d, posts: 0, causa: null, abortada: false, erroresGuardado: [] };
    const traza = [];
    const ctxBase = { co: d.co, bodega: d.bodega, tipo_dto: d.tipo_dto };
    let ajustes = 0;
    let descartes = 0;
    let fase = 'INICIAL';

    const agregar = (specs) => {
        for (const s of specs) d.novedades.push(crearNovedad(s.codigo, { ...ctxBase, ...s }));
    };
    const agregarUnica = (codigo) => {
        if (!d.novedades.some(n => n.codigo === codigo)) agregar([{ codigo }]);
    };
    const novedadRechazo = () => agregarUnica(d.tipo_dto === 'CEI' ? 'CEI_RECHAZADO' : 'CSA_RECHAZADO');
    const respuestaActual = () => ({ rondas: traza.slice(-MAX_RONDAS_TRAZA) });
    const ahora = () => new Date().toISOString();

    // Saves the final state. A failure is a persistence failure: the run aborts, and a document Siesa may have
    // accepted stays AMBIGUO in memory so nothing that depends on it is sent.
    const cerrar = async (status, { error = null, posiblementeEnviado = false, ok = false } = {}) => {
        const final = { ...d, status, error, respuesta: respuestaActual(), ...resumenLineas(d.lineas), updated_at: ahora() };
        log(`[BACKUP ${d.tipo_dto} CO ${d.co} ${d.bodega}] row to save: ${JSON.stringify({ ...final, payload: undefined })}`);
        try {
            await guardarConReintento(clonar(final), guardar, esperar);
            Object.assign(d, final);
        } catch (e) {
            resultado.erroresGuardado.push({ fase: 'RESULTADO', ok, error: e.message });
            resultado.abortada = true;
            Object.assign(d, final, { status: posiblementeEnviado ? 'AMBIGUO' : status });
            d.posiblementeEnviado = posiblementeEnviado;
        }
        resultado.status = d.status;
        return resultado;
    };

    for (;;) {
        if (resumenLineas(d.lineas).lineas_activas === 0) {
            agregarUnica(d.tipo_dto === 'CEI' ? 'CEI_RECHAZADO' : 'CSA_DESCARTADA_TOTAL');
            return cerrar('CANCELADO', { error: null });
        }

        const payload = construirPayloadDocumento({
            def, fecha: d.fecha, co: d.co, bodega: d.bodega, lineas: d.lineas, unidadNegocio,
            nota: notaDocumento(def, d.fecha, d.co, d.bodega)
        });
        const ronda = ajustes + descartes;

        // Pre-send marker with the exact payload: if it cannot be persisted nothing is posted and the run stops.
        const sending = {
            ...d, status: 'SENDING', payload, rondas: ronda, intentos: d.intentos + 1,
            respuesta: respuestaActual(), ...resumenLineas(d.lineas), updated_at: ahora()
        };
        try {
            await guardarConReintento(clonar(sending), guardar, esperar);
        } catch (e) {
            resultado.erroresGuardado.push({ fase: 'SENDING', ok: false, error: e.message });
            resultado.abortada = true;
            return resultado;
        }
        Object.assign(d, sending);

        resultado.posts += 1;
        let res;
        try {
            res = await enviar(clonar(payload));
        } catch (e) {
            res = { ok: false, ambiguo: true, respuesta: null, mensaje: e.message };
        }
        const detalleRespuesta = res.respuesta && Array.isArray(res.respuesta.detalle) ? res.respuesta.detalle : undefined;
        traza.push({ ronda, fase, ok: !!res.ok, mensaje: res.mensaje, ...(detalleRespuesta ? { detalle: detalleRespuesta } : {}) });

        if (res.ok) return cerrar('OK', { ok: true, posiblementeEnviado: true });
        if (res.ambiguo) return cerrar('AMBIGUO', { error: `AMBIGUO: ${res.mensaje}`, posiblementeEnviado: true });

        const aplicables = faltantesAplicables(detalleRespuesta, d.lineas, d.bodega);
        if (aplicables.length === 0) {
            resultado.causa = 'NO_CORREGIBLE';
            novedadRechazo();
            return cerrar('ERROR', { error: res.mensaje });
        }

        if (ajustes < MAX_RONDAS_AJUSTE) {
            ajustes += 1;
            fase = 'AJUSTE';
            for (const { linea, faltante } of aplicables) {
                agregar(d.tipo_dto === 'CEI'
                    ? ajustarLineaCei(d, linea, faltante, ajustes)
                    : ajustarLineaCsa(d, linea, faltante, ajustes));
            }
        } else if (descartes < MAX_RONDAS_DESCARTE) {
            descartes += 1;
            fase = 'DESCARTE';
            for (const { linea } of aplicables) agregar(descartarLinea(d, linea, ajustes + descartes));
        } else {
            resultado.causa = 'FALTANTE_AGOTADO';
            novedadRechazo();
            return cerrar('ERROR', { error: res.mensaje });
        }
    }
}

// ──────────────────────────────────────────────────────────
// One store: CEI first, CSA only after the CEI is OK
// ──────────────────────────────────────────────────────────
function resultadoSinEnvio(doc) {
    return { status: doc.status, doc, posts: 0, causa: null, abortada: false, erroresGuardado: [] };
}

async function procesarDocumento(doc, deps) {
    return ESTADOS_ENVIABLES.has(doc.status) ? enviarDocumento(doc, deps) : resultadoSinEnvio(doc);
}

// { cei, csa } are stored document rows (csa may be null: store without origins). Resume friendly: documents that
// are OK/AMBIGUO/CANCELADO are never resent. Returns { cei, csa, bloqueo, abortada }:
//   bloqueo: null | 'CEI_AMBIGUO' (red) | 'CEI_ERROR' | 'CEI_CANCELADO' | 'CEI_NO_OK' (green, reported)
async function enviarTienda({ cei, csa = null }, deps) {
    const salida = { cei: null, csa: null, bloqueo: null, abortada: false };

    salida.cei = await procesarDocumento(cei, deps);
    if (salida.cei.abortada) { salida.abortada = true; return salida; }
    if (!csa) return salida;

    const estadoCei = salida.cei.status;
    if (estadoCei !== 'OK') {
        salida.bloqueo = { AMBIGUO: 'CEI_AMBIGUO', ERROR: 'CEI_ERROR', CANCELADO: 'CEI_CANCELADO' }[estadoCei] || 'CEI_NO_OK';
        return salida;
    }

    // Derived right before sending (idempotent, survives crash/resume): CEI lines that ended DESCARTADA take their
    // share out of the CSA.
    const { lineas } = aplicarDescartesCei(salida.cei.doc.lineas, csa.lineas);
    salida.csa = await procesarDocumento({ ...csa, lineas }, deps);
    if (salida.csa.abortada) salida.abortada = true;
    return salida;
}

// ──────────────────────────────────────────────────────────
// Job colour helper
// ──────────────────────────────────────────────────────────
// Systemic failure: at least one document was POSTed in the run and EVERY posted document ended ERROR for a
// non-Faltante reason (auth, connector, payload shape). A mix with an OK document, an AMBIGUO/CANCELADO outcome
// or Faltante-cap exhaustion is not systemic. `resultados`: [{ status, causa, posts }] per processed document.
function falloSistemico(resultados = []) {
    const enviados = resultados.filter(r => r.posts >= 1);
    return enviados.length >= 1 && enviados.every(r => r.status === 'ERROR' && r.causa !== 'FALTANTE_AGOTADO');
}

module.exports = {
    aplicarDescartesCei,
    enviarDocumento,
    enviarTienda,
    falloSistemico,
    guardarConReintento,
    MAX_POSTS_POR_DOCUMENTO,
    MAX_RONDAS_AJUSTE,
    MAX_RONDAS_DESCARTE
};
