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
        const nits = Array.isArray(req.body?.nits) ? req.body.nits.filter(Boolean).map(String).map(s => s.trim()).filter(Boolean) : null;
        if (nits && nits.length > 0) {
            console.log(`--- 🔄 Recibida petición HTTP para sincronizar ${nits.length} cliente(s) específico(s): ${nits.join(', ')} ---`);
        } else {
            console.log('--- 🔄 Recibida petición HTTP para sincronizar clientes (todos los pendientes) ---');
        }
        const result = await syncPOS(nits);
        if (result && result.success === false) {
            return res.status(500).json(result);
        }
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
        const { estado, tipo, categoria, consec, limit, solo_pendientes, fecha_desde, fecha_hasta } = req.query;

        let query = logger.supabase.from('sps_facturas').select('*');

        // Filtros
        if (consec) query = query.eq('consec', consec);
        if (solo_pendientes === '1') query = query.in('estado', ['FALLO', 'SIN_RECAUDO']);
        else if (estado) query = query.eq('estado', estado.toUpperCase());
        if (tipo) query = query.eq('tipo', tipo.toUpperCase());
        if (categoria) query = query.eq('categoria_error', categoria.toUpperCase());
        if (fecha_desde) query = query.gte('fecha_factura', fecha_desde);
        if (fecha_hasta) query = query.lte('fecha_factura', fecha_hasta);

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
        const fechaInicio = req.query.fechaInicio || req.query.fecha || hoy;
        const fechaFin = req.query.fechaFin || req.query.fecha || hoy;
        const filtroCaja = req.query.caja ? req.query.caja.toUpperCase().trim() : null;
        const esRango = fechaInicio !== fechaFin;
        const CIA = process.env.CIA || '7375';
        const queryStats = process.env.QUERY_STATS || 'merkahorro_venta_pos_stats_dev';
        const URL_STATS = `https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=${queryStats}`;

        // 1) Datos POS (total_pos, por_caja, por_nit, neto_total)
        let posData = null;

        if (!esRango && fechaInicio === hoy) {
            // Día único = hoy: tiempo real desde Connekta + auto-upsert
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
                    return (d.FECHA_DOCTO || '').split('T')[0] === fechaInicio;
                });

                const totalPos = delDia.length;
                const netoTotal = delDia.reduce((s, d) => s + parseFloat(d.VrNetoDocto || 0), 0);
                const porCaja = {};
                const porNit = {
                    generico: { transacciones: 0, neto: 0, etiqueta: '2222222222' },
                    sinNit: { transacciones: 0, neto: 0, etiqueta: 'Sin NIT' },
                    real: { transacciones: 0, neto: 0, etiqueta: 'Clientes reales' }
                };
                delDia.forEach(d => {
                    const c = d.ID_TIPO_DOCTO || 'SIN_CAJA';
                    if (!porCaja[c]) porCaja[c] = { transacciones: 0, neto: 0 };
                    porCaja[c].transacciones++;
                    porCaja[c].neto += parseFloat(d.VrNetoDocto || 0);
                    const nit = (d.NitTercero || '').trim();
                    const esG = nit === '222222222222';
                    const esSinNIT = !d.NitTercero;
                    if (esSinNIT) {
                        porNit.sinNit.transacciones++;
                        porNit.sinNit.neto += parseFloat(d.VrNetoDocto || 0);
                    }
                    (esG || esSinNIT ? porNit.generico : porNit.real).transacciones++;
                    (esG || esSinNIT ? porNit.generico : porNit.real).neto += parseFloat(d.VrNetoDocto || 0);
                });

                posData = { total_pos: totalPos, neto_total: netoTotal, por_caja: porCaja, por_nit: porNit };

                await logger.supabase.from('sps_estadisticas_diarias').upsert({
                    fecha: fechaInicio,
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
            // Histórico desde sps_estadisticas_diarias (día único pasado o rango)
            const fechasAConsultar = [];
            if (esRango) {
                // Si el rango incluye hoy, obtener Connekta para hoy y agregarlo
                if (fechaInicio <= hoy && fechaFin >= hoy) {
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
                            return (d.FECHA_DOCTO || '').split('T')[0] === hoy;
                        });

                        const totalPos = delDia.length;
                        const netoTotal = delDia.reduce((s, d) => s + parseFloat(d.VrNetoDocto || 0), 0);
                        const porCaja = {};
                        const porNit = {
                            generico: { transacciones: 0, neto: 0, etiqueta: '2222222222' },
                            sinNit: { transacciones: 0, neto: 0, etiqueta: 'Sin NIT' },
                            real: { transacciones: 0, neto: 0, etiqueta: 'Clientes reales' }
                        };
                        delDia.forEach(d => {
                            const c = d.ID_TIPO_DOCTO || 'SIN_CAJA';
                            if (!porCaja[c]) porCaja[c] = { transacciones: 0, neto: 0 };
                            porCaja[c].transacciones++;
                            porCaja[c].neto += parseFloat(d.VrNetoDocto || 0);
                            const nit = (d.NitTercero || '').trim();
                            const esG = nit === '222222222222';
                            const esSinNIT = !d.NitTercero;
                            if (esSinNIT) {
                                porNit.sinNit.transacciones++;
                                porNit.sinNit.neto += parseFloat(d.VrNetoDocto || 0);
                            }
                            (esG || esSinNIT ? porNit.generico : porNit.real).transacciones++;
                            (esG || esSinNIT ? porNit.generico : porNit.real).neto += parseFloat(d.VrNetoDocto || 0);
                        });

                        posData = { total_pos: totalPos, neto_total: netoTotal, por_caja: porCaja, por_nit: porNit };

                        await logger.supabase.from('sps_estadisticas_diarias').upsert({
                            fecha: hoy,
                            total_pos: totalPos,
                            neto_total: netoTotal,
                            por_caja: porCaja,
                            por_nit: porNit,
                            actualizado_en: new Date().toISOString()
                        }, { onConflict: 'fecha' });
                    } catch (e) {
                        console.error('⚠️ Error consultando Connekta stats para hoy:', e.message);
                    }
                }

                // Consultar sps_estadisticas_diarias para el rango (excluyendo hoy si ya se consultó)
                let historicos = [];
                try {
                    let query = logger.supabase
                        .from('sps_estadisticas_diarias')
                        .select('*')
                        .gte('fecha', fechaInicio);
                    if (posData) {
                        query = query.lt('fecha', hoy);
                    } else {
                        query = query.lte('fecha', fechaFin);
                    }
                    const { data: snapData } = await query;
                    historicos = snapData || [];
                    if (historicos.length > 0) {
                        const agregado = {
                            total_pos: 0,
                            neto_total: 0,
                            por_caja: {},
                            por_nit: {
                                generico: { transacciones: 0, neto: 0, etiqueta: '2222222222' },
                                sinNit: { transacciones: 0, neto: 0, etiqueta: 'Sin NIT' },
                                real: { transacciones: 0, neto: 0, etiqueta: 'Clientes reales' }
                            }
                        };
                        historicos.forEach(h => {
                            agregado.total_pos += h.total_pos || 0;
                            agregado.neto_total += h.neto_total || 0;
                            const cajas = h.por_caja || {};
                            Object.keys(cajas).forEach(c => {
                                if (!agregado.por_caja[c]) agregado.por_caja[c] = { transacciones: 0, neto: 0 };
                                agregado.por_caja[c].transacciones += cajas[c].transacciones || 0;
                                agregado.por_caja[c].neto += cajas[c].neto || 0;
                            });
                            const nit = h.por_nit || {};
                            if (nit.generico) {
                                agregado.por_nit.generico.transacciones += nit.generico.transacciones || 0;
                                agregado.por_nit.generico.neto += nit.generico.neto || 0;
                            }
                            if (nit.sinNit) {
                                agregado.por_nit.sinNit.transacciones += nit.sinNit.transacciones || 0;
                                agregado.por_nit.sinNit.neto += nit.sinNit.neto || 0;
                            }
                            if (nit.real) {
                                agregado.por_nit.real.transacciones += nit.real.transacciones || 0;
                                agregado.por_nit.real.neto += nit.real.neto || 0;
                            }
                        });
                        // Si hoy ya se consultó via Connekta, sumar
                        if (posData) {
                            agregado.total_pos += posData.total_pos;
                            agregado.neto_total += posData.neto_total;
                            Object.keys(posData.por_caja).forEach(c => {
                                if (!agregado.por_caja[c]) agregado.por_caja[c] = { transacciones: 0, neto: 0 };
                                agregado.por_caja[c].transacciones += posData.por_caja[c].transacciones || 0;
                                agregado.por_caja[c].neto += posData.por_caja[c].neto || 0;
                            });
                            agregado.por_nit.generico.transacciones += posData.por_nit.generico.transacciones || 0;
                            agregado.por_nit.generico.neto += posData.por_nit.generico.neto || 0;
                            agregado.por_nit.sinNit.transacciones += posData.por_nit.sinNit?.transacciones || 0;
                            agregado.por_nit.sinNit.neto += posData.por_nit.sinNit?.neto || 0;
                            agregado.por_nit.real.transacciones += posData.por_nit.real.transacciones || 0;
                            agregado.por_nit.real.neto += posData.por_nit.real.neto || 0;
                        }
                        posData = agregado;
                    }
                } catch (_) { /* no encontrado → fallback */ }

                // Rellenar días sin snapshot con sps_facturas (solo clientes reales)
                if (esRango && posData) {
                    const fechasSnap = new Set(historicos.map(h => h.fecha));
                    const diasFaltantes = [];
                    let iter = new Date(fechaInicio + 'T12:00:00');
                    const end = new Date(fechaFin + 'T12:00:00');
                    while (iter <= end) {
                        const dia = iter.toLocaleDateString('en-CA');
                        if (!fechasSnap.has(dia) && dia !== hoy) diasFaltantes.push(dia);
                        iter.setDate(iter.getDate() + 1);
                    }
                    if (diasFaltantes.length > 0) {
                        try {
                            const { data: faltantes } = await logger.supabase
                                .from('sps_facturas')
                                .select('estado, co, caja, consec, neto, fecha_factura, cliente_nit')
                                .in('fecha_factura', diasFaltantes);
                            if (faltantes && faltantes.length > 0) {
                                const unicos = new Map();
                                faltantes.forEach(f => {
                                    const key = `${f.co || ''}:${f.caja || ''}:${f.consec}`;
                                    const prioridad = { 'FALLO': 3, 'SIN_RECAUDO': 2, 'OK': 1 };
                                    const existe = unicos.get(key);
                                    if (!existe || prioridad[f.estado] > prioridad[existe.estado]) {
                                        unicos.set(key, f);
                                    }
                                });
                                const trans = [...unicos.values()];
                                const reales = trans.filter(f => (f.cliente_nit || '').trim() !== '222222222222');
                                if (reales.length > 0) {
                                    posData.total_pos += reales.length;
                                    const netoReal = reales.reduce((s, f) => s + (parseFloat(f.neto) || 0), 0);
                                    posData.neto_total += netoReal;
                                    posData.por_nit.real.transacciones += reales.length;
                                    posData.por_nit.real.neto += netoReal;
                                    reales.forEach(f => {
                                        const c = f.caja || 'SIN_CAJA';
                                        if (!posData.por_caja[c]) posData.por_caja[c] = { transacciones: 0, neto: 0 };
                                        posData.por_caja[c].transacciones++;
                                        posData.por_caja[c].neto += parseFloat(f.neto) || 0;
                                    });
                                }
                            }
                        } catch (_) { /* fallback silencioso */ }
                    }
                }
            } else {
                // Día único pasado
                try {
                    const { data: historico } = await logger.supabase
                        .from('sps_estadisticas_diarias')
                        .select('*')
                        .eq('fecha', fechaInicio)
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
        }

        // 2) sps_facturas: estado de sincronización + fallback POS
        let query = logger.supabase
            .from('sps_facturas')
            .select('estado, co, caja, consec, neto, fecha_factura, cliente_nit')
            .gte('fecha_factura', fechaInicio)
            .lte('fecha_factura', fechaFin);
        if (filtroCaja) query = query.eq('caja', filtroCaja);
        const { data: facturas, error } = await query;
        if (error) throw error;

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

        const netoSync = transaccionesSync.reduce((s, f) => s + (parseFloat(f.neto) || 0), 0);
        const porNitSync = {
            generico: { transacciones: 0, neto: 0, etiqueta: '2222222222' },
            sinNit: { transacciones: 0, neto: 0, etiqueta: 'Sin NIT' },
            real: { transacciones: 0, neto: 0, etiqueta: 'Clientes reales' }
        };
        transaccionesSync.forEach(f => {
            const nit = (f.cliente_nit || '').trim();
            const esG = nit === '222222222222';
            const esSinNIT = !f.cliente_nit;
            if (esSinNIT) {
                porNitSync.sinNit.transacciones++;
                porNitSync.sinNit.neto += parseFloat(f.neto) || 0;
            }
            (esG || esSinNIT ? porNitSync.generico : porNitSync.real).transacciones++;
            (esG || esSinNIT ? porNitSync.generico : porNitSync.real).neto += parseFloat(f.neto) || 0;
        });

        // 3) Fallback: si no hay datos POS, calcular desde sps_facturas
        if (!posData) {
            const totalPos = transaccionesSync.length;
            const porCaja = {};
            transaccionesSync.forEach(f => {
                const c = f.caja || 'SIN_CAJA';
                if (!porCaja[c]) porCaja[c] = { transacciones: 0, neto: 0 };
                porCaja[c].transacciones++;
                porCaja[c].neto += parseFloat(f.neto) || 0;
            });
            posData = { total_pos: totalPos, neto_total: netoSync, por_caja: porCaja, por_nit: porNitSync };
        }

        // 3b) Si hay filtro de caja activo, recalcular POS data para reflejar SOLO esa caja
        if (filtroCaja) {
            const cajaSel = posData.por_caja?.[filtroCaja];
            if (cajaSel) {
                // Recalcular total_pos y neto_total desde la caja seleccionada
                posData.total_pos = cajaSel.transacciones || 0;
                posData.neto_total = cajaSel.neto || 0;
                posData.por_caja = { [filtroCaja]: cajaSel };
                // Recalcular por_nit desde sps_facturas (filtrada por caja) como aproximación POS
                const totalReal = porNitSync.real?.transacciones || 0;
                const netoReal = porNitSync.real?.neto || 0;
                const totalGen = porNitSync.generico?.transacciones || 0;
                const netoGen = porNitSync.generico?.neto || 0;
                const totalSinNIT = porNitSync.sinNit?.transacciones || 0;
                const netoSinNIT = porNitSync.sinNit?.neto || 0;
                posData.por_nit = {
                    generico: { transacciones: totalGen, neto: netoGen, etiqueta: '2222222222' },
                    sinNit: { transacciones: totalSinNIT, neto: netoSinNIT, etiqueta: 'Sin NIT' },
                    real: { transacciones: totalReal, neto: netoReal, etiqueta: 'Clientes reales' }
                };
            } else {
                // La caja no tiene datos en el rango → todo en cero
                posData.total_pos = 0;
                posData.neto_total = 0;
                posData.por_caja = {};
                posData.por_nit = {
                    generico: { transacciones: 0, neto: 0, etiqueta: '2222222222' },
                    sinNit: { transacciones: 0, neto: 0, etiqueta: 'Sin NIT' },
                    real: { transacciones: 0, neto: 0, etiqueta: 'Clientes reales' }
                };
            }
        }

        res.status(200).json({
            success: true,
            fecha: esRango ? `${fechaInicio}—${fechaFin}` : fechaInicio,
            fecha_inicio: fechaInicio,
            fecha_fin: fechaFin,
            total_pos: posData.total_pos,
            total_sync: transaccionesSync.length,
            ok: transaccionesSync.filter(f => f.estado === 'OK').length,
            fallo: transaccionesSync.filter(f => f.estado === 'FALLO').length,
            sin_recaudo: transaccionesSync.filter(f => f.estado === 'SIN_RECAUDO').length,
            neto_total: posData.neto_total,
            neto_sync: netoSync,
            por_caja: posData.por_caja,
            por_nit: posData.por_nit,
            por_nit_sync: porNitSync
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

/**
 * GET /api/logs/estadisticas
 * Devuelve el detalle día por día de sps_estadisticas_diarias para un rango.
 * Query params: fechaInicio (YYYY-MM-DD), fechaFin (YYYY-MM-DD)
 */
app.get('/api/logs/estadisticas', async (req, res) => {
    try {
        const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
        const fechaInicio = req.query.fechaInicio || hoy;
        const fechaFin = req.query.fechaFin || hoy;
        let query = logger.supabase
            .from('sps_estadisticas_diarias')
            .select('*')
            .gte('fecha', fechaInicio)
            .lte('fecha', fechaFin)
            .order('fecha', { ascending: true });
        const { data, error } = await query;
        if (error) throw error;
        res.status(200).json({ success: true, data: data || [] });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/logs/ajustes
 * Devuelve todos los ajustes de inventario (CPE) aplanados.
 * Cada cpe_item se convierte en una fila independiente con datos de la factura.
 */
app.get('/api/logs/ajustes', async (req, res) => {
    try {
        const { data, error } = await logger.supabase
            .from('sps_facturas')
            .select('consec, tipo, co, caja, fecha_factura, cpe_items')
            .not('cpe_items', 'is', null)
            .order('ultima_corrida', { ascending: false })
            .limit(500);
        if (error) throw error;

        const filas = (data || []).flatMap(f =>
            (f.cpe_items || []).map(item => ({
                consec: f.consec,
                tipo: f.tipo,
                co: f.co,
                caja: f.caja,
                fecha: f.fecha_factura,
                item: item.item,
                bodega: item.bodega,
                cantidad: item.cantidad,
                un: item.un,
                costo: item.costo
            }))
        );

        res.status(200).json({ success: true, count: filas.length, data: filas });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/logs/resumen-impuestos
 * Devuelve el agregado de impuestos por llave (IV02, IV03, ICO, etc.) para un rango de fechas.
 * También incluye el total base (neto antes de impuestos).
 *
 * Query params: fechaInicio (YYYY-MM-DD), fechaFin (YYYY-MM-DD)
 *
 * Respuesta:
 * {
 *   success: true,
 *   totalBase: 12345678,           // Suma de netos de facturas con impuestos
 *   totalImpuestos: 2345678,       // Suma de todos los VALOR_TOTAL
 *   totalFacturas: 123,            // Facturas que contribuyeron
 *   porLlave: [
 *     { llave: "IV03", descripcion: "IVA 19% BIENES", valorTotal: 1234567, baseGravable: 6500000, count: 45 },
 *     ...
 *   ]
 * }
 */
app.get('/api/logs/resumen-impuestos', async (req, res) => {
    try {
        const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
        const fechaInicio = req.query.fechaInicio || req.query.fecha || hoy;
        const fechaFin = req.query.fechaFin || req.query.fecha || hoy;

        // Junio 2026 se sirve EXCLUSIVAMENTE desde sps_impuestos_offline
        const esSoloJunio = fechaInicio >= '2026-06-01' && fechaFin <= '2026-06-30';

        const DESCRIPCIONES = {
            'IV02': 'IVA 5% BIENES',
            'IV03': 'IVA 19% BIENES',
            'IV04': 'IVA 19% SERVICIOS',
            'IV05': 'IVA 19% HONORARIOS',
            'IV06': 'IVA 19% ARRENDAMIENTOS',
            'IV07': 'IVA 19% CERVEZA',
            'IV08': 'IVA DEL 19% EN GASEOSAS',
            'ICO': 'IMPUESTO AL CONSUMO'
        };

        const porLlave = {};
        let totalBase = 0;
        let totalFacturas = 0;
        let totalDocumentos = 0;

        if (esSoloJunio) {
            // --- MODO JUNIO: solo sps_impuestos_offline ---
            const { data: offline, error } = await logger.supabase
                .from('sps_impuestos_offline')
                .select('total_base, total_impuestos, total_facturas, por_llave')
                .gte('fecha', fechaInicio)
                .lte('fecha', fechaFin);

            if (error) throw error;

            (offline || []).forEach(o => {
                totalBase += parseFloat(o.total_base) || 0;
                totalFacturas += o.total_facturas || 0;

                if (o.por_llave && typeof o.por_llave === 'object') {
                    Object.entries(o.por_llave).forEach(([llave, datos]) => {
                        if (!porLlave[llave]) {
                            porLlave[llave] = {
                                llave,
                                descripcion: DESCRIPCIONES[llave] || llave,
                                valorTotal: 0,
                                baseGravable: 0,
                                count: 0
                            };
                        }
                        porLlave[llave].valorTotal += parseFloat(datos.valorTotal) || 0;
                        porLlave[llave].baseGravable += parseFloat(datos.baseGravable) || 0;
                        porLlave[llave].count += datos.count || 0;
                    });
                }
            });

            totalDocumentos = totalFacturas;
        } else {
            // --- MODO NORMAL: solo sps_facturas ---
            const { data, error } = await logger.supabase
                .from('sps_facturas')
                .select('co, caja, consec, estado, neto, impuestos, fecha_factura')
                .not('impuestos', 'is', null)
                .gte('fecha_factura', fechaInicio)
                .lte('fecha_factura', fechaFin);

            if (error) throw error;

            // Deduplicar
            const PRIORIDAD = { 'FALLO': 3, 'SIN_RECAUDO': 2, 'OK': 1 };
            const unicos = new Map();
            (data || []).forEach(f => {
                const key = `${f.co || ''}:${f.caja || ''}:${f.consec}`;
                const prev = unicos.get(key);
                if (!prev || (PRIORIDAD[f.estado] || 0) > (PRIORIDAD[prev.estado] || 0)) {
                    unicos.set(key, f);
                }
            });
            const facturas = [...unicos.values()];

            facturas.forEach(f => {
                totalBase += parseFloat(f.neto) || 0;
                (f.impuestos || []).forEach(imp => {
                    const llave = imp.ID_LLAVE_IMPUESTO || 'OTROS';
                    if (!porLlave[llave]) {
                        porLlave[llave] = {
                            llave,
                            descripcion: DESCRIPCIONES[llave] || llave,
                            valorTotal: 0,
                            baseGravable: 0,
                            count: 0
                        };
                    }
                    porLlave[llave].valorTotal += parseFloat(imp.VALOR_TOTAL) || 0;
                    porLlave[llave].baseGravable += parseFloat(imp.BASE_GRAVABLE) || 0;
                    porLlave[llave].count++;
                });
            });

            totalFacturas = facturas.length;
            totalDocumentos = (data || []).length;
        }

        const totalImpuestos = Object.values(porLlave).reduce((s, v) => s + v.valorTotal, 0);
        const totalBaseGravable = Object.values(porLlave).reduce((s, v) => s + v.baseGravable, 0);

        res.status(200).json({
            success: true,
            totalImpuestos: Math.round(totalImpuestos),
            totalFacturas,
            totalDocumentos,
            porLlave: Object.values(porLlave).sort((a, b) => b.valorTotal - a.valorTotal)
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/logs/resumen-ajustes
 * Devuelve el resumen agregado de ajustes de inventario (CPE) para un rango de fechas.
 *
 * Query params: fechaInicio (YYYY-MM-DD), fechaFin (YYYY-MM-DD)
 *
 * Respuesta:
 * {
 *   success: true,
 *   totalItems: 45,              // Suma de cantidades de todos los ajustes
 *   totalValor: 12345678,        // Suma de (cantidad * costo) de todos los ajustes
 *   totalProductos: 12,          // Cantidad de ítems únicos ajustados
 *   totalFacturas: 8,            // Facturas que tienen CPE
 *   data: [ ... ]                // Detalle opcional si se necesita
 * }
 */
app.get('/api/logs/resumen-ajustes', async (req, res) => {
    try {
        const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
        const fechaInicio = req.query.fechaInicio || req.query.fecha || hoy;
        const fechaFin = req.query.fechaFin || req.query.fecha || hoy;

        const { data, error } = await logger.supabase
            .from('sps_facturas')
            .select('consec, tipo, co, caja, fecha_factura, cpe_items')
            .not('cpe_items', 'is', null)
            .gte('fecha_factura', fechaInicio)
            .lte('fecha_factura', fechaFin)
            .order('ultima_corrida', { ascending: false });

        if (error) throw error;

        const filas = (data || []).flatMap(f =>
            (f.cpe_items || []).map(item => ({
                consec: f.consec,
                tipo: f.tipo,
                co: f.co,
                caja: f.caja,
                fecha: f.fecha_factura,
                item: item.item,
                bodega: item.bodega,
                cantidad: parseInt(item.cantidad) || 0,
                un: item.un,
                costo: parseFloat(item.costo) || 0,
                valorTotal: (parseInt(item.cantidad) || 0) * (parseFloat(item.costo) || 0)
            }))
        );

        const totalItems = filas.reduce((s, r) => s + r.cantidad, 0);
        const totalValor = filas.reduce((s, r) => s + r.valorTotal, 0);
        const productosUnicos = new Set(filas.map(r => r.item)).size;
        const facturasUnicas = new Set(filas.map(r => r.consec)).size;

        res.status(200).json({
            success: true,
            totalItems,
            totalValor: Math.round(totalValor),
            totalProductos: productosUnicos,
            totalFacturas: facturasUnicas,
            totalFilas: filas.length
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/diagnostico/env
 * Diagnóstico: muestra estado de variables de entorno para notificaciones
 */
app.get('/api/diagnostico/env', (req, res) => {
    res.json({
        NOTIFY_ERROR_EMAILS: process.env.NOTIFY_ERROR_EMAILS ? '✅ configurado' : '❌ VACÍO',
        NOTIFY_CPE_EMAILS: process.env.NOTIFY_CPE_EMAILS ? '✅ configurado' : '❌ VACÍO',
        SMTP_HOST: process.env.SMTP_HOST ? '✅ ' + process.env.SMTP_HOST : '❌ VACÍO',
        SMTP_USER: process.env.SMTP_USER ? '✅ ' + process.env.SMTP_USER.replace(/(.{3}).*(@.*)/, '$1***$2') : '❌ VACÍO',
        VERCEL_ENV: process.env.VERCEL_ENV || '(no Vercel)',
    });
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
        console.log(`- GET  http://localhost:${PORT}/api/logs/ajustes`);
        console.log(`- GET  http://localhost:${PORT}/api/logs/resumen-impuestos`);
        console.log(`- GET  http://localhost:${PORT}/api/logs/resumen-ajustes`);
            console.log(`- POST http://localhost:${PORT}/api/reportes/generar`);
        console.log(`- GET  http://localhost:${PORT}/api/reportes/config`);
        console.log(`- POST http://localhost:${PORT}/api/reportes/config`);
        console.log(`- GET  http://localhost:${PORT}/api/reportes/historial`);
        console.log(`=================================================`);
    });
}

// Exportar la app para Vercel (serverless)
module.exports = app;
