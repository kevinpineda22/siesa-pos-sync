// Pure tests: no network, no env files, no Siesa/Supabase.
const test = require('node:test');
const assert = require('node:assert');
const {
    TRAZA_COLUMNAS, trazaGithub, capLista, alertasTocino, alertasNegativos, trazaCorrida, insertarTolerante
} = require('../corridaTraza');

const ENV = {
    GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '2', GITHUB_JOB: 'transformacion',
    GITHUB_REPOSITORY: 'org/repo', GITHUB_SERVER_URL: 'https://github.example.com'
};

test('TRAZA_COLUMNAS lists the five new columns', () => {
    assert.deepStrictEqual([...TRAZA_COLUMNAS].sort(),
        ['alertas', 'github_job', 'github_run_attempt', 'github_run_id', 'github_run_url']);
});

test('trazaGithub maps runner env to columns and builds the Actions URL', () => {
    assert.deepStrictEqual(trazaGithub(ENV), {
        github_run_id: 12345, github_run_attempt: 2, github_job: 'transformacion',
        github_run_url: 'https://github.example.com/org/repo/actions/runs/12345'
    });
});

test('trazaGithub defaults the server URL to github.com', () => {
    const r = trazaGithub({ GITHUB_RUN_ID: '9', GITHUB_REPOSITORY: 'o/r' });
    assert.strictEqual(r.github_run_url, 'https://github.com/o/r/actions/runs/9');
});

test('trazaGithub without GITHUB_RUN_ID returns all nulls', () => {
    assert.deepStrictEqual(trazaGithub({}), {
        github_run_id: null, github_run_attempt: null, github_job: null, github_run_url: null
    });
});

test('trazaGithub without repository keeps ids but no URL', () => {
    const r = trazaGithub({ GITHUB_RUN_ID: '9' });
    assert.strictEqual(r.github_run_id, 9);
    assert.strictEqual(r.github_run_url, null);
});

test('capLista keeps the true total and caps items at 50', () => {
    const r = capLista(Array.from({ length: 80 }, (_, i) => i));
    assert.strictEqual(r.total, 80);
    assert.strictEqual(r.items.length, 50);
    assert.strictEqual(r.truncada, true);
});

test('capLista caps long strings (top-level and object values) at 300 chars', () => {
    const r = capLista(['x'.repeat(500), { error: 'y'.repeat(500), n: 1 }]);
    assert.strictEqual(r.items[0].length, 300);
    assert.strictEqual(r.items[1].error.length, 300);
    assert.strictEqual(r.items[1].n, 1);
    assert.strictEqual(r.truncada, false);
});

test('capLista tolerates non-arrays', () => {
    assert.deepStrictEqual(capLista(undefined), { total: 0, items: [], truncada: false });
});

test('alertasTocino builds counts, lists and flags', () => {
    const a = alertasTocino({
        sinFilas: true, noClasificadas: [{ a: 1 }], netoNoPositivo: [1, 2], netoCambiado: [{ co: '1' }],
        ambiguos: [], erroresSiesa: ['e'], erroresGuardado: [], sinConfig: [], advertenciasUM: []
    });
    assert.strictEqual(a.v, 1);
    assert.strictEqual(a.job, 'tocino');
    assert.strictEqual(a.conteos.noClasificadas, 1);
    assert.strictEqual(a.conteos.netoNoPositivo, 2);
    assert.strictEqual(a.listas.netoNoPositivo.total, 2);
    assert.strictEqual(a.listas.erroresSiesa.items[0], 'e');
    assert.strictEqual(a.flags.sinFilas, true);
});

const resultadoNeg = () => ({
    abortada: true,
    inventario: { descartadas: 3 },
    alertas: {
        omitidos: [{ i: 1 }], errores: [{ i: 2 }], anomalias: [{ t: 'PLAN_INCOMPLETO' }],
        ambiguos: [{ a: 1 }, { a: 2 }], cancelados: [], bloqueados: [], reintentosDiasPrevios: [],
        erroresSiesa: [], erroresGuardado: [],
        fechaDesfasada: { fecha: '2026-01-01', hoy: '2026-01-02', motivo: 'late' }
    }
});

test('alertasNegativos includes ambiguos, abortada, fechaDesfasada and inventarioDescartado', () => {
    const a = alertasNegativos(resultadoNeg());
    assert.strictEqual(a.job, 'negativos');
    assert.strictEqual(a.conteos.ambiguos, 2);
    assert.strictEqual(a.listas.ambiguos.total, 2);
    assert.strictEqual(a.conteos.omitidos, 1);
    assert.strictEqual(a.conteos.errores, 1);
    assert.strictEqual(a.conteos.anomalias, 1);
    assert.strictEqual(a.flags.abortada, true);
    assert.deepStrictEqual(a.flags.fechaDesfasada, { motivo: 'late' });
    assert.strictEqual(a.flags.inventarioDescartado, 3);
});

test('alertasNegativos handles array descartadas and missing keys', () => {
    const a = alertasNegativos({ inventario: { descartadas: [1, 2] }, alertas: { omitidos: [1] } });
    assert.strictEqual(a.flags.inventarioDescartado, 2);
    assert.strictEqual(a.flags.abortada, false);
    assert.strictEqual(a.flags.fechaDesfasada, null);
    assert.strictEqual('ambiguos' in a.listas, false);
    assert.strictEqual(a.conteos.omitidos, 1);
});

test('oversized alertas (>64 KB) drop items but keep counts and mark truncada', () => {
    const big = Array.from({ length: 50 }, () => ({ x: 'z'.repeat(300) }));
    const lists = {};
    for (const k of ['omitidos', 'errores', 'anomalias', 'ambiguos', 'cancelados', 'bloqueados', 'reintentosDiasPrevios', 'erroresSiesa', 'erroresGuardado']) lists[k] = big;
    const a = alertasNegativos({ alertas: lists });
    assert.strictEqual(a.truncada, true);
    assert.strictEqual(a.conteos.omitidos, 50);
    assert.deepStrictEqual(a.listas.omitidos.items, []);
    assert.strictEqual(a.listas.omitidos.total, 50);
    assert.ok(JSON.stringify(a).length < 64 * 1024);
});

test('trazaCorrida merges github columns and alertas', () => {
    const r = trazaCorrida('negativos', resultadoNeg(), ENV);
    assert.strictEqual(r.github_run_id, 12345);
    assert.strictEqual(r.alertas.job, 'negativos');
    assert.deepStrictEqual(Object.keys(r).sort(), [...TRAZA_COLUMNAS].sort());
});

test('trazaCorrida for tocino and without runner env gives null github columns', () => {
    const r = trazaCorrida('tocino', { sinFilas: false }, {});
    assert.strictEqual(r.github_run_id, null);
    assert.strictEqual(r.alertas.job, 'tocino');
});

test('trazaCorrida: a throwing build yields alertas null and keeps github columns', () => {
    const src = { get noClasificadas() { throw new Error('boom'); } };
    const r = trazaCorrida('tocino', src, ENV);
    assert.strictEqual(r.alertas, null);
    assert.strictEqual(r.github_run_id, 12345);
});

test('trazaCorrida never throws on a null source or unknown job', () => {
    assert.strictEqual(trazaCorrida('negativos', null, {}).alertas, null);
    assert.strictEqual(trazaCorrida('otro', {}, {}).alertas, null);
});

test('insertarTolerante inserts the full row when it works', async () => {
    const llamadas = [];
    await insertarTolerante(async (f) => { llamadas.push(f); }, { fecha: 'x', alertas: {} }, () => {});
    assert.strictEqual(llamadas.length, 1);
    assert.ok('alertas' in llamadas[0]);
});

test('insertarTolerante retries once without trace columns on PGRST204 and warns', async () => {
    const llamadas = []; const avisos = [];
    const insertar = async (f) => {
        llamadas.push(f);
        if (llamadas.length === 1) throw Object.assign(new Error('Could not find the column'), { code: 'PGRST204' });
    };
    await insertarTolerante(insertar, { fecha: 'x', mensaje: 'm', github_run_id: 1, alertas: {} }, (m) => avisos.push(m));
    assert.strictEqual(llamadas.length, 2);
    assert.deepStrictEqual(llamadas[1], { fecha: 'x', mensaje: 'm' });
    assert.strictEqual(avisos.length, 1);
});

test('insertarTolerante retries on 42703 and on missing-column messages', async () => {
    for (const err of [
        Object.assign(new Error('x'), { code: '42703' }),
        new Error('column "alertas" of relation "t" does not exist'),
        new Error("Could not find the 'alertas' column of 't' in the schema cache")
    ]) {
        let n = 0;
        await insertarTolerante(async () => { if (++n === 1) throw err; }, { a: 1, alertas: null }, () => {});
        assert.strictEqual(n, 2);
    }
});

test('insertarTolerante rethrows other errors without retrying', async () => {
    let n = 0;
    await assert.rejects(
        insertarTolerante(async () => { n++; throw new Error('duplicate key'); }, { a: 1, alertas: {} }, () => {}),
        /duplicate key/);
    assert.strictEqual(n, 1);
});

test('insertarTolerante throws the retry error if the legacy insert fails too', async () => {
    let n = 0;
    await assert.rejects(
        insertarTolerante(async () => {
            n++;
            throw n === 1 ? Object.assign(new Error('col'), { code: 'PGRST204' }) : new Error('network down');
        }, { a: 1, alertas: {} }, () => {}),
        /network down/);
    assert.strictEqual(n, 2);
});
