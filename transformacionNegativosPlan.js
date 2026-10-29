// Pure planner for the negative inventory transformation job.
// No I/O, no env access, no network: everything comes in through arguments so it can be tested in isolation.
// Quantities are handled as integer cents end-to-end to avoid float drift in the origin ledger.

const DOC_ENTRADA = { tipoDto: 'CEI', claseDto: '61', concepto: '601', motivo: '06' };
const DOC_SALIDA = { tipoDto: 'CSA', claseDto: '62', concepto: '602', motivo: '10' };

const ITEMS_EXCLUIDOS_POR_DEFECTO = [15207];
const UNIDAD_NEGOCIO_POR_DEFECTO = '003';
// Where the CSA unit cost comes from. 'origen' = origin CostoPromUnitInst (business rule, pending QA against
// the connector); 'cero' = 0, the value the tocino job sends today. Switch here without touching the rest.
const POLITICA_COSTO_CSA_POR_DEFECTO = 'origen';

// ──────────────────────────────────────────────────────────
// Decimal-safe cents
// ──────────────────────────────────────────────────────────

// Splits |v| into integer cents plus the third decimal digit, using the 15 significant digits
// representation so binary noise (e.g. 0.515 stored as 0.51499999...) does not change the result.
function descomponer(v) {
    const x = Math.abs(Number(v));
    if (!Number.isFinite(x)) return { centavos: 0, tercer: 0 };
    if (x < 1e-6) return { centavos: 0, tercer: 0 };
    let s = x.toPrecision(15);
    if (/e/i.test(s)) s = x.toFixed(3); // very large magnitudes: exponent notation is not parseable below
    const [ent, frac = ''] = s.split('.');
    const f = (frac + '000').slice(0, 3);
    return { centavos: Number(ent) * 100 + Number(f.slice(0, 2)), tercer: Number(f[2]) };
}

// Half-up rounding of |v| to 2 decimals, returned as integer cents.
function aCentavos(v) {
    const { centavos, tercer } = descomponer(v);
    return centavos + (tercer >= 5 ? 1 : 0);
}

// Truncation (floor) of |v| to cents: used for origin availability so we never promise stock we do not have.
function truncarCentavos(v) {
    return descomponer(v).centavos;
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

function limpiarNumero(n) {
    return String(Number(Number(n).toFixed(4)));
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

const comparadorNumerico = new Intl.Collator('en', { numeric: true });

// ──────────────────────────────────────────────────────────
// Payload
// ──────────────────────────────────────────────────────────
function construirPayloadNegativo({ def, fecha, co, bodega, item, um, cantidad, costo, nota, unidadNegocio }) {
    return {
        Documentos: [{
            'TIPO_DTO': def.tipoDto,
            'FECHA_DOCUMENTO=8 (AAAAMMDD)': fecha.replace(/-/g, ''),
            'CLASE_DTO': def.claseDto,
            'NOTA': nota,
            'CONCEPTO': def.concepto
        }],
        Movimientos: [{
            'TIPO_DTO': def.tipoDto,
            'CONSECUTIVO': '0',
            'NRO_REGISTRO': '1',
            'BODEGA': bodega,
            'CONCEPTO': def.concepto,
            'MOTIVO': def.motivo,
            'CENTRO_OPERA_MOVIMIENTO': co,
            'UNIDAD_MEDIDA': um,
            'CANTIDAD': formatDecimal(cantidad),
            'ITEM': padItem(item),
            'UNIDAD_NEGOCIO': unidadNegocio,
            'COSTO_PROMEDIO_UNITARIO': formatDecimal(costo)
        }]
    };
}

// ──────────────────────────────────────────────────────────
// Planner
// ──────────────────────────────────────────────────────────
// inventario: [{ co, bodega, item, disponible, costo, um }]   (already normalized by the caller)
// reglas:     { equivalencias: [{item_origen,item_destino,activo}], prioridad: [{item_origen,orden,activo}], excluidos? }
// previos:    stored rows [{ fecha, co, bodega, item_destino, tipo_dto, status }] for the same entorno
// Returns { documentos, omitidos, errores }. Never mutates its inputs.
function planificarTransformaciones({
    inventario = [], reglas = {}, previos = [], fecha, entorno,
    unidadNegocio = UNIDAD_NEGOCIO_POR_DEFECTO,
    politicaCostoCsa = POLITICA_COSTO_CSA_POR_DEFECTO
} = {}) {
    const excluidos = new Set((reglas.excluidos || ITEMS_EXCLUIDOS_POR_DEFECTO).map(Number));
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

    // Deduplicate inventory rows per co|bodega|item. Identical duplicates collapse to one row; conflicting
    // duplicates (different stock, cost or UM) make the key an anomaly: it is neither planned nor used as an
    // origin, and it is reported (fail safe).
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

    // Ledger: availability in cents (truncated), cost and UM per co|bodega|item.
    const ledger = new Map();
    const negativos = [];
    const omitidos = [];
    for (const [k, f] of filas) {
        if (conflictivos.has(k)) {
            omitidos.push({
                co: f.co, bodega: f.bodega, item_destino: f.item, item_origen: f.item, motivo: 'INVENTARIO_DUPLICADO',
                detalle: 'Conflicting inventory rows for the same co|bodega|item; item ignored.'
            });
            continue;
        }
        ledger.set(k, { dispCents: f.disp > 0 ? truncarCentavos(f.disp) : 0, costo: f.costo, um: f.um });
        if (f.disp < 0) negativos.push(f);
    }

    // The destination set is fixed before allocation: a destination negative in this run is never an origin
    // in the same run (its CEI only brings it to ~0).
    const esDestinoEstaCorrida = new Set(negativos.map(n => clave(n.co, n.bodega, n.item)));

    const yaPlanificados = new Set();
    const bloqueados = new Set();
    for (const p of previos) {
        const k = clave(p.co, p.bodega, p.item_destino);
        if (norm(p.fecha) === fecha) yaPlanificados.add(k);
        if (p.tipo_dto === 'CEI' && (p.status === 'SENDING' || p.status === 'AMBIGUO')) bloqueados.add(k);
    }

    negativos.sort((a, b) =>
        comparadorNumerico.compare(a.co, b.co) || comparadorNumerico.compare(a.bodega, b.bodega) || a.item - b.item
    );

    const documentos = [];
    const errores = [];

    for (const dest of negativos) {
        if (excluidos.has(dest.item)) continue;
        const origenes = origenesPorDestino.get(dest.item);
        if (!origenes || origenes.length === 0) continue;

        const kDest = clave(dest.co, dest.bodega, dest.item);
        if (yaPlanificados.has(kDest)) continue;

        const base = { co: dest.co, bodega: dest.bodega, item_destino: dest.item };
        if (bloqueados.has(kDest)) {
            omitidos.push({ ...base, motivo: 'BLOQUEADO', detalle: 'Prior CEI is SENDING/AMBIGUO; manual review required.' });
            continue;
        }

        const q = aCentavos(dest.disp);
        if (q === 0) continue;

        if (!costoValido(dest.costo)) {
            errores.push({ ...base, cantidad: q / 100, error: 'Destination unit cost is missing or zero; nothing sent.' });
            continue;
        }

        // A destination without UM cannot produce a valid CEI nor be matched against origins: fail safe.
        if (!dest.um) {
            errores.push({ ...base, cantidad: q / 100, error: 'Destination UM is missing; nothing sent.' });
            continue;
        }

        // Tentative allocation: the ledger is only committed when the whole destination is accepted.
        let restante = q;
        const asignaciones = [];
        const omitidosDest = [];
        let errorCosto = null;
        for (const origen of origenes) {
            if (restante <= 0) break;
            const kOrig = clave(dest.co, dest.bodega, origen);
            if (esDestinoEstaCorrida.has(kOrig)) continue;
            const entrada = ledger.get(kOrig);
            if (!entrada || entrada.dispCents <= 0) continue;
            // An origin without UM is unknown, never a match.
            if (!entrada.um || entrada.um.toUpperCase() !== dest.um.toUpperCase()) {
                omitidosDest.push({ ...base, item_origen: origen, motivo: 'UM', detalle: `Origin UM ${entrada.um || '?'} differs from destination UM ${dest.um || '?'}.` });
                continue;
            }
            if (politicaCostoCsa === 'origen' && !costoValido(entrada.costo)) {
                errorCosto = `Origin ${origen} unit cost is missing or zero; nothing sent.`;
                break;
            }
            const toma = Math.min(entrada.dispCents, restante);
            restante -= toma;
            asignaciones.push({ origen, toma, entrada });
        }

        if (errorCosto) {
            errores.push({ ...base, cantidad: q / 100, error: errorCosto });
            continue;
        }

        omitidos.push(...omitidosDest);
        for (const a of asignaciones) a.entrada.dispCents -= a.toma;
        if (restante > 0) {
            omitidos.push({ ...base, motivo: 'SIN_STOCK', cantidad: restante / 100, detalle: 'Origins cannot cover the full quantity.' });
        }

        const nota = `Transformacion negativos ${fecha} CO ${dest.co}`;
        documentos.push({
            entorno, fecha, ...base,
            tipo_dto: DOC_ENTRADA.tipoDto, item_origen: 0,
            cantidad: q / 100, costo_unitario: Number(dest.costo), um: dest.um,
            disponible_snapshot: dest.disp,
            payload: construirPayloadNegativo({
                def: DOC_ENTRADA, fecha, co: dest.co, bodega: dest.bodega, item: dest.item, um: dest.um,
                cantidad: q / 100, costo: Number(dest.costo), unidadNegocio,
                nota: `${nota} - CEI ${limpiarNumero(q / 100)} ${dest.um.toLowerCase()}`
            })
        });
        for (const a of asignaciones) {
            const cantidad = a.toma / 100;
            const costo = politicaCostoCsa === 'origen' ? Number(a.entrada.costo) : 0;
            documentos.push({
                entorno, fecha, ...base,
                tipo_dto: DOC_SALIDA.tipoDto, item_origen: a.origen,
                cantidad, costo_unitario: costo, um: a.entrada.um,
                disponible_snapshot: a.entrada.dispCents / 100 + cantidad,
                payload: construirPayloadNegativo({
                    def: DOC_SALIDA, fecha, co: dest.co, bodega: dest.bodega, item: a.origen, um: a.entrada.um,
                    cantidad, costo, unidadNegocio,
                    nota: `${nota} - CSA ${a.origen} ${limpiarNumero(cantidad)} ${a.entrada.um.toLowerCase()}`
                })
            });
        }
    }

    return { documentos, omitidos, errores };
}

module.exports = {
    aCentavos,
    truncarCentavos,
    planificarTransformaciones,
    construirPayloadNegativo,
    ITEMS_EXCLUIDOS_POR_DEFECTO,
    UNIDAD_NEGOCIO_POR_DEFECTO,
    POLITICA_COSTO_CSA_POR_DEFECTO
};
