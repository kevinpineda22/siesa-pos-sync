/**
 * runTransformacionNegativosCron.js
 *
 * Entry point of the NEGATIVE INVENTORY TRANSFORMATION job (GitHub Actions, runs after the tocino job).
 * Clears negative stock of destination meat items with a CEI (entry) plus CSA (exit) per origin.
 *
 * Runs directly on the GitHub Actions runner (not through Vercel).
 *
 * Configuration (environment variables / GitHub Secrets):
 *   - CONNI_KEY, CONNI_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY, CIA.
 *   - ENTORNO_SIESA_TRANSF          QA (default) | PROD   (write environment of this flow).
 *   - TRANSF_FECHA                  YYYY-MM-DD (optional). A past date runs resume-only.
 *   - TRANSF_DRY_RUN                1 | true (optional, no Siesa POST and no Supabase writes).
 *   - TRANSF_NEG_QUERY_INVENTARIO   Connekta inventory query (default merkahorro_items_inventario_costo_dev_transformaciones).
 *   - TRANSF_NEG_COLUMNAS           JSON column map override (optional).
 *   - TRANSF_NEG_ITEMS_EXCLUIDOS    comma separated items never treated as destinations (default 15207).
 *   - TRANSF_NEG_DIAS_REANUDAR      lookback window in days for resume (default 7).
 *   - TRANSF_NEG_UNIDAD_NEGOCIO     business unit (default 003).
 *   - TRANSF_ID_DOCUMENTO, TRANSF_NOMBRE_DOCUMENTO  connector (shared with the tocino job).
 *   - NOTIFY_TRANSF_EMAILS          (or NOTIFY_EMAILS) comma separated list.
 *
 * Exit: 0 when OK; 1 when Siesa rejected/left ambiguous a document, a result could not be saved,
 * a destination is blocked pending manual review, or a fatal error happened.
 * A date-guard rejection (future date, or today before 21:30 COT) exits 1 without a ERROR_FATAL run record.
 */
require('dotenv').config();
const { transformacionNegativos, registrarCorridaNegativos, ENTORNO } = require('../transformacionNegativos');
const { fechaBogota } = require('../transformacionCarnes');

// Registers an ERROR_FATAL run (best effort): never throws and never masks the original error.
async function registrarErrorFatal(e) {
    try {
        if (['1', 'true'].includes((process.env.TRANSF_DRY_RUN || '').toLowerCase())) return;
        // Date-guard rejection is not a failed run of the flow.
        if (e && e.codigo === 'VALIDACION_FECHA') return;
        const esFechaValida = (f) => /^\d{4}-\d{2}-\d{2}$/.test(f);
        const forzada = (process.env.TRANSF_FECHA || '').trim();
        const fecha = esFechaValida(forzada) ? forzada : fechaBogota();
        if (!esFechaValida(fecha) || !['QA', 'PROD'].includes(ENTORNO)) return;
        await registrarCorridaNegativos({
            fecha,
            entorno: ENTORNO,
            resultado: 'ERROR_FATAL',
            mensaje: String((e && e.message) || e).slice(0, 500),
            origen: process.env.GITHUB_EVENT_NAME || 'local'
        });
    } catch (err) {
        console.warn(`Could not register the fatal error: ${err.message}`);
    }
}

(async () => {
    console.log('==================================================');
    console.log('JOB NEGATIVE INVENTORY TRANSFORMATION');
    console.log(`   Write environment=${process.env.ENTORNO_SIESA_TRANSF || 'QA'} (default QA)`);
    if (process.env.TRANSF_FECHA) console.log(`   Forced date=${process.env.TRANSF_FECHA}`);
    console.log('==================================================');

    try {
        const res = await transformacionNegativos({});
        const a = res.alertas;
        console.log(`\nJob finished. Date=${res.fecha} | Mode=${res.modo} | Destinations=${res.destinos} | Sent OK=${res.documentos} | Failures=${res.fallos} | Aborted=${res.abortada ? 'YES' : 'no'}`);

        if (res.fallos > 0 || a.erroresGuardado.length > 0 || res.abortada) {
            console.error(`${res.fallos} failure(s), ${a.erroresGuardado.length} save error(s)${res.abortada ? ', run aborted' : ''} -> the job is RED.`);
            process.exit(1);
        }
        if (a.omitidos.length > 0 || a.errores.length > 0 || a.cancelados.length > 0 || a.reintentosDiasPrevios.length > 0 || a.anomalias.length > 0) {
            console.log('There are alerts (skipped, errors, cancelled, prior-day retries, anomalies). Review the email and the log. The job is NOT marked red.');
        }
        process.exit(0);
    } catch (e) {
        console.error('Fatal error in the negative transformation job:', e.message);
        console.error(e.stack);
        await registrarErrorFatal(e);
        process.exit(1);
    }
})();
