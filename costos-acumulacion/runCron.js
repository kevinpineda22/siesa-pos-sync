/**
 * runCron.js — Punto de entrada del job diario de AJUSTE DE COSTOS / ACUMULACIÓN.
 *
 * Corre una sola vez al día (GitHub Actions, 9:13pm COT) directamente en el runner.
 *
 * ⚠️ Debe ejecutarse UNA sola vez al día: los Kits no son idempotentes (ver ajusteCostos.js).
 *
 * Variables de entorno:
 *   - CONNI_KEY, CONNI_TOKEN, CIA           (credenciales / compañía)
 *   - COSTOS_ENTORNO   PROD (default) | QA  (entorno de ESCRITURA)
 *   - COSTOS_FECHA     YYYY-MM-DD           (opcional, para reprocesar un día puntual)
 *   - COSTOS_DRY_RUN   true                 (opcional, muestra el payload sin enviar)
 *
 * Salida: exit 0 si todo OK; exit 1 si algún documento falló o hubo error fatal.
 */
require('dotenv').config();
const { ajustarCostos } = require('./ajusteCostos');

(async () => {
    try {
        const res = await ajustarCostos({});

        if (res.dryRun) {
            console.log(`\n🏁 DRY-RUN finalizado. Ajustes detectados=${res.ajustes} | Descartados=${res.descartes}`);
            process.exit(0);
        }

        console.log(`\n🏁 Job finalizado. Ajustes=${res.ajustes} | Documentos=${res.total} | OK=${res.ok} | FALLO=${res.fail} | Descartados=${res.descartes}`);

        if (res.fail > 0) {
            console.error(`❌ ${res.fail} documento(s) rechazados por Siesa -> el job queda en ROJO.`);
            (res.errores || []).forEach((e) => console.error(`   [Bodega ${e.bodega}] ${e.detalle}`));
            process.exit(1);
        }
        if (res.descartes > 0) {
            console.log(`ℹ️ ${res.descartes} ítem(s) descartados (ver detalle arriba). No ponen el job en rojo, pero conviene revisarlos.`);
        }
        process.exit(0);
    } catch (error) {
        console.error('❌ Error fatal en el job de ajuste de costos:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
})();
