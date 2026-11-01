// Pure helper tests: no network, no env, no Siesa/Supabase.
const test = require('node:test');
const assert = require('node:assert');
const { resolverPermitirDiaEnCurso } = require('../transformacionNegativosPlan');

test('schedule ignores the flag (env and option)', () => {
    assert.strictEqual(resolverPermitirDiaEnCurso({ env: 'true', evento: 'schedule' }), false);
    assert.strictEqual(resolverPermitirDiaEnCurso({ opcion: true, env: 'true', evento: 'schedule' }), false);
});

test('workflow_dispatch with env true/1 enables it', () => {
    assert.strictEqual(resolverPermitirDiaEnCurso({ env: 'true', evento: 'workflow_dispatch' }), true);
    assert.strictEqual(resolverPermitirDiaEnCurso({ env: '1', evento: 'workflow_dispatch' }), true);
    assert.strictEqual(resolverPermitirDiaEnCurso({ env: 'TRUE', evento: 'workflow_dispatch' }), true);
});

test('false, empty or missing env disables it', () => {
    assert.strictEqual(resolverPermitirDiaEnCurso({ env: 'false', evento: 'workflow_dispatch' }), false);
    assert.strictEqual(resolverPermitirDiaEnCurso({ env: '', evento: 'workflow_dispatch' }), false);
    assert.strictEqual(resolverPermitirDiaEnCurso({ env: undefined }), false);
    assert.strictEqual(resolverPermitirDiaEnCurso(), false);
});

test('option override wins over env (non-schedule)', () => {
    assert.strictEqual(resolverPermitirDiaEnCurso({ opcion: true, env: 'false' }), true);
    assert.strictEqual(resolverPermitirDiaEnCurso({ opcion: false, env: 'true' }), false);
});
