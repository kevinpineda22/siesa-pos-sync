// Facturas omitidas: documentos del POS que nunca recibieron una fila en `sps_facturas`.
//
// Cuando una corrida salta facturas por completo (no llegan a CNZ ni a CFZ), no queda registro en
// Supabase y el panel no puede mostrarlas ni reprocesarlas. Este módulo descarga las queries
// ACUMULADAS del POS, agrupa por documento y las compara contra `sps_facturas`.
//
// SOLO LECTURA: no escribe en Siesa ni en Supabase.
//
// Llave de comparación: la misma con la que `logger.registrarResultado` arma el id de la fila
// (`{tipo}:{co}:{caja}:{consec}`), donde `co` es el CO del POS (CoDoc de la venta) y NO el CO con
// el que se crea el documento en Siesa (`coDocumento`). Ver syncVentas.js (meta.co en la
// construcción de tareas) y logger.js (registrarResultado).

const TIPOS = ['CFZ', 'CNZ'];
const CAJAS_VALIDAS = ['Z01', 'Z02'];
const NIT_GENERICO = '222222222222';
const COS_GENERICOS = ['011', '012'];
const MAX_DIAS_RANGO = 31;
const TAM_PAGINA_SUPABASE = 1000;
const TAM_LOTE_IDS = 200;

// Fecha mínima que cubren las queries acumuladas (temporal). Configurable por entorno.
const FECHA_MINIMA_ACUM = (process.env.FACTURAS_OMITIDAS_DESDE || '2026-11-01').trim();

// Query de Connekta con las cabeceras de facturas acumuladas (ver queries_connekta).
const QUERY_FACTURAS_ACUM = 'merkahorro_facturas_pos_acum';

const REGEX_FECHA = /^\d{4}-\d{2}-\d{2}$/;

function esFechaValida(valor) {
    if (!REGEX_FECHA.test(valor)) return false;
    const d = new Date(`${valor}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === valor;
}

function diasEntre(desde, hasta) {
    return Math.round((new Date(`${hasta}T00:00:00Z`) - new Date(`${desde}T00:00:00Z`)) / 86400000) + 1;
}

/**
 * Valida el rango de fechas. Devuelve un mensaje de error (string) o null si es válido.
 */
function validarRango(desde, hasta, { minimo = FECHA_MINIMA_ACUM, maxDias = MAX_DIAS_RANGO } = {}) {
    if (!desde || !hasta) return 'Los parámetros "desde" y "hasta" son obligatorios (YYYY-MM-DD).';
    if (!esFechaValida(desde) || !esFechaValida(hasta)) return 'Las fechas deben tener el formato YYYY-MM-DD y ser válidas.';
    if (desde > hasta) return '"desde" no puede ser posterior a "hasta".';
    if (desde < minimo) return `"desde" no puede ser anterior a ${minimo} (primera fecha cubierta por las queries acumuladas).`;
    if (diasEntre(desde, hasta) > maxDias) return `El rango máximo es de ${maxDias} días.`;
    return null;
}

// El sync escribe el CO recortado y, si viene vacío, '001' (ver buildKey en syncVentas.js).
// Para comparar se usa siempre la forma de 3 dígitos.
const normCo = (co) => (String(co ?? '').trim() || '001').padStart(3, '0');
// Variantes con las que pudo quedar guardado el CO en sps_facturas: con ceros ('001') y sin ellos ('1').
function variantesCo(co) {
    const base = normCo(co);
    const sinCeros = String(Number(base));
    return [...new Set([base, sinCeros])];
}
const normCaja = (caja) => String(caja ?? '').trim().toUpperCase();
// consec: Number -> String quita ceros a la izquierda; si no es numérico se deja el texto limpio.
function normConsec(consec) {
    const n = Number(String(consec ?? '').trim());
    return Number.isFinite(n) && String(consec ?? '').trim() !== '' ? String(n) : String(consec ?? '').trim();
}
const fechaDe = (valor) => String(valor ?? '').split('T')[0];
const soloDigitos = (valor) => String(valor ?? '').replace(/\D/g, '');

/**
 * Agrupa registros de detalle (una fila por línea) en documentos únicos.
 * El neto (VrNetoDocto) es del documento y se repite en cada línea: se toma el de la primera.
 * Filtra por fecha [desde, hasta] y cajas Z01/Z02.
 *
 * @param {Array} registros filas de la query acumulada
 * @param {'normal'|'genericos'} flujo
 * @returns {Map<string, object>} documentos por llave `co|caja|consec`
 */
function agruparDocumentos(registros, { desde, hasta, flujo }) {
    const docs = new Map();
    for (const r of Array.isArray(registros) ? registros : []) {
        const fecha = fechaDe(r.FECHA_DOCTO);
        if (!fecha || fecha < desde || fecha > hasta) continue;
        const caja = normCaja(r.ID_TIPO_DOCTO);
        if (!CAJAS_VALIDAS.includes(caja)) continue;
        const co = normCo(r.CoDoc);
        const consec = normConsec(r.CONSEC_DOCTO);
        if (!consec) continue;
        const llave = `${co}|${caja}|${consec}`;
        if (docs.has(llave)) continue;
        const nit = String(r.NitTercero ?? '').trim();
        docs.set(llave, {
            co, caja, consec, fecha,
            nit,
            razon_social: String(r.RazonSocial ?? '').trim(),
            neto: Number(r.VrNetoDocto) || 0,
            // genericos: NIT 222222222222 en CO 011/012 (así lo entrega la query *_gen_acum).
            flujo: flujo === 'genericos' || (soloDigitos(nit) === NIT_GENERICO && COS_GENERICOS.includes(co))
                ? 'genericos' : 'normal'
        });
    }
    return docs;
}

/** Llave de una fila registrada en sps_facturas: `tipo|co|caja|consec` normalizada. */
function claveRegistrada({ tipo, co, caja, consec }) {
    return `${String(tipo ?? '').trim().toUpperCase()}|${normCo(co)}|${normCaja(caja)}|${normConsec(consec)}`;
}

/**
 * Función pura: devuelve los documentos a los que les falta CFZ y/o CNZ.
 * Cualquier fila presente en sps_facturas (cualquier estado) cuenta como registrada.
 *
 * @param {Iterable<object>} documentos documentos agrupados ({co, caja, consec, ...})
 * @param {Set<string>} registradas llaves de `claveRegistrada`
 */
function compararConRegistradas(documentos, registradas) {
    const omitidas = [];
    for (const d of documentos) {
        const faltan = TIPOS.filter(t => !registradas.has(`${t}|${d.co}|${d.caja}|${d.consec}`));
        if (faltan.length === 0) continue;
        omitidas.push({
            co: d.co,
            caja: d.caja,
            consec: d.consec,
            llave: `${d.co}-${d.caja}-${d.consec}`,
            fecha: d.fecha,
            nit: d.nit,
            razon_social: d.razon_social,
            neto: d.neto,
            faltan,
            flujo: d.flujo
        });
    }
    return omitidas.sort((a, b) =>
        a.fecha.localeCompare(b.fecha) ||
        a.co.localeCompare(b.co) ||
        a.caja.localeCompare(b.caja) ||
        Number(a.consec) - Number(b.consec));
}

/** Fecha mínima (YYYY-MM-DD) de FECHA_DOCTO presente en los registros descargados, o null si no hay. */
function coberturaDesde(registros) {
    let minima = null;
    for (const r of Array.isArray(registros) ? registros : []) {
        const f = fechaDe(r.FECHA_DOCTO);
        if (f && (minima === null || f < minima)) minima = f;
    }
    return minima;
}

/**
 * Une documentos de varias fuentes. Gana la PRIMERA fuente que tenga la llave, por eso
 * las fuentes de genéricos deben ir antes que la normal (un genérico nunca queda como 'normal').
 * @param {Array<Map<string, object>>} mapas en orden de prioridad
 */
function fusionarDocumentos(mapas) {
    const docs = new Map();
    for (const mapa of mapas) {
        for (const [llave, doc] of mapa) {
            if (!docs.has(llave)) docs.set(llave, doc);
        }
    }
    return docs;
}

/**
 * Consolida los resultados (Promise.allSettled) de las fuentes en documentos, cobertura y fuentes fallidas.
 * - La fuente 'normal' es obligatoria: si falló, se relanza su error.
 * - Una fuente de genéricos fallida se EXCLUYE completa (nunca parcial) y se reporta; solo puede
 *   ocultar documentos, nunca hacer que uno se reporte como omitido sin serlo.
 * - Prioridad: genéricos primero (un CO 011/012 genérico nunca queda como 'normal').
 * @param {Array<{id: string, flujo: string}>} fuentes
 * @param {Array<PromiseSettledResult<Array>>} resultados mismo orden que `fuentes`
 */
function consolidarFuentes(fuentes, resultados, { desde, hasta }) {
    const cobertura = {};
    const fuentesFallidas = [];
    const mapas = [];
    const indices = fuentes.map((f, i) => i).sort((a, b) =>
        (fuentes[a].flujo === 'genericos' ? 0 : 1) - (fuentes[b].flujo === 'genericos' ? 0 : 1));
    for (const i of indices) {
        const f = fuentes[i];
        const r = resultados[i];
        if (r.status === 'rejected') {
            const mensaje = String(r.reason?.message ?? r.reason ?? 'Error desconocido');
            if (f.flujo === 'normal') throw (r.reason instanceof Error ? r.reason : new Error(mensaje));
            fuentesFallidas.push({ fuente: f.id, error: mensaje });
            cobertura[f.id] = null;
            continue;
        }
        cobertura[f.id] = coberturaDesde(r.value);
        mapas.push(agruparDocumentos(r.value, { desde, hasta, flujo: f.flujo }));
    }
    return { documentos: fusionarDocumentos(mapas), cobertura, fuentes_fallidas: fuentesFallidas };
}

/** Ids exactos `{tipo}:{co}:{caja}:{consec}` (con variantes de CO) de lo que falta en cada candidata. */
function idsCandidatos(omitidas) {
    const ids = new Set();
    for (const o of omitidas) {
        for (const tipo of o.faltan) {
            for (const co of variantesCo(o.co)) ids.add(`${tipo}:${co}:${o.caja}:${o.consec}`);
        }
    }
    return [...ids];
}

// Lee de sps_facturas (paginado) las filas del rango, restringidas a los CO/cajas relevantes.
async function leerRegistradas(supabase, { desde, hasta, cos, cajas = CAJAS_VALIDAS }) {
    const registradas = new Set();
    if (cos.length === 0) return registradas;
    const cosConsulta = [...new Set(cos.flatMap(variantesCo))];
    for (let inicio = 0; ; inicio += TAM_PAGINA_SUPABASE) {
        const { data, error } = await supabase
            .from('sps_facturas')
            .select('id, tipo, co, caja, consec')
            .in('tipo', TIPOS)
            .in('co', cosConsulta)
            .in('caja', cajas)
            .gte('fecha_factura', desde)
            .lte('fecha_factura', hasta)
            .order('id')
            .range(inicio, inicio + TAM_PAGINA_SUPABASE - 1);
        if (error) throw new Error(`No se pudo leer sps_facturas: ${error.message}`);
        const pagina = data || [];
        pagina.forEach(r => registradas.add(claveRegistrada(r)));
        if (pagina.length < TAM_PAGINA_SUPABASE) break;
    }
    return registradas;
}

// Segunda pasada sin filtro de fecha: busca por id exacto las candidatas a omitidas. Cubre filas de
// sps_facturas con fecha_factura nula (el primer filtro las excluiría y se reenviaría un duplicado a Siesa).
// Devuelve las llaves (`claveRegistrada`) de las filas encontradas.
async function leerRegistradasPorId(supabase, ids) {
    const encontradas = new Set();
    for (let i = 0; i < ids.length; i += TAM_LOTE_IDS) {
        const { data, error } = await supabase
            .from('sps_facturas')
            .select('id, tipo, co, caja, consec')
            .in('id', ids.slice(i, i + TAM_LOTE_IDS));
        if (error) throw new Error(`No se pudo verificar sps_facturas por id: ${error.message}`);
        (data || []).forEach(r => encontradas.add(claveRegistrada(r)));
    }
    return encontradas;
}

/**
 * GET /api/facturas-omitidas?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
 * Solo lectura. Requiere sesión Supabase (requireSupabaseUser en server.js).
 */
async function facturasOmitidas(req, res) {
    const desde = String(req.query?.desde ?? '').trim();
    const hasta = String(req.query?.hasta ?? '').trim();
    const errorRango = validarRango(desde, hasta);
    if (errorRango) return res.status(400).json({ success: false, error: errorRango });

    try {
        // require diferido: mantiene este módulo puro y testeable sin cargar los flujos de sync.
        const logger = require('./logger');
        const { fetchPaginadoCompleto, URL_VENTAS_DETALLE_ACUM } = require('./syncVentas');

        // Única fuente: query liviana de CABECERAS (una fila por factura, sin líneas). Trae los NIT
        // reales de todos los CO y los genéricos solo de 011/012; agruparDocumentos los clasifica por
        // NIT + CO. Las queries de detalle (venta/gen acum) eran demasiado pesadas: el endpoint
        // superaba el timeout aunque se pidiera un solo día (Connekta no filtra por fecha).
        const urlFacturas = new URL(URL_VENTAS_DETALLE_ACUM);
        urlFacturas.searchParams.set('descripcion', QUERY_FACTURAS_ACUM);
        const fuentes = [
            { id: 'normal', flujo: 'normal', etiqueta: 'Omitidas', url: urlFacturas.toString() }
        ];

        // La fuente es estricta: completa o error, nunca parcial. Mismo formato que Promise.allSettled.
        const resultados = [];
        for (const f of fuentes) {
            try {
                resultados.push({ status: 'fulfilled', value: await fetchPaginadoCompleto(f.url, f.etiqueta, { estricto: true }) });
            } catch (error) {
                resultados.push({ status: 'rejected', reason: error });
            }
        }
        const { documentos, cobertura, fuentes_fallidas } = consolidarFuentes(fuentes, resultados, { desde, hasta });

        const cos = [...new Set([...documentos.values()].map(d => d.co))];
        const registradas = await leerRegistradas(logger.supabase, { desde, hasta, cos });
        let data = compararConRegistradas(documentos.values(), registradas);
        if (data.length > 0) {
            const porId = await leerRegistradasPorId(logger.supabase, idsCandidatos(data));
            data = compararConRegistradas(data.map(o => documentos.get(`${o.co}|${o.caja}|${o.consec}`)), new Set([...registradas, ...porId]));
        }

        res.status(200).json({ desde, hasta, cobertura_desde: cobertura.normal, cobertura, fuentes_fallidas, total: data.length, data });
    } catch (error) {
        console.error('❌ /api/facturas-omitidas:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
}

module.exports = {
    FECHA_MINIMA_ACUM,
    MAX_DIAS_RANGO,
    validarRango,
    agruparDocumentos,
    claveRegistrada,
    variantesCo,
    coberturaDesde,
    fusionarDocumentos,
    consolidarFuentes,
    idsCandidatos,
    compararConRegistradas,
    facturasOmitidas
};
