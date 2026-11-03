// Pure tests for the Siesa "Faltante Inv." parser: no network, no env.
const test = require('node:test');
const assert = require('node:assert');
const { parsearFaltantes, ubicarLinea, faltantesAplicables } = require('../siesaFaltantes');

const det = (faltante, valor) => ({
    f_detalle: `Item sin cantidad disponible. Faltante Inv.: ${faltante}`,
    f_valor: valor
});

test('S9 parses a negative faltante as a positive magnitude with item and bodega', () => {
    const r = parsearFaltantes([det('-5.84', 'Item:0189243Bodega:00201')]);
    assert.deepStrictEqual(r, [{ itemTexto: '0189243', bodega: '00201', faltante: 5.84 }]);
});

test('S10 parses a tiny faltante', () => {
    const r = parsearFaltantes([det('-0.001', 'Item:0000009Bodega:00101')]);
    assert.strictEqual(r[0].faltante, 0.001);
});

test('S11 keeps the concatenated item+extension text as is', () => {
    const r = parsearFaltantes([det('-1', 'Item:0001705A-0001705Bodega:PV001')]);
    assert.strictEqual(r[0].itemTexto, '0001705A-0001705');
    assert.strictEqual(r[0].bodega, 'PV001');
});

test('entries without a parsable faltante, item or a positive magnitude are ignored', () => {
    const r = parsearFaltantes([
        { f_detalle: 'Cualquier otro error', f_valor: 'Item:0000009Bodega:00101' },
        { f_detalle: 'Faltante Inv.: -2', f_valor: 'sin item' },
        det('0', 'Item:0000009Bodega:00101'),
        det('-3', 'Item:0000008Bodega:00101')
    ]);
    assert.deepStrictEqual(r.map(x => x.itemTexto), ['0000008']);
});

test('non-array or empty detalle gives no faltantes', () => {
    assert.deepStrictEqual(parsearFaltantes(undefined), []);
    assert.deepStrictEqual(parsearFaltantes(null), []);
    assert.deepStrictEqual(parsearFaltantes('x'), []);
    assert.deepStrictEqual(parsearFaltantes([]), []);
});

const lineas = [
    { nro: 1, item: 9, estado: 'ACTIVA' },
    { nro: 2, item: '1705A', estado: 'ACTIVA' },
    { nro: 3, item: 15207, estado: 'ACTIVA' },
    { nro: 4, item: 8, estado: 'DESCARTADA' }
];

test('ubicarLinea ignores leading zeros and matches numeric or alphanumeric items', () => {
    assert.strictEqual(ubicarLinea(lineas, '0000009').nro, 1);
    assert.strictEqual(ubicarLinea(lineas, '9').nro, 1);
    assert.strictEqual(ubicarLinea(lineas, '0015207').nro, 3);
});

test('S11 ubicarLinea matches a concatenated item+extension by prefix', () => {
    assert.strictEqual(ubicarLinea(lineas, '0001705A-0001705').nro, 2);
});

test('ubicarLinea prefers the longest matching item for prefix matches and never matches DESCARTADA lines', () => {
    const l = [{ nro: 1, item: 170, estado: 'ACTIVA' }, { nro: 2, item: '1705A', estado: 'ACTIVA' }];
    assert.strictEqual(ubicarLinea(l, '0001705A-0001705').nro, 2);
    assert.strictEqual(ubicarLinea(lineas, '0000008'), undefined);
    assert.strictEqual(ubicarLinea(lineas, '0000777'), undefined);
});

test('faltantesAplicables keeps only entries for this bodega that match an active line', () => {
    const detalle = [
        det('-2', 'Item:0000009Bodega:00101'),
        det('-3', 'Item:0000009Bodega:99999'),
        det('-4', 'Item:0000777Bodega:00101'),
        det('-1.5', 'Item:0001705A-0001705Bodega:00101')
    ];
    const r = faltantesAplicables(detalle, lineas, '00101');
    assert.deepStrictEqual(r.map(x => [x.linea.nro, x.faltante]), [[1, 2], [2, 1.5]]);
});

test('faltantesAplicables tolerates leading zeros in the bodega and returns [] when nothing is usable', () => {
    assert.strictEqual(faltantesAplicables([det('-2', 'Item:0000009Bodega:101')], lineas, '00101').length, 1);
    assert.deepStrictEqual(faltantesAplicables([det('-2', 'Item:0000777Bodega:00101')], lineas, '00101'), []);
    assert.deepStrictEqual(faltantesAplicables([{ f_detalle: 'otro', f_valor: '' }], lineas, '00101'), []);
});
