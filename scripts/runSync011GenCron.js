/**
 * runSync011GenCron.js
 *
 * Punto de entrada del job diario del FLUJO GENÉRICOS por CO (GitHub Actions, 11pm COT).
 * Por cada CO de GEN_COS (default "011,012") toma las facturas GENÉRICAS (222222222222) del día
 * (011 → caja Z01; 012 → cajas Z01 y Z02), muestrea el 10% (determinista distribuido) y las
 * procesa con la mecánica CNZ→CFZ (misma que el flujo normal). NO toca estadísticas ni el flujo
 * normal. Los COs corren en SECUENCIA; un fallo en uno no impide correr el siguiente.
 *
 * ⚠️ Corre a las 11pm, después de las transformaciones (pedido de inventarios). Las queries leen
 *    las tablas VIVAS del POS, que solo conservan el día en curso: si el POS ya cerró el día, la
 *    tabla está vacía o parcial y el job procesa 0 o menos facturas (riesgo aceptado).
 *
 * Corre directamente en el runner de GitHub Actions (no vía Vercel) para no chocar con el
 * límite serverless. El runner tiene hasta 90 min.
 *
 * Configuración (variables de entorno / GitHub Secrets):
 *   - CONNI_KEY, CONNI_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY, CIA, ENTORNO_SIESA_011,
 *     CONCURRENCIA, PAGINACION_CONCURRENCIA, MAX_RONDAS_AJUSTE.
 *   - GEN_COS (opcional, default "011,012"): COs genéricos a procesar, separados por coma.
 *   - MUESTRA_PORCENTAJE_011 (opcional, default 10). Aplica a TODOS los COs.
 *   - MUESTRA_FECHA_011 (opcional, YYYY-MM-DD, para reprocesar un día puntual). Aplica a TODOS los COs.
 *   - MUESTRA_SOLO_CNZ (opcional, "true" para cortar en CNZ en pruebas).
 *
 * Salida: exit 0 si OK; exit 1 si alguna factura quedó en FALLO por ERROR REAL
 * (conexión/desconocido) o si algún CO lanzó una excepción. Los FALLOS por maestras/datos
 * NO ponen el job en rojo.
 */
require('dotenv').config();
const { sync011Gen, COS_GEN_SOPORTADOS } = require('../sync011Gen');
const { parsearError } = require('../logger');

// Mismas categorías "no críticas" que el job normal: son FALLOS esperados (maestras/datos/
// reglas de negocio) que quedan visibles en el dashboard pero NO ponen el job en rojo.
const CAT_NO_CRITICAS = new Set([
    'CLIENTE_FALTANTE', 'INVENTARIO_INSUFICIENTE', 'ITEM_INEXISTENTE',
    'UM_INEXISTENTE', 'EQUIVALENCIA_FALTA', 'PUNTO_ENVIO_FALTA',
    'DATO_INVALIDO', 'CAMPO_LARGO', 'PERIODO_CERRADO'
]);

(async () => {
    const cos = (process.env.GEN_COS || '011,012').split(',').map(s => s.trim()).filter(Boolean);

    console.log('==================================================');
    console.log('🌙 JOB GENÉRICOS → Siesa (diario 11pm COT)');
    console.log(`   COs=${cos.join(', ')} | Entorno escritura=${process.env.ENTORNO_SIESA_011 || 'QA'} (default QA) | Muestreo=${process.env.MUESTRA_PORCENTAJE_011 || '10'}%`);
    if (process.env.MUESTRA_FECHA_011) console.log(`   Fecha forzada=${process.env.MUESTRA_FECHA_011}`);
    console.log('==================================================');

    if (cos.length === 0) {
        console.error('❌ GEN_COS no contiene ningún CO.');
        process.exit(1);
    }

    let muestra = 0, genericasDia = 0, total = 0, ok = 0, fail = 0;
    const detalle = [];
    const excepciones = []; // { co, mensaje }

    for (const co of cos) {
        console.log('\n##################################################');
        console.log(`# CO ${co} — GENÉRICOS`);
        console.log('##################################################');

        if (!COS_GEN_SOPORTADOS.includes(co)) {
            console.error(`❌ CO ${co} no soportado (soportados: ${COS_GEN_SOPORTADOS.join(', ')}). Se omite.`);
            excepciones.push({ co, mensaje: 'CO no soportado' });
            continue;
        }

        try {
            const res = await sync011Gen({ co });
            const rFail = res && typeof res.fail === 'number' ? res.fail : 0;
            const rOk = res && typeof res.ok === 'number' ? res.ok : 0;
            const rTotal = res && typeof res.total === 'number' ? res.total : 0;
            console.log(`\n🏁 CO ${co} finalizado. Muestra=${res?.muestra ?? 0}/${res?.genericasDia ?? 0} | Total=${rTotal} | OK=${rOk} | FALLO=${rFail}`);

            muestra += res?.muestra ?? 0;
            genericasDia += res?.genericasDia ?? 0;
            total += rTotal;
            ok += rOk;
            fail += rFail;
            if (res && Array.isArray(res.detalle)) detalle.push(...res.detalle.map(r => ({ ...r, _co: co })));
        } catch (e) {
            // Un CO que falla NO debe impedir que corra el siguiente.
            console.error(`❌ Error fatal en el CO ${co}:`, e.message);
            console.error(e.stack);
            excepciones.push({ co, mensaje: e.message });
        }
    }

    console.log('\n==================================================');
    console.log(`🏁 Job finalizado (COs: ${cos.join(', ')}). Muestra=${muestra}/${genericasDia} | Total=${total} | OK=${ok} | FALLO=${fail}`);
    console.log('==================================================');

    // Rojo solo ante ERRORES REALES (conexión/desconocido) o excepciones de un CO, no por FALLOS de maestras/datos.
    const fallidas = detalle.filter(r => !r.ok);
    const erroresReales = fallidas.filter(r => !CAT_NO_CRITICAS.has(parsearError(r.mensaje).categoria));

    let rojo = false;
    if (excepciones.length > 0) {
        console.error(`❌ ${excepciones.length} CO(s) terminaron con excepción -> el job queda en ROJO: ${excepciones.map(x => `${x.co} (${x.mensaje})`).join('; ')}`);
        rojo = true;
    }
    if (erroresReales.length > 0) {
        console.error(`❌ ${erroresReales.length} factura(s) con ERROR REAL (conexión/desconocido) -> el job queda en ROJO:`);
        erroresReales.forEach(r => console.error(`   [CO ${r._co}] [${r.tipo} ${r.caja ? r.caja + '-' : ''}${r.consecutivo}] categoría=${parsearError(r.mensaje).categoria}`));
        rojo = true;
    }
    if (rojo) process.exit(1);

    if (fail > 0) {
        console.log(`ℹ️ ${fail} factura(s) en FALLO por maestras/datos (esperado, visibles en el dashboard). El job NO se marca en rojo.`);
    }
    process.exit(0);
})();
