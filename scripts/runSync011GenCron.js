/**
 * runSync011GenCron.js
 *
 * Punto de entrada del job diario del FLUJO 011-GENÉRICOS (GitHub Actions, 9pm COT).
 * Toma las facturas GENÉRICAS (222222222222) del día del CO 011 / caja Z01, muestrea el
 * 10% (determinista distribuido) y las procesa con la mecánica CNZ→CFZ (misma que el flujo
 * normal). NO toca estadísticas ni el flujo normal.
 *
 * Corre directamente en el runner de GitHub Actions (no vía Vercel) para no chocar con el
 * límite serverless. El runner tiene hasta 60 min.
 *
 * Configuración (variables de entorno / GitHub Secrets):
 *   - CONNI_KEY, CONNI_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY, CIA, ENTORNO_SIESA,
 *     CONCURRENCIA, PAGINACION_CONCURRENCIA, MAX_RONDAS_AJUSTE.
 *   - MUESTRA_PORCENTAJE_011 (opcional, default 10).
 *   - MUESTRA_FECHA_011 (opcional, YYYY-MM-DD, para reprocesar un día puntual en pruebas).
 *   - MUESTRA_SOLO_CNZ (opcional, "true" para cortar en CNZ en pruebas).
 *
 * Salida: exit 0 si OK; exit 1 si alguna factura quedó en FALLO por ERROR REAL
 * (conexión/desconocido). Los FALLOS por maestras/datos NO ponen el job en rojo.
 */
require('dotenv').config();
const { sync011Gen } = require('../sync011Gen');
const { parsearError } = require('../logger');

// Mismas categorías "no críticas" que el job normal: son FALLOS esperados (maestras/datos/
// reglas de negocio) que quedan visibles en el dashboard pero NO ponen el job en rojo.
const CAT_NO_CRITICAS = new Set([
    'CLIENTE_FALTANTE', 'INVENTARIO_INSUFICIENTE', 'ITEM_INEXISTENTE',
    'UM_INEXISTENTE', 'EQUIVALENCIA_FALTA', 'PUNTO_ENVIO_FALTA',
    'DATO_INVALIDO', 'CAMPO_LARGO', 'PERIODO_CERRADO'
]);

(async () => {
    console.log('==================================================');
    console.log('🌙 JOB 011 GENÉRICOS → Siesa (diario 9pm COT)');
    console.log(`   Entorno escritura=${process.env.ENTORNO_SIESA_011 || 'QA'} (default QA) | Muestreo=${process.env.MUESTRA_PORCENTAJE_011 || '10'}%`);
    if (process.env.MUESTRA_FECHA_011) console.log(`   Fecha forzada=${process.env.MUESTRA_FECHA_011}`);
    console.log('==================================================');

    try {
        const res = await sync011Gen({});
        const fail = res && typeof res.fail === 'number' ? res.fail : 0;
        const ok = res && typeof res.ok === 'number' ? res.ok : 0;
        const total = res && typeof res.total === 'number' ? res.total : 0;
        console.log(`\n🏁 Job finalizado. Muestra=${res?.muestra ?? 0}/${res?.genericasDia ?? 0} | Total=${total} | OK=${ok} | FALLO=${fail}`);

        // Rojo solo ante ERRORES REALES (conexión/desconocido), no por FALLOS de maestras/datos.
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
        console.error('❌ Error fatal en el job 011-gen:', e.message);
        console.error(e.stack);
        process.exit(1);
    }
})();
