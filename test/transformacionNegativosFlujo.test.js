// Pure orchestration logic of the negative inventory job: no network, no env, no Siesa/Supabase.
const test = require('node:test');
const assert = require('node:assert');
const {
    agruparPorTienda, partirEnLotes, guardarPlanPorPares, esErrorTamano, esTablaFaltante,
    planificarReanudacion, detectarPlanIncompleto, calcularFallos, decidirSalidaCron,
    recolectarNovedades, describirDocumento, filaDetalle, coPermitido
} = require('../transformacionNegativosFlujo');

const FECHA = '2026-10-29';
const AYER = '2026-10-28';
const doc = (tipo, extra = {}) => ({
    entorno: 'QA', fecha: FECHA, co: '001', bodega: '00101', tipo_dto: tipo, status: 'PLANNED', intentos: 0,
    lineas: [{ item: 1, um: 'KL', cantidad: 2, estado: 'ACTIVA', origenes: tipo === 'CEI' ? [{ item: 5, cantidad: 2 }] : undefined }],
    novedades: [], ...extra
});
const noop = async () => {};

// ---- grouping ----
test('agruparPorTienda groups CEI and CSA per fecha|co|bodega and slices dates', () => {
    const m = agruparPorTienda([doc('CEI', { fecha: '2026-10-29T00:00:00' }), doc('CSA'), doc('CEI', { co: '002' })]);
    assert.strictEqual(m.size, 2);
    const t = m.get(`${FECHA}|001|00101`);
    assert.ok(t.cei && t.csa);
    assert.strictEqual(m.get(`${FECHA}|002|00101`).csa, null);
});

// ---- batching (PS-6) ----
test('partirEnLotes never splits a store pair and respects max pairs', () => {
    const docs = [];
    for (let i = 1; i <= 5; i++) docs.push(doc('CEI', { co: String(i) }), doc('CSA', { co: String(i) }));
    const lotes = partirEnLotes(docs, { maxPares: 2, maxBytes: 1e9 });
    assert.deepStrictEqual(lotes.map(l => l.length), [4, 4, 2]);
    for (const l of lotes) {
        const cos = l.map(d => d.co);
        for (const co of new Set(cos)) assert.strictEqual(cos.filter(c => c === co).length, 2);
    }
});

test('partirEnLotes closes a batch by byte size and a single oversize pair goes alone', () => {
    const grande = (co) => doc('CEI', { co, payload: { x: 'a'.repeat(500) } });
    const lotes = partirEnLotes([grande('1'), grande('2'), grande('3')], { maxPares: 99, maxBytes: 700 });
    assert.deepStrictEqual(lotes.map(l => l.length), [1, 1, 1]);
    assert.deepStrictEqual(partirEnLotes([], {}), []);
});

test('guardarPlanPorPares upserts whole pairs per call', async () => {
    const llamadas = [];
    const docs = [doc('CEI'), doc('CSA'), doc('CEI', { co: '002' }), doc('CSA', { co: '002' })];
    await guardarPlanPorPares(docs, async (rows) => { llamadas.push(rows.map(r => `${r.co}${r.tipo_dto}`)); }, { maxPares: 1, esperar: noop });
    assert.deepStrictEqual(llamadas, [['001CEI', '001CSA'], ['002CEI', '002CSA']]);
});

test('guardarPlanPorPares halves the batch on size errors down to one pair; pair is never split', async () => {
    const llamadas = [];
    const docs = [];
    for (let i = 1; i <= 4; i++) docs.push(doc('CEI', { co: String(i) }), doc('CSA', { co: String(i) }));
    const upsert = async (rows) => {
        llamadas.push(rows.length);
        if (rows.length > 2) throw Object.assign(new Error('Payload Too Large'), { status: 413 });
    };
    await guardarPlanPorPares(docs, upsert, { maxPares: 99, maxBytes: 1e9, esperar: noop });
    assert.deepStrictEqual(llamadas, [8, 4, 2, 2, 4, 2, 2]);
});

test('guardarPlanPorPares: a single pair too large is a persistence failure naming the store', async () => {
    const upsert = async () => { throw Object.assign(new Error('too large'), { status: 413 }); };
    await assert.rejects(
        guardarPlanPorPares([doc('CEI'), doc('CSA')], upsert, { esperar: noop }),
        (e) => e.code === 'TIENDA_DEMASIADO_GRANDE' && /001/.test(e.message) && /00101/.test(e.message)
    );
});

test('guardarPlanPorPares: missing table (42P01) says to apply migration 010 and is not retried', async () => {
    let n = 0;
    const upsert = async () => { n++; throw Object.assign(new Error('relation does not exist'), { code: '42P01' }); };
    await assert.rejects(guardarPlanPorPares([doc('CEI')], upsert, { esperar: noop }), (e) => e.code === 'MIGRACION_010' && /migration 010/.test(e.message));
    assert.strictEqual(n, 1);
});

test('guardarPlanPorPares retries transient errors 3 times then throws', async () => {
    let n = 0;
    const esperas = [];
    const upsert = async () => { n++; throw new Error('network'); };
    await assert.rejects(guardarPlanPorPares([doc('CEI')], upsert, { esperar: async (ms) => { esperas.push(ms); } }), /network/);
    assert.strictEqual(n, 3);
    assert.deepStrictEqual(esperas, [1000, 2000]);
    let k = 0;
    await guardarPlanPorPares([doc('CEI')], async () => { if (++k < 2) throw new Error('blip'); }, { esperar: noop });
    assert.strictEqual(k, 2);
});

test('error classifiers', () => {
    assert.ok(esErrorTamano({ status: 413 }));
    assert.ok(esErrorTamano({ message: 'Request Entity Too Large' }));
    assert.ok(!esErrorTamano({ message: 'boom' }));
    assert.ok(esTablaFaltante({ code: '42P01' }));
    assert.ok(esTablaFaltante({ message: 'relation "x" does not exist' }));
    assert.ok(!esTablaFaltante({ message: 'column foo does not exist' }));
});

// ---- resume (PS-8, PS-9) ----
test('planificarReanudacion: SENDING becomes AMBIGUO and is reported as previous', () => {
    const r = planificarReanudacion({ docs: [doc('CEI', { status: 'SENDING', intentos: 1 })], fecha: FECHA, ahora: new Date('2026-10-29T10:00:00Z') });
    assert.strictEqual(r.docs[0].status, 'AMBIGUO');
    assert.match(r.docs[0].error, /left in SENDING/);
    assert.strictEqual(r.ambiguos.length, 1);
    assert.strictEqual(r.ambiguos[0].previo, true);
    assert.strictEqual(r.cambios.length, 1);
});

test('planificarReanudacion S6: prior-day CEI ERROR cancels CEI and the pending CSA of that store', () => {
    const r = planificarReanudacion({
        docs: [doc('CEI', { fecha: AYER, status: 'ERROR', intentos: 1 }), doc('CSA', { fecha: AYER, status: 'PLANNED' })],
        fecha: FECHA
    });
    assert.deepStrictEqual(r.docs.map(d => d.status), ['CANCELADO', 'CANCELADO']);
    assert.strictEqual(r.cancelados.length, 2);
    assert.strictEqual(r.cancelados[1].estadoPrevio, 'PLANNED');
});

test('planificarReanudacion: prior-day CEI PLANNED attempts=0 is cancelable; with attempts>0 it is an anomaly', () => {
    const a = planificarReanudacion({ docs: [doc('CEI', { fecha: AYER }), doc('CSA', { fecha: AYER })], fecha: FECHA });
    assert.deepStrictEqual(a.docs.map(d => d.status), ['CANCELADO', 'CANCELADO']);
    const b = planificarReanudacion({ docs: [doc('CEI', { fecha: AYER, intentos: 2 }), doc('CSA', { fecha: AYER })], fecha: FECHA });
    assert.deepStrictEqual(b.docs.map(d => d.status), ['PLANNED', 'PLANNED']);
    assert.strictEqual(b.anomalias.length, 1);
    assert.match(b.anomalias[0].motivo, /attempts/);
});

test('planificarReanudacion: prior-day CEI OK and CSA PLANNED/ERROR are left for resend; AMBIGUO/OK never cancelled', () => {
    const r = planificarReanudacion({
        docs: [
            doc('CEI', { fecha: AYER, status: 'OK' }), doc('CSA', { fecha: AYER, status: 'ERROR' }),
            doc('CEI', { fecha: AYER, co: '002', status: 'AMBIGUO' }), doc('CSA', { fecha: AYER, co: '002', status: 'PLANNED' })
        ],
        fecha: FECHA
    });
    assert.deepStrictEqual(r.docs.map(d => d.status), ['OK', 'ERROR', 'AMBIGUO', 'PLANNED']);
    assert.strictEqual(r.cancelados.length, 0);
});

test('planificarReanudacion: today documents are never cancelled and SENDING CEI is not cancelled the same run', () => {
    const r = planificarReanudacion({
        docs: [doc('CEI', { status: 'ERROR', intentos: 1 }), doc('CEI', { fecha: AYER, co: '009', status: 'SENDING', intentos: 1 }), doc('CSA', { fecha: AYER, co: '009' })],
        fecha: FECHA
    });
    assert.deepStrictEqual(r.docs.map(d => d.status), ['ERROR', 'AMBIGUO', 'PLANNED']);
});

test('planificarReanudacion does not mutate its input', () => {
    const entrada = [doc('CEI', { status: 'SENDING' })];
    planificarReanudacion({ docs: entrada, fecha: FECHA });
    assert.strictEqual(entrada[0].status, 'SENDING');
});

// ---- PLAN_INCOMPLETO ----
test('detectarPlanIncompleto: CEI with origenes but no CSA row', () => {
    const r = detectarPlanIncompleto([doc('CEI'), doc('CEI', { co: '002' }), doc('CSA', { co: '002' })]);
    assert.strictEqual(r.anomalias.length, 1);
    assert.strictEqual(r.anomalias[0].tipoAnomalia, 'PLAN_INCOMPLETO');
    assert.deepStrictEqual([...r.tiendas], [`${FECHA}|001|00101`]);
});

test('detectarPlanIncompleto: CEI-only store without origins, or cancelled CEI, is fine', () => {
    const sinOrigen = doc('CEI', { lineas: [{ item: 1, cantidad: 2, estado: 'ACTIVA', origenes: [] }] });
    assert.strictEqual(detectarPlanIncompleto([sinOrigen]).anomalias.length, 0);
    assert.strictEqual(detectarPlanIncompleto([doc('CEI', { status: 'CANCELADO' })]).anomalias.length, 0);
});

// ---- fallos / colour (NV-3) ----
const vacias = () => ({ ambiguos: [], bloqueados: [], anomalias: [], erroresGuardado: [], novedades: [] });
test('calcularFallos counts AMBIGUO (new+previous), CSAs blocked behind AMBIGUO CEI, PLAN_INCOMPLETO, fechaDesfasada, systemic', () => {
    const a = vacias();
    assert.strictEqual(calcularFallos({ alertas: a, sistemico: false }), 0);
    a.ambiguos.push({ previo: false }, { previo: true });
    a.bloqueados.push({ causa: 'CEI_AMBIGUO' }, { causa: 'CEI_ERROR' }, { causa: 'CEI_CANCELADO' });
    a.anomalias.push({ tipoAnomalia: 'PLAN_INCOMPLETO' }, { motivo: 'x' });
    a.fechaDesfasada = { motivo: 'm' };
    assert.strictEqual(calcularFallos({ alertas: a, sistemico: true }), 2 + 1 + 1 + 1 + 1);
});

test('calcularFallos: novedades ALTA, CSA blocked behind CEI ERROR and LEGADO_PENDIENTE do not make the job red', () => {
    const a = vacias();
    a.novedades.push({ codigo: 'CEI_RECHAZADO', severidad: 'ALTA' });
    a.bloqueados.push({ causa: 'CEI_ERROR' });
    a.omitidos = [{ motivo: 'LEGADO_PENDIENTE' }];
    assert.strictEqual(calcularFallos({ alertas: a, sistemico: false }), 0);
});

test('decidirSalidaCron: exit 1 on fallos, save errors or abort; 0 otherwise (with novedades is green)', () => {
    const base = { fallos: 0, abortada: false, alertas: vacias() };
    assert.strictEqual(decidirSalidaCron(base).codigo, 0);
    assert.strictEqual(decidirSalidaCron({ ...base, fallos: 1 }).codigo, 1);
    assert.strictEqual(decidirSalidaCron({ ...base, abortada: true }).codigo, 1);
    const g = vacias(); g.erroresGuardado.push({});
    assert.strictEqual(decidirSalidaCron({ ...base, alertas: g }).codigo, 1);
    const n = vacias(); n.novedades.push({ severidad: 'ALTA' }, { severidad: 'INFO' });
    const s = decidirSalidaCron({ ...base, alertas: n });
    assert.strictEqual(s.codigo, 0);
    assert.match(s.mensajes.join('\n'), /2 novedad/i);
    assert.match(s.mensajes.join('\n'), /1 ALTA/);
});

// ---- novedades, detalle, dry-run description ----
test('recolectarNovedades merges docs, dedups and sorts ALTA first', () => {
    const n1 = { codigo: 'SIN_STOCK', severidad: 'MEDIA', co: '001', bodega: '00101', tipo_dto: 'CSA', item_destino: 1, item_origen: 5 };
    const n2 = { codigo: 'CEI_RECHAZADO', severidad: 'ALTA', co: '001', bodega: '00101', tipo_dto: 'CEI' };
    const r = recolectarNovedades([doc('CSA', { novedades: [n1, n1] }), doc('CEI', { novedades: [n2] })]);
    assert.deepStrictEqual(r.map(n => n.codigo), ['CEI_RECHAZADO', 'SIN_STOCK']);
});

test('filaDetalle builds the per-document row', () => {
    const f = filaDetalle(doc('CEI', { status: 'OK', cantidad_total: 2, lineas_activas: 1, rondas: 1, error: null }), 'OK');
    assert.deepStrictEqual(f, { fecha: FECHA, co: '001', bodega: '00101', tipo_dto: 'CEI', lineas_activas: 1, cantidad_total: 2, rondas: 1, resultado: 'OK', error: null });
});

test('describirDocumento prints store, lines, attribution and novedades for the dry-run review', () => {
    const csa = doc('CSA', {
        cantidad_total: 3, lineas_activas: 1,
        lineas: [{ item: 5, um: 'KL', cantidad: 3, estado: 'ACTIVA', atribucion: [{ item_destino: 1, cantidad: 2, orden: 1 }, { item_destino: 2, cantidad: 1, orden: 2 }] }],
        novedades: [{ codigo: 'SIN_STOCK', severidad: 'MEDIA', mensaje: 'No habia suficiente 5' }]
    });
    const texto = describirDocumento(csa).join('\n');
    assert.match(texto, /CSA/);
    assert.match(texto, /CO 001/);
    assert.match(texto, /00101/);
    assert.match(texto, /item 5/);
    assert.match(texto, /1=2/);
    assert.match(texto, /\[MEDIA\]/);
    const cei = describirDocumento(doc('CEI')).join('\n');
    assert.match(cei, /item 1/);
    assert.match(cei, /5=2/);
});

test('coPermitido: empty filter allows all; tolerates leading zeros', () => {
    assert.ok(coPermitido('001', ''));
    assert.ok(coPermitido('001', undefined));
    assert.ok(coPermitido('001', '1, 005'));
    assert.ok(coPermitido('005', ['5']));
    assert.ok(!coPermitido('002', '001,005'));
});
