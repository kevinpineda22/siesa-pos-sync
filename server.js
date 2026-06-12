require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { syncPOS } = require('./syncPOS');
const { syncVentas } = require('./syncVentas');
const logger = require('./logger');
const reportes = require('./reportes');

const app = express();
const PORT = process.env.PORT || 4000;

// Middlewares
app.use(cors());
app.use(express.json());

// Ruta raíz: health-check
app.get('/', (req, res) => {
    res.status(200).json({
        nombre: 'Siesa POS Sync API',
        estado: 'operacional',
        version: '1.0.0',
        entornos: {
            sincronizar_ventas: { metodo: 'POST', ruta: '/api/sync-ventas' },
            sincronizar_clientes: { metodo: 'POST', ruta: '/api/sync-clientes' },
            logs_facturas: { metodo: 'GET', ruta: '/api/logs' },
            historial_corridas: { metodo: 'GET', ruta: '/api/logs/corridas' },
            resumen_diario: { metodo: 'GET', ruta: '/api/logs/resumen-diario' }
        },
        documentacion: 'https://github.com/kevinpineda22/siesa-pos-sync',
        timestamp: new Date().toISOString()
    });
});

// Helper: lee un JSON del directorio de logs sin reventar si no existe.
// (Ya no se usa localmente, pero se deja por retrocompatibilidad con scripts viejos si los hay)
function leerLog(nombreArchivo) {
    return [];
}

// Endpoints (Rutas)
app.post('/api/sync-clientes', async (req, res) => {
    try {
        console.log('--- 🔄 Recibida petición HTTP para sincronizar clientes ---');
        const result = await syncPOS();
        res.status(200).json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/sync-ventas', async (req, res) => {
    try {
        // Body opcional:
        //   { consecs: ["63951", "63952"] } → reprocesa esos consecs (ignora límite).
        //   { limite: 5 }                   → procesa los próximos 5 (sobrescribe LIMITE_FACTURAS solo esta vez).
        //   { co: "001,003" }              → filtrar por centros de operación.
        //   { caja: "P05,P03" }            → filtrar por tipo de caja/tipo de documento.
        // Si no se envía nada, corre el flujo normal con LIMITE_FACTURAS del .env.
        const consecs = Array.isArray(req.body?.consecs) ? req.body.consecs.filter(Boolean).map(String) : null;
        const limiteRaw = req.body?.limite;
        const limite = Number.isFinite(Number(limiteRaw)) && Number(limiteRaw) > 0
            ? parseInt(limiteRaw, 10)
            : null;
        const co = req.body?.co ? String(req.body.co).trim() : null;
        const caja = req.body?.caja ? String(req.body.caja).trim() : null;

        const opciones = {};
        if (consecs && consecs.length > 0) opciones.consecs = consecs;
        if (limite && !opciones.consecs) opciones.limite = limite; // consecs tiene prioridad
        if (co) opciones.co = co;
        if (caja) opciones.caja = caja;

        if (opciones.consecs) {
            console.log(`--- 🔄 Recibida petición HTTP para reprocesar consecs: ${opciones.consecs.join(', ')} ---`);
        } else if (opciones.limite) {
            console.log(`--- 🔄 Recibida petición HTTP para sincronizar ${opciones.limite} factura(s) ---`);
        } else {
            console.log('--- 🔄 Recibida petición HTTP para sincronizar ventas (modo normal) ---');
        }
        const partesFiltro = [];
        if (opciones.co) partesFiltro.push(`CO=${opciones.co}`);
        if (opciones.caja) partesFiltro.push(`Caja=${opciones.caja}`);
        if (partesFiltro.length > 0) console.log(`   🎯 Filtros: ${partesFiltro.join(', ')}`);

        const result = await syncVentas(opciones);
        res.status(200).json({ success: true, data: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/logs
 * Devuelve el estado consolidado de las corridas para el frontend.
 *
 * Query params opcionales:
 *   - estado=OK|FALLO       → filtra por estado
 *   - tipo=CFZ|CNZ|CPE      → filtra por tipo de documento
 *   - categoria=...         → filtra por categoría de error (CLIENTE_FALTANTE, etc.)
 *   - consec=63951          → trae el detalle de un consec puntual
 *   - limit=50              → máximo de registros a devolver (default 200, sin tope=todos)
 *   - solo_pendientes=1     → equivalente a estado=FALLO (atajo)
 *
 * Respuesta:
 * {
 *   success: true,
 *   resumen: { total, ok, fallo, pendientes_unicos, ultima_corrida },
 *   data: [ ...facturas ],
 *   errores_maestras: "texto plano del reporte para contabilidad"
 * }
 */
app.get('/api/logs', async (req, res) => {
    try {
        const { estado, tipo, categoria, consec, limit, solo_pendientes } = req.query;

        let query = logger.supabase.from('sps_facturas').select('*');

        // Filtros
        if (consec) query = query.eq('consec', consec);
        if (solo_pendientes === '1') query = query.in('estado', ['FALLO', 'SIN_RECAUDO']);
        else if (estado) query = query.eq('estado', estado.toUpperCase());
        if (tipo) query = query.eq('tipo', tipo.toUpperCase());
        if (categoria) query = query.eq('categoria_error', categoria.toUpperCase());

        // Orden y limite
        const max = limit ? parseInt(limit, 10) : 200;
        query = query.order('ultima_corrida', { ascending: false }).limit(isNaN(max) || max <= 0 ? 200 : max);

        const { data: truncadas, error } = await query;
        if (error) throw error;

        // Resumen rápido
        const { count: total } = await logger.supabase.from('sps_facturas').select('*', { count: 'exact', head: true });
        const { count: ok } = await logger.supabase.from('sps_facturas').select('*', { count: 'exact', head: true }).eq('estado', 'OK');
        const { count: fallo } = await logger.supabase.from('sps_facturas').select('*', { count: 'exact', head: true }).eq('estado', 'FALLO');
        const { count: sinRecaudo } = await logger.supabase.from('sps_facturas').select('*', { count: 'exact', head: true }).eq('estado', 'SIN_RECAUDO');
        
        const { data: ultima } = await logger.supabase.from('sps_facturas').select('ultima_corrida').order('ultima_corrida', { ascending: false }).limit(1).single();

        const resumen = {
            total: total || 0,
            ok: ok || 0,
            fallo: fallo || 0,
            sin_recaudo: sinRecaudo || 0,
            pendientes_unicos: (fallo || 0) + (sinRecaudo || 0),
            ultima_corrida: ultima ? ultima.ultima_corrida : ''
        };

        // Reporte de maestras
        const { data: maestras } = await logger.supabase.from('sps_errores_maestras').select('*').order('fecha', { ascending: false });
        let erroresMaestras = 'Reporte de Maestras Faltantes en Siesa\\n===============================\\n';
        if (maestras && maestras.length > 0) {
            erroresMaestras += maestras.map(m => `[${new Date(m.fecha).toLocaleDateString()}] ${m.consec ? '('+m.consec+') ' : ''}${m.mensaje}`).join('\\n');
        }

        res.status(200).json({
            success: true,
            resumen,
            count: truncadas.length,
            data: truncadas,
            errores_maestras: erroresMaestras
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/logs/corridas
 * Lista los snapshots de corridas individuales (archivos corrida_*.json).
 */
app.get('/api/logs/corridas', async (req, res) => {
    try {
        const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
        const { data, error } = await logger.supabase
            .from('sps_corridas')
            .select('*')
            .order('fecha', { ascending: false })
            .limit(limit);

        if (error) throw error;

        // Formatear para que el frontend lo lea igual (espera {archivo, total, ok, fail, ...})
        const dataFormateada = data.map(c => ({
            archivo: `corrida_${new Date(c.fecha).toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`,
            ...c
        }));

        res.status(200).json({ success: true, count: dataFormateada.length, data: dataFormateada });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/logs/resumen-diario
 * Resumen agregado por día: total de transacciones POS, estado de sincronización,
 * desglose por caja y por tipo de NIT (genérico 2222222222 vs clientes reales).
 *
 * Combina dos fuentes:
 *   - Connekta (query stats) → total de transacciones POS por caja/tipo NIT
 *   - sps_facturas (Supabase) → estado de sincronización (OK/FALLO)
 *
 * Query params:
 *   - fecha=YYYY-MM-DD  (opcional, por defecto hoy)
 *   - caja=Z01|Z02     (opcional, filtra por caja)
 *
 * Respuesta:
 * {
 *   success: true,
 *   fecha: "2026-06-11",
 *   total_pos: 148,          // transacciones reales en POS (desde Connekta)
 *   total_sync: 14,          // transacciones únicas procesadas (desde sps_facturas, deduplicadas)
 *   ok: 14,
 *   fallo: 0,
 *   sin_recaudo: 0,
 *   neto_total: 625112,
 *   por_caja: { "Z01": { transacciones: 80, neto: 350000 }, ... },
 *   por_nit:  { generico: { transacciones: 120, neto: 500000, etiqueta: "2222222222" },
 *               real:     { transacciones: 28,  neto: 125112, etiqueta: "Clientes reales" } }
 * }
 */
app.get('/api/logs/resumen-diario', async (req, res) => {
    try {
        const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
        const fecha = req.query.fecha || hoy;
        const filtroCaja = req.query.caja ? req.query.caja.toUpperCase().trim() : null;
        const CIA = process.env.CIA || '7375';
        const queryStats = process.env.QUERY_STATS || 'merkahorro_venta_pos_stats_dev';
        const URL_STATS = `https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=${queryStats}`;
        const esHoy = fecha === hoy;

        // 1) Datos POS (total_pos, por_caja, por_nit, neto_total)
        let posData = null;

        if (esHoy) {
            // Tiempo real desde Connekta — y auto-upsert a sps_estadisticas_diarias
            try {
                const resp = await axios.get(URL_STATS, {
                    headers: {
                        'ConniKey': process.env.CONNI_KEY,
                        'ConniToken': process.env.CONNI_TOKEN
                    }
                });
                let raw = resp.data;
                if (raw.detalle && raw.detalle.Datos) raw = raw.detalle.Datos;
                else if (raw.detalle && raw.detalle.Table) raw = raw.detalle.Table;
                else if (raw.Table) raw = raw.Table;
                const posDocs = Array.isArray(raw) ? raw : [];

                const delDia = posDocs.filter(d => {
                    if (filtroCaja && (d.ID_TIPO_DOCTO || '').toUpperCase() !== filtroCaja) return false;
                    return (d.FECHA_DOCTO || '').split('T')[0] === fecha;
                });

                const totalPos = delDia.length;
                const netoTotal = delDia.reduce((s, d) => s + parseFloat(d.VrNetoDocto || 0), 0);
                const porCaja = {};
                const porNit = {
                    generico: { transacciones: 0, neto: 0, etiqueta: '2222222222' },
                    real: { transacciones: 0, neto: 0, etiqueta: 'Clientes reales' }
                };
                delDia.forEach(d => {
                    const c = d.ID_TIPO_DOCTO || 'SIN_CAJA';
                    if (!porCaja[c]) porCaja[c] = { transacciones: 0, neto: 0 };
                    porCaja[c].transacciones++;
                    porCaja[c].neto += parseFloat(d.VrNetoDocto || 0);
                    const esG = (d.NitTercero || '').trim() === '222222222222';
                    (esG ? porNit.generico : porNit.real).transacciones++;
                    (esG ? porNit.generico : porNit.real).neto += parseFloat(d.VrNetoDocto || 0);
                });

                posData = { total_pos: totalPos, neto_total: netoTotal, por_caja: porCaja, por_nit: porNit };

                // Snapshot en Supabase (lecturas futuras)
                await logger.supabase.from('sps_estadisticas_diarias').upsert({
                    fecha,
                    total_pos: totalPos,
                    neto_total: netoTotal,
                    por_caja: porCaja,
                    por_nit: porNit,
                    actualizado_en: new Date().toISOString()
                }, { onConflict: 'fecha' });
            } catch (e) {
                console.error('⚠️ Error consultando Connekta stats:', e.message);
            }
        } else {
            // Histórico desde sps_estadisticas_diarias
            try {
                const { data: historico } = await logger.supabase
                    .from('sps_estadisticas_diarias')
                    .select('*')
                    .eq('fecha', fecha)
                    .single();
                if (historico) {
                    posData = {
                        total_pos: historico.total_pos,
                        neto_total: historico.neto_total,
                        por_caja: historico.por_caja || {},
                        por_nit: historico.por_nit || {}
                    };
                }
            } catch (_) { /* no encontrado → fallback */ }
        }

        // 2) sps_facturas: estado de sincronización + fallback POS
        let query = logger.supabase
            .from('sps_facturas')
            .select('estado, co, caja, consec, neto, fecha_factura, cliente_nit')
            .eq('fecha_factura', fecha);
        if (filtroCaja) query = query.eq('caja', filtroCaja);
        const { data: facturas, error } = await query;
        if (error) throw error;

        // Deduplicar: cada transacción aparece como CNZ + CFZ → contar como 1
        const unicos = new Map();
        facturas.forEach(f => {
            const key = `${f.co || ''}:${f.caja || ''}:${f.consec}`;
            const prioridad = { 'FALLO': 3, 'SIN_RECAUDO': 2, 'OK': 1 };
            const existe = unicos.get(key);
            if (!existe || prioridad[f.estado] > prioridad[existe.estado]) {
                unicos.set(key, f);
            }
        });
        const transaccionesSync = [...unicos.values()];

        // 3) Fallback: si no hay datos POS, calcular desde sps_facturas
        if (!posData) {
            const totalPos = transaccionesSync.length;
            const netoTotal = transaccionesSync.reduce((s, f) => s + (parseFloat(f.neto) || 0), 0);
            const porCaja = {};
            const porNit = {
                generico: { transacciones: 0, neto: 0, etiqueta: '2222222222' },
                real: { transacciones: 0, neto: 0, etiqueta: 'Clientes reales' }
            };
            transaccionesSync.forEach(f => {
                const c = f.caja || 'SIN_CAJA';
                if (!porCaja[c]) porCaja[c] = { transacciones: 0, neto: 0 };
                porCaja[c].transacciones++;
                porCaja[c].neto += parseFloat(f.neto) || 0;
                const esG = (f.cliente_nit || '').trim() === '222222222222';
                (esG ? porNit.generico : porNit.real).transacciones++;
                (esG ? porNit.generico : porNit.real).neto += parseFloat(f.neto) || 0;
            });
            posData = { total_pos: totalPos, neto_total: netoTotal, por_caja: porCaja, por_nit: porNit };
        }

        res.status(200).json({
            success: true,
            fecha,
            total_pos: posData.total_pos,
            total_sync: transaccionesSync.length,
            ok: transaccionesSync.filter(f => f.estado === 'OK').length,
            fallo: transaccionesSync.filter(f => f.estado === 'FALLO').length,
            sin_recaudo: transaccionesSync.filter(f => f.estado === 'SIN_RECAUDO').length,
            neto_total: posData.neto_total,
            por_caja: posData.por_caja,
            por_nit: posData.por_nit
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// =============================================================================
// ENDPOINTS DE REPORTES
// =============================================================================

/**
 * POST /api/reportes/generar
 * Genera y envía el reporte PDF por correo.
 *
 * Body opcional:
 *   { periodo: 'diario' | 'semanal' }
 *   { fecha_inicio, fecha_fin }  → override de fechas
 *   { destinatarios: [...] }     → override de destinatarios
 *
 * Si no se envía nada, usa la configuración guardada en Supabase.
 */
app.post('/api/reportes/generar', async (req, res) => {
    try {
        const { periodo, fecha_inicio, fecha_fin, destinatarios } = req.body || {};
        console.log('--- 📊 Generando reporte PDF ---');
        const resultado = await reportes.generarYEnviar({
            periodo,
            fechaInicio: fecha_inicio,
            fechaFin: fecha_fin,
            destinatarios,
        });
        res.status(200).json({ success: true, data: resultado });
    } catch (error) {
        console.error('❌ Error generando reporte:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/reportes/config
 * Devuelve la configuración actual de reportes.
 */
app.get('/api/reportes/config', async (req, res) => {
    try {
        const config = await reportes.getConfig();
        res.status(200).json({ success: true, data: config });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/reportes/config
 * Guarda la configuración de reportes.
 *
 * Body:
 *   { destinatarios: ["correo@dominio.com", ...],
 *     programacion: 'diario' | 'semanal',
 *     hora_envio: '08:00',
 *     dia_semana: 1,
 *     activo: true }
 */
app.post('/api/reportes/config', async (req, res) => {
    try {
        const config = await reportes.saveConfig(req.body);
        console.log('--- 💾 Configuración de reportes guardada ---');
        res.status(200).json({ success: true, data: config });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/reportes/historial
 * Devuelve el historial de reportes enviados.
 */
app.get('/api/reportes/historial', async (req, res) => {
    try {
        const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
        const historial = await reportes.getHistorial(limit);
        res.status(200).json({ success: true, count: historial.length, data: historial });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Iniciar el servidor (solo en local; en Vercel corre como serverless)
if (!process.env.VERCEL) {
    app.listen(PORT, () => {
        console.log(`=================================================`);
        console.log(`🚀 Servidor API de Integración POS <-> Siesa`);
        console.log(`📡 Corriendo en http://localhost:${PORT}`);
        console.log(`=================================================`);
        console.log(`Rutas disponibles para tu Frontend en React:`);
        console.log(`- POST http://localhost:${PORT}/api/sync-clientes`);
        console.log(`- POST http://localhost:${PORT}/api/sync-ventas`);
        console.log(`- GET  http://localhost:${PORT}/api/logs`);
            console.log(`- GET  http://localhost:${PORT}/api/logs/corridas`);
            console.log(`- GET  http://localhost:${PORT}/api/logs/resumen-diario`);
            console.log(`- POST http://localhost:${PORT}/api/reportes/generar`);
        console.log(`- GET  http://localhost:${PORT}/api/reportes/config`);
        console.log(`- POST http://localhost:${PORT}/api/reportes/config`);
        console.log(`- GET  http://localhost:${PORT}/api/reportes/historial`);
        console.log(`=================================================`);
    });
}

// Exportar la app para Vercel (serverless)
module.exports = app;
