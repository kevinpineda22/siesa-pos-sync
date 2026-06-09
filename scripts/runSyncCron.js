/**
 * runSyncCron.js
 *
 * Punto de entrada del job automático (GitHub Actions, cada 1 hora).
 * Ejecuta el flujo completo CNZ→CFZ para las facturas de HOY del CO/Caja configurados,
 * procesando TODAS las nuevas y omitiendo las ya procesadas (idempotencia en Supabase).
 *
 * Corre directamente en el runner de GitHub Actions (no vía el endpoint de Vercel), para
 * no chocar con el límite de ejecución serverless. El runner tiene hasta 6h.
 *
 * Configuración (variables de entorno, vienen de GitHub Secrets/Variables o del .env local):
 *   - CO_FILTER     : CO(s) a sincronizar, ej. "001" o "001,003". (Requerido para acotar.)
 *   - CAJA_FILTER   : caja(s)/tipo docto, ej. "P01,P03,P05" o "P05".
 *   - CONNI_KEY, CONNI_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY, CIA, ENTORNO_SIESA,
 *     CONCURRENCIA, PAGINACION_CONCURRENCIA, MAX_RONDAS_AJUSTE.
 *
 * Salida: exit 0 si todo OK; exit 1 si alguna factura quedó en FALLO (para que el run de
 * GitHub Actions se marque como fallido y sea visible en el historial).
 */
require('dotenv').config();
const { syncVentas } = require('../syncVentas');
const { parsearError } = require('../logger');

// Categorías de FALLO que son por DATOS/MAESTRAS o reglas de negocio (esperadas): NO ponen
// el job en rojo, pero quedan visibles en el dashboard. Cualquier otra categoría
// (ERROR_CONEXION_SIESA, OTRO/desconocido) se considera ERROR REAL y sí pone el job en rojo.
const CAT_NO_CRITICAS = new Set([
    'CLIENTE_FALTANTE', 'INVENTARIO_INSUFICIENTE', 'ITEM_INEXISTENTE',
    'UM_INEXISTENTE', 'EQUIVALENCIA_FALTA', 'PUNTO_ENVIO_FALTA',
    'DATO_INVALIDO', 'CAMPO_LARGO', 'PERIODO_CERRADO'
]);

(async () => {
    const co = process.env.CO_FILTER;     // puede venir vacío -> syncVentas cae al fallback de .env
    const caja = process.env.CAJA_FILTER;

    // --- Modo PRUEBA (opcional) ---
    // CRON_LIMITE > 0  -> procesa solo N facturas (las más recientes), en vez de TODAS.
    // CRON_SOLO_HOY="false" -> NO filtra por "hoy" (útil para probar si hoy aún no hay facturas).
    const limiteRaw = parseInt(process.env.CRON_LIMITE || '0', 10);
    const limite = Number.isFinite(limiteRaw) && limiteRaw > 0 ? limiteRaw : null;
    const soloHoy = (process.env.CRON_SOLO_HOY || 'true').toLowerCase() !== 'false';

    const opciones = {};
    if (co) opciones.co = co;
    if (caja) opciones.caja = caja;
    if (soloHoy) opciones.soloHoy = true;
    if (limite) opciones.limite = limite;   // modo prueba: tope de N
    else opciones.todas = true;             // producción: todas las nuevas del día

    console.log('==================================================');
    console.log(limite ? '🧪 JOB DE PRUEBA POS → Siesa' : '🤖 JOB AUTOMÁTICO POS → Siesa (cada 1h)');
    console.log(`   CO=${co || '(default .env)'} | Caja=${caja || '(default .env)'} | soloHoy=${soloHoy} | ${limite ? `limite=${limite}` : 'todas=true'}`);
    console.log(`   Entorno=${process.env.ENTORNO_SIESA || 'QA'}`);
    console.log('==================================================');

    try {
        const res = await syncVentas(opciones);
        const fail = res && typeof res.fail === 'number' ? res.fail : 0;
        const ok = res && typeof res.ok === 'number' ? res.ok : 0;
        const total = res && typeof res.total === 'number' ? res.total : 0;
        console.log(`\n🏁 Job finalizado. Total=${total} | OK=${ok} | FALLO=${fail}`);

        // El job se marca en ROJO solo ante ERRORES REALES (conexión/desconocido), no por
        // FALLOS de maestras/datos (esos son esperados y se ven en el dashboard).
        const fallidas = (res && Array.isArray(res.detalle) ? res.detalle : []).filter(r => !r.ok);
        const erroresReales = fallidas.filter(r => !CAT_NO_CRITICAS.has(parsearError(r.mensaje).categoria));

        if (erroresReales.length > 0) {
            console.error(`❌ ${erroresReales.length} factura(s) con ERROR REAL (conexión/desconocido) -> el job queda en ROJO:`);
            erroresReales.forEach(r => console.error(`   [${r.tipo} ${r.consecutivo}] categoría=${parsearError(r.mensaje).categoria}`));
            process.exit(1);
        }
        if (fail > 0) {
            console.log(`ℹ️ ${fail} factura(s) en FALLO por maestras/datos (esperado, visibles en el dashboard). El job NO se marca en rojo.`);
        }
        process.exit(0);
    } catch (e) {
        console.error('❌ Error fatal en el job:', e.message);
        console.error(e.stack);
        process.exit(1);
    }
})();
