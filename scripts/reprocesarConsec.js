/**
 * reprocesarConsec.js — Reprocesar UN consec puntual que ya estaba OK.
 *
 * Úsalo SOLO cuando hayas ANULADO el documento en Siesa y quieras que el flujo lo vuelva a
 * crear (p.ej. para que aplique el fix de unidad de medida P6 -> UND).
 *
 * Qué hace:
 *   1. Borra la idempotencia de ese consec/CO/caja para los tipos indicados (CNZ y/o CFZ),
 *      para que el flujo NO lo omita.
 *   2. Reprocesa SOLO ese consec (modo consec específico). Los demás documentos OK del mismo
 *      consec en otra caja siguen OK -> la idempotencia los omite (no se duplican).
 *
 * ⚠️ ESTO SÍ ENVÍA A PRODUCCIÓN DE SIESA (recrea el/los documento(s)).
 *    Limpia/recrea SOLO los tipos que REALMENTE anulaste en Siesa, o duplicarás.
 *
 * Uso (por defecto consec 136 / CO 001 / caja Z02 / tipos CNZ,CFZ):
 *   node scripts/reprocesarConsec.js
 * Overrides:
 *   RP_CONSEC=136 RP_CO=001 RP_CAJA=Z02 RP_TIPOS=CFZ node scripts/reprocesarConsec.js
 */
require('dotenv').config();
const { syncVentas } = require('../syncVentas');
const logger = require('../logger');

(async () => {
    const consec = process.env.RP_CONSEC || '136';
    const co = (process.env.RP_CO || '001').padStart(3, '0');
    const caja = (process.env.RP_CAJA || 'Z02').toUpperCase();
    const tipos = (process.env.RP_TIPOS || 'CNZ,CFZ')
        .split(',')
        .map((t) => t.trim().toUpperCase())
        .filter(Boolean);

    const ids = tipos.map((t) => `${t}:${co}:${caja}:${consec}`);

    console.log('==================================================');
    console.log(`♻️  REPROCESAR consec=${consec} | CO=${co} | Caja=${caja} | tipos=${tipos.join(',')}`);
    console.log('   ⚠️  Esto recrea el/los documento(s) en Siesa PRODUCCIÓN.');
    console.log('==================================================');

    // 1) Limpiar idempotencia SOLO de esas filas.
    console.log(`🧹 Borrando idempotencia: ${ids.join(', ')}`);
    const { error } = await logger.supabase.from('sps_facturas').delete().in('id', ids);
    if (error) {
        console.error('❌ Error limpiando idempotencia:', error.message);
        process.exit(1);
    }
    console.log('✅ Idempotencia limpiada (esas filas ya no están OK).');

    // 2) Reprocesar SOLO ese consec. El modo consec específico lo busca en su propio CO/Caja
    //    e ignora filtros de hoy. Los grupos del mismo consec en otra caja que sigan OK se
    //    omiten por idempotencia, así que no se duplican.
    console.log(`🚀 Reprocesando consec ${consec}...`);
    const res = await syncVentas({ consecs: [consec] });
    const fail = res?.fail ?? 0;
    console.log(`\n🏁 Total=${res?.total ?? 0} | OK=${res?.ok ?? 0} | FALLO=${fail}`);
    (res?.detalle || []).forEach((r) => {
        console.log(`  ${r.ok ? '✅' : '❌'} [${r.tipo} ${r.consecutivo}] CO ${r.co} · Caja ${r.caja} ${r.ok ? '' : '— ' + String(r.mensaje).slice(0, 120)}`);
    });
    process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
    console.error('❌ Error fatal:', e.message);
    process.exit(1);
});
