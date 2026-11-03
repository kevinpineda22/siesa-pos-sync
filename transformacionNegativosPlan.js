// Pure planner for the negative inventory transformation job.
// No I/O, no env access, no network: everything comes in through arguments so it can be tested in isolation.
// Quantities are handled as integers of 1e-4 end-to-end to avoid float drift in the origin ledger.

const { crearNovedad, ordenarNovedades } = require('./negativosNovedades');

const DOC_ENTRADA = { tipoDto: 'CEI', claseDto: '61', concepto: '601', motivo: '06' };
const DOC_SALIDA = { tipoDto: 'CSA', claseDto: '62', concepto: '602', motivo: '10' };

const ITEMS_EXCLUIDOS_POR_DEFECTO = [15207];
const UNIDAD_NEGOCIO_POR_DEFECTO = '003';
// Where the CSA unit cost comes from. 'origen' = origin CostoPromUnitInst (business rule, pending QA against
// the connector); 'cero' = 0, the value the tocino job sends today. Switch here without touching the rest.
const POLITICA_COSTO_CSA_POR_DEFECTO = 'origen';

// ──────────────────────────────────────────────────────────
// Decimal-safe 1e-4 units
// ──────────────────────────────────────────────────────────
const UNIDADES = 10000;

// Splits |v| into integer 1e-4 units, the fifth digit and whether anything non-zero follows the fourth digit.
// Uses the 15 significant digits representation so binary noise (0.30000000000000004) does not change the result.
function descomponerUnidades(v) {
    const x = Math.abs(Number(v));
    if (!Number.isFinite(x) || x < 1e-6) return { unidades: 0, quinto: 0, resto: false };
    let s = x.toPrecision(15);
    if (/e/i.test(s)) s = x.toFixed(6); // very large magnitudes: exponent notation is not parseable below
    const [ent, frac = ''] = s.split('.');
    const f = (frac + '00000').slice(0, 5);
    return {
        unidades: Number(ent) * UNIDADES + Number(f.slice(0, 4)),
        quinto: Number(f[4]),
        resto: /[1-9]/.test(frac.slice(4))
    };
}

// |v| rounded UP to 4 decimals: CEI quantity, so the destination never ends with a residual negative.
function aUnidadesCeil(v) {
    const { unidades, resto } = descomponerUnidades(v);
    return unidades + (resto ? 1 : 0);
}

// |v| truncated to 4 decimals: origin availability and anything that must not promise stock we do not have.
function truncarUnidades(v) {
    return descomponerUnidades(v).unidades;
}

// |v| rounded half-up to 4 decimals (stored quantities, which already carry at most 4 decimals).
function aUnidades(v) {
    const { unidades, quinto } = descomponerUnidades(v);
    return unidades + (quinto >= 5 ? 1 : 0);
}

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────
function formatDecimal(number) {
    if (number === null || number === undefined) return '000000000000000.0000';
    return parseFloat(number).toFixed(4).padStart(20, '0');
}

function padItem(id) {
    return String(id).trim().padStart(7, '0');
}

function norm(v) {
    return (v ?? '').toString().trim();
}

function clave(co, bodega, item) {
    return `${norm(co)}|${norm(bodega)}|${Number(item)}`;
}

function costoValido(c) {
    const n = Number(c);
    return c !== null && c !== undefined && c !== '' && Number.isFinite(n) && n > 0;
}

// Configured exclusions ADD to the defaults (never replace them). Any token that is not an integer item code is a
// configuration error: fail fast instead of silently ignoring it.
function construirExcluidos(extra) {
    const set = new Set(ITEMS_EXCLUIDOS_POR_DEFECTO.map(Number));
    for (const token of extra || []) {
        const texto = norm(token);
        const n = Number(texto);
        if (!/^\d+$/.test(texto) || !Number.isSafeInteger(n)) {
            throw new Error(`Invalid excluded item code "${texto}": expected an integer item code.`);
        }
        set.add(n);
    }
    return set;
}

const comparadorNumerico = new Intl.Collator('en', { numeric: true });

// ──────────────────────────────────────────────────────────
// Per-store planner: one CEI document and one CSA document per store (co, bodega)
// ──────────────────────────────────────────────────────────

// A CSA that is still pending OR may already be posted in Siesa reserves its origin stock (conservative):
// a SENDING/AMBIGUO document may have landed, so its stock may already be gone.
const ESTADOS_DOC_CSA_RESERVAN_ORIGEN = new Set(['PLANNED', 'ERROR', 'SENDING', 'AMBIGUO']);
const ESTADOS_LINEA_ACTIVA = new Set(['ACTIVA', 'AJUSTADA']);

function normCo(v) {
    const t = norm(v);
    return /^\d+$/.test(t) ? (t.replace(/^0+/, '') || '0') : t;
}

// CO filter (env TRANSF_NEG_COS): comma list or array of CO ids, empty = all stores.
function parsearCosFiltro(valor) {
    const lista = Array.isArray(valor) ? valor : String(valor ?? '').split(',');
    return lista.map(norm).filter(Boolean);
}

// Totals of a document's lines: only ACTIVA/AJUSTADA lines count. Exact, summed in 1e-4 integer units.
function resumenLineas(lineas = []) {
    const activas = lineas.filter(l => ESTADOS_LINEA_ACTIVA.has(l.estado));
    const unidades = activas.reduce((acc, l) => acc + aUnidades(l.cantidad), 0);
    return { cantidad_total: unidades / UNIDADES, lineas_activas: activas.length };
}

// Multi-line payload for one document. NRO_REGISTRO is renumbered on every build (dropped lines leave no gaps).
function construirPayloadDocumento({ def, fecha, co, bodega, lineas, unidadNegocio, nota }) {
    const activas = lineas.filter(l => ESTADOS_LINEA_ACTIVA.has(l.estado));
    return {
        Documentos: [{
            'TIPO_DTO': def.tipoDto,
            'FECHA_DOCUMENTO=8 (AAAAMMDD)': fecha.replace(/-/g, ''),
            'CLASE_DTO': def.claseDto,
            'NOTA': nota,
            'CONCEPTO': def.concepto
        }],
        Movimientos: activas.map((l, i) => ({
            'TIPO_DTO': def.tipoDto,
            'CONSECUTIVO': '0',
            'NRO_REGISTRO': String(i + 1),
            'BODEGA': bodega,
            'CONCEPTO': def.concepto,
            'MOTIVO': def.motivo,
            'CENTRO_OPERA_MOVIMIENTO': co,
            'UNIDAD_MEDIDA': l.um,
            'CANTIDAD': formatDecimal(aUnidades(l.cantidad) / UNIDADES),
            'ITEM': padItem(l.item),
            'UNIDAD_NEGOCIO': unidadNegocio,
            'COSTO_PROMEDIO_UNITARIO': formatDecimal(l.costo)
        }))
    };
}

function notaDocumento(def, fecha, co, bodega) {
    return `Transformacion negativos ${fecha} CO ${co} BOD ${bodega} - ${def.tipoDto}`;
}

function ensamblarDocumento({ def, entorno, fecha, co, bodega, lineas, novedades, unidadNegocio }) {
    return {
        entorno, fecha, co, bodega, tipo_dto: def.tipoDto,
        lineas,
        novedades: ordenarNovedades(novedades.map(n => crearNovedad(n.codigo, { ...n, co, bodega, tipo_dto: def.tipoDto }))),
        ...resumenLineas(lineas),
        payload: construirPayloadDocumento({ def, fecha, co, bodega, lineas, unidadNegocio, nota: notaDocumento(def, fecha, co, bodega) })
    };
}

// inventario: [{ co, bodega, item, disponible, costo, um }]
// reglas:     { equivalencias, prioridad, excluidos? }
// previos:    { docs: rows of the new table (same entorno), legado: rows of the legacy per-destination table }
// cos:        optional CO filter (array or comma string); empty = all stores
// Returns { documentos, omitidos, errores }. Never mutates its inputs.
function planificarNegativosPorTienda({
    inventario = [], reglas = {}, previos = {}, fecha, entorno,
    unidadNegocio = UNIDAD_NEGOCIO_POR_DEFECTO,
    politicaCostoCsa = POLITICA_COSTO_CSA_POR_DEFECTO,
    cos
} = {}) {
    const docsPrevios = previos.docs || [];
    const legado = previos.legado || [];
    const cosPermitidos = new Set(parsearCosFiltro(cos).map(normCo));
    const excluidos = construirExcluidos(reglas.excluidos);
    const equivalencias = (reglas.equivalencias || []).filter(e => e.activo !== false);
    const ordenPrioridad = new Map(
        (reglas.prioridad || []).filter(p => p.activo !== false).map(p => [Number(p.item_origen), Number(p.orden)])
    );

    // Origins per destination, in global priority order (unlisted last, then item asc).
    const origenesPorDestino = new Map();
    for (const e of equivalencias) {
        const d = Number(e.item_destino);
        if (!origenesPorDestino.has(d)) origenesPorDestino.set(d, []);
        const lista = origenesPorDestino.get(d);
        if (!lista.includes(Number(e.item_origen))) lista.push(Number(e.item_origen));
    }
    for (const lista of origenesPorDestino.values()) {
        lista.sort((a, b) => {
            const oa = ordenPrioridad.has(a) ? ordenPrioridad.get(a) : Infinity;
            const ob = ordenPrioridad.has(b) ? ordenPrioridad.get(b) : Infinity;
            return oa === ob ? a - b : (oa < ob ? -1 : 1);
        });
    }

    // Deduplicate inventory rows per co|bodega|item: identical duplicates collapse, conflicting ones are an
    // anomaly (neither planned nor used as origin) and are reported (fail safe).
    const filas = new Map();
    const conflictivos = new Map();
    for (const r of inventario) {
        const disp = Number(r.disponible);
        if (!Number.isFinite(disp)) continue;
        const k = clave(r.co, r.bodega, r.item);
        const fila = { co: norm(r.co), bodega: norm(r.bodega), item: Number(r.item), disp, costo: r.costo, um: norm(r.um) };
        const previa = filas.get(k);
        if (!previa) { filas.set(k, fila); continue; }
        const igual = previa.disp === fila.disp && Number(previa.costo) === Number(fila.costo) && previa.um.toUpperCase() === fila.um.toUpperCase();
        if (!igual) conflictivos.set(k, fila);
    }

    // Ledger: availability in 1e-4 units (truncated), cost and UM per co|bodega|item.
    const ledger = new Map();
    const negativos = [];
    const omitidos = [];
    const errores = [];
    for (const [k, f] of filas) {
        if (conflictivos.has(k)) {
            omitidos.push({
                co: f.co, bodega: f.bodega, item_destino: f.item, item_origen: f.item, motivo: 'INVENTARIO_DUPLICADO',
                detalle: 'Conflicting inventory rows for the same co|bodega|item; item ignored.'
            });
            continue;
        }
        ledger.set(k, { dispU: f.disp > 0 ? truncarUnidades(f.disp) : 0, reservadoU: 0, costo: f.costo, um: f.um });
        if (f.disp < 0) negativos.push(f);
    }

    // The destination set is fixed before allocation: a destination negative in this run is never an origin
    // in the same run (its CEI only brings it to ~0).
    const esDestinoEstaCorrida = new Set(negativos.map(n => clave(n.co, n.bodega, n.item)));

    // Reservation from the new table: non-DESCARTADA lines of CSA documents that are pending or possibly posted.
    const tiendasYaPlanificadas = new Set();
    for (const d of docsPrevios) {
        if (norm(d.fecha) === fecha) tiendasYaPlanificadas.add(`${norm(d.co)}|${norm(d.bodega)}`);
        if (d.tipo_dto !== 'CSA' || !ESTADOS_DOC_CSA_RESERVAN_ORIGEN.has(d.status)) continue;
        for (const l of d.lineas || []) {
            if (l.estado === 'DESCARTADA') continue;
            const entrada = ledger.get(clave(d.co, d.bodega, l.item));
            const u = aUnidades(l.cantidad);
            if (!entrada || u <= 0) continue;
            const antes = entrada.dispU;
            entrada.dispU = Math.max(0, antes - u);
            // Tracked so the audit snapshot can stay pre-reservation.
            entrada.reservadoU += antes - entrada.dispU;
        }
    }

    // Cutover: the legacy table is read-only history. A destination the legacy flow already owns for this fecha is
    // never planned here (exactly one path per store/fecha/destination); legacy leftovers are only reported.
    const propiosLegado = new Set();
    const bloqueadosLegado = new Set();
    for (const r of legado) {
        const kd = clave(r.co, r.bodega, r.item_destino);
        if (norm(r.fecha) === fecha) propiosLegado.add(kd);
        if (r.tipo_dto === 'CEI' && (r.status === 'SENDING' || r.status === 'AMBIGUO')) bloqueadosLegado.add(kd);
        if (r.tipo_dto === 'CSA' && (r.status === 'PLANNED' || r.status === 'ERROR')) {
            omitidos.push({
                co: norm(r.co), bodega: norm(r.bodega), item_destino: Number(r.item_destino), item_origen: Number(r.item_origen),
                motivo: 'LEGADO_PENDIENTE', cantidad: Number(r.cantidad),
                detalle: 'Legacy CSA still pending; it is never resent by the per-store flow. Manual review required.'
            });
        }
    }

    negativos.sort((a, b) =>
        comparadorNumerico.compare(a.co, b.co) || comparadorNumerico.compare(a.bodega, b.bodega) || a.item - b.item
    );
    const tiendas = new Map();
    for (const n of negativos) {
        const k = `${n.co}|${n.bodega}`;
        if (!tiendas.has(k)) tiendas.set(k, []);
        tiendas.get(k).push(n);
    }

    const documentos = [];
    for (const [kTienda, destinos] of tiendas) {
        const { co, bodega } = destinos[0];
        if (cosPermitidos.size > 0 && !cosPermitidos.has(normCo(co))) continue;
        if (tiendasYaPlanificadas.has(kTienda)) continue;

        const lineasCei = [];
        const csaPorOrigen = new Map();
        const pendientes = [];   // novedades without tipo_dto yet: attached to the CSA doc, else to the CEI doc
        let orden = 0;

        for (const dest of destinos) {
            if (excluidos.has(dest.item)) continue;
            const origenes = origenesPorDestino.get(dest.item);
            if (!origenes || origenes.length === 0) continue;

            const kDest = clave(dest.co, dest.bodega, dest.item);
            const base = { co: dest.co, bodega: dest.bodega, item_destino: dest.item };
            if (bloqueadosLegado.has(kDest)) {
                omitidos.push({ ...base, motivo: 'BLOQUEADO_LEGADO', detalle: 'Legacy CEI is SENDING/AMBIGUO; manual review required.' });
                continue;
            }
            if (propiosLegado.has(kDest)) continue;

            const q = aUnidadesCeil(dest.disp);
            if (q === 0) continue;

            if (!costoValido(dest.costo)) {
                errores.push({ ...base, cantidad: q / UNIDADES, error: 'Destination unit cost is missing or zero; nothing sent.' });
                continue;
            }
            // A destination without UM cannot produce a valid CEI nor be matched against origins: fail safe.
            if (!dest.um) {
                errores.push({ ...base, cantidad: q / UNIDADES, error: 'Destination UM is missing; nothing sent.' });
                continue;
            }

            // Tentative allocation: the ledger is only committed when the whole destination is accepted.
            let restante = q;
            const asignaciones = [];
            const omitidosDest = [];
            let errorCosto = null;
            let origenSinDato = null;
            let ultimoOrigen = origenes[0];
            for (const origen of origenes) {
                if (restante <= 0) break;
                const kOrig = clave(dest.co, dest.bodega, origen);
                if (esDestinoEstaCorrida.has(kOrig)) continue;
                if (conflictivos.has(kOrig)) continue;
                const entrada = ledger.get(kOrig);
                // The inventory query has no ORDER BY, so paging can skip rows: an origin with no row is UNKNOWN
                // stock, not zero. Reaching it before the quantity is covered means we cannot trust the plan.
                if (!entrada) { origenSinDato = origen; break; }
                ultimoOrigen = origen;
                if (entrada.dispU <= 0) continue;
                // An origin without UM is unknown, never a match.
                if (!entrada.um || entrada.um.toUpperCase() !== dest.um.toUpperCase()) {
                    omitidosDest.push({ ...base, item_origen: origen, motivo: 'UM', detalle: `Origin UM ${entrada.um || '?'} differs from destination UM ${dest.um || '?'}.` });
                    continue;
                }
                if (politicaCostoCsa === 'origen' && !costoValido(entrada.costo)) {
                    errorCosto = `Origin ${origen} unit cost is missing or zero; nothing sent.`;
                    break;
                }
                const toma = Math.min(entrada.dispU, restante);
                restante -= toma;
                asignaciones.push({ origen, toma, entrada });
            }

            if (origenSinDato !== null) {
                omitidos.push({
                    ...base, item_origen: origenSinDato, motivo: 'ORIGEN_SIN_DATO',
                    detalle: `No inventory row for origin ${origenSinDato} in bodega ${dest.bodega}; stock unknown, destination skipped and retried next run.`
                });
                continue;
            }
            if (errorCosto) {
                errores.push({ ...base, cantidad: q / UNIDADES, error: errorCosto });
                continue;
            }

            omitidos.push(...omitidosDest);
            for (const o of omitidosDest) pendientes.push({ codigo: 'UM_DISTINTA', item_destino: dest.item, item_origen: o.item_origen });
            orden += 1;
            for (const a of asignaciones) {
                let linea = csaPorOrigen.get(a.origen);
                if (!linea) {
                    linea = {
                        item: a.origen, um: a.entrada.um,
                        costo: politicaCostoCsa === 'origen' ? Number(a.entrada.costo) : 0,
                        // Pre-reservation live availability at the moment of the first allocation.
                        disponible_snapshot: (a.entrada.dispU + a.entrada.reservadoU) / UNIDADES,
                        unidades: 0, atribucion: []
                    };
                    csaPorOrigen.set(a.origen, linea);
                }
                linea.unidades += a.toma;
                linea.atribucion.push({ item_destino: dest.item, cantidad: a.toma / UNIDADES, orden });
                a.entrada.dispU -= a.toma;
            }
            if (restante > 0) {
                omitidos.push({ ...base, motivo: 'SIN_STOCK', cantidad: restante / UNIDADES, detalle: 'Origins cannot cover the full quantity.' });
                pendientes.push({ codigo: 'SIN_STOCK', item_destino: dest.item, item_origen: ultimoOrigen, cantidad: restante / UNIDADES });
            }
            lineasCei.push({
                nro: lineasCei.length + 1, item: dest.item, um: dest.um, costo: Number(dest.costo),
                disponible_snapshot: dest.disp, cantidad_plan: q / UNIDADES, cantidad: q / UNIDADES,
                estado: 'ACTIVA', ajustes: [],
                origenes: asignaciones.map(a => ({ item: a.origen, cantidad: a.toma / UNIDADES }))
            });
        }

        if (lineasCei.length === 0) continue;

        const lineasCsa = [...csaPorOrigen.values()].map((l, i) => ({
            nro: i + 1, item: l.item, um: l.um, costo: l.costo, disponible_snapshot: l.disponible_snapshot,
            cantidad_plan: l.unidades / UNIDADES, cantidad: l.unidades / UNIDADES,
            estado: 'ACTIVA', ajustes: [], atribucion: l.atribucion
        }));
        const hayCsa = lineasCsa.length > 0;
        const comunes = { entorno, fecha, co, bodega, unidadNegocio };
        documentos.push(ensamblarDocumento({ ...comunes, def: DOC_ENTRADA, lineas: lineasCei, novedades: hayCsa ? [] : pendientes }));
        if (hayCsa) documentos.push(ensamblarDocumento({ ...comunes, def: DOC_SALIDA, lineas: lineasCsa, novedades: pendientes }));
    }

    return { documentos, omitidos, errores };
}

// Same-day override for a manual early-close run (stores closing before 21:30 COT).
// `opcion` (tests) wins over the env value; a scheduled run NEVER honours the flag, so the nightly cron
// keeps the 21:30 COT guard even if the env var leaks into it.
function resolverPermitirDiaEnCurso({ opcion, env, evento } = {}) {
    if (evento === 'schedule') return false;
    if (opcion !== undefined) return opcion === true;
    return ['1', 'true'].includes(String(env || '').toLowerCase());
}

module.exports = {
    resolverPermitirDiaEnCurso,
    UNIDADES,
    aUnidades,
    aUnidadesCeil,
    truncarUnidades,
    resumenLineas,
    parsearCosFiltro,
    normCo,
    planificarNegativosPorTienda,
    construirPayloadDocumento,
    notaDocumento,
    DOC_ENTRADA,
    DOC_SALIDA,
    ITEMS_EXCLUIDOS_POR_DEFECTO,
    UNIDAD_NEGOCIO_POR_DEFECTO,
    POLITICA_COSTO_CSA_POR_DEFECTO
};
