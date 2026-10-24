process.env.ENTORNO_SIESA_TRANSF = 'QA';

const test = require('node:test');
const assert = require('node:assert');
const { resumirCorrida, validarFechaObjetivo, registrarCorrida } = require('../transformacionCarnes');

const base = { fecha: '2026-10-22', entorno: 'QA', grupos: 0, fallos: 0, totalUnidades: 0, totalKilos: 0, alertas: { erroresGuardado: [] } };
const meta = { filasVivo: 10, filasAcum: 20, filasDia: 5, diasDisponibles: ['2026-10-21', '2026-10-22'], origen: 'schedule' };

test('PROCESADO cuando hay grupos y no hay fallos', () => {
    const fila = resumirCorrida({ ...base, grupos: 2, totalUnidades: 30, totalKilos: 11.4 }, meta);
    assert.strictEqual(fila.resultado, 'PROCESADO');
    assert.strictEqual(fila.grupos, 2);
    assert.strictEqual(fila.unidades, 30);
    assert.strictEqual(fila.kilos, 11.4);
    assert.strictEqual(fila.filas_vivo, 10);
    assert.strictEqual(fila.filas_acum, 20);
    assert.strictEqual(fila.filas_dia, 5);
    assert.deepStrictEqual(fila.dias_disponibles, meta.diasDisponibles);
    assert.strictEqual(fila.origen, 'schedule');
    assert.strictEqual(fila.fecha, '2026-10-22');
    assert.strictEqual(fila.entorno, 'QA');
});

test('SIN_VENTAS cuando no hay grupos', () => {
    const fila = resumirCorrida(base, meta);
    assert.strictEqual(fila.resultado, 'SIN_VENTAS');
    assert.ok(!/vac[ií]as/.test(fila.mensaje));
});

test('SIN_VENTAS con tablas vivas vacías avisa del posible hueco de cierre', () => {
    const fila = resumirCorrida(base, { ...meta, filasVivo: 0 });
    assert.strictEqual(fila.resultado, 'SIN_VENTAS');
    assert.match(fila.mensaje, /tablas vivas llegaron vac[ií]as/);
    assert.match(fila.mensaje, /cierre del POS/);
});

test('CON_FALLO cuando hay fallos de Siesa', () => {
    const fila = resumirCorrida({ ...base, grupos: 1, fallos: 1 }, meta);
    assert.strictEqual(fila.resultado, 'CON_FALLO');
    assert.strictEqual(fila.fallos, 1);
});

test('CON_FALLO cuando hay errores de guardado aunque fallos sea 0', () => {
    const fila = resumirCorrida({ ...base, grupos: 1, alertas: { erroresGuardado: [{ error: 'x' }] } }, meta);
    assert.strictEqual(fila.resultado, 'CON_FALLO');
});

test('CON_FALLO tiene prioridad sobre SIN_VENTAS', () => {
    const fila = resumirCorrida({ ...base, grupos: 0, fallos: 2 }, meta);
    assert.strictEqual(fila.resultado, 'CON_FALLO');
});

test('meta ausente deja los campos opcionales en null', () => {
    const fila = resumirCorrida({ ...base, grupos: 1, totalUnidades: 5, totalKilos: 1.9 });
    assert.strictEqual(fila.filas_vivo, null);
    assert.strictEqual(fila.dias_disponibles, null);
    assert.strictEqual(fila.origen, null);
    assert.strictEqual(fila.resultado, 'PROCESADO');
});

test('validarFechaObjetivo etiqueta los rechazos con codigo VALIDACION_FECHA', () => {
    const ahora = new Date('2026-10-24T15:00:00Z'); // 10:00 en Bogota
    assert.throws(() => validarFechaObjetivo('2026-10-30', false, ahora), (e) => e.codigo === 'VALIDACION_FECHA' && /Fecha futura/.test(e.message));
    assert.throws(() => validarFechaObjetivo('2026-10-24', false, ahora), (e) => e.codigo === 'VALIDACION_FECHA' && /21:30/.test(e.message));
    assert.doesNotThrow(() => validarFechaObjetivo('2026-10-23', false, ahora));
});

test('registrarCorrida reintenta una vez y devuelve true si el segundo intento funciona', async () => {
    let llamadas = 0;
    const ok = await registrarCorrida({}, { insertar: async () => { if (++llamadas === 1) throw new Error('x'); }, esperar: async () => {} });
    assert.strictEqual(ok, true);
    assert.strictEqual(llamadas, 2);
});

test('registrarCorrida nunca lanza: devuelve false tras 2 errores', async () => {
    let llamadas = 0;
    const ok = await registrarCorrida({}, { insertar: async () => { llamadas++; throw new Error('x'); }, esperar: async () => {} });
    assert.strictEqual(ok, false);
    assert.strictEqual(llamadas, 2);
});

test('registrarCorrida corta por timeout', async () => {
    const ok = await registrarCorrida({}, { insertar: () => new Promise(() => {}), esperar: async () => {}, timeoutMs: 20 });
    assert.strictEqual(ok, false);
});
