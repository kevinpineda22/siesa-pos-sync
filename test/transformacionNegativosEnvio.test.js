// Pure sender tests: the sender gets guardar/enviar/esperar injected, so nothing here touches
// Siesa, Connekta, Supabase or the env.
const test = require('node:test');
const assert = require('node:assert');
const {
    aplicarDescartesCei, enviarDocumento, enviarTienda, falloSistemico
} = require('../transformacionNegativosEnvio');
const { resumenLineas } = require('../transformacionNegativosPlan');

const FECHA = '2026-10-29';
const BODEGA = '00101';

// ---- builders ----
const ceiLinea = (item, cantidad, extra = {}) => ({
    nro: 1, item, um: 'KL', costo: 500, disponible_snapshot: -cantidad, cantidad_plan: cantidad, cantidad,
    estado: 'ACTIVA', ajustes: [], origenes: [], ...extra
});
const csaLinea = (item, cantidad, atribucion = [], extra = {}) => ({
    nro: 1, item, um: 'KL', costo: 700, disponible_snapshot: cantidad, cantidad_plan: cantidad, cantidad,
    estado: 'ACTIVA', ajustes: [], atribucion, ...extra
});
const doc = (tipo, lineas, extra = {}) => ({
    entorno: 'QA', fecha: FECHA, co: '001', bodega: BODEGA, tipo_dto: tipo, status: 'PLANNED',
    lineas: lineas.map((l, i) => ({ ...l, nro: i + 1 })), novedades: [], intentos: 0, rondas: 0, ...extra
});
const faltante = (item, x, bodega = BODEGA) => ({
    f_detalle: `Item sin cantidad disponible. Faltante Inv.: -${x}`,
    f_valor: `Item:${String(item).padStart(7, '0')}Bodega:${bodega}`
});
const rechazo = (...detalle) => ({ ok: false, ambiguo: false, respuesta: { detalle }, mensaje: 'rechazado por faltante' });
const ok = () => ({ ok: true, ambiguo: false, respuesta: { mensaje: 'OK' }, mensaje: 'OK' });
const clonar = (x) => JSON.parse(JSON.stringify(x));

// Fakes share an event log so the order SAVE -> POST can be asserted.
function entorno({ respuestas = [], guardarFalla = () => false } = {}) {
    const eventos = [];
    const posts = [];
    const guardados = [];
    const esperas = [];
    let n = 0;
    const cola = Array.isArray(respuestas) ? [...respuestas] : null;
    const deps = {
        unidadNegocio: '003',
        esperar: async (ms) => { esperas.push(ms); },
        guardar: async (row) => {
            const intento = guardados.length;
            if (guardarFalla(row, intento)) throw new Error('db down');
            guardados.push(clonar(row));
            eventos.push(`SAVE:${row.tipo_dto}:${row.status}`);
        },
        enviar: async (payload) => {
            posts.push(clonar(payload));
            eventos.push(`POST:${payload.Documentos[0].TIPO_DTO}`);
            n += 1;
            const r = cola ? cola.shift() : respuestas(payload, n);
            if (r instanceof Error) throw r;
            return r;
        }
    };
    return { deps, eventos, posts, guardados, esperas };
}
const cantidades = (payload) => payload.Movimientos.map(m => m.CANTIDAD);
const ultimo = (arr) => arr[arr.length - 1];

// =====================================================================
// aplicarDescartesCei
// =====================================================================
test('FR-4 dropping CEI line A reduces a shared CSA line by A share only; B share is kept', () => {
    const cei = [ceiLinea(8, 3, { estado: 'DESCARTADA' }), ceiLinea(9, 3)];
    const csa = [csaLinea(1, 4, [{ item_destino: 8, cantidad: 3, orden: 1 }, { item_destino: 9, cantidad: 1, orden: 2 }])];
    const r = aplicarDescartesCei(cei, csa);
    assert.strictEqual(r.lineas[0].cantidad, 1);
    assert.strictEqual(r.lineas[0].estado, 'ACTIVA');
    assert.deepStrictEqual(r.lineas[0].atribucion, [{ item_destino: 9, cantidad: 1, orden: 2 }]);
    assert.strictEqual(r.vacia, false);
});

test('FR-4 dropping B keeps A; the line is deleted (DESCARTADA) only when it reaches zero', () => {
    const csa = [csaLinea(1, 4, [{ item_destino: 8, cantidad: 3, orden: 1 }, { item_destino: 9, cantidad: 1, orden: 2 }])];
    const soloB = aplicarDescartesCei([ceiLinea(8, 3), ceiLinea(9, 3, { estado: 'DESCARTADA' })], csa);
    assert.strictEqual(soloB.lineas[0].cantidad, 3);
    assert.strictEqual(soloB.lineas[0].estado, 'ACTIVA');
    const ambas = aplicarDescartesCei([ceiLinea(8, 3, { estado: 'DESCARTADA' }), ceiLinea(9, 3, { estado: 'DESCARTADA' })], csa);
    assert.strictEqual(ambas.lineas[0].cantidad, 0);
    assert.strictEqual(ambas.lineas[0].estado, 'DESCARTADA');
    assert.strictEqual(ambas.vacia, true);
});

test('FR-4 is idempotent, does not mutate its inputs and leaves unrelated lines alone', () => {
    const cei = [ceiLinea(8, 3, { estado: 'DESCARTADA' }), ceiLinea(9, 3)];
    const csa = [
        csaLinea(1, 4, [{ item_destino: 8, cantidad: 3, orden: 1 }, { item_destino: 9, cantidad: 1, orden: 2 }]),
        csaLinea(2, 2, [{ item_destino: 9, cantidad: 2, orden: 2 }])
    ];
    const copia = clonar({ cei, csa });
    const una = aplicarDescartesCei(cei, csa);
    assert.deepStrictEqual({ cei, csa }, copia);
    const dos = aplicarDescartesCei(cei, una.lineas);
    assert.deepStrictEqual(dos.lineas, una.lineas);
    assert.strictEqual(una.lineas[1].cantidad, 2);
    assert.deepStrictEqual(aplicarDescartesCei([ceiLinea(8, 3)], csa).lineas, csa);
});

test('FR-4 amounts are exact in 1e-4 units', () => {
    const cei = [ceiLinea(8, 0.1, { estado: 'DESCARTADA' })];
    const csa = [csaLinea(1, 0.3, [{ item_destino: 8, cantidad: 0.1, orden: 1 }, { item_destino: 9, cantidad: 0.2, orden: 2 }])];
    assert.strictEqual(aplicarDescartesCei(cei, csa).lineas[0].cantidad, 0.2);
});

// =====================================================================
// Adjust phase
// =====================================================================
test('S10 CEI rejected with faltante 0.001 is resent with 22.021', async () => {
    const e = entorno({ respuestas: [rechazo(faltante(9, '0.001')), ok()] });
    const r = await enviarDocumento(doc('CEI', [ceiLinea(9, 22.02)]), e.deps);
    assert.strictEqual(r.status, 'OK');
    assert.strictEqual(r.posts, 2);
    assert.deepStrictEqual(cantidades(e.posts[0]), ['000000000000022.0200']);
    assert.deepStrictEqual(cantidades(e.posts[1]), ['000000000000022.0210']);
    const linea = r.doc.lineas[0];
    assert.strictEqual(linea.cantidad, 22.021);
    assert.strictEqual(linea.cantidad_plan, 22.02);
    assert.strictEqual(linea.estado, 'AJUSTADA');
    assert.deepStrictEqual(linea.ajustes, [{ ronda: 1, faltante: 0.001, anterior: 22.02, nueva: 22.021 }]);
    assert.ok(r.doc.novedades.some(n => n.codigo === 'LINEA_AJUSTADA' && n.severidad === 'INFO'));
});

test('FR-2 faltante is cumulative per round on the CEI line', async () => {
    const e = entorno({ respuestas: [rechazo(faltante(9, 2)), rechazo(faltante(9, 1)), ok()] });
    const r = await enviarDocumento(doc('CEI', [ceiLinea(9, 10)]), e.deps);
    assert.strictEqual(r.status, 'OK');
    assert.deepStrictEqual(e.posts.map(p => cantidades(p)[0]), ['000000000000010.0000', '000000000000012.0000', '000000000000013.0000']);
    assert.strictEqual(r.doc.rondas, 2);
});

test('S9 CSA 123.95 rejected with faltante 5.84 is resent with 118.11', async () => {
    const e = entorno({ respuestas: [rechazo(faltante(1, '5.84')), ok()] });
    const r = await enviarDocumento(doc('CSA', [csaLinea(1, 123.95, [{ item_destino: 9, cantidad: 123.95, orden: 1 }])]), e.deps);
    assert.strictEqual(r.status, 'OK');
    assert.deepStrictEqual(cantidades(e.posts[1]), ['000000000000118.1100']);
    assert.strictEqual(r.doc.lineas[0].cantidad, 118.11);
    assert.deepStrictEqual(r.doc.lineas[0].atribucion, [{ item_destino: 9, cantidad: 118.11, orden: 1 }]);
});

test('FR-2 only the named line is touched on a multi-line document', async () => {
    const e = entorno({ respuestas: [rechazo(faltante(8, 1)), ok()] });
    const r = await enviarDocumento(doc('CEI', [ceiLinea(7, 5), ceiLinea(8, 5), ceiLinea(9, 5)]), e.deps);
    assert.deepStrictEqual(r.doc.lineas.map(l => l.cantidad), [5, 6, 5]);
    assert.deepStrictEqual(e.posts[1].Movimientos.map(m => m.NRO_REGISTRO), ['1', '2', '3']);
});

test('FR-2 CSA cut is floored at zero: the line becomes DESCARTADA and an empty document is CANCELADO without posting again', async () => {
    const e = entorno({ respuestas: [rechazo(faltante(1, 9))] });
    const r = await enviarDocumento(doc('CSA', [csaLinea(1, 4, [{ item_destino: 9, cantidad: 4, orden: 1 }])]), e.deps);
    assert.strictEqual(r.posts, 1);
    assert.strictEqual(r.status, 'CANCELADO');
    assert.strictEqual(r.doc.lineas[0].cantidad, 0);
    assert.strictEqual(r.doc.lineas[0].estado, 'DESCARTADA');
    assert.ok(r.doc.novedades.some(n => n.codigo === 'CSA_DESCARTADA_TOTAL' && n.severidad === 'ALTA'));
    assert.strictEqual(ultimo(e.guardados).status, 'CANCELADO');
});

test('FR-7 CSA cuts hit the highest orden first and emit SIN_STOCK per destination', async () => {
    const atribucion = [{ item_destino: 8, cantidad: 6, orden: 1 }, { item_destino: 9, cantidad: 3, orden: 2 }, { item_destino: 7, cantidad: 1, orden: 3 }];
    const e = entorno({ respuestas: [rechazo(faltante(1, 4)), ok()] });
    const r = await enviarDocumento(doc('CSA', [csaLinea(1, 10, atribucion)]), e.deps);
    const l = r.doc.lineas[0];
    assert.strictEqual(l.cantidad, 6);
    assert.deepStrictEqual(l.atribucion, [{ item_destino: 8, cantidad: 6, orden: 1 }]);
    const sin = r.doc.novedades.filter(n => n.codigo === 'SIN_STOCK');
    assert.deepStrictEqual(sin.map(n => [n.item_destino, n.cantidad, n.item_origen, n.tipo_dto]), [[7, 1, 1, 'CSA'], [9, 3, 1, 'CSA']]);
});

test('FR-7 a partial cut shrinks the last share and keeps the earlier ones', async () => {
    const atribucion = [{ item_destino: 8, cantidad: 6, orden: 1 }, { item_destino: 9, cantidad: 3, orden: 2 }];
    const e = entorno({ respuestas: [rechazo(faltante(1, 1.5)), ok()] });
    const r = await enviarDocumento(doc('CSA', [csaLinea(1, 9, atribucion)]), e.deps);
    assert.deepStrictEqual(r.doc.lineas[0].atribucion, [{ item_destino: 8, cantidad: 6, orden: 1 }, { item_destino: 9, cantidad: 1.5, orden: 2 }]);
    assert.strictEqual(r.doc.lineas[0].cantidad, 7.5);
    assert.strictEqual(r.doc.lineas[0].estado, 'AJUSTADA');
});

test('FR-1 rejections for another bodega or an unknown item are not correctable and never loop', async () => {
    for (const detalle of [[faltante(9, 1, '99999')], [faltante(777, 1)], []]) {
        const e = entorno({ respuestas: [rechazo(...detalle)] });
        const r = await enviarDocumento(doc('CEI', [ceiLinea(9, 5)]), e.deps);
        assert.strictEqual(r.posts, 1);
        assert.strictEqual(r.status, 'ERROR');
        assert.strictEqual(r.causa, 'NO_CORREGIBLE');
    }
});

// =====================================================================
// Drop phase and caps
// =====================================================================
test('FR-3 after 5 adjust rounds the failing line is dropped and the document is resent without it', async () => {
    const siempreA = (payload) => {
        const tieneA = payload.Movimientos.some(m => m.ITEM === '0000008');
        return tieneA ? rechazo(faltante(8, 1)) : ok();
    };
    const e = entorno({ respuestas: siempreA });
    const r = await enviarDocumento(doc('CEI', [ceiLinea(8, 5), ceiLinea(9, 5)]), e.deps);
    assert.strictEqual(r.status, 'OK');
    assert.strictEqual(r.posts, 7);
    assert.strictEqual(e.posts[6].Movimientos.length, 1);
    assert.strictEqual(e.posts[6].Movimientos[0].ITEM, '0000009');
    assert.strictEqual(e.posts[6].Movimientos[0].NRO_REGISTRO, '1');
    assert.strictEqual(r.doc.lineas[0].estado, 'DESCARTADA');
    assert.ok(r.doc.novedades.some(n => n.codigo === 'LINEA_DESCARTADA' && n.severidad === 'MEDIA'));
    assert.strictEqual(r.doc.rondas, 6);
});

test('S12 hard cap: never more than 11 POSTs per document, then ERROR with CEI_RECHAZADO (green cause)', async () => {
    const siempreFalla = (payload) => rechazo(faltante(Number(payload.Movimientos[0].ITEM), 1));
    const e = entorno({ respuestas: siempreFalla });
    const lineas = [1, 2, 3, 4, 5, 6, 7, 8].map(i => ceiLinea(i, 5));
    const r = await enviarDocumento(doc('CEI', lineas), e.deps);
    assert.strictEqual(e.posts.length, 11);
    assert.strictEqual(r.posts, 11);
    assert.strictEqual(r.status, 'ERROR');
    assert.strictEqual(r.causa, 'FALTANTE_AGOTADO');
    assert.ok(r.doc.novedades.some(n => n.codigo === 'CEI_RECHAZADO' && n.severidad === 'ALTA'));
    assert.strictEqual(r.doc.lineas.filter(l => l.estado === 'DESCARTADA').length, 5);
    assert.strictEqual(ultimo(e.guardados).status, 'ERROR');
});

test('FR-3 dropping every line ends CANCELADO with CEI_RECHAZADO', async () => {
    const e = entorno({ respuestas: (payload) => rechazo(faltante(Number(payload.Movimientos[0].ITEM), 1)) });
    const r = await enviarDocumento(doc('CEI', [ceiLinea(9, 5)]), e.deps);
    assert.strictEqual(r.status, 'CANCELADO');
    assert.strictEqual(r.posts, 6);
    assert.ok(r.doc.novedades.some(n => n.codigo === 'CEI_RECHAZADO'));
});

test('S18b a CSA rejected until the caps are exhausted ends ERROR with CSA_RECHAZADO', async () => {
    const e = entorno({ respuestas: (payload) => rechazo(faltante(Number(payload.Movimientos[0].ITEM), 0.0001)) });
    const lineas = [1, 2, 3, 4, 5, 6, 7].map(i => csaLinea(i, 100, [{ item_destino: 9, cantidad: 100, orden: 1 }]));
    const r = await enviarDocumento(doc('CSA', lineas), e.deps);
    assert.strictEqual(r.status, 'ERROR');
    assert.strictEqual(r.posts, 11);
    assert.ok(r.doc.novedades.some(n => n.codigo === 'CSA_RECHAZADO' && n.severidad === 'ALTA'));
});

test('FR-6 a non-correctable rejection ends ERROR immediately with a rejection novedad', async () => {
    const e = entorno({ respuestas: [{ ok: false, ambiguo: false, respuesta: { mensaje: 'Unauthorized' }, mensaje: '401 Unauthorized' }] });
    const r = await enviarDocumento(doc('CSA', [csaLinea(1, 5, [{ item_destino: 9, cantidad: 5, orden: 1 }])]), e.deps);
    assert.strictEqual(r.status, 'ERROR');
    assert.strictEqual(r.posts, 1);
    assert.strictEqual(r.causa, 'NO_CORREGIBLE');
    assert.strictEqual(r.doc.error, '401 Unauthorized');
    assert.ok(r.doc.novedades.some(n => n.codigo === 'CSA_RECHAZADO'));
});

test('a document with no active lines is CANCELADO without any POST', async () => {
    const e = entorno({ respuestas: [] });
    const r = await enviarDocumento(doc('CEI', [ceiLinea(9, 5, { estado: 'DESCARTADA' })]), e.deps);
    assert.strictEqual(r.status, 'CANCELADO');
    assert.strictEqual(r.posts, 0);
    assert.strictEqual(e.posts.length, 0);
});

// =====================================================================
// Persistence order
// =====================================================================
test('PS-7/FR-5 SENDING with the exact adjusted payload is persisted BEFORE every POST', async () => {
    const e = entorno({ respuestas: [rechazo(faltante(9, 2)), rechazo(faltante(9, 1)), ok()] });
    const r = await enviarDocumento(doc('CEI', [ceiLinea(9, 10)]), e.deps);
    assert.strictEqual(r.status, 'OK');
    assert.deepStrictEqual(e.eventos, [
        'SAVE:CEI:SENDING', 'POST:CEI', 'SAVE:CEI:SENDING', 'POST:CEI', 'SAVE:CEI:SENDING', 'POST:CEI', 'SAVE:CEI:OK'
    ]);
    const sending = e.guardados.filter(g => g.status === 'SENDING');
    assert.strictEqual(sending.length, 3);
    sending.forEach((s, i) => assert.deepStrictEqual(s.payload, e.posts[i]));
    assert.deepStrictEqual(sending.map(s => s.intentos), [1, 2, 3]);
    assert.deepStrictEqual(sending.map(s => s.rondas), [0, 1, 2]);
    assert.strictEqual(sending[2].lineas[0].cantidad, 13);
    const final = ultimo(e.guardados);
    assert.strictEqual(final.status, 'OK');
    assert.strictEqual(final.error, null);
    assert.strictEqual(final.cantidad_total, 13);
    assert.strictEqual(final.lineas_activas, 1);
    assert.strictEqual(final.respuesta.rondas.length, 3);
    assert.deepStrictEqual(final.respuesta.rondas.map(x => [x.ronda, x.fase, x.ok]), [[0, 'INICIAL', false], [1, 'AJUSTE', false], [2, 'AJUSTE', true]]);
});

test('PS-7 if SENDING cannot be persisted nothing is posted and the run aborts', async () => {
    const e = entorno({ respuestas: [ok()], guardarFalla: () => true });
    const r = await enviarDocumento(doc('CEI', [ceiLinea(9, 10)]), e.deps);
    assert.strictEqual(r.abortada, true);
    assert.strictEqual(e.posts.length, 0);
    assert.strictEqual(r.posts, 0);
    assert.strictEqual(r.erroresGuardado[0].fase, 'SENDING');
    assert.deepStrictEqual(e.esperas, [1000, 2000]);
});

test('PS-7 a failing SENDING save on a retry round aborts without that POST', async () => {
    const e = entorno({
        respuestas: [rechazo(faltante(9, 1)), ok()],
        guardarFalla: (row) => row.status === 'SENDING' && row.intentos === 2
    });
    const r = await enviarDocumento(doc('CEI', [ceiLinea(9, 10)]), e.deps);
    assert.strictEqual(r.abortada, true);
    assert.strictEqual(e.posts.length, 1);
});

test('S14/FR-6 an ambiguous outcome stops the document: AMBIGUO saved, never resent', async () => {
    const e = entorno({ respuestas: [{ ok: false, ambiguo: true, respuesta: null, mensaje: 'timeout' }, ok()] });
    const r = await enviarDocumento(doc('CEI', [ceiLinea(9, 10)]), e.deps);
    assert.strictEqual(r.status, 'AMBIGUO');
    assert.strictEqual(r.posts, 1);
    assert.strictEqual(e.posts.length, 1);
    const final = ultimo(e.guardados);
    assert.strictEqual(final.status, 'AMBIGUO');
    assert.match(final.error, /^AMBIGUO: timeout/);
    assert.deepStrictEqual(final.payload, e.posts[0]);
});

test('S14 a thrown POST is treated as AMBIGUO', async () => {
    const e = entorno({ respuestas: [new Error('socket hang up')] });
    const r = await enviarDocumento(doc('CEI', [ceiLinea(9, 10)]), e.deps);
    assert.strictEqual(r.status, 'AMBIGUO');
});

test('S14b a result save that fails once is retried with backoff and succeeds', async () => {
    let fallos = 0;
    const e = entorno({
        respuestas: [ok()],
        guardarFalla: (row) => {
            if (row.status === 'OK' && fallos < 1) { fallos += 1; return true; }
            return false;
        }
    });
    const r = await enviarDocumento(doc('CEI', [ceiLinea(9, 10)]), e.deps);
    assert.strictEqual(r.status, 'OK');
    assert.strictEqual(r.abortada, false);
    assert.deepStrictEqual(r.erroresGuardado, []);
    assert.deepStrictEqual(e.esperas, [1000]);
});

test('S14b a result save that always fails is a persistence failure: aborted, and an accepted document stays AMBIGUO in memory', async () => {
    const e = entorno({ respuestas: [ok()], guardarFalla: (row) => row.status === 'OK' });
    const r = await enviarDocumento(doc('CEI', [ceiLinea(9, 10)]), e.deps);
    assert.strictEqual(r.abortada, true);
    assert.strictEqual(r.status, 'AMBIGUO');
    assert.strictEqual(r.erroresGuardado.length, 1);
    assert.strictEqual(r.erroresGuardado[0].fase, 'RESULTADO');
    assert.strictEqual(r.erroresGuardado[0].ok, true);
    assert.deepStrictEqual(e.esperas, [1000, 2000]);
});

test('a definitive rejection whose save fails keeps ERROR in memory and is a persistence failure', async () => {
    const e = entorno({ respuestas: [{ ok: false, ambiguo: false, respuesta: null, mensaje: 'boom' }], guardarFalla: (row) => row.status === 'ERROR' });
    const r = await enviarDocumento(doc('CEI', [ceiLinea(9, 10)]), e.deps);
    assert.strictEqual(r.abortada, true);
    assert.strictEqual(r.status, 'ERROR');
    assert.strictEqual(r.erroresGuardado[0].ok, false);
});

test('respuesta.rondas keeps only the last 12 entries', async () => {
    const e = entorno({ respuestas: (payload) => rechazo(faltante(Number(payload.Movimientos[0].ITEM), 1)) });
    const lineas = [1, 2, 3, 4, 5, 6, 7, 8].map(i => ceiLinea(i, 5));
    const r = await enviarDocumento(doc('CEI', lineas), e.deps);
    assert.ok(r.doc.respuesta.rondas.length <= 12);
    assert.strictEqual(r.doc.respuesta.rondas.length, 11);
});

// =====================================================================
// CEI -> CSA ordering
// =====================================================================
test('PS-9 CSA is sent only after the CEI is OK, with attribution of dropped CEI destinations removed', async () => {
    const respuestas = (payload) => {
        const esCei = payload.Documentos[0].TIPO_DTO === 'CEI';
        if (esCei && payload.Movimientos.some(m => m.ITEM === '0000008')) return rechazo(faltante(8, 1));
        return ok();
    };
    const e = entorno({ respuestas });
    const cei = doc('CEI', [ceiLinea(8, 3), ceiLinea(9, 3)]);
    const csa = doc('CSA', [csaLinea(1, 6, [{ item_destino: 8, cantidad: 3, orden: 1 }, { item_destino: 9, cantidad: 3, orden: 2 }])]);
    const r = await enviarTienda({ cei, csa }, e.deps);
    assert.strictEqual(r.cei.status, 'OK');
    assert.strictEqual(r.csa.status, 'OK');
    assert.strictEqual(r.bloqueo, null);
    const ultimoPostCei = e.eventos.lastIndexOf('POST:CEI');
    const primerPostCsa = e.eventos.indexOf('POST:CSA');
    assert.ok(ultimoPostCei < primerPostCsa);
    const postCsa = e.posts.find(p => p.Documentos[0].TIPO_DTO === 'CSA');
    assert.deepStrictEqual(cantidades(postCsa), ['000000000000003.0000']);
    assert.deepStrictEqual(r.csa.doc.lineas[0].atribucion, [{ item_destino: 9, cantidad: 3, orden: 2 }]);
});

test('PS-9 CEI AMBIGUO blocks the CSA (red)', async () => {
    const e = entorno({ respuestas: [{ ok: false, ambiguo: true, respuesta: null, mensaje: 'timeout' }] });
    const r = await enviarTienda({ cei: doc('CEI', [ceiLinea(9, 3)]), csa: doc('CSA', [csaLinea(1, 3, [{ item_destino: 9, cantidad: 3, orden: 1 }])]) }, e.deps);
    assert.strictEqual(r.cei.status, 'AMBIGUO');
    assert.strictEqual(r.csa, null);
    assert.strictEqual(r.bloqueo, 'CEI_AMBIGUO');
    assert.strictEqual(e.posts.length, 1);
});

test('PS-9 CEI ERROR or CANCELADO blocks the CSA (green) without posting it', async () => {
    const e1 = entorno({ respuestas: [{ ok: false, ambiguo: false, respuesta: null, mensaje: 'boom' }] });
    const csa = doc('CSA', [csaLinea(1, 3, [{ item_destino: 9, cantidad: 3, orden: 1 }])]);
    const r1 = await enviarTienda({ cei: doc('CEI', [ceiLinea(9, 3)]), csa }, e1.deps);
    assert.strictEqual(r1.bloqueo, 'CEI_ERROR');
    assert.strictEqual(r1.csa, null);
    assert.strictEqual(e1.posts.length, 1);
    const e2 = entorno({ respuestas: [] });
    const r2 = await enviarTienda({ cei: doc('CEI', [ceiLinea(9, 3, { estado: 'DESCARTADA' })]), csa }, e2.deps);
    assert.strictEqual(r2.cei.status, 'CANCELADO');
    assert.strictEqual(r2.bloqueo, 'CEI_CANCELADO');
    assert.strictEqual(e2.posts.length, 0);
});

test('PS-9 a CSA whose attribution vanished is CANCELADO with CSA_DESCARTADA_TOTAL and never posted', async () => {
    const e = entorno({ respuestas: (payload) => (payload.Documentos[0].TIPO_DTO === 'CEI' && payload.Movimientos.some(m => m.ITEM === '0000008') ? rechazo(faltante(8, 1)) : ok()) });
    const csa = doc('CSA', [csaLinea(1, 3, [{ item_destino: 8, cantidad: 3, orden: 1 }])]);
    const r = await enviarTienda({ cei: doc('CEI', [ceiLinea(8, 3), ceiLinea(9, 3)]), csa }, e.deps);
    // CEI line 8 is dropped after 5 adjust rounds; the CEI then goes OK without it.
    assert.strictEqual(r.cei.status, 'OK');
    assert.strictEqual(r.csa.status, 'CANCELADO');
    assert.ok(r.csa.doc.novedades.some(n => n.codigo === 'CSA_DESCARTADA_TOTAL'));
    assert.ok(!e.posts.some(p => p.Documentos[0].TIPO_DTO === 'CSA'));
    assert.strictEqual(ultimo(e.guardados).status, 'CANCELADO');
    assert.strictEqual(ultimo(e.guardados).tipo_dto, 'CSA');
});

test('resume: an already OK CEI is not resent and the pending CSA goes through the same loop', async () => {
    const e = entorno({ respuestas: [rechazo(faltante(1, 1)), ok()] });
    const cei = doc('CEI', [ceiLinea(9, 3)], { status: 'OK' });
    const csa = doc('CSA', [csaLinea(1, 3, [{ item_destino: 9, cantidad: 3, orden: 1 }])], { status: 'ERROR' });
    const r = await enviarTienda({ cei, csa }, e.deps);
    assert.strictEqual(r.cei.status, 'OK');
    assert.strictEqual(r.cei.posts, 0);
    assert.strictEqual(r.csa.status, 'OK');
    assert.strictEqual(e.posts.length, 2);
    assert.ok(e.posts.every(p => p.Documentos[0].TIPO_DTO === 'CSA'));
});

test('resume: CSA already OK/AMBIGUO/CANCELADO is never resent', async () => {
    for (const status of ['OK', 'AMBIGUO', 'CANCELADO']) {
        const e = entorno({ respuestas: [ok()] });
        const r = await enviarTienda({
            cei: doc('CEI', [ceiLinea(9, 3)], { status: 'OK' }),
            csa: doc('CSA', [csaLinea(1, 3, [{ item_destino: 9, cantidad: 3, orden: 1 }])], { status })
        }, e.deps);
        assert.strictEqual(e.posts.length, 0, status);
        assert.strictEqual(r.csa.status, status);
    }
});

test('a store without CSA only sends the CEI', async () => {
    const e = entorno({ respuestas: [ok()] });
    const r = await enviarTienda({ cei: doc('CEI', [ceiLinea(9, 3)]), csa: null }, e.deps);
    assert.strictEqual(r.cei.status, 'OK');
    assert.strictEqual(r.csa, null);
    assert.strictEqual(r.bloqueo, null);
});

test('an aborted CEI stops the store: the CSA is not touched', async () => {
    const e = entorno({ respuestas: [ok()], guardarFalla: () => true });
    const r = await enviarTienda({ cei: doc('CEI', [ceiLinea(9, 3)]), csa: doc('CSA', [csaLinea(1, 3, [{ item_destino: 9, cantidad: 3, orden: 1 }])]) }, e.deps);
    assert.strictEqual(r.abortada, true);
    assert.strictEqual(r.csa, null);
});

test('a CSA that aborts on persistence propagates the abort', async () => {
    const e = entorno({ respuestas: [ok(), ok()], guardarFalla: (row) => row.tipo_dto === 'CSA' && row.status === 'SENDING' });
    const r = await enviarTienda({ cei: doc('CEI', [ceiLinea(9, 3)]), csa: doc('CSA', [csaLinea(1, 3, [{ item_destino: 9, cantidad: 3, orden: 1 }])]) }, e.deps);
    assert.strictEqual(r.cei.status, 'OK');
    assert.strictEqual(r.abortada, true);
    assert.strictEqual(e.posts.length, 1);
});

// =====================================================================
// falloSistemico
// =====================================================================
const res = (status, causa, posts = 1) => ({ status, causa, posts });

test('S20c every sent document ended ERROR for non-Faltante reasons -> systemic failure', () => {
    assert.strictEqual(falloSistemico([1, 2, 3, 4].map(() => res('ERROR', 'NO_CORREGIBLE'))), true);
});

test('S20d a mix with at least one OK is not systemic', () => {
    assert.strictEqual(falloSistemico([res('ERROR', 'NO_CORREGIBLE'), res('ERROR', 'NO_CORREGIBLE'), res('ERROR', 'NO_CORREGIBLE'), res('OK', null)]), false);
});

test('Faltante exhaustion is never systemic, even next to non-Faltante errors', () => {
    assert.strictEqual(falloSistemico([res('ERROR', 'FALTANTE_AGOTADO', 11)]), false);
    assert.strictEqual(falloSistemico([res('ERROR', 'NO_CORREGIBLE'), res('ERROR', 'FALTANTE_AGOTADO', 11)]), false);
});

test('S20e zero documents sent -> the rule does not apply', () => {
    assert.strictEqual(falloSistemico([]), false);
    assert.strictEqual(falloSistemico([res('CANCELADO', null, 0), res('OK', null, 0)]), false);
});

test('documents that were not posted do not count; AMBIGUO or CANCELADO-after-posts are not "all ERROR"', () => {
    assert.strictEqual(falloSistemico([res('CANCELADO', null, 0), res('ERROR', 'NO_CORREGIBLE')]), true);
    assert.strictEqual(falloSistemico([res('AMBIGUO', null), res('ERROR', 'NO_CORREGIBLE')]), false);
    assert.strictEqual(falloSistemico([res('CANCELADO', null, 3), res('ERROR', 'NO_CORREGIBLE')]), false);
});

test('resumenLineas stays consistent with the saved totals', () => {
    assert.deepStrictEqual(resumenLineas([ceiLinea(9, 1.5), ceiLinea(8, 2, { estado: 'DESCARTADA' })]), { cantidad_total: 1.5, lineas_activas: 1 });
});
