// Pure tests for the novedades catalog: no network, no env.
const test = require('node:test');
const assert = require('node:assert');
const { CODIGOS, SEVERIDADES, crearNovedad, ordenarNovedades } = require('../negativosNovedades');

const ctx = { co: '001', bodega: '00101', tipo_dto: 'CSA' };

test('catalog codes carry the agreed severities', () => {
    assert.deepStrictEqual(SEVERIDADES, {
        SIN_STOCK: 'MEDIA',
        UM_DISTINTA: 'INFO',
        LINEA_AJUSTADA: 'INFO',
        LINEA_DESCARTADA: 'MEDIA',
        CEI_RECHAZADO: 'ALTA',
        CSA_RECHAZADO: 'ALTA',
        CSA_DESCARTADA_TOTAL: 'ALTA'
    });
    assert.deepStrictEqual(Object.keys(CODIGOS).sort(), Object.keys(SEVERIDADES).sort());
});

test('SIN_STOCK uses the exact Spanish copy and names origin and destination', () => {
    const n = crearNovedad('SIN_STOCK', { ...ctx, item_origen: 1705, item_destino: 9, cantidad: 3 });
    assert.strictEqual(n.codigo, 'SIN_STOCK');
    assert.strictEqual(n.severidad, 'MEDIA');
    assert.strictEqual(n.mensaje, 'No había suficiente 1705 para cubrir la transformación completa de 9');
    assert.strictEqual(n.co, '001');
    assert.strictEqual(n.bodega, '00101');
    assert.strictEqual(n.tipo_dto, 'CSA');
    assert.strictEqual(n.cantidad, 3);
});

test('optional fields are omitted when not provided', () => {
    const n = crearNovedad('CSA_DESCARTADA_TOTAL', ctx);
    assert.strictEqual(n.severidad, 'ALTA');
    assert.ok(!('item_destino' in n));
    assert.ok(!('item_origen' in n));
    assert.ok(!('ronda' in n));
    assert.ok(n.mensaje.length > 0);
});

test('unknown code throws', () => {
    assert.throws(() => crearNovedad('NOPE', ctx), /NOPE/);
});

test('every catalog code builds a Spanish message', () => {
    for (const codigo of Object.keys(CODIGOS)) {
        const n = crearNovedad(codigo, { ...ctx, item_origen: 1, item_destino: 2, ronda: 1, anterior: 1, nueva: 2 });
        assert.ok(typeof n.mensaje === 'string' && n.mensaje.length > 10, codigo);
    }
});

test('ordenarNovedades sorts ALTA > MEDIA > INFO, stable inside a severity, without mutating', () => {
    const lista = [
        crearNovedad('UM_DISTINTA', { ...ctx, item_origen: 1, item_destino: 9 }),
        crearNovedad('SIN_STOCK', { ...ctx, item_origen: 1, item_destino: 9 }),
        crearNovedad('CEI_RECHAZADO', ctx),
        crearNovedad('SIN_STOCK', { ...ctx, item_origen: 2, item_destino: 9 }),
        crearNovedad('LINEA_AJUSTADA', ctx)
    ];
    const copia = [...lista];
    const orden = ordenarNovedades(lista);
    assert.deepStrictEqual(orden.map(n => n.codigo), ['CEI_RECHAZADO', 'SIN_STOCK', 'SIN_STOCK', 'UM_DISTINTA', 'LINEA_AJUSTADA']);
    assert.deepStrictEqual(orden.filter(n => n.codigo === 'SIN_STOCK').map(n => n.item_origen), [1, 2]);
    assert.deepStrictEqual(lista, copia);
});
