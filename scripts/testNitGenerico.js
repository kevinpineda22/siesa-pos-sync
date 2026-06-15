/**
 * testNitGenerico.js — READ-ONLY. Revisa los NIT en sps_facturas para una fecha.
 * Sirve para entender por qué el "Resumen del día" muestra 0 genéricos.
 * Solo LEE Supabase. NO toca Siesa.
 *
 *   node scripts/testNitGenerico.js
 *   NIT_FECHA=2026-06-14 node scripts/testNitGenerico.js
 */
require('dotenv').config();
const logger = require('../logger');

(async () => {
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    const fecha = process.env.NIT_FECHA || hoy;

    const { data, error } = await logger.supabase
        .from('sps_facturas')
        .select('consec, co, caja, tipo, estado, cliente_nit, fecha_factura, neto')
        .eq('fecha_factura', fecha);
    if (error) { console.error('❌', error.message); process.exit(1); }

    console.log('==================================================');
    console.log(`🔎 sps_facturas con fecha_factura = ${fecha}  (READ-ONLY)`);
    console.log('==================================================');
    console.log(`Filas totales (CNZ+CFZ): ${data.length}`);

    // Dedup por co:caja:consec (igual que el backend)
    const unicos = new Map();
    data.forEach(f => {
        const key = `${f.co || ''}:${f.caja || ''}:${f.consec}`;
        if (!unicos.has(key)) unicos.set(key, f);
    });
    const txs = [...unicos.values()];
    console.log(`Transacciones únicas: ${txs.length}\n`);

    const norm = (n) => (n || '').toString().trim();
    const generico12 = txs.filter(f => norm(f.cliente_nit) === '222222222222').length; // 12 doses (lo que compara el código)
    const generico10 = txs.filter(f => norm(f.cliente_nit) === '2222222222').length;   // 10 doses
    const vacios = txs.filter(f => norm(f.cliente_nit) === '').length;

    console.log(`Genéricos detectados como '222222222222' (12 doses, lo que usa el código): ${generico12}`);
    console.log(`Coinciden con '2222222222' (10 doses):                                    ${generico10}`);
    console.log(`Sin cliente_nit (vacío):                                                  ${vacios}\n`);

    // Distribución de NITs (top 25)
    const counts = {};
    txs.forEach(f => { const k = norm(f.cliente_nit) || '(vacío)'; counts[k] = (counts[k] || 0) + 1; });
    console.log('NITs distintos (top 25 por frecuencia):');
    Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 25)
        .forEach(([nit, n]) => console.log(`  ${String(n).padStart(4)}  ${nit}`));

    // ¿Hay NITs que "parecen" genéricos (puros 2) pero no son exactamente 12 doses?
    const pareceGenerico = Object.keys(counts).filter(k => /^2+$/.test(k) && k !== '222222222222');
    if (pareceGenerico.length > 0) {
        console.log('\n⚠️ NITs que parecen genéricos pero NO son 12 doses:');
        pareceGenerico.forEach(k => console.log(`     "${k}" (${k.length} dígitos) -> ${counts[k]} transacción(es)`));
        console.log('   => el código compara contra "222222222222" (12). Si el real tiene otro largo, por eso da 0.');
    }
    console.log('\n🧪 Solo lectura, no se tocó Siesa.\n');
    process.exit(0);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
