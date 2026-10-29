// Orchestrator tests: every dependency is an in-memory fake. No network, no Supabase, no Siesa.
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
const INVENTARIO_RAW = [
    { IDCO: '001', IdBodega: '00201', CodigoItem: 15202, CantidadDisponible: -5, CostoPromUnitInst: 9000, UM: 'KL' },
    { IDCO: '001', IdBodega: '00201', CodigoItem: 15101, CantidadDisponible: 3, CostoPromUnitInst: 5000, UM: 'KL' },
    { IDCO: '001', IdBodega: '00201', CodigoItem: 15102, CantidadDisponible: 10, CostoPromUnitInst: 6000, UM: 'KL' }
];

const clave = (f) => `${f.fecha}|${f.co}|${f.bodega}|${f.item_destino}|${f.tipo_dto}|${f.item_origen}`;

function filaGuardada(fecha, tipo, origen, status, extra = {}) {
    return {
        entorno: 'QA', fecha, co: '001', bodega: '00201', item_destino: 15202, tipo_dto: tipo, item_origen: origen,
        status, cantidad: 1, intentos: 0, error: null, respuesta: null,
        payload: { Movimientos: [{ TIPO_DTO: tipo, ITEM: String(origen || 15202).padStart(7, '0') }] },
        ...extra
    };
}

// Builds fake deps plus an ordered event log.
//   enviarResultado(payload) -> { ok, ambiguo, respuesta, mensaje }
//   fallaGuardado(fila) -> true to make guardarFila throw for that row
function crearEntorno({ guardadas = [], enviarResultado, fallaGuardado = () => false, inventario = INVENTARIO_RAW } = {}) {
    const db = new Map(guardadas.map(f => [clave(f), JSON.parse(JSON.stringify(f))]));
    const eventos = [];
    const posts = [];
    const notificaciones = [];
    const corridas = [];
    const deps = {
        cargarReglas: async () => { eventos.push('REGLAS'); return JSON.parse(JSON.stringify(REGLAS)); },
        leerInventario: async (q) => { eventos.push(`INV:${q}`); return { filas: inventario, paginas: 2 }; },
        cargarFilas: async ({ desde, hasta }) => [...db.values()].filter(f => f.fecha >= desde && f.fecha <= hasta).map(f => JSON.parse(JSON.stringify(f))),
        guardarFila: async (fila) => {
            if (fallaGuardado(fila)) throw new Error('db down');
            eventos.push(`SAVE:${fila.tipo_dto}:${fila.item_origen}:${fila.status}:${fila.fecha}`);
            db.set(clave(fila), JSON.parse(JSON.stringify(fila)));
        },
        guardarLote: async (filas) => {
            eventos.push(`LOTE:${filas.length}`);
            filas.forEach(f => db.set(clave(f), JSON.parse(JSON.stringify(f))));
        },
        enviar: async (payload) => {
            const m = payload.Movimientos[0];
            const id = `${m.TIPO_DTO}:${Number(m.ITEM)}`;
            eventos.push(`POST:${id}`);
            posts.push(id);
            return enviarResultado ? enviarResultado(payload) : { ok: true, ambiguo: false, respuesta: { ok: 1 }, mensaje: 'OK' };
        },
        notificar: async (r) => { notificaciones.push(r); },
        insertarCorrida: async (fila) => { corridas.push(fila); },
        esperar: async () => {}
    };
    return { deps, db, eventos, posts, notificaciones, corridas };
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

const POST_CEI = 'POST:CEI:15202';

// ── 3.1 plan before send, SENDING before POST ─────────────────────────────

test('plan is persisted before any send and SENDING is persisted right before each POST', async () => {
    const env = crearEntorno();
    const r = await correr({ fecha: HOY }, env.deps);

    assert.strictEqual(r.destinos, 1);
    assert.strictEqual(r.documentos, 3);
    assert.deepStrictEqual(env.posts, ['CEI:15202', 'CSA:15101', 'CSA:15102']);
    assert.strictEqual(env.eventos.indexOf('LOTE:3'), env.eventos.findIndex(e => e.startsWith('SAVE') || e.startsWith('POST')) - 1);
    assert.ok(env.eventos.indexOf('LOTE:3') < env.eventos.indexOf(POST_CEI));
    env.eventos.forEach((e, i) => {
        if (!e.startsWith('POST:')) return;
        const [, tipo, item] = e.split(':');
        const esperado = `SAVE:${tipo}:${tipo === 'CEI' ? 0 : item}:SENDING:${HOY}`;
        assert.strictEqual(env.eventos[i - 1], esperado, `SENDING must precede ${e}`);
    });
    // CEI before every CSA
    assert.ok(env.eventos.indexOf(POST_CEI) < env.eventos.indexOf('POST:CSA:15101'));
    for (const f of env.db.values()) assert.strictEqual(f.status, 'OK');
    assert.strictEqual(env.notificaciones.length, 1);
});

test('SENDING persist failure aborts with zero POSTs', async () => {
    const env = crearEntorno({ fallaGuardado: f => f.status === 'SENDING' });
    const r = await correr({ fecha: HOY }, env.deps);

    assert.strictEqual(env.posts.length, 0);
    assert.strictEqual(r.abortada, true);
    assert.strictEqual(r.alertas.erroresGuardado.length, 1);
    assert.strictEqual(r.alertas.erroresGuardado[0].fase, 'SENDING');
    assert.ok(r.fallos > 0);
});

test('save failure after OK aborts the run: no further POSTs', async () => {
    const env = crearEntorno({ fallaGuardado: f => f.tipo_dto === 'CEI' && f.status === 'OK' });
    const r = await correr({ fecha: HOY }, env.deps);

    assert.deepStrictEqual(env.posts, ['CEI:15202']);
    assert.strictEqual(r.abortada, true);
    assert.strictEqual(r.alertas.erroresGuardado[0].fase, 'RESULTADO');
    assert.strictEqual(r.alertas.erroresGuardado[0].ok, true);
});

test('save failure after a definitive ERROR also aborts the run', async () => {
    const env = crearEntorno({
        enviarResultado: () => ({ ok: false, ambiguo: false, respuesta: { detalle: ['x'] }, mensaje: 'rejected' }),
        fallaGuardado: f => f.status === 'ERROR'
    });
    const r = await correr({ fecha: HOY }, env.deps);

    assert.deepStrictEqual(env.posts, ['CEI:15202']);
    assert.strictEqual(r.abortada, true);
    assert.strictEqual(r.alertas.erroresGuardado.length, 1);
});

// ── 3.2 CEI gates the CSAs ────────────────────────────────────────────────

test('CEI definitive failure blocks its CSAs', async () => {
    const env = crearEntorno({ enviarResultado: () => ({ ok: false, ambiguo: false, respuesta: null, mensaje: 'rejected' }) });
    const r = await correr({ fecha: HOY }, env.deps);

    assert.deepStrictEqual(env.posts, ['CEI:15202']);
    assert.strictEqual(r.alertas.erroresSiesa.length, 1);
    assert.strictEqual(r.alertas.bloqueados.length, 2);
    assert.strictEqual(r.fallos > 0, true);
});

test('CEI AMBIGUO blocks CSAs and flags "possibly sent, manual review"', async () => {
    const env = crearEntorno({ enviarResultado: () => ({ ok: false, ambiguo: true, respuesta: null, mensaje: 'timeout' }) });
    const r = await correr({ fecha: HOY }, env.deps);

    assert.deepStrictEqual(env.posts, ['CEI:15202']);
    assert.strictEqual(r.alertas.ambiguos.length, 1);
    assert.strictEqual(r.alertas.bloqueados.length, 2);
    assert.ok(r.alertas.bloqueados.every(b => b.motivo === MOTIVO_CEI_POSIBLEMENTE_ENVIADO));
    const cei = [...env.db.values()].find(f => f.tipo_dto === 'CEI');
    assert.strictEqual(cei.status, 'AMBIGUO');
});

test('CEI AMBIGUO caused by a failed OK-save blocks CSAs and carries the manual review flag', async () => {
    const env = crearEntorno({ fallaGuardado: f => f.tipo_dto === 'CEI' && f.status === 'OK' });
    const r = await correr({ fecha: HOY }, env.deps);

    assert.deepStrictEqual(env.posts, ['CEI:15202']);
    assert.strictEqual(r.alertas.bloqueados.length, 2);
    assert.ok(r.alertas.bloqueados.every(b => b.motivo === 'CEI possibly sent, CSAs blocked, manual review'));
    // The row is still SENDING in storage: it becomes AMBIGUO on the next run.
    const cei = [...env.db.values()].find(f => f.tipo_dto === 'CEI');
    assert.strictEqual(cei.status, 'SENDING');
});

// ── 3.3 cancellation of prior-day rows ────────────────────────────────────

test('run start cancels eligible prior-day rows BEFORE planning; SENDING/AMBIGUO/OK are never cancelled', async () => {
    const dest = (n, tipo, origen, status, extra) => filaGuardada(AYER, tipo, origen, status, { item_destino: n, ...extra });
    const guardadas = [
        // 15301: CEI PLANNED intentos 0 + CSA PLANNED -> cancelled
        dest(15301, 'CEI', 0, 'PLANNED'), dest(15301, 'CSA', 15101, 'PLANNED'),
        // 15302: CEI ERROR + CSA ERROR -> cancelled
        dest(15302, 'CEI', 0, 'ERROR', { intentos: 1 }), dest(15302, 'CSA', 15101, 'ERROR', { intentos: 1 }),
        // 15303: CEI AMBIGUO -> nothing cancelled
        dest(15303, 'CEI', 0, 'AMBIGUO', { intentos: 1 }), dest(15303, 'CSA', 15101, 'PLANNED'),
        // 15304: CEI OK -> not cancelled
        dest(15304, 'CEI', 0, 'OK', { intentos: 1 }), dest(15304, 'CSA', 15101, 'OK', { intentos: 1 })
    ];
    const env = crearEntorno({ guardadas, inventario: [] });
    const r = await correr({ fecha: HOY }, env.deps);

    const estado = (n, tipo) => [...env.db.values()].find(f => f.item_destino === n && f.tipo_dto === tipo).status;
    assert.strictEqual(estado(15301, 'CEI'), 'CANCELADO');
    assert.strictEqual(estado(15301, 'CSA'), 'CANCELADO');
    assert.strictEqual(estado(15302, 'CEI'), 'CANCELADO');
    assert.strictEqual(estado(15302, 'CSA'), 'CANCELADO');
    assert.strictEqual(estado(15303, 'CEI'), 'AMBIGUO');
    assert.strictEqual(estado(15303, 'CSA'), 'PLANNED');
    assert.strictEqual(estado(15304, 'CEI'), 'OK');
    assert.strictEqual(r.alertas.cancelados.length, 4);
    const ultimaCancelacion = Math.max(...env.eventos.map((e, i) => e.includes(':CANCELADO:') ? i : -1));
    assert.ok(ultimaCancelacion < env.eventos.indexOf('INV:q_test'), 'cancellation must happen before the inventory is planned');
    assert.strictEqual(env.posts.length, 0);
    // The AMBIGUO CEI keeps its pending CSA blocked and flagged.
    assert.ok(r.alertas.bloqueados.some(b => b.item_destino === 15303 && b.motivo === MOTIVO_CEI_POSIBLEMENTE_ENVIADO));
});

test('a destination cancelled yesterday can be planned again today', async () => {
    const guardadas = [filaGuardada(AYER, 'CEI', 0, 'PLANNED'), filaGuardada(AYER, 'CSA', 15101, 'PLANNED')];
    const env = crearEntorno({ guardadas });
    const r = await correr({ fecha: HOY }, env.deps);

    assert.strictEqual(r.alertas.cancelados.length, 2);
    assert.strictEqual(r.destinos, 1);
    assert.deepStrictEqual(env.posts, ['CEI:15202', 'CSA:15101', 'CSA:15102']);
});

// ── 3.4 SENDING, resume, nothing to do ────────────────────────────────────

test('a row found in SENDING becomes AMBIGUO, is not resent and blocks its CSAs', async () => {
    const guardadas = [filaGuardada(HOY, 'CEI', 0, 'SENDING', { intentos: 1 }), filaGuardada(HOY, 'CSA', 15101, 'PLANNED')];
    const env = crearEntorno({ guardadas });
    const r = await correr({ fecha: HOY }, env.deps);

    assert.strictEqual(env.posts.length, 0);
    assert.strictEqual([...env.db.values()].find(f => f.tipo_dto === 'CEI').status, 'AMBIGUO');
    assert.ok(env.eventos.some(e => e === `SAVE:CEI:0:AMBIGUO:${HOY}`));
    assert.strictEqual(r.alertas.ambiguos.filter(a => a.previo).length, 1);
    assert.strictEqual(r.alertas.bloqueados.length, 1);
    assert.strictEqual(r.destinos, 0, 'a SENDING/AMBIGUO destination is not replanned');
});

test('re-run resumes only the failed CSA', async () => {
    const guardadas = [
        filaGuardada(HOY, 'CEI', 0, 'OK', { intentos: 1 }),
        filaGuardada(HOY, 'CSA', 15101, 'OK', { intentos: 1 }),
        filaGuardada(HOY, 'CSA', 15102, 'ERROR', { intentos: 1 })
    ];
    const env = crearEntorno({ guardadas });
    const r = await correr({ fecha: HOY }, env.deps);

    assert.deepStrictEqual(env.posts, ['CSA:15102']);
    assert.strictEqual(r.destinos, 0, 'the destination is not replanned');
    assert.strictEqual([...env.db.values()].find(f => f.item_origen === 15102).status, 'OK');
    assert.strictEqual([...env.db.values()].find(f => f.item_origen === 15102).intentos, 2);
});

test('all rows OK: nothing is sent even if the inventory still shows the negative', async () => {
    const guardadas = [
        filaGuardada(HOY, 'CEI', 0, 'OK', { intentos: 1 }),
        filaGuardada(HOY, 'CSA', 15101, 'OK', { intentos: 1 }),
        filaGuardada(HOY, 'CSA', 15102, 'OK', { intentos: 1 })
    ];
    const env = crearEntorno({ guardadas });
    const r = await correr({ fecha: HOY }, env.deps);

    assert.strictEqual(env.posts.length, 0);
    assert.strictEqual(r.destinos, 0);
    assert.ok(!env.eventos.some(e => e.startsWith('LOTE')));
});

// ── 3.5 prior-day CSA retries are reported ────────────────────────────────

test('prior-day CSA retries after CEI OK are reported in the payload', async () => {
    const guardadas = [
        filaGuardada(AYER, 'CEI', 0, 'OK', { intentos: 1 }),
        filaGuardada(AYER, 'CSA', 15101, 'OK', { intentos: 1 }),
        filaGuardada(AYER, 'CSA', 15102, 'ERROR', { intentos: 1 })
    ];
    const env = crearEntorno({ guardadas, inventario: [] });
    const r = await correr({ fecha: HOY }, env.deps);

    assert.deepStrictEqual(env.posts, ['CSA:15102']);
    assert.strictEqual(r.alertas.reintentosDiasPrevios.length, 1);
    const rep = r.alertas.reintentosDiasPrevios[0];
    assert.strictEqual(rep.fecha, AYER);
    assert.strictEqual(rep.item_origen, 15102);
    assert.strictEqual(rep.intentosPrevios, 1);
    assert.strictEqual(rep.resultado, 'OK');
    assert.strictEqual(env.notificaciones[0].alertas.reintentosDiasPrevios.length, 1);
});

// ── 3.6 date guard, resume-only, dry run, fail fast ───────────────────────

test('a past fecha is resume-only: zero inventory-query calls and no planning', async () => {
    const guardadas = [
        filaGuardada(AYER, 'CEI', 0, 'OK', { intentos: 1 }),
        filaGuardada(AYER, 'CSA', 15101, 'ERROR', { intentos: 1 })
    ];
    const env = crearEntorno({ guardadas });
    const r = await correr({ fecha: AYER }, env.deps);

    assert.strictEqual(r.modo, 'SOLO_REANUDAR');
    assert.ok(!env.eventos.some(e => e.startsWith('INV:')));
    assert.ok(!env.eventos.includes('REGLAS'));
    assert.ok(!env.eventos.some(e => e.startsWith('LOTE')));
    assert.deepStrictEqual(env.posts, ['CSA:15101']);
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
    assert.strictEqual(r.detalle.length, 3);
    assert.ok(r.detalle.every(d => d.resultado === 'DRY_RUN'));
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

test('the run record carries inventory rows and pages and is written to the injected table writer', async () => {
    const env = crearEntorno();
    const r = await correr({ fecha: HOY }, env.deps);

    assert.deepStrictEqual(r.inventario, { filas: 3, paginas: 2, descartadas: 0 });
    assert.strictEqual(env.corridas.length, 1);
    assert.match(env.corridas[0].mensaje, /inventory_rows=3/);
    assert.match(env.corridas[0].mensaje, /inventory_pages=2/);
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
        { IDCO: '1', IdBodega: ' 00201 ', CodigoItem: '15202', CantidadDisponible: '-5.5', CostoPromUnitInst: '9000', UM: ' KL ' },
        { IDCO: '001', IdBodega: '00201', CodigoItem: 'x', CantidadDisponible: 1, CostoPromUnitInst: 1, UM: 'KL' },
        { IDCO: '001', IdBodega: '00201', CodigoItem: 15101, CantidadDisponible: 2, CostoPromUnitInst: null, UM: 'KL' }
    ]);
    assert.strictEqual(descartadas, 1);
    assert.deepStrictEqual(filas[0], { co: '001', bodega: '00201', item: 15202, disponible: -5.5, costo: 9000, um: 'KL' });
    assert.strictEqual(filas[1].costo, null);
    // Column override
    const o = mapearInventario([{ a: '2', b: 'B', c: 7, d: 1, e: 2, f: 'UN' }], { co: 'a', bodega: 'b', item: 'c', disponible: 'd', costo: 'e', um: 'f' });
    assert.deepStrictEqual(o.filas[0], { co: '002', bodega: 'B', item: 7, disponible: 1, costo: 2, um: 'UN' });
});
