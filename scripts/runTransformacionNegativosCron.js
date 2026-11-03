/**
 * runTransformacionNegativosCron.js
 *
 * Entry point of the NEGATIVE INVENTORY TRANSFORMATION job (GitHub Actions, runs after the tocino job).
 * Clears negative stock of destination meat items with ONE CEI (entry) and ONE CSA (exit) document per store
 * (CO + bodega). Siesa "Faltante Inv." rejections are corrected automatically (adjust, then drop lines).
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
 *   - TRANSF_NEG_COS                comma separated CO ids to process (e.g. 005 or 001,005). Empty = every store.
 *                                   Limits planning AND sending (first limited send after enabling the new flow).
 *   - TRANSF_NEG_PERMITIR_DIA_EN_CURSO  'true' skips the 21:30 COT same-day guard (manual early-close run only;
 *                                   ignored when GITHUB_EVENT_NAME is 'schedule'; future dates are still rejected).
 *   - TRANSF_ID_DOCUMENTO, TRANSF_NOMBRE_DOCUMENTO  connector (shared with the tocino job).
 *   - NOTIFY_TRANSF_EMAILS          (or NOTIFY_EMAILS) comma separated list.
 *
 * Requires migration 010 (table sps_transformaciones_negativos_docs). The legacy table is read-only history.
 *
 * Exit 1 (RED) only when: a document is AMBIGUO (new or left in SENDING), a CSA is blocked behind an AMBIGUO CEI,
 * a result/plan could not be saved, the run was aborted, the plan is incomplete, a scheduled run hit a past date,
 * or a SYSTEMIC failure happened (documents were sent and every one ended in a non-Faltante ERROR: auth, connector,
 * payload). A fatal error also exits 1. Everything else exits 0, including novedades (even ALTA): documents
 * rejected or dropped for Faltante reasons, CSAs blocked behind a rejected CEI, skipped destinations. Those are
 * reported in the email and the log, never as a red job (sync-pos.yml only runs after a green job).
 * A date-guard rejection (future date, or today before 21:30 COT) exits 1 without a ERROR_FATAL run record.
 */
require('dotenv').config();
const { transformacionNegativos, registrarCorridaNegativos, ENTORNO } = require('../transformacionNegativos');
const { fechaBogota } = require('../transformacionCarnes');
const { trazaGithub } = require('../corridaTraza');
const { decidirSalidaCron } = require('../transformacionNegativosFlujo');

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
            origen: process.env.GITHUB_EVENT_NAME || 'local',
            ...trazaGithub(process.env)
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
        console.log(`\nJob finished. Date=${res.fecha} | Mode=${res.modo} | Destination lines=${res.destinos} | Documents OK=${res.documentos} | Failures=${res.fallos} | Novedades=${res.alertas.novedades.length} | Aborted=${res.abortada ? 'YES' : 'no'}`);

        const salida = decidirSalidaCron(res);
        for (const m of salida.mensajes) (salida.codigo === 1 ? console.error : console.log)(m);
        process.exit(salida.codigo);
    } catch (e) {
        console.error('Fatal error in the negative transformation job:', e.message);
        console.error(e.stack);
        await registrarErrorFatal(e);
        process.exit(1);
    }
})();
