/**
 * Marca como OK todas las CNZ que fallaron en una fecha específica.
 * Uso: node scripts/marcarCNZOk.js [fecha]
 * Por defecto marca las del 2026-08-18.
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const FECHA = process.argv[2] || '2026-08-18';

(async () => {
    // 1) Buscar CNZ fallidas de esa fecha
    const { data: fallidas, error: selErr } = await supabase
        .from('sps_facturas')
        .select('id, consec, co, caja, estado, intentos, neto, cliente_nit, fecha_factura')
        .eq('tipo', 'CNZ')
        .eq('estado', 'FALLO')
        .eq('fecha_factura', FECHA);

    if (selErr) { console.error('❌ Error leyendo:', selErr.message); process.exit(1); }
    if (!fallidas || fallidas.length === 0) {
        console.log(`ℹ️ No hay CNZ en estado FALLO para ${FECHA}.`);
        return;
    }

    console.log(`\n📋 CNZ en FALLO para ${FECHA}: ${fallidas.length}\n`);
    fallidas.forEach(f => console.log(`  ${f.id}  |  neto $${f.neto}  |  NIT ${f.cliente_nit}  |  intentos ${f.intentos}`));

    // 2) Marcar como OK
    const ids = fallidas.map(f => f.id);
    const { error: updErr } = await supabase
        .from('sps_facturas')
        .update({ estado: 'OK', intentos: 1, ultima_corrida: new Date().toISOString() })
        .in('id', ids);

    if (updErr) { console.error('❌ Error actualizando:', updErr.message); process.exit(1); }
    console.log(`\n✅ ${ids.length} CNZ marcadas como OK.`);
})();
