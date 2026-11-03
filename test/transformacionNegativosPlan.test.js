// Pure planner tests: no network, no env, no Siesa/Supabase.
const test = require('node:test');
const assert = require('node:assert');


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


const {
    aUnidades, aUnidadesCeil, truncarUnidades, UNIDADES,
    planificarNegativosPorTienda, construirPayloadDocumento, parsearCosFiltro
} = require('../transformacionNegativosPlan');

// ---- per-store planning ----
const planT = (inventario, r, extra = {}) => planificarNegativosPorTienda({
    inventario, reglas: r, previos: { docs: [], legado: [] }, fecha: FECHA, entorno: 'QA', ...extra
});
const docT = (plan, tipo, bodega = '00101', co = '001') =>
    plan.documentos.find(d => d.tipo_dto === tipo && d.bodega === bodega && d.co === co);
const nro = (l) => l.map(x => [x.item, x.cantidad]);

test('PS1 store with 3 negative destinations -> one CEI (3 lines) and one CSA', () => {
    const r = reglas([[1, 7], [1, 8], [2, 9]], [1, 2]);
    const plan = planT([inv(7, -2), inv(8, -3), inv(9, -1), inv(1, 10), inv(2, 10)], r);
    assert.strictEqual(plan.documentos.length, 2);
    const e = docT(plan, 'CEI');
    assert.deepStrictEqual(nro(e.lineas), [[7, 2], [8, 3], [9, 1]]);
    assert.deepStrictEqual(e.lineas.map(l => l.nro), [1, 2, 3]);
    const s = docT(plan, 'CSA');
    assert.deepStrictEqual(nro(s.lineas), [[1, 5], [2, 1]]);
    assert.strictEqual(e.cantidad_total, 6);
    assert.strictEqual(e.lineas_activas, 3);
    assert.strictEqual(s.lineas_activas, 2);
    assert.strictEqual(e.entorno, 'QA');
    assert.strictEqual(e.fecha, FECHA);
});

test('PS2 negative -0.0004: CEI line is 0.0004 and the destination ends at zero', () => {
    const r = reglas([[1, 9]], [1]);
    const plan = planT([inv(9, -0.0004), inv(1, 10)], r);
    assert.strictEqual(docT(plan, 'CEI').lineas[0].cantidad, 0.0004);
    assert.strictEqual(docT(plan, 'CSA').lineas[0].cantidad, 0.0004);
    assert.strictEqual(docT(plan, 'CEI').payload.Movimientos[0].CANTIDAD, '000000000000000.0004');
});

test('PS2 CEI quantity is the full negative rounded UP to 4 decimals', () => {
    const r = reglas([[1, 9]], [1]);
    const plan = planT([inv(9, -0.00041), inv(1, 10)], r);
    assert.strictEqual(docT(plan, 'CEI').lineas[0].cantidad, 0.0005);
    const sub = planT([inv(9, -1e-7), inv(1, 10)], r);
    assert.strictEqual(sub.documentos.length, 0);
});

test('PS2 origin availability is truncated to 4 decimals', () => {
    const r = reglas([[1, 9]], [1]);
    const plan = planT([inv(9, -1), inv(1, 0.00019)], r);
    assert.strictEqual(docT(plan, 'CSA').lineas[0].cantidad, 0.0001);
});

test('PS3 CEI/CSA line shape carries snapshot, plan quantity, state, origenes and costs', () => {
    const r = reglas([[1, 9]], [1]);
    const plan = planT([inv(9, -2, { costo: 500 }), inv(1, 10, { costo: 700 })], r);
    const l = docT(plan, 'CEI').lineas[0];
    assert.deepStrictEqual(l, {
        nro: 1, item: 9, um: 'KL', costo: 500, disponible_snapshot: -2, cantidad_plan: 2, cantidad: 2,
        estado: 'ACTIVA', ajustes: [], origenes: [{ item: 1, cantidad: 2 }]
    });
    const c = docT(plan, 'CSA').lineas[0];
    assert.deepStrictEqual(c, {
        nro: 1, item: 1, um: 'KL', costo: 700, disponible_snapshot: 10, cantidad_plan: 2, cantidad: 2,
        estado: 'ACTIVA', ajustes: [], atribucion: [{ item_destino: 9, cantidad: 2, orden: 1 }]
    });
});

test('PS4 same origin across destinations of a store aggregates into ONE CSA line with attribution', () => {
    const r = reglas([[1, 8], [1, 9]], [1]);
    const plan = planT([inv(8, -3), inv(9, -3), inv(1, 4)], r);
    const s = docT(plan, 'CSA');
    assert.strictEqual(s.lineas.length, 1);
    assert.strictEqual(s.lineas[0].cantidad, 4);
    assert.deepStrictEqual(s.lineas[0].atribucion, [
        { item_destino: 8, cantidad: 3, orden: 1 },
        { item_destino: 9, cantidad: 1, orden: 2 }
    ]);
    assert.strictEqual(s.lineas[0].disponible_snapshot, 4);
    assert.strictEqual(s.cantidad_total, 4);
    assert.deepStrictEqual(docT(plan, 'CEI').lineas.map(l => l.cantidad), [3, 3]);
    const shortfall = s.novedades.filter(n => n.codigo === 'SIN_STOCK');
    assert.strictEqual(shortfall.length, 1);
    assert.strictEqual(shortfall[0].item_destino, 9);
    assert.strictEqual(shortfall[0].item_origen, 1);
    assert.strictEqual(shortfall[0].cantidad, 2);
});

test('PS4 an invalid destination is excluded without blocking the rest of the store', () => {
    const r = reglas([[1, 8], [1, 9]], [1]);
    const plan = planT([inv(8, -3, { costo: 0 }), inv(9, -2), inv(1, 10)], r);
    assert.deepStrictEqual(nro(docT(plan, 'CEI').lineas), [[9, 2]]);
    assert.deepStrictEqual(nro(docT(plan, 'CSA').lineas), [[1, 2]]);
    assert.strictEqual(plan.errores.length, 1);
    assert.strictEqual(plan.errores[0].item_destino, 8);
});

test('PS4 destination skipped by ORIGEN_SIN_DATO leaves the ledger untouched and the store continues', () => {
    const r = reglas([[1, 8], [2, 8], [1, 9]], [1, 2]);
    const plan = planT([inv(8, -5), inv(9, -2), inv(1, 2)], r);
    assert.deepStrictEqual(nro(docT(plan, 'CEI').lineas), [[9, 2]]);
    assert.deepStrictEqual(nro(docT(plan, 'CSA').lineas), [[1, 2]]);
    assert.ok(plan.omitidos.some(o => o.motivo === 'ORIGEN_SIN_DATO' && o.item_destino === 8));
});

test('PS4 CSA is emitted only with at least one origin line; CEI is emitted with SIN_STOCK novedad', () => {
    const r = reglas([[1, 9]], [1]);
    const plan = planT([inv(9, -5), inv(1, 0)], r);
    assert.strictEqual(plan.documentos.length, 1);
    const e = docT(plan, 'CEI');
    assert.strictEqual(e.lineas[0].cantidad, 5);
    assert.deepStrictEqual(e.lineas[0].origenes, []);
    const n = e.novedades.find(x => x.codigo === 'SIN_STOCK');
    assert.ok(n);
    assert.strictEqual(n.item_destino, 9);
    assert.strictEqual(n.tipo_dto, 'CEI');
    assert.strictEqual(n.cantidad, 5);
    assert.strictEqual(n.severidad, 'MEDIA');
});

test('PS4 UM mismatch emits an UM_DISTINTA (INFO) novedad and the line is not planned', () => {
    const r = reglas([[1, 9], [2, 9]], [1, 2]);
    const plan = planT([inv(9, -4), inv(1, 10, { um: 'UND' }), inv(2, 10)], r);
    assert.deepStrictEqual(nro(docT(plan, 'CSA').lineas), [[2, 4]]);
    const n = docT(plan, 'CSA').novedades.find(x => x.codigo === 'UM_DISTINTA');
    assert.ok(n);
    assert.strictEqual(n.severidad, 'INFO');
    assert.strictEqual(n.item_origen, 1);
    assert.strictEqual(n.item_destino, 9);
});

test('PS1 stores are independent: each (co,bodega) gets its own pair, ordered by co then bodega', () => {
    const r = reglas([[1, 9]], [1]);
    const plan = planT([
        inv(9, -3, { bodega: 'B2' }), inv(1, 3, { bodega: 'B2' }),
        inv(9, -3, { bodega: 'B1' }), inv(1, 3, { bodega: 'B1' }),
        inv(9, -3, { co: '002', bodega: 'C1' }), inv(1, 3, { co: '002', bodega: 'C1' })
    ], r);
    assert.deepStrictEqual(plan.documentos.map(d => `${d.co}/${d.bodega}/${d.tipo_dto}`),
        ['001/B1/CEI', '001/B1/CSA', '001/B2/CEI', '001/B2/CSA', '002/C1/CEI', '002/C1/CSA']);
});

test('PS4 plan is deterministic regardless of input order', () => {
    const r = reglas([[1, 8], [1, 9]], [1]);
    const a = planT([inv(9, -3), inv(8, -3), inv(1, 4)], r);
    const b = planT([inv(1, 4), inv(8, -3), inv(9, -3)], r);
    assert.deepStrictEqual(a, b);
});

test('PS4 15207 and configured exclusions are never destinations; invalid exclusion throws', () => {
    const r = reglas([[1, 9], [1, 15207]], [1]);
    const plan = planT([inv(9, -2), inv(15207, -2), inv(1, 50)], r);
    assert.deepStrictEqual(nro(docT(plan, 'CEI').lineas), [[9, 2]]);
    assert.throws(() => planT([inv(9, -2), inv(1, 5)], reglas([[1, 9]], [1], { excluidos: ['abc'] })), /excluded item/i);
});

test('PS4 negative destination of the run is never an origin in the same run', () => {
    const r = reglas([[15202, 15251], [15177, 15202], [15150, 15251]], [15202, 15177, 15150]);
    const plan = planT([inv(15202, -2), inv(15251, -4), inv(15177, 10), inv(15150, 10)], r);
    assert.deepStrictEqual(nro(docT(plan, 'CSA').lineas), [[15177, 2], [15150, 4]]);
});

// ---- reservation (S4 / S4b) ----
const csaDoc = (status, lineas, extra = {}) => ({
    fecha: '2026-10-28', co: '001', bodega: '00101', tipo_dto: 'CSA', status, lineas, ...extra
});
const lineaCsa = (item, cantidad, estado = 'ACTIVA') => ({ item, cantidad, estado });
const planConDocs = (inventario, r, docs, extra = {}) =>
    planT(inventario, r, { previos: { docs, legado: [] }, ...extra });

test('S4 PLANNED CSA line reserves origin stock: planner offers 6 of 10', () => {
    const r = reglas([[1, 9]], [1]);
    const plan = planConDocs([inv(9, -8), inv(1, 10)], r, [csaDoc('PLANNED', [lineaCsa(1, 4)])]);
    assert.strictEqual(docT(plan, 'CSA').lineas[0].cantidad, 6);
    assert.strictEqual(docT(plan, 'CSA').lineas[0].disponible_snapshot, 10);
});

test('S4b PLANNED, ERROR, SENDING and AMBIGUO CSAs reserve origin stock', () => {
    const r = reglas([[1, 9]], [1]);
    for (const status of ['PLANNED', 'ERROR', 'SENDING', 'AMBIGUO']) {
        const plan = planConDocs([inv(9, -8), inv(1, 10)], r, [csaDoc(status, [lineaCsa(1, 4)])]);
        assert.strictEqual(docT(plan, 'CSA').lineas[0].cantidad, 6, status);
    }
});

test('S4 OK and CANCELADO CSAs and DESCARTADA lines do not reserve; CEI docs never reserve', () => {
    const r = reglas([[1, 9]], [1]);
    for (const status of ['OK', 'CANCELADO']) {
        const plan = planConDocs([inv(9, -8), inv(1, 10)], r, [csaDoc(status, [lineaCsa(1, 4)])]);
        assert.strictEqual(docT(plan, 'CSA').lineas[0].cantidad, 8, status);
    }
    const desc = planConDocs([inv(9, -8), inv(1, 10)], r, [csaDoc('ERROR', [lineaCsa(1, 4, 'DESCARTADA')])]);
    assert.strictEqual(docT(desc, 'CSA').lineas[0].cantidad, 8);
    const cei = planConDocs([inv(9, -8), inv(1, 10)], r, [{ ...csaDoc('ERROR', [lineaCsa(1, 4)]), tipo_dto: 'CEI' }]);
    assert.strictEqual(docT(cei, 'CSA').lineas[0].cantidad, 8);
});

test('S4 reservations are scoped to co|bodega|item and clamped at zero (CEI-only fallback)', () => {
    const r = reglas([[1, 9]], [1]);
    const otras = planConDocs([inv(9, -8), inv(1, 10)], r, [
        csaDoc('ERROR', [lineaCsa(1, 9)], { bodega: '00102' }),
        csaDoc('ERROR', [lineaCsa(1, 9)], { co: '002' }),
        csaDoc('ERROR', [lineaCsa(2, 9)])
    ]);
    assert.strictEqual(docT(otras, 'CSA').lineas[0].cantidad, 8);
    const agotado = planConDocs([inv(9, -5), inv(1, 3)], r, [
        csaDoc('ERROR', [lineaCsa(1, 2)]),
        csaDoc('PLANNED', [lineaCsa(1, 5)], { fecha: '2026-10-27' })
    ]);
    assert.strictEqual(docT(agotado, 'CSA'), undefined);
    assert.strictEqual(docT(agotado, 'CEI').lineas[0].cantidad, 5);
});

test('S4 reservations are exact to 4 decimals', () => {
    const r = reglas([[1, 9]], [1]);
    const plan = planConDocs([inv(9, -8), inv(1, 10.3)], r, [csaDoc('ERROR', [lineaCsa(1, 2.3501)])]);
    assert.strictEqual(docT(plan, 'CSA').lineas[0].cantidad, 7.9499);
});

// ---- resume ----
test('Resume: a store already planned for the fecha is skipped; a prior-day doc does not skip', () => {
    const r = reglas([[1, 9]], [1]);
    const hoy = { fecha: FECHA, co: '001', bodega: '00101', tipo_dto: 'CEI', status: 'OK', lineas: [] };
    assert.strictEqual(planConDocs([inv(9, -2), inv(1, 10)], r, [hoy]).documentos.length, 0);
    const ayer = { ...hoy, fecha: '2026-10-28' };
    assert.strictEqual(planConDocs([inv(9, -2), inv(1, 10)], r, [ayer]).documentos.length, 2);
    const otra = { ...hoy, bodega: '00102' };
    assert.strictEqual(planConDocs([inv(9, -2), inv(1, 10)], r, [otra]).documentos.length, 2);
});

// ---- cutover (S7 / S7b) ----
const legadoRow = (extra = {}) => ({ fecha: FECHA, co: '001', bodega: '00101', item_destino: 8, tipo_dto: 'CEI', item_origen: 0, status: 'OK', ...extra });
const planConLegado = (inventario, r, legado, extra = {}) =>
    planT(inventario, r, { previos: { docs: [], legado }, ...extra });

test('S7 a destination with a legacy row for the fecha is excluded; other destinations of the store are planned', () => {
    const r = reglas([[1, 8], [1, 9]], [1]);
    const plan = planConLegado([inv(8, -3), inv(9, -2), inv(1, 10)], r, [legadoRow()]);
    assert.deepStrictEqual(nro(docT(plan, 'CEI').lineas), [[9, 2]]);
    assert.deepStrictEqual(nro(docT(plan, 'CSA').lineas), [[1, 2]]);
});

test('S7 a legacy row of another store or another fecha does not exclude the destination', () => {
    const r = reglas([[1, 8]], [1]);
    const otraTienda = planConLegado([inv(8, -3), inv(1, 10)], r, [legadoRow({ bodega: '00102' })]);
    assert.strictEqual(otraTienda.documentos.length, 2);
    const ayerOk = planConLegado([inv(8, -3), inv(1, 10)], r, [legadoRow({ fecha: '2026-10-28' })]);
    assert.strictEqual(ayerOk.documentos.length, 2);
});

test('S7 legacy CEI in SENDING/AMBIGUO blocks that destination (BLOQUEADO_LEGADO) even from another day', () => {
    const r = reglas([[1, 8], [1, 9]], [1]);
    for (const status of ['SENDING', 'AMBIGUO']) {
        const plan = planConLegado([inv(8, -3), inv(9, -2), inv(1, 10)], r, [legadoRow({ fecha: '2026-10-28', status })]);
        assert.deepStrictEqual(nro(docT(plan, 'CEI').lineas), [[9, 2]], status);
        assert.ok(plan.omitidos.some(o => o.motivo === 'BLOQUEADO_LEGADO' && o.item_destino === 8), status);
    }
});

test('S7b legacy CSA PLANNED/ERROR is reported LEGADO_PENDIENTE, never reserves origin stock, never planned again', () => {
    const r = reglas([[1, 9]], [1]);
    const legado = [legadoRow({ fecha: '2026-10-28', item_destino: 7, tipo_dto: 'CSA', item_origen: 1, status: 'ERROR', cantidad: 6 })];
    const plan = planConLegado([inv(9, -8), inv(1, 10)], r, legado);
    assert.strictEqual(docT(plan, 'CSA').lineas[0].cantidad, 8);
    const a = plan.omitidos.filter(o => o.motivo === 'LEGADO_PENDIENTE');
    assert.strictEqual(a.length, 1);
    assert.strictEqual(a[0].item_destino, 7);
    assert.strictEqual(a[0].item_origen, 1);
    const ok = planConLegado([inv(9, -8), inv(1, 10)], r, [{ ...legado[0], status: 'OK' }]);
    assert.strictEqual(ok.omitidos.filter(o => o.motivo === 'LEGADO_PENDIENTE').length, 0);
});

test('S7 invariant: no destination/fecha is planned when legacy already owns it, whatever the legacy tipo', () => {
    const r = reglas([[1, 8]], [1]);
    for (const tipo_dto of ['CEI', 'CSA']) {
        const plan = planConLegado([inv(8, -3), inv(1, 10)], r, [legadoRow({ tipo_dto, item_origen: tipo_dto === 'CSA' ? 1 : 0 })]);
        assert.strictEqual(plan.documentos.length, 0, tipo_dto);
    }
});

// ---- CO filter ----
test('CO filter: parsearCosFiltro handles lists, blanks and leading zeros', () => {
    assert.deepStrictEqual(parsearCosFiltro(''), []);
    assert.deepStrictEqual(parsearCosFiltro(undefined), []);
    assert.deepStrictEqual(parsearCosFiltro(' 001, 011 ,,'), ['001', '011']);
    assert.deepStrictEqual(parsearCosFiltro(['002', ' 003 ']), ['002', '003']);
});

test('CO filter: only the selected COs are planned; empty means all; leading zeros are tolerated', () => {
    const r = reglas([[1, 9]], [1]);
    const data = [inv(9, -3), inv(1, 3), inv(9, -3, { co: '011', bodega: 'B11' }), inv(1, 3, { co: '011', bodega: 'B11' })];
    assert.deepStrictEqual([...new Set(planT(data, r).documentos.map(d => d.co))], ['001', '011']);
    assert.deepStrictEqual([...new Set(planT(data, r, { cos: ['011'] }).documentos.map(d => d.co))], ['011']);
    assert.deepStrictEqual([...new Set(planT(data, r, { cos: '11' }).documentos.map(d => d.co))], ['011']);
    assert.strictEqual(planT(data, r, { cos: [] }).documentos.length, 4);
    assert.strictEqual(planT(data, r, { cos: ['999'] }).documentos.length, 0);
});

// ---- payload builder ----
test('PB1 construirPayloadDocumento builds N Movimientos with renumbered NRO_REGISTRO and only ACTIVA/AJUSTADA lines', () => {
    const lineas = [
        { nro: 1, item: 7, um: 'KL', costo: 500, cantidad: 2, estado: 'ACTIVA' },
        { nro: 2, item: 8, um: 'KL', costo: 500, cantidad: 1.2345, estado: 'DESCARTADA' },
        { nro: 3, item: 9, um: 'UND', costo: 0, cantidad: 123.95, estado: 'AJUSTADA' }
    ];
    const p = construirPayloadDocumento({ def: { tipoDto: 'CEI', claseDto: '61', concepto: '601', motivo: '06' }, fecha: FECHA, co: '001', bodega: '00101', lineas, unidadNegocio: '003', nota: 'n' });
    assert.strictEqual(p.Documentos.length, 1);
    assert.strictEqual(p.Documentos[0].TIPO_DTO, 'CEI');
    assert.strictEqual(p.Documentos[0].NOTA, 'n');
    assert.strictEqual(p.Documentos[0]['FECHA_DOCUMENTO=8 (AAAAMMDD)'], '20261029');
    assert.strictEqual(p.Movimientos.length, 2);
    assert.deepStrictEqual(p.Movimientos.map(m => m.NRO_REGISTRO), ['1', '2']);
    assert.deepStrictEqual(p.Movimientos.map(m => m.ITEM), ['0000007', '0000009']);
    assert.deepStrictEqual(p.Movimientos.map(m => m.CANTIDAD), ['000000000000002.0000', '000000000000123.9500']);
    assert.strictEqual(p.Movimientos[0].CONSECUTIVO, '0');
    assert.strictEqual(p.Movimientos[0].BODEGA, '00101');
    assert.strictEqual(p.Movimientos[0].CENTRO_OPERA_MOVIMIENTO, '001');
    assert.strictEqual(p.Movimientos[0].MOTIVO, '06');
    assert.strictEqual(p.Movimientos[0].UNIDAD_NEGOCIO, '003');
    assert.strictEqual(p.Movimientos[1].UNIDAD_MEDIDA, 'UND');
    assert.strictEqual(p.Movimientos[0].COSTO_PROMEDIO_UNITARIO, '000000000000500.0000');
});

test('PB1 payload of a planned document uses connector shape for CEI and CSA', () => {
    const r = reglas([[1, 9]], [1]);
    const plan = planT([inv(9, -2), inv(1, 10)], r);
    const e = docT(plan, 'CEI').payload;
    assert.strictEqual(e.Documentos[0].CLASE_DTO, '61');
    assert.strictEqual(e.Documentos[0].CONCEPTO, '601');
    assert.strictEqual(e.Movimientos[0].MOTIVO, '06');
    const s = docT(plan, 'CSA').payload;
    assert.strictEqual(s.Documentos[0].CLASE_DTO, '62');
    assert.strictEqual(s.Documentos[0].CONCEPTO, '602');
    assert.strictEqual(s.Movimientos[0].MOTIVO, '10');
    assert.strictEqual(s.Movimientos[0].ITEM, '0000001');
});


// ---- units helpers ----
test('U1 aUnidadesCeil rounds the magnitude UP to 4 decimals, decimal-safe', () => {
    assert.strictEqual(UNIDADES, 10000);
    assert.strictEqual(aUnidadesCeil(-0.0004), 4);
    assert.strictEqual(aUnidadesCeil(-0.00041), 5);
    assert.strictEqual(aUnidadesCeil(-0.001), 10);
    assert.strictEqual(aUnidadesCeil(-5.84), 58400);
    assert.strictEqual(aUnidadesCeil(-0.30000000000000004), 3000);
    assert.strictEqual(aUnidadesCeil(22.02), 220200);
    assert.strictEqual(aUnidadesCeil('3.1'), 31000);
    assert.strictEqual(aUnidadesCeil(1e-7), 0);
    assert.strictEqual(aUnidadesCeil(0), 0);
    assert.strictEqual(aUnidadesCeil(null), 0);
});

test('U2 truncarUnidades floors the magnitude to 4 decimals (never promises stock we do not have)', () => {
    assert.strictEqual(truncarUnidades(0.00019), 1);
    assert.strictEqual(truncarUnidades(10.3), 103000);
    assert.strictEqual(truncarUnidades(0.019), 190);
    assert.strictEqual(truncarUnidades(0.3), 3000);
    assert.strictEqual(truncarUnidades(1e-7), 0);
});

test('U3 aUnidades rounds half-up to 4 decimals', () => {
    assert.strictEqual(aUnidades(0.00005), 1);
    assert.strictEqual(aUnidades(0.00004), 0);
    assert.strictEqual(aUnidades(123.95), 1239500);
    assert.strictEqual(aUnidades(-2.675), 26750);
    assert.strictEqual(aUnidades(undefined), 0);
});
