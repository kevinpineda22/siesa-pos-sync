// Pure tests: no network, no env files, no Siesa/Supabase.
const test = require('node:test');
const assert = require('node:assert');
const {
    validarRango, agruparDocumentos, claveRegistrada, compararConRegistradas,
    variantesCo, coberturaDesde, fusionarDocumentos, idsCandidatos
} = require('../facturasOmitidas');

const linea = (o = {}) => ({
    CoDoc: '001', ID_TIPO_DOCTO: 'Z01', CONSEC_DOCTO: '0024291', FECHA_DOCTO: '2026-11-10T00:00:00',
    NitTercero: '900123456', RazonSocial: 'ACME SAS', VrNetoDocto: '15000', ...o
});

test('validarRango accepts a valid range', () => {
    assert.strictEqual(validarRango('2026-11-05', '2026-11-10', { minimo: '2026-11-01' }), null);
});

test('validarRango rejects missing, malformed, inverted, too early and too long ranges', () => {
    const opts = { minimo: '2026-11-01', maxDias: 31 };
    assert.ok(validarRango('', '2026-11-10', opts));
    assert.ok(validarRango('2026-13-01', '2026-13-02', opts));
    assert.ok(validarRango('2026-11-10', '2026-11-05', opts));
    assert.ok(validarRango('2026-10-31', '2026-11-05', opts));
    assert.ok(validarRango('2026-11-01', '2026-12-02', opts));
    assert.strictEqual(validarRango('2026-11-01', '2026-12-01', opts), null);
});

test('agruparDocumentos collapses lines into one document and takes the net once', () => {
    const docs = agruparDocumentos(
        [linea(), linea({ VrNetoDocto: '15000' }), linea({ CONSEC_DOCTO: '24292', VrNetoDocto: '800' })],
        { desde: '2026-11-01', hasta: '2026-11-30', flujo: 'normal' }
    );
    assert.strictEqual(docs.size, 2);
    const d = docs.get('001|Z01|24291');
    assert.strictEqual(d.neto, 15000);
    assert.strictEqual(d.fecha, '2026-11-10');
    assert.strictEqual(d.razon_social, 'ACME SAS');
});

test('agruparDocumentos filters by date and by caja Z01/Z02', () => {
    const docs = agruparDocumentos(
        [
            linea({ FECHA_DOCTO: '2026-11-09T00:00:00' }),
            linea({ CONSEC_DOCTO: '2', ID_TIPO_DOCTO: 'P05' }),
            linea({ CONSEC_DOCTO: '3', ID_TIPO_DOCTO: 'z02' })
        ],
        { desde: '2026-11-10', hasta: '2026-11-10', flujo: 'normal' }
    );
    assert.deepStrictEqual([...docs.keys()], ['001|Z02|3']);
});

test('agruparDocumentos marks generic flow', () => {
    const docs = agruparDocumentos(
        [linea({ CoDoc: '11', NitTercero: '222222222222' })],
        { desde: '2026-11-01', hasta: '2026-11-30', flujo: 'genericos' }
    );
    assert.strictEqual(docs.get('011|Z01|24291').flujo, 'genericos');
});

test('claveRegistrada normalizes co, caja and consec', () => {
    assert.strictEqual(claveRegistrada({ tipo: 'CFZ', co: '1', caja: 'z01', consec: '0024291' }), 'CFZ|001|Z01|24291');
    assert.strictEqual(claveRegistrada({ tipo: 'CNZ', co: '001', caja: 'Z01', consec: 24291 }), 'CNZ|001|Z01|24291');
});

test('compararConRegistradas reports missing types, ignores estado and sorts', () => {
    const docs = agruparDocumentos(
        [
            linea({ CONSEC_DOCTO: '30' }),                                  // falta CFZ y CNZ
            linea({ CONSEC_DOCTO: '20' }),                                  // solo falta CNZ
            linea({ CONSEC_DOCTO: '10' }),                                  // completa -> no sale
            linea({ CONSEC_DOCTO: '5', FECHA_DOCTO: '2026-11-02T00:00:00' }) // falta ambas, fecha anterior
        ],
        { desde: '2026-11-01', hasta: '2026-11-30', flujo: 'normal' }
    );
    const reg = new Set([
        claveRegistrada({ tipo: 'CFZ', co: '001', caja: 'Z01', consec: '20' }),
        claveRegistrada({ tipo: 'CFZ', co: '001', caja: 'Z01', consec: '10' }),
        claveRegistrada({ tipo: 'CNZ', co: '001', caja: 'Z01', consec: '10' })
    ]);
    const out = compararConRegistradas(docs.values(), reg);
    assert.deepStrictEqual(out.map(o => [o.llave, o.faltan]), [
        ['001-Z01-5', ['CFZ', 'CNZ']],
        ['001-Z01-20', ['CNZ']],
        ['001-Z01-30', ['CFZ', 'CNZ']]
    ]);
    assert.strictEqual(out[0].flujo, 'normal');
});

test('claveRegistrada treats an empty co as 001 and matches unpadded variants', () => {
    assert.strictEqual(claveRegistrada({ tipo: 'CFZ', co: '', caja: 'Z01', consec: '5' }), 'CFZ|001|Z01|5');
    assert.strictEqual(claveRegistrada({ tipo: 'CFZ', co: ' 1 ', caja: 'Z01', consec: '5' }), 'CFZ|001|Z01|5');
});

test('variantesCo returns padded and unpadded forms', () => {
    assert.deepStrictEqual(variantesCo('001'), ['001', '1']);
    assert.deepStrictEqual(variantesCo(''), ['001', '1']);
    assert.deepStrictEqual(variantesCo('011'), ['011', '11']);
});

test('idsCandidatos builds exact ids per missing tipo and co variant', () => {
    const ids = idsCandidatos([{ co: '011', caja: 'Z01', consec: '7', faltan: ['CNZ'] }]);
    assert.deepStrictEqual(ids.sort(), ['CNZ:011:Z01:7', 'CNZ:11:Z01:7']);
});

test('a row found by exact id (e.g. null fecha_factura) removes the candidate', () => {
    const docs = agruparDocumentos([linea({ CONSEC_DOCTO: '9' })],
        { desde: '2026-11-01', hasta: '2026-11-30', flujo: 'normal' });
    const primera = compararConRegistradas(docs.values(), new Set());
    assert.deepStrictEqual(primera[0].faltan, ['CFZ', 'CNZ']);
    const porId = new Set([claveRegistrada({ tipo: 'CFZ', co: '1', caja: 'Z01', consec: '9' }),
        claveRegistrada({ tipo: 'CNZ', co: '001', caja: 'Z01', consec: '9' })]);
    assert.strictEqual(compararConRegistradas(docs.values(), porId).length, 0);
});

test('fusionarDocumentos gives priority to the first source (generics first)', () => {
    const gen = agruparDocumentos([linea({ CoDoc: '011', NitTercero: '222222222222' })],
        { desde: '2026-11-01', hasta: '2026-11-30', flujo: 'genericos' });
    const normal = agruparDocumentos([linea({ CoDoc: '011', NitTercero: '900' })],
        { desde: '2026-11-01', hasta: '2026-11-30', flujo: 'normal' });
    const docs = fusionarDocumentos([gen, normal]);
    assert.strictEqual(docs.size, 1);
    assert.strictEqual(docs.get('011|Z01|24291').flujo, 'genericos');
});

test('coberturaDesde returns the earliest FECHA_DOCTO or null', () => {
    assert.strictEqual(coberturaDesde([linea({ FECHA_DOCTO: '2026-11-05T00:00:00' }), linea({ FECHA_DOCTO: '2026-11-03T00:00:00' })]), '2026-11-03');
    assert.strictEqual(coberturaDesde([]), null);
});
