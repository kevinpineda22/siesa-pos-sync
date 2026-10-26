const test = require('node:test');
const assert = require('node:assert');
const { calcularDV, compararIdNitCliente } = require('../documento');

test('calcularDV calcula el dígito de verificación DIAN', () => {
    assert.strictEqual(calcularDV('900745137'), 2);
});

test('calcularDV devuelve null con entrada no numérica', () => {
    assert.strictEqual(calcularDV('CR555662'), null);
    assert.strictEqual(calcularDV(''), null);
    assert.strictEqual(calcularDV(null), null);
});

test('compararIdNitCliente: Volcan (id = NIT + DV) coincide', () => {
    assert.strictEqual(compararIdNitCliente('9007451372', '900745137').coincide, true);
    assert.strictEqual(compararIdNitCliente('900745137', '9007451372').coincide, true);
});

test('compararIdNitCliente: Munera (documentos distintos) no coincide', () => {
    assert.strictEqual(compararIdNitCliente('1035428107', '1035867370').coincide, false);
});

test('compararIdNitCliente: valores iguales coinciden', () => {
    assert.strictEqual(compararIdNitCliente('900745137', '900745137').coincide, true);
});

test('compararIdNitCliente: sufijo con guion coincide', () => {
    assert.strictEqual(compararIdNitCliente('900745137-2', '900745137').coincide, true);
    assert.strictEqual(compararIdNitCliente('900745137', '900745137-2').coincide, true);
});

test('compararIdNitCliente: vacíos o nulos no se comparan', () => {
    assert.strictEqual(compararIdNitCliente(null, '900745137').coincide, true);
    assert.strictEqual(compararIdNitCliente('900745137', '').coincide, true);
    assert.strictEqual(compararIdNitCliente(undefined, undefined).coincide, true);
});

test('compararIdNitCliente: ignora espacios', () => {
    assert.strictEqual(compararIdNitCliente(' 900 745 137 2', '900745137').coincide, true);
    assert.strictEqual(compararIdNitCliente('1035 428107', '1035867370').coincide, false);
});

test('compararIdNitCliente: dígito agregado incorrecto no coincide', () => {
    assert.strictEqual(compararIdNitCliente('9007451375', '900745137').coincide, false);
});
