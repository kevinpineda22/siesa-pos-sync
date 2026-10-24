/**
 * runTransformacionCron.js
 *
 * Punto de entrada del job diario de TRANSFORMACIÓN TOCINO → CHICHARRÓN (GitHub Actions, 10pm COT).
 * Toma las unidades netas vendidas del ítem 15207 y registra en Siesa la entrada de chicharrón (CEI)
 * y la salida de tocino (CSA) por cada (fecha, CO, bodega).
 *
 * Corre directamente en el runner de GitHub Actions (no vía Vercel).
 *
 * Configuración (variables de entorno / GitHub Secrets):
 *   - CONNI_KEY, CONNI_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY, CIA.
 *   - ENTORNO_SIESA_TRANSF   QA (default) | PROD   (entorno de ESCRITURA de este flujo).
 *   - TRANSF_FECHA           YYYY-MM-DD (opcional, reprocesar un día puntual).
 *   - TRANSF_DRY_RUN         1 | true (opcional, no envía a Siesa ni escribe en Supabase).
 *   - TRANSF_MAPA            JSON con la configuración de transformaciones (opcional).
 *   - TRANSF_ID_DOCUMENTO, TRANSF_NOMBRE_DOCUMENTO, TRANSF_QUERY_VIVO, TRANSF_QUERY_ACUM (opcionales).
 *   - NOTIFY_TRANSF_EMAILS   (o NOTIFY_EMAILS) lista separada por comas.
 *
 * Salida: exit 0 si OK; exit 1 si Siesa rechazó algún documento, no se pudo registrar el
 * resultado, o hubo un error fatal.
 */
require('dotenv').config();
const { transformacionCarnes, registrarCorrida, fechaBogota, ENTORNO } = require('../transformacionCarnes');

// Registra una corrida ERROR_FATAL (best-effort): nunca lanza ni enmascara el error original.
async function registrarErrorFatal(e) {
    try {
        if (['1', 'true'].includes((process.env.TRANSF_DRY_RUN || '').toLowerCase())) return;
        // Rechazo de la guardia de fecha: no es una corrida fallida del flujo.
        if (e && e.codigo === 'VALIDACION_FECHA') return;
        const esFechaValida = (f) => /^\d{4}-\d{2}-\d{2}$/.test(f);
        const forzada = (process.env.TRANSF_FECHA || '').trim();
        const fecha = esFechaValida(forzada) ? forzada : fechaBogota();
        if (!esFechaValida(fecha) || !['QA', 'PROD'].includes(ENTORNO)) return;
        await registrarCorrida({
            fecha,
            entorno: ENTORNO,
            resultado: 'ERROR_FATAL',
            mensaje: String((e && e.message) || e).slice(0, 500),
            origen: process.env.GITHUB_EVENT_NAME || 'local'
        });
    } catch (err) {
        console.warn(`⚠️ No se pudo registrar el error fatal: ${err.message}`);
    }
}

(async () => {
    console.log('==================================================');
    console.log('🌙 JOB TRANSFORMACIÓN TOCINO → CHICHARRÓN (diario 10pm COT)');
    console.log(`   Entorno escritura=${process.env.ENTORNO_SIESA_TRANSF || 'QA'} (default QA)`);
    if (process.env.TRANSF_FECHA) console.log(`   Fecha forzada=${process.env.TRANSF_FECHA}`);
    console.log('==================================================');

    try {
        const res = await transformacionCarnes({});
        console.log(`\n🏁 Job finalizado. Fecha=${res.fecha} | Grupos=${res.grupos} | Unidades=${res.totalUnidades} | Kg=${res.totalKilos} | Con fallo=${res.fallos}`);

        const erroresGuardado = res.alertas.erroresGuardado.length;
        if (res.fallos > 0 || erroresGuardado > 0) {
            console.error(`❌ ${res.fallos} grupo(s) con fallo en Siesa y ${erroresGuardado} error(es) al registrar -> el job queda en ROJO.`);
            process.exit(1);
        }
        if (res.alertas.sinFilas || res.alertas.netoCambiado.length > 0 || res.alertas.noClasificadas.length > 0 || res.alertas.netoNoPositivo.length > 0) {
            console.log('ℹ️ Hay alertas (sin filas / filas no contadas / neto ≤ 0). Revisar el correo y el log. El job NO se marca en rojo.');
        }
        process.exit(0);
    } catch (e) {
        console.error('❌ Error fatal en el job de transformación:', e.message);
        console.error(e.stack);
        await registrarErrorFatal(e);
        process.exit(1);
    }
})();
