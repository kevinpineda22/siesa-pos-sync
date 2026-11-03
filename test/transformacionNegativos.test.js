// Orchestrator tests: every dependency is an in-memory fake. No network, no Supabase, no Siesa.
// NOTE: this file requires ../transformacionNegativos, which loads transformacionCarnes (dotenv). Do not run it
// casually: it is NOT part of the safe test list.
process.env.ENTORNO_SIESA_TRANSF = 'QA';

const test = require('node:test');
const assert = require('node:assert');
const {
    transformacionNegativos, mapearInventario, resumirCorridaNegativos, MOTIVO_CEI_POSIBLEMENTE_ENVIADO
} = require('../transformacionNegativos');

const HOY = '2026-10-29';
const AYER = '2026-10-28';
const AHORA_NOCHE = new Date('2026-10-30T04:00:00Z'); // 23:00 COT on 2026-10-29
const AHORA_MANANA = new Date('2026-10-29T15:00:00Z'); // 10:00 COT on 2026-10-29

const REGLAS = {
    equivalencias: [
        { item_origen: 15101, item_destino: 15202, activo: true },
        { item_origen: 15102, item_destino: 15202, activo: true }
    ],
    prioridad: [{ item_origen: 15101, orden: 1, activo: true }, { item_origen: 15102, orden: 2, activo: true }]
};

// Raw Connekta rows: 15202 is short by 5 kg; 15101 has 3 kg, 15102 has 10 kg.
// Expected plan: one CEI (15202 = 5) and one CSA (15101 = 3, 15102 = 2) for store 001/00201.
const INVENTARIO_RAW = [
    { IDCO: '001', IdBodega: '00201', CodigoItem: 15202, CantidadDisponible: -5, CostoPromUnitInst: 9000, UM: 'KL' },
    { IDCO: '001', IdBodega: '00201', CodigoItem: 15101, CantidadDisponible: 3, CostoPromUnitInst: 5000, UM: 'KL' },
    { IDCO: '001', IdBodega: '00201', CodigoItem: 15102, CantidadDisponible: 10, CostoPromUnitInst: 6000, UM: 'KL' }
];

const clave = (f) => `${f.fecha}|${f.co}|${f.bodega}|${f.tipo_dto}`;
const copia = (x) => JSON.parse(JSON.stringify(x));

// Stored document rows (new table) as they would come back from Supabase.
function docGuardado(fecha, tipo, status, extra = {}) {
    const lineas = tipo === 'CEI'
        ? [{ nro: 1, item: 15202, um: 'KL', costo: 9000, disponible_snapshot: -5, cantidad_plan: 5, cantidad: 5, estado: 'ACTIVA', ajustes: [], origenes: [{ item: 15101, cantidad: 3 }, { item: 15102, cantidad: 2 }] }]
        : [
            { nro: 1, item: 15101, um: 'KL', costo: 5000, disponible_snapshot: 3, cantidad_plan: 3, cantidad: 3, estado: 'ACTIVA', ajustes: [], atribucion: [{ item_destino: 15202, cantidad: 3, orden: 1 }] },
            { nro: 2, item: 15102, um: 'KL', costo: 6000, disponible_snapshot: 10, cantidad_plan: 2, cantidad: 2, estado: 'ACTIVA', ajustes: [], atribucion: [{ item_destino: 15202, cantidad: 2, orden: 1 }] }
        ];
    return {
        entorno: 'QA', fecha, co: '001', bodega: '00201', tipo_dto: tipo, status,
        lineas, novedades: [], cantidad_total: 5, lineas_activas: lineas.length, payload: null, respuesta: null,
        error: null, intentos: 0, rondas: 0,
        ...extra
    };
}

// Faltante rejection as returned by Siesa (detalle entries).
const faltante = (item, x) => ({
    ok: false, ambiguo: false, mensaje: 'rechazo',
    respuesta: { detalle: [{ f_detalle: `Item sin cantidad disponible. Faltante Inv.: -${x}`, f_valor: `Item:${String(item).padStart(7, '0')}Bodega:00201` }] }
});
const OK = { ok: true, ambiguo: false, respuesta: { ok: 1 }, mensaje: 'OK' };

// Builds fake deps plus an ordered event log.
//   enviarResultado(tipo, payload, n) -> { ok, ambiguo, respuesta, mensaje }   (n = POST count so far, 1-based)
//   fallaGuardado(fila) -> true to make guardarDoc throw for that row
function crearEntorno({ guardados = [], legado = [], enviarResultado, fallaGuardado = () => false, inventario = INVENTARIO_RAW, guardarLote } = {}) {
    const db = new Map(guardados.map(f => [clave(f), copia(f)]));
    const eventos = [];
    const posts = [];
    const payloads = [];
    const notificaciones = [];
    const corridas = [];
    const lotes = [];
    const deps = {
        cargarReglas: async () => { eventos.push('REGLAS'); return copia(REGLAS); },
        leerInventario: async (q) => { eventos.push(`INV:${q}`); return { filas: inventario, paginas: 2 }; },
        cargarDocs: async ({ desde, hasta }) => [...db.values()].filter(f => f.fecha >= desde && f.fecha <= hasta).map(copia),
        cargarLegado: async () => copia(legado),
        guardarDoc: async (fila) => {
            if (fallaGuardado(fila)) throw new Error('db down');
            eventos.push(`SAVE:${fila.tipo_dto}:${fila.status}:${fila.fecha}`);
            db.set(clave(fila), copia(fila));
        },
        guardarLote: guardarLote || (async (filas) => {
            eventos.push(`LOTE:${filas.length}`);
            lotes.push(filas.map(f => `${f.co}${f.tipo_dto}`));
            filas.forEach(f => db.set(clave(f), copia(f)));
        }),
        enviar: async (payload) => {
            const tipo = payload.Documentos[0].TIPO_DTO;
            eventos.push(`POST:${tipo}`);
            posts.push(tipo);
            payloads.push(payload);
            return enviarResultado ? enviarResultado(tipo, payload, posts.length) : OK;
        },
        notificar: async (r) => { notificaciones.push(r); },
        insertarCorrida: async (fila) => { corridas.push(fila); },
        esperar: async () => {}
    };
    return { deps, db, eventos, posts, payloads, notificaciones, corridas, lotes };
}

async function correr(opciones, deps) {
    const originales = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = () => {};
    try {
        return await transformacionNegativos({
            ahora: AHORA_NOCHE, queryInventario: 'q_test', columnas: {}, diasReanudar: 7, unidadNegocio: '003', ...opciones
        }, deps);
    } finally {
        Object.assign(console, originales);
    }
}

const itemsDe = (payload) => payload.Movimientos.map(m => Number(m.ITEM));
const estadoDe = (env, fecha, tipo) => env.db.get(`${fecha}|001|00201|${tipo}`).status;

// ── per-store flow: plan before send, SENDING before every POST ───────────

test('one CEI and one CSA per store: whole plan persisted before any POST, SENDING right before each POST', async () => {
    const env = crearEntorno();
    const r = await correr({ fecha: HOY }, env.deps);

    assert.strictEqual(r.destinos, 1);
    assert.strictEqual(r.documentos, 2);
    assert.strictEqual(r.fallos, 0);
    assert.deepStrictEqual(env.posts, ['CEI', 'CSA']);
    assert.deepStrictEqual(env.lotes, [['001CEI', '001CSA']]); // the pair travels in ONE call
    assert.deepStrictEqual(itemsDe(env.payloads[0]), [15202]);
    assert.deepStrictEqual(itemsDe(env.payloads[1]), [15101, 15102]);
    assert.ok(env.eventos.indexOf('LOTE:2') < env.eventos.indexOf('POST:CEI'));
    env.eventos.forEach((e, i) => {
        if (!e.startsWith('POST:')) return;
        assert.strictEqual(env.eventos[i - 1], `SAVE:${e.slice(5)}:SENDING:${HOY}`, `SENDING must precede ${e}`);
    });
    assert.ok(env.eventos.indexOf('POST:CEI') < env.eventos.indexOf('POST:CSA'));
    assert.strictEqual(estadoDe(env, HOY, 'CEI'), 'OK');
    assert.strictEqual(estadoDe(env, HOY, 'CSA'), 'OK');
    assert.strictEqual(env.notificaciones.length, 1);
});

test('SENDING persist failure aborts with zero POSTs', async () => {
    const env = crearEntorno({ fallaGuardado: f => f.status === 'SENDING' });
    const r = await correr({ fecha: HOY }, env.deps);

    assert.strictEqual(env.posts.length, 0);
    assert.strictEqual(r.abortada, true);
    assert.strictEqual(r.alertas.erroresGuardado.length, 1);
    assert.strictEqual(r.alertas.erroresGuardado[0].fase, 'SENDING');
});

test('save failure after OK aborts the run: no CSA POST, the CEI is AMBIGUO in memory', async () => {
    const env = crearEntorno({ fallaGuardado: f => f.status === 'OK' });
    const r = await correr({ fecha: HOY }, env.deps);

    assert.deepStrictEqual(env.posts, ['CEI']);
    assert.strictEqual(r.abortada, true);
    assert.strictEqual(r.alertas.erroresGuardado[0].fase, 'RESULTADO');
    assert.strictEqual(r.alertas.ambiguos.length, 1);
    assert.ok(r.alertas.bloqueados.some(b => b.tipo_dto === 'CSA'));
});

test('missing table (42P01) on the plan save aborts before any POST telling to apply migration 010', async () => {
    const env = crearEntorno({ guardarLote: async () => { throw Object.assign(new Error('relation does not exist'), { code: '42P01' }); } });
    await assert.rejects(correr({ fecha: HOY }, env.deps), /migration 010/);
    assert.strictEqual(env.posts.length, 0);
});

test('missing table (42P01) on the document read fails the real run and is tolerated by the dry run', async () => {
    const env = crearEntorno();
    env.deps.cargarDocs = async () => { throw Object.assign(new Error('relation does not exist'), { code: '42P01' }); };
    await assert.rejects(correr({ fecha: HOY }, env.deps), /migration 010/);
    assert.strictEqual(env.posts.length, 0);
    const seco = await correr({ fecha: HOY, dryRun: true, ahora: AHORA_MANANA }, env.deps);
    assert.strictEqual(seco.dryRun, true);
});

// ── Faltante retries, novedades and job colour ────────────────────────────

test('CSA rejected for Faltante is adjusted and resent; the cut is reported as a novedad and the job stays green', async () => {
    const env = crearEntorno({ enviarResultado: (tipo, p, n) => (n === 2 ? faltante(15101, 1) : OK) });
    const r = await correr({ fecha: HOY }, env.deps);

    assert.deepStrictEqual(env.posts, ['CEI', 'CSA', 'CSA']);
    assert.strictEqual(r.documentos, 2);
    assert.strictEqual(r.fallos, 0);
    assert.ok(r.alertas.novedades.some(n => n.codigo === 'SIN_STOCK'));
    assert.strictEqual(env.payloads[2].Movimientos[0].CANTIDAD.replace(/^0+/, ''), '2.0000');
});

test('Faltante caps exhausted on the CEI: store ends without documents, CSA blocked, job stays green (ALTA novedad)', async () => {
    const env = crearEntorno({ enviarResultado: (tipo) => (tipo === 'CEI' ? faltante(15202, 0.5) : OK) });
    const r = await correr({ fecha: HOY }, env.deps);

    assert.ok(!env.posts.includes('CSA'));
    assert.strictEqual(r.fallos, 0);
    assert.ok(r.alertas.novedades.some(n => n.codigo === 'CEI_RECHAZADO' && n.severidad === 'ALTA'));
    assert.ok(r.alertas.bloqueados.every(b => b.causa === 'CEI_CANCELADO' || b.causa === 'CEI_ERROR'));
});

test('systemic failure: every sent document ended ERROR for a non-Faltante reason -> job is red', async () => {
    const env = crearEntorno({ enviarResultado: () => ({ ok: false, ambiguo: false, respuesta: null, mensaje: '401 unauthorized' }) });
    const r = await correr({ fecha: HOY }, env.deps);

    assert.deepStrictEqual(env.posts, ['CEI']);
    assert.strictEqual(r.sistemico, true);
    assert.ok(r.fallos >= 1);
    assert.ok(r.alertas.bloqueados.some(b => b.causa === 'CEI_ERROR'));
});

test('not systemic: CEI OK and CSA ERROR (non-Faltante) leaves the job green', async () => {
    const env = crearEntorno({ enviarResultado: (tipo) => (tipo === 'CEI' ? OK : { ok: false, ambiguo: false, respuesta: null, mensaje: 'connector error' }) });
    const r = await correr({ fecha: HOY }, env.deps);

    assert.strictEqual(r.sistemico, false);
    assert.strictEqual(r.fallos, 0);
    assert.strictEqual(estadoDe(env, HOY, 'CSA'), 'ERROR');
});

test('CEI AMBIGUO blocks the CSA, is red and flags "possibly sent, manual review"', async () => {
    const env = crearEntorno({ enviarResultado: () => ({ ok: false, ambiguo: true, respuesta: null, mensaje: 'timeout' }) });
    const r = await correr({ fecha: HOY }, env.deps);

    assert.deepStrictEqual(env.posts, ['CEI']);
    assert.strictEqual(r.alertas.ambiguos.length, 1);
    assert.ok(r.fallos >= 2);
    assert.ok(r.alertas.bloqueados.every(b => b.motivo === MOTIVO_CEI_POSIBLEMENTE_ENVIADO && b.causa === 'CEI_AMBIGUO'));
    assert.strictEqual(estadoDe(env, HOY, 'CEI'), 'AMBIGUO');
});

// ── resume ────────────────────────────────────────────────────────────────

test('a document found in SENDING becomes AMBIGUO, is not resent and blocks the CSA (red)', async () => {
    const env = crearEntorno({ guardados: [docGuardado(HOY, 'CEI', 'SENDING', { intentos: 1 }), docGuardado(HOY, 'CSA', 'PLANNED')] });
    const r = await correr({ fecha: HOY }, env.deps);

    assert.strictEqual(env.posts.length, 0);
    assert.strictEqual(estadoDe(env, HOY, 'CEI'), 'AMBIGUO');
    assert.strictEqual(r.alertas.ambiguos.filter(a => a.previo).length, 1);
    assert.ok(r.alertas.bloqueados.some(b => b.causa === 'CEI_AMBIGUO'));
    assert.ok(r.fallos >= 2);
});

test('re-run resumes only the failed CSA', async () => {
    const env = crearEntorno({ guardados: [docGuardado(HOY, 'CEI', 'OK', { intentos: 1 }), docGuardado(HOY, 'CSA', 'ERROR', { intentos: 1 })] });
    const r = await correr({ fecha: HOY }, env.deps);

    assert.deepStrictEqual(env.posts, ['CSA']);
    assert.strictEqual(r.fallos, 0);
    assert.strictEqual(estadoDe(env, HOY, 'CSA'), 'OK');
});

test('all documents OK: nothing is sent even if the inventory still shows the negative', async () => {
    const env = crearEntorno({ guardados: [docGuardado(HOY, 'CEI', 'OK', { intentos: 1 }), docGuardado(HOY, 'CSA', 'OK', { intentos: 1 })] });
    const r = await correr({ fecha: HOY }, env.deps);

    assert.strictEqual(env.posts.length, 0);
    assert.strictEqual(r.destinos, 0);
    assert.ok(!env.eventos.some(e => e.startsWith('LOTE')));
});

test('S6 run start cancels a prior-day CEI ERROR and its pending CSA BEFORE planning; a new pair is planned today', async () => {
    const env = crearEntorno({ guardados: [docGuardado(AYER, 'CEI', 'ERROR', { intentos: 1 }), docGuardado(AYER, 'CSA', 'PLANNED')] });
    const r = await correr({ fecha: HOY }, env.deps);

    assert.strictEqual(r.alertas.cancelados.length, 2);
    assert.strictEqual(estadoDe(env, AYER, 'CEI'), 'CANCELADO');
    assert.strictEqual(estadoDe(env, AYER, 'CSA'), 'CANCELADO');
    assert.ok(env.eventos.indexOf(`SAVE:CEI:CANCELADO:${AYER}`) < env.eventos.indexOf('LOTE:2'));
    assert.deepStrictEqual(env.posts, ['CEI', 'CSA']);
});

test('prior-day CEI OK with a pending CSA: the CSA is resent and reported as a prior-day retry', async () => {
    const env = crearEntorno({ inventario: [], guardados: [docGuardado(AYER, 'CEI', 'OK', { intentos: 1 }), docGuardado(AYER, 'CSA', 'ERROR', { intentos: 1 })] });
    const r = await correr({ fecha: HOY }, env.deps);

    assert.deepStrictEqual(env.posts, ['CSA']);
    assert.strictEqual(r.alertas.reintentosDiasPrevios.length, 1);
    assert.strictEqual(r.alertas.reintentosDiasPrevios[0].resultado, 'OK');
});

test('prior-day CEI PLANNED with attempts > 0 is an anomaly: not cancelled, not sent', async () => {
    const env = crearEntorno({ inventario: [], guardados: [docGuardado(AYER, 'CEI', 'PLANNED', { intentos: 2 }), docGuardado(AYER, 'CSA', 'PLANNED')] });
    const r = await correr({ fecha: HOY }, env.deps);

    assert.strictEqual(env.posts.length, 0);
    assert.strictEqual(r.alertas.anomalias.length, 1);
    assert.strictEqual(estadoDe(env, AYER, 'CEI'), 'PLANNED');
});

test('PLAN_INCOMPLETO: a CEI with origins and no CSA row is never sent and the job is red', async () => {
    const env = crearEntorno({ inventario: [], guardados: [docGuardado(HOY, 'CEI', 'PLANNED')] });
    const r = await correr({ fecha: HOY }, env.deps);

    assert.strictEqual(env.posts.length, 0);
    assert.ok(r.alertas.anomalias.some(a => a.tipoAnomalia === 'PLAN_INCOMPLETO'));
    assert.ok(r.fallos >= 1);
});

// ── cutover (legacy table is read-only history) ───────────────────────────

test('S7 a destination with a legacy row for the date is not planned in the new documents and legacy is never written', async () => {
    const legado = [{ entorno: 'QA', fecha: HOY, co: '001', bodega: '00201', item_destino: 15202, tipo_dto: 'CEI', item_origen: 0, status: 'OK' }];
    const env = crearEntorno({ legado });
    const r = await correr({ fecha: HOY }, env.deps);

    assert.strictEqual(r.destinos, 0);
    assert.strictEqual(env.posts.length, 0);
    assert.strictEqual(env.db.size, 0);
});

test('S7b a legacy CSA still PLANNED is reported as LEGADO_PENDIENTE, not resent, job green', async () => {
    const legado = [{ entorno: 'QA', fecha: AYER, co: '001', bodega: '00201', item_destino: 15202, tipo_dto: 'CSA', item_origen: 15101, status: 'PLANNED', cantidad: 3 }];
    const env = crearEntorno({ legado, inventario: [] });
    const r = await correr({ fecha: HOY }, env.deps);

    assert.ok(r.alertas.omitidos.some(o => o.motivo === 'LEGADO_PENDIENTE'));
    assert.strictEqual(env.posts.length, 0);
    assert.strictEqual(r.fallos, 0);
});

// ── CO filter (TRANSF_NEG_COS) ────────────────────────────────────────────

test('CO filter: only the selected CO is planned and sent; others are untouched', async () => {
    const otra = crearEntorno();
    const r0 = await correr({ fecha: HOY, cos: '002' }, otra.deps);
    assert.strictEqual(r0.destinos, 0);
    assert.strictEqual(otra.posts.length, 0);

    const env = crearEntorno();
    const r = await correr({ fecha: HOY, cos: '1' }, env.deps);
    assert.strictEqual(r.destinos, 1);
    assert.deepStrictEqual(env.posts, ['CEI', 'CSA']);
});

test('CO filter also limits the resume: stored documents of other COs are not sent', async () => {
    const env = crearEntorno({ guardados: [docGuardado(HOY, 'CEI', 'ERROR', { intentos: 1 }), docGuardado(HOY, 'CSA', 'PLANNED')] });
    await correr({ fecha: HOY, cos: '005' }, env.deps);
    assert.strictEqual(env.posts.length, 0);
});

// ── date guard, resume-only, dry run, fail fast ───────────────────────────

test('a past fecha is resume-only: zero inventory-query calls and no planning', async () => {
    const env = crearEntorno({ guardados: [docGuardado(AYER, 'CEI', 'OK', { intentos: 1 }), docGuardado(AYER, 'CSA', 'ERROR', { intentos: 1 })] });
    const r = await correr({ fecha: AYER }, env.deps);

    assert.strictEqual(r.modo, 'SOLO_REANUDAR');
    assert.ok(!env.eventos.some(e => e.startsWith('INV:')));
    assert.ok(!env.eventos.includes('REGLAS'));
    assert.ok(!env.eventos.some(e => e.startsWith('LOTE')));
    assert.deepStrictEqual(env.posts, ['CSA']);
});

test('a future fecha is rejected before any read or write', async () => {
    const env = crearEntorno();
    await assert.rejects(correr({ fecha: '2026-10-31' }, env.deps), e => e.codigo === 'VALIDACION_FECHA');
    assert.deepStrictEqual(env.eventos, []);
    assert.strictEqual(env.corridas.length, 0);
});

test('today before 21:30 COT is rejected (non dry-run) with no writes', async () => {
    const env = crearEntorno();
    await assert.rejects(correr({ fecha: HOY, ahora: AHORA_MANANA }, env.deps), e => e.codigo === 'VALIDACION_FECHA');
    assert.deepStrictEqual(env.eventos, []);
});

test('dry_run: plan is computed but nothing is written, posted, notified or recorded', async () => {
    const env = crearEntorno();
    const r = await correr({ fecha: HOY, dryRun: true, ahora: AHORA_MANANA }, env.deps);

    assert.strictEqual(r.dryRun, true);
    assert.strictEqual(r.destinos, 1);
    assert.strictEqual(r.detalle.length, 2);
    assert.ok(r.detalle.every(d => d.resultado === 'DRY_RUN'));
    assert.deepStrictEqual(r.detalle.map(d => d.tipo_dto), ['CEI', 'CSA']);
    assert.strictEqual(env.posts.length, 0);
    assert.ok(!env.eventos.some(e => e.startsWith('SAVE') || e.startsWith('LOTE')));
    assert.strictEqual(env.db.size, 0);
    assert.strictEqual(env.notificaciones.length, 0);
    assert.strictEqual(env.corridas.length, 0);
});

test('an empty inventory query name fails fast before any read or write', async () => {
    const env = crearEntorno();
    await assert.rejects(correr({ fecha: HOY, queryInventario: '  ' }, env.deps), /TRANSF_NEG_QUERY_INVENTARIO/);
    assert.deepStrictEqual(env.eventos, []);
});

// ── run record + inventory mapping ────────────────────────────────────────

test('the run record carries inventory rows, pages and novedades and is written to the injected table writer', async () => {
    const env = crearEntorno();
    const r = await correr({ fecha: HOY }, env.deps);

    assert.deepStrictEqual(r.inventario, { filas: 3, paginas: 2, descartadas: 0 });
    assert.strictEqual(env.corridas.length, 1);
    assert.match(env.corridas[0].mensaje, /inventory_rows=3/);
    assert.match(env.corridas[0].mensaje, /inventory_pages=2/);
    assert.match(env.corridas[0].mensaje, /novedades=0/);
    assert.strictEqual(env.corridas[0].resultado, 'PROCESADO');
    assert.strictEqual(env.corridas[0].entorno, 'QA');
});

test('resumirCorridaNegativos: CON_FALLO on failures, SIN_NEGATIVOS when nothing planned', () => {
    const base = { fecha: HOY, entorno: 'QA', modo: 'PLANIFICAR', destinos: 0, documentos: 0, fallos: 0, alertas: {} };
    assert.strictEqual(resumirCorridaNegativos(base).resultado, 'SIN_NEGATIVOS');
    assert.strictEqual(resumirCorridaNegativos({ ...base, fallos: 1 }).resultado, 'CON_FALLO');
    assert.strictEqual(resumirCorridaNegativos({ ...base, destinos: 2, documentos: 4 }).resultado, 'PROCESADO');
    assert.strictEqual(resumirCorridaNegativos({ ...base, alertas: { erroresGuardado: [{}] } }).resultado, 'CON_FALLO');
});

test('mapearInventario maps the Connekta columns and discards unparseable rows', () => {
    const { filas, descartadas } = mapearInventario([
        { IDCO: '1', IdBodega: ' 00101 ', CodigoItem: '15202', CantidadDisponible: '-2.5', CostoPromUnitInst: '9000', UM: ' KL ' },
        { IDCO: '1', IdBodega: '00101', CodigoItem: 'x', CantidadDisponible: '1' },
        { IDCO: '1', IdBodega: '00101', CodigoItem: '15101', CantidadDisponible: '' }
    ]);
    assert.strictEqual(descartadas, 2);
    assert.deepStrictEqual(filas, [{ co: '001', bodega: '00101', item: 15202, disponible: -2.5, costo: 9000, um: 'KL' }]);
});

// ── W3: a scheduled run that lands on a past Bogota date must not pass silently ──

test('W3 scheduled run on a past fecha raises an alert and counts as failed; resume-only safety is kept', async () => {
    const env = crearEntorno();
    const r = await correr({ fecha: AYER, evento: 'schedule' }, env.deps);

    assert.strictEqual(r.modo, 'SOLO_REANUDAR');
    assert.ok(r.fallos >= 1);
    assert.ok(r.alertas.fechaDesfasada);
    assert.strictEqual(r.alertas.fechaDesfasada.fecha, AYER);
    assert.strictEqual(r.alertas.fechaDesfasada.hoy, HOY);
    assert.ok(!env.eventos.some(e => e.startsWith('INV:') || e.startsWith('LOTE')));
    assert.strictEqual(env.posts.length, 0);
    assert.strictEqual(env.notificaciones.length, 1);
    assert.strictEqual(env.corridas[0].resultado, 'CON_FALLO');
});

test('W3 manual dispatch on a past fecha stays a legitimate resume-only run (no alert)', async () => {
    const env = crearEntorno();
    const r = await correr({ fecha: AYER, evento: 'workflow_dispatch' }, env.deps);
    assert.strictEqual(r.fallos, 0);
    assert.strictEqual(r.alertas.fechaDesfasada, undefined);
});

test('W3 scheduled run on today plans normally with no date alert', async () => {
    const env = crearEntorno();
    const r = await correr({ fecha: HOY, evento: 'schedule' }, env.deps);
    assert.strictEqual(r.modo, 'PLANIFICAR');
    assert.strictEqual(r.fallos, 0);
    assert.strictEqual(r.alertas.fechaDesfasada, undefined);
});

// ── S1: TRANSF_NEG_ITEMS_EXCLUIDOS adds to the defaults and is validated ──

async function conEnv(valor, fn) {
    const previo = process.env.TRANSF_NEG_ITEMS_EXCLUIDOS;
    process.env.TRANSF_NEG_ITEMS_EXCLUIDOS = valor;
    try { return await fn(); } finally {
        if (previo === undefined) delete process.env.TRANSF_NEG_ITEMS_EXCLUIDOS; else process.env.TRANSF_NEG_ITEMS_EXCLUIDOS = previo;
    }
}

test('S1 env exclusions add to the defaults: the configured item and 15207 are both excluded', async () => {
    const inventario = [...INVENTARIO_RAW, { IDCO: '001', IdBodega: '00201', CodigoItem: 15207, CantidadDisponible: -2, CostoPromUnitInst: 9000, UM: 'KL' }];
    const reglas = { ...REGLAS, equivalencias: [...REGLAS.equivalencias, { item_origen: 15101, item_destino: 15207, activo: true }] };
    const env = crearEntorno({ inventario });
    env.deps.cargarReglas = async () => copia(reglas);
    const r = await conEnv('15202', () => correr({ fecha: HOY }, env.deps));
    assert.strictEqual(r.destinos, 0);
    assert.strictEqual(env.posts.length, 0);
});

test('S1 an invalid token in the env list fails fast before any read or write', async () => {
    const env = crearEntorno();
    await assert.rejects(conEnv('15202,abc', () => correr({ fecha: HOY }, env.deps)), /TRANSF_NEG_ITEMS_EXCLUIDOS.*abc/);
    assert.deepStrictEqual(env.eventos, []);
});
