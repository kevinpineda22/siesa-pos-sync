// Pure planner tests: no network, no env, no Siesa/Supabase.
const test = require('node:test');
const assert = require('node:assert');
const { aCentavos, planificarTransformaciones } = require('../transformacionNegativosPlan');

const FECHA = '2026-10-29';

const inv = (item, disponible, extra = {}) => ({ co: '001', bodega: '00101', item, disponible, costo: 1000, um: 'KL', ...extra });

function reglas(pares, prioridad, extra = {}) {
    return {
        equivalencias: pares.map(([o, d, activo = true]) => ({ item_origen: o, item_destino: d, activo })),
        prioridad: prioridad.map((o, i) => ({ item_origen: o, orden: i + 1, activo: true })),
        excluidos: [15207],
        ...extra
    };
}

function planificar(inventario, r, extra = {}) {
    return planificarTransformaciones({ inventario, reglas: r, previos: [], fecha: FECHA, entorno: 'QA', ...extra });
}

const csas = (plan, destino) => plan.documentos.filter(d => d.tipo_dto === 'CSA' && d.item_destino === destino);
const cei = (plan, destino) => plan.documentos.find(d => d.tipo_dto === 'CEI' && d.item_destino === destino);

// ---- R1 rounding ----
test('R1 aCentavos rounds half-up decimal-safe', () => {
    assert.strictEqual(aCentavos(-0.515), 52);
    assert.strictEqual(aCentavos(-1.005), 101);
    assert.strictEqual(aCentavos(-2.675), 268);
    assert.strictEqual(aCentavos(-0.004), 0);
    assert.strictEqual(aCentavos(0.005), 1);
    assert.strictEqual(aCentavos(1e-7), 0);
    assert.strictEqual(aCentavos('3.1'), 310);
});

test('R1 destination qty is abs(stock) rounded to 2 decimals; -0.004 is skipped', () => {
    const r = reglas([[100, 200]], [100]);
    const plan = planificar([inv(200, -0.515), inv(100, 10)], r);
    assert.strictEqual(cei(plan, 200).cantidad, 0.52);
    const skip = planificar([inv(200, -0.004), inv(100, 10)], r);
    assert.strictEqual(skip.documentos.length, 0);
});

test('R1 item 15207 is ignored as destination', () => {
    const r = reglas([[100, 15207]], [100]);
    const plan = planificar([inv(15207, -5), inv(100, 10)], r);
    assert.strictEqual(plan.documentos.length, 0);
});

// ---- R2 / R3 priority, activo, split ----
test('R2 origins with no stock are ineligible; only B is used', () => {
    const r = reglas([[1, 9], [2, 9]], [1, 2]);
    const plan = planificar([inv(9, -4), inv(1, 0), inv(2, 10)], r);
    assert.deepStrictEqual(csas(plan, 9).map(d => d.item_origen), [2]);
    assert.strictEqual(csas(plan, 9)[0].cantidad, 4);
});

test('R2 inactive equivalence is never used', () => {
    const r = reglas([[1, 9, false], [2, 9]], [1, 2]);
    const plan = planificar([inv(9, -4), inv(1, 50), inv(2, 50)], r);
    assert.deepStrictEqual(csas(plan, 9).map(d => d.item_origen), [2]);
});

test('R2 global priority order decides, not equivalence order', () => {
    const r = reglas([[1, 9], [2, 9]], [2, 1]);
    const plan = planificar([inv(9, -4), inv(1, 50), inv(2, 50)], r);
    assert.deepStrictEqual(csas(plan, 9).map(d => d.item_origen), [2]);
});

test('R3 partial split A=3, B=2, CEI=5', () => {
    const r = reglas([[1, 9], [2, 9]], [1, 2]);
    const plan = planificar([inv(9, -5), inv(1, 3), inv(2, 10)], r);
    assert.strictEqual(cei(plan, 9).cantidad, 5);
    assert.deepStrictEqual(csas(plan, 9).map(d => [d.item_origen, d.cantidad]), [[1, 3], [2, 2]]);
});

test('R3 no origin stock: CEI alone for full qty', () => {
    const r = reglas([[1, 9]], [1]);
    const plan = planificar([inv(9, -5), inv(1, 0)], r);
    assert.strictEqual(plan.documentos.length, 1);
    assert.strictEqual(cei(plan, 9).cantidad, 5);
});

test('R3 origins cover part: CEI full, CSAs the covered part, remainder reported', () => {
    const r = reglas([[1, 9]], [1]);
    const plan = planificar([inv(9, -5), inv(1, 2)], r);
    assert.strictEqual(cei(plan, 9).cantidad, 5);
    assert.strictEqual(csas(plan, 9)[0].cantidad, 2);
    assert.ok(plan.omitidos.some(o => o.motivo === 'SIN_STOCK' && o.item_destino === 9 && o.cantidad === 3));
});

// ---- R4 ledger ----
test('R4 shared origin: later destination sees only remaining stock', () => {
    const r = reglas([[1, 8], [1, 9]], [1]);
    const plan = planificar([inv(8, -3), inv(9, -3), inv(1, 4)], r);
    assert.strictEqual(csas(plan, 8)[0].cantidad, 3);
    assert.strictEqual(csas(plan, 9)[0].cantidad, 1);
});

test('R4 deterministic order is co, bodega, item numeric regardless of input order', () => {
    const r = reglas([[1, 8], [1, 9]], [1]);
    const a = planificar([inv(9, -3), inv(8, -3), inv(1, 4)], r);
    const b = planificar([inv(1, 4), inv(8, -3), inv(9, -3)], r);
    assert.deepStrictEqual(a, b);
    assert.strictEqual(csas(a, 8)[0].cantidad, 3);
});

test('R4 negative destination (15202) is never an origin for 15251 in the same run', () => {
    const r = reglas([[15202, 15251], [15177, 15202], [15150, 15251]], [15202, 15177, 15150]);
    const plan = planificar([inv(15202, -2), inv(15251, -4), inv(15177, 10), inv(15150, 10)], r);
    assert.deepStrictEqual(csas(plan, 15251).map(d => d.item_origen), [15150]);
    assert.deepStrictEqual(csas(plan, 15202).map(d => d.item_origen), [15177]);
});

test('R4 positive 15202 is an eligible origin and its ledger is consumed', () => {
    const r = reglas([[15202, 15251], [15202, 15250]], [15202]);
    const plan = planificar([inv(15202, 5), inv(15250, -3), inv(15251, -3)], r);
    assert.strictEqual(csas(plan, 15250)[0].cantidad, 3);
    assert.strictEqual(csas(plan, 15251)[0].cantidad, 2);
});

test('R4 identical input twice gives identical plan', () => {
    const r = reglas([[1, 9], [2, 9]], [1, 2]);
    const data = [inv(9, -5), inv(1, 3), inv(2, 10)];
    assert.deepStrictEqual(planificar(data, r), planificar(data, r));
});

test('R4 ledger is per bodega', () => {
    const r = reglas([[1, 9]], [1]);
    const plan = planificar([
        inv(9, -3, { bodega: 'B1' }), inv(1, 3, { bodega: 'B1' }),
        inv(9, -3, { bodega: 'B2' }), inv(1, 3, { bodega: 'B2' })
    ], r);
    assert.strictEqual(plan.documentos.filter(d => d.tipo_dto === 'CSA').length, 2);
});

test('R4 origin availability is truncated to cents (0.019 -> 0.01)', () => {
    const r = reglas([[1, 9]], [1]);
    const plan = planificar([inv(9, -1), inv(1, 0.019)], r);
    assert.strictEqual(csas(plan, 9)[0].cantidad, 0.01);
});

// ---- R5 UM ----
test('R5 UM mismatch origin is skipped and reported; next origin used', () => {
    const r = reglas([[1, 9], [2, 9]], [1, 2]);
    const plan = planificar([inv(9, -4), inv(1, 10, { um: 'UND' }), inv(2, 10)], r);
    assert.deepStrictEqual(csas(plan, 9).map(d => d.item_origen), [2]);
    assert.ok(plan.omitidos.some(o => o.motivo === 'UM' && o.item_origen === 1 && o.item_destino === 9));
});

// ---- R6 cost ----
test('R6 destination with zero or missing cost is skipped with an error reason', () => {
    const r = reglas([[1, 9]], [1]);
    const plan = planificar([inv(9, -4, { costo: 0 }), inv(1, 10)], r);
    assert.strictEqual(plan.documentos.length, 0);
    assert.strictEqual(plan.errores.length, 1);
    assert.strictEqual(plan.errores[0].item_destino, 9);
    assert.match(plan.errores[0].error, /cost/i);
    const plan2 = planificar([inv(9, -4, { costo: null }), inv(1, 10)], r);
    assert.strictEqual(plan2.errores.length, 1);
});

test('R6 chosen origin with zero cost skips the destination and leaves the ledger untouched', () => {
    const r = reglas([[1, 8], [1, 9]], [1]);
    const plan = planificar([inv(8, -3), inv(9, -3), inv(1, 4, { costo: 0 })], r);
    assert.strictEqual(plan.documentos.length, 0);
    assert.strictEqual(plan.errores.length, 2);
});

test('R6 CEI uses destination cost and CSA uses origin cost', () => {
    const r = reglas([[1, 9]], [1]);
    const plan = planificar([inv(9, -2, { costo: 500 }), inv(1, 10, { costo: 700 })], r);
    assert.strictEqual(cei(plan, 9).costo_unitario, 500);
    assert.strictEqual(csas(plan, 9)[0].costo_unitario, 700);
    assert.strictEqual(cei(plan, 9).payload.Movimientos[0].COSTO_PROMEDIO_UNITARIO, '000000000000500.0000');
    assert.strictEqual(csas(plan, 9)[0].payload.Movimientos[0].COSTO_PROMEDIO_UNITARIO, '000000000000700.0000');
});

test('CSA cost policy is isolated: "cero" sends 0 and ignores origin cost', () => {
    const r = reglas([[1, 9]], [1]);
    const plan = planificar([inv(9, -2, { costo: 500 }), inv(1, 10, { costo: 0 })], r, { politicaCostoCsa: 'cero' });
    assert.strictEqual(plan.errores.length, 0);
    assert.strictEqual(csas(plan, 9)[0].costo_unitario, 0);
    assert.strictEqual(csas(plan, 9)[0].payload.Movimientos[0].COSTO_PROMEDIO_UNITARIO, '000000000000000.0000');
});

// ---- payload shape ----
test('payload fields follow the CEI/CSA connector shape', () => {
    const r = reglas([[1, 9]], [1]);
    const plan = planificar([inv(9, -2), inv(1, 10)], r);
    const e = cei(plan, 9).payload;
    assert.strictEqual(e.Documentos[0].TIPO_DTO, 'CEI');
    assert.strictEqual(e.Documentos[0].CLASE_DTO, '61');
    assert.strictEqual(e.Documentos[0].CONCEPTO, '601');
    assert.strictEqual(e.Documentos[0]['FECHA_DOCUMENTO=8 (AAAAMMDD)'], '20261029');
    assert.strictEqual(e.Movimientos[0].MOTIVO, '06');
    assert.strictEqual(e.Movimientos[0].ITEM, '0000009');
    assert.strictEqual(e.Movimientos[0].CANTIDAD, '000000000000002.0000');
    assert.strictEqual(e.Movimientos[0].UNIDAD_NEGOCIO, '003');
    const s = csas(plan, 9)[0].payload;
    assert.strictEqual(s.Documentos[0].TIPO_DTO, 'CSA');
    assert.strictEqual(s.Documentos[0].CLASE_DTO, '62');
    assert.strictEqual(s.Documentos[0].CONCEPTO, '602');
    assert.strictEqual(s.Movimientos[0].MOTIVO, '10');
    assert.strictEqual(s.Movimientos[0].ITEM, '0000001');
});

// ---- previos ----
test('destination already planned for the fecha is not replanned', () => {
    const r = reglas([[1, 9]], [1]);
    const previos = [{ fecha: FECHA, co: '001', bodega: '00101', item_destino: 9, tipo_dto: 'CEI', status: 'OK' }];
    const plan = planificar([inv(9, -2), inv(1, 10)], r, { previos });
    assert.strictEqual(plan.documentos.length, 0);
});

test('destination with a SENDING/AMBIGUO CEI in lookback is blocked and reported', () => {
    const r = reglas([[1, 9]], [1]);
    const previos = [{ fecha: '2026-10-28', co: '001', bodega: '00101', item_destino: 9, tipo_dto: 'CEI', status: 'AMBIGUO' }];
    const plan = planificar([inv(9, -2), inv(1, 10)], r, { previos });
    assert.strictEqual(plan.documentos.length, 0);
    assert.ok(plan.omitidos.some(o => o.motivo === 'BLOQUEADO' && o.item_destino === 9));
});

test('destination with an OK CEI from a prior day is planned again for today', () => {
    const r = reglas([[1, 9]], [1]);
    const previos = [{ fecha: '2026-10-28', co: '001', bodega: '00101', item_destino: 9, tipo_dto: 'CEI', status: 'OK' }];
    const plan = planificar([inv(9, -2), inv(1, 10)], r, { previos });
    assert.strictEqual(plan.documentos.length, 2);
});

test('destination without an active equivalence produces nothing', () => {
    const r = reglas([[1, 9, false]], [1]);
    const plan = planificar([inv(9, -2), inv(1, 10)], r);
    assert.strictEqual(plan.documentos.length, 0);
});

// ---- Duplicate inventory rows ----
test('identical duplicate negative rows for the same key produce a single CEI', () => {
    const r = reglas([[1, 9]], [1]);
    const plan = planificar([inv(9, -4), inv(9, -4), inv(1, 10)], r);
    assert.strictEqual(plan.documentos.filter(d => d.tipo_dto === 'CEI').length, 1);
    assert.strictEqual(cei(plan, 9).cantidad, 4);
    assert.strictEqual(csas(plan, 9).length, 1);
    assert.strictEqual(plan.omitidos.filter(o => o.motivo === 'INVENTARIO_DUPLICADO').length, 0);
});

test('identical duplicate origin rows do not double the origin stock', () => {
    const r = reglas([[1, 9]], [1]);
    const plan = planificar([inv(9, -8), inv(1, 5), inv(1, 5)], r);
    assert.strictEqual(csas(plan, 9)[0].cantidad, 5);
    assert.ok(plan.omitidos.some(o => o.motivo === 'SIN_STOCK' && o.cantidad === 3));
});

test('conflicting duplicate destination rows are skipped, reported, and leave the ledger untouched', () => {
    const r = reglas([[1, 8], [1, 9]], [1]);
    const plan = planificar([inv(8, -3), inv(9, -3), inv(9, -5), inv(1, 10)], r);
    assert.strictEqual(cei(plan, 9), undefined);
    assert.strictEqual(csas(plan, 9).length, 0);
    assert.ok(plan.omitidos.some(o => o.motivo === 'INVENTARIO_DUPLICADO' && o.item_destino === 9));
    // Destination 8 is unaffected and sees the full origin stock.
    assert.strictEqual(csas(plan, 8)[0].cantidad, 3);
});

test('conflicting duplicate origin rows make that origin unusable and are reported', () => {
    const r = reglas([[1, 9], [2, 9]], [1, 2]);
    const plan = planificar([inv(9, -4), inv(1, 10), inv(1, 10, { costo: 2000 }), inv(2, 10)], r);
    assert.deepStrictEqual(csas(plan, 9).map(d => d.item_origen), [2]);
    assert.ok(plan.omitidos.some(o => o.motivo === 'INVENTARIO_DUPLICADO' && o.item_origen === 1));
});

// ---- Missing UM ----
test('destination with empty or missing UM is not transformed and is reported', () => {
    const r = reglas([[1, 9]], [1]);
    for (const um of ['', null, undefined, '  ']) {
        const plan = planificar([inv(9, -4, { um }), inv(1, 10, { um: '' })], r);
        assert.strictEqual(plan.documentos.length, 0);
        assert.strictEqual(plan.errores.length, 1);
        assert.match(plan.errores[0].error, /UM/);
    }
});

test('origin with empty UM is never matched, even against a valid destination UM', () => {
    const r = reglas([[1, 9], [2, 9]], [1, 2]);
    const plan = planificar([inv(9, -4), inv(1, 10, { um: '' }), inv(2, 10)], r);
    assert.deepStrictEqual(csas(plan, 9).map(d => d.item_origen), [2]);
    assert.ok(plan.omitidos.some(o => o.motivo === 'UM' && o.item_origen === 1));
});

// ---- Missing origin inventory row = unknown stock ----
test('missing first origin row skips the whole destination and reports ORIGEN_SIN_DATO', () => {
    const r = reglas([[1, 9], [2, 9]], [1, 2]);
    const plan = planificar([inv(9, -4), inv(2, 10)], r);
    assert.strictEqual(plan.documentos.length, 0);
    const o = plan.omitidos.find(x => x.motivo === 'ORIGEN_SIN_DATO');
    assert.ok(o);
    assert.strictEqual(o.bodega, '00101');
    assert.strictEqual(o.item_destino, 9);
    assert.strictEqual(o.item_origen, 1);
});

test('missing origin row after partial coverage skips the destination and leaves the ledger untouched', () => {
    const r = reglas([[1, 8], [2, 8], [1, 9], [3, 9]], [1, 2, 3]);
    // Destination 8 takes origin 1 (2 of 5) then hits missing origin 2; destination 9 must still see origin 1 in full.
    const plan = planificar([inv(8, -5), inv(9, -2), inv(1, 2), inv(3, 10)], r);
    assert.strictEqual(cei(plan, 8), undefined);
    assert.strictEqual(csas(plan, 8).length, 0);
    assert.ok(plan.omitidos.some(o => o.motivo === 'ORIGEN_SIN_DATO' && o.item_destino === 8 && o.item_origen === 2));
    assert.strictEqual(csas(plan, 9)[0].cantidad, 2);
    assert.strictEqual(csas(plan, 9)[0].item_origen, 1);
});

test('missing origin row after full coverage is irrelevant', () => {
    const r = reglas([[1, 9], [2, 9]], [1, 2]);
    const plan = planificar([inv(9, -4), inv(1, 10)], r);
    assert.strictEqual(cei(plan, 9).cantidad, 4);
    assert.deepStrictEqual(csas(plan, 9).map(d => d.item_origen), [1]);
    assert.strictEqual(plan.omitidos.filter(o => o.motivo === 'ORIGEN_SIN_DATO').length, 0);
});

test('all origin rows present with zero or negative stock still sends the CEI alone', () => {
    const r = reglas([[1, 9], [2, 9]], [1, 2]);
    const plan = planificar([inv(9, -5), inv(1, 0), inv(2, 0)], r);
    assert.strictEqual(plan.documentos.length, 1);
    assert.strictEqual(cei(plan, 9).cantidad, 5);
    assert.strictEqual(plan.omitidos.filter(o => o.motivo === 'ORIGEN_SIN_DATO').length, 0);
});

test('UM-mismatched origin does not count as missing; walk continues to the next present origin', () => {
    const r = reglas([[1, 9], [2, 9]], [1, 2]);
    const plan = planificar([inv(9, -4), inv(1, 10, { um: 'UND' }), inv(2, 10)], r);
    assert.deepStrictEqual(csas(plan, 9).map(d => d.item_origen), [2]);
    assert.strictEqual(plan.omitidos.filter(o => o.motivo === 'ORIGEN_SIN_DATO').length, 0);
});
