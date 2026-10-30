const test = require('node:test');
const assert = require('node:assert');
const notifier = require('../notifier');

const id = { fecha: '2026-10-29', co: '001', bodega: '00101', item_destino: 15251, tipo_dto: 'CSA', item_origen: 15202 };
const base = {
    fecha: '2026-10-29', entorno: 'QA', modo: 'NORMAL', destinos: 2, documentos: 3, fallos: 0, abortada: false,
    inventario: { filas: 1200, paginas: 2, descartadas: 0 },
    detalle: [{ ...id, tipo_dto: 'CEI', item_origen: 0, cantidad: 4.5, resultado: 'OK', error: null }],
    alertas: {
        erroresSiesa: [], ambiguos: [], erroresGuardado: [], bloqueados: [], cancelados: [],
        anomalias: [], omitidos: [], errores: [], reintentosDiasPrevios: []
    }
};
const conAlertas = (a) => ({ ...base, alertas: { ...base.alertas, ...a } });

test('builder: clean run has no alerts and reports pages/rows', () => {
    const m = notifier.buildTransformacionNegativosEmail(base);
    assert.strictEqual(m.nAlertas, 0);
    assert.match(m.html, /1[.,]?200/);
    assert.match(m.html, /2 page/i);
    assert.doesNotMatch(m.subject, /alerta/);
});

test('builder: AMBIGUO states CEI possibly sent, CSAs blocked, manual review', () => {
    const m = notifier.buildTransformacionNegativosEmail(conAlertas({
        ambiguos: [{ ...id, tipo_dto: 'CEI', item_origen: 0, error: 'AMBIGUO: timeout', previo: false }],
        bloqueados: [{ ...id, cantidad: 2, motivo: 'CEI possibly sent, CSAs blocked, manual review' }]
    }));
    assert.match(m.html, /CEI possibly sent, CSAs blocked, manual review/);
    assert.ok(m.nAlertas >= 2);
});

test('builder: PLAN_INCOMPLETO, missing cost/UM, duplicates, prior-day retries and UM skips are listed', () => {
    const m = notifier.buildTransformacionNegativosEmail(conAlertas({
        anomalias: [{ ...id, tipoAnomalia: 'PLAN_INCOMPLETO', motivo: 'plan incompleto: CEI expects 2' }],
        errores: [{ ...id, cantidad: 1, error: 'Destination unit cost is missing or zero; nothing sent.' }],
        omitidos: [
            { ...id, motivo: 'INVENTARIO_DUPLICADO', detalle: 'Conflicting inventory rows' },
            { ...id, motivo: 'UM_DISTINTA', detalle: 'UM mismatch' }
        ],
        reintentosDiasPrevios: [{ ...id, fecha: '2026-10-28', cantidad: 1, intentosPrevios: 1, resultado: 'OK' }]
    }));
    for (const re of [/PLAN_INCOMPLETO/, /cost is missing/, /INVENTARIO_DUPLICADO/, /UM_DISTINTA/, /2026-10-28/]) {
        assert.match(m.html, re);
    }
});

test('builder: ORIGEN_SIN_DATO skip is listed with the missing origin and counts as an alert', () => {
    const m = notifier.buildTransformacionNegativosEmail(conAlertas({
        omitidos: [{ ...id, tipo_dto: undefined, item_origen: 15177, motivo: 'ORIGEN_SIN_DATO', detalle: 'No inventory row for origin 15177' }]
    }));
    assert.match(m.html, /ORIGEN_SIN_DATO/);
    assert.match(m.html, /origen 15177/);
    assert.ok(m.nAlertas >= 1);
});

test('builder: escapes HTML in dynamic text', () => {
    const m = notifier.buildTransformacionNegativosEmail(conAlertas({
        errores: [{ ...id, cantidad: 1, error: '<script>x</script>' }]
    }));
    assert.doesNotMatch(m.html, /<script>/);
});

test('send: uses injected transport and recipient fallback chain NEG -> TRANSF -> NOTIFY', async () => {
    const guardado = { ...process.env };
    try {
        delete process.env.NOTIFY_TRANSF_NEG_EMAILS; delete process.env.NOTIFY_TRANSF_EMAILS;
        process.env.NOTIFY_EMAILS = 'general@x.com';
        const enviados = [];
        const transport = { sendMail: async (m) => { enviados.push(m); return { messageId: 'id' }; } };
        await notifier.sendTransformacionNegativosNotification(base, { transport });
        assert.strictEqual(enviados[0].to, 'general@x.com');

        process.env.NOTIFY_TRANSF_EMAILS = 'transf@x.com';
        await notifier.sendTransformacionNegativosNotification(base, { transport });
        assert.strictEqual(enviados[1].to, 'transf@x.com');

        process.env.NOTIFY_TRANSF_NEG_EMAILS = 'neg@x.com, otro@x.com';
        await notifier.sendTransformacionNegativosNotification(base, { transport });
        assert.strictEqual(enviados[2].to, 'neg@x.com, otro@x.com');
    } finally {
        for (const k of Object.keys(process.env)) if (!(k in guardado)) delete process.env[k];
        Object.assign(process.env, guardado);
    }
});

test('send: no recipients -> no send; transport failure does not throw', async () => {
    const guardado = { ...process.env };
    try {
        delete process.env.NOTIFY_TRANSF_NEG_EMAILS; delete process.env.NOTIFY_TRANSF_EMAILS; delete process.env.NOTIFY_EMAILS;
        let n = 0;
        await notifier.sendTransformacionNegativosNotification(base, { transport: { sendMail: async () => { n++; } } });
        assert.strictEqual(n, 0);
        process.env.NOTIFY_EMAILS = 'a@x.com';
        await notifier.sendTransformacionNegativosNotification(base, { transport: { sendMail: async () => { throw new Error('smtp down'); } } });
    } finally {
        for (const k of Object.keys(process.env)) if (!(k in guardado)) delete process.env[k];
        Object.assign(process.env, guardado);
    }
});
