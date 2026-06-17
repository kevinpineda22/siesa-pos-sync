/**
 * testResumenRango.js — READ-ONLY. Compara, día por día de un rango, el snapshot POS
 * (sps_estadisticas_diarias) contra las facturas sincronizadas (sps_facturas).
 * Sirve para entender por qué POS < Sincronizado en el resumen por rango.
 * Solo LEE Supabase. NO toca Siesa.
 *
 *   node scripts/testResumenRango.js
 *   RG_INICIO=2026-06-11 RG_FIN=2026-06-17 node scripts/testResumenRango.js
 */
require('dotenv').config();
const logger = require('../logger');

const sig = (f) => { const d = new Date(f + 'T12:00:00'); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); };

(async () => {
    const inicio = process.env.RG_INICIO || '2026-06-11';
    const fin = process.env.RG_FIN || '2026-06-17';

    const { data: stats } = await logger.supabase
        .from('sps_estadisticas_diarias')
        .select('fecha, total_pos, por_nit').gte('fecha', inicio).lte('fecha', fin);
    const { data: facs } = await logger.supabase
        .from('sps_facturas')
        .select('estado, co, caja, consec, cliente_nit, fecha_factura')
        .gte('fecha_factura', inicio).lte('fecha_factura', fin);

    // Dedup facturas por co:caja:consec (igual que el backend)
    const prio = { FALLO: 3, SIN_RECAUDO: 2, OK: 1 };
    const uniq = new Map();
    (facs || []).forEach(f => {
        const k = `${f.co || ''}:${f.caja || ''}:${f.consec}`;
        const p = uniq.get(k);
        if (!p || (prio[f.estado] || 0) > (prio[p.estado] || 0)) uniq.set(k, f);
    });
    const txs = [...uniq.values()];

    const posPorDia = {};
    (stats || []).forEach(s => { posPorDia[s.fecha] = { real: s.por_nit?.real?.transacciones || 0, gen: s.por_nit?.generico?.transacciones || 0 }; });

    const synPorDia = {};
    txs.forEach(f => {
        const d = (f.fecha_factura || '').slice(0, 10);
        const esG = (f.cliente_nit || '').trim() === '222222222222';
        if (!synPorDia[d]) synPorDia[d] = { real: 0, gen: 0 };
        if (esG) synPorDia[d].gen++; else synPorDia[d].real++;
    });

    console.log('==================================================');
    console.log(`🔎 Rango ${inicio} → ${fin}   POS snapshot vs Sincronizado  (READ-ONLY)`);
    console.log('==================================================');
    console.log('FECHA        POS(real)  Sync(real)   ¿snapshot?');
    let posTot = 0, synTot = 0, sinSnap = 0;
    for (let d = inicio; d <= fin; d = sig(d)) {
        const pos = posPorDia[d];
        const syn = synPorDia[d] || { real: 0 };
        posTot += pos ? pos.real : 0;
        synTot += syn.real;
        if (!pos) sinSnap++;
        console.log(`${d}   ${String(pos ? pos.real : 0).padStart(6)}    ${String(syn.real).padStart(6)}       ${pos ? 'sí' : 'NO ❌ (falta snapshot)'}`);
    }
    console.log('--------------------------------------------------');
    console.log(`TOTAL real:   POS=${posTot}   Sync=${synTot}   (dif ${synTot - posTot})`);
    console.log(`Días sin snapshot POS en el rango: ${sinSnap}`);
    console.log('\n🧪 Solo lectura, no se tocó Siesa.\n');
    process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
