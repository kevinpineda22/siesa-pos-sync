require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { syncPOS } = require('./syncPOS');
const { syncVentas } = require('./syncVentas');
const logger = require('./logger');

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
            historial_corridas: { metodo: 'GET', ruta: '/api/logs/corridas' }
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
        // Si no se envía nada, corre el flujo normal con LIMITE_FACTURAS del .env.
        const consecs = Array.isArray(req.body?.consecs) ? req.body.consecs.filter(Boolean).map(String) : null;
        const limiteRaw = req.body?.limite;
        const limite = Number.isFinite(Number(limiteRaw)) && Number(limiteRaw) > 0
            ? parseInt(limiteRaw, 10)
            : null;

        const opciones = {};
        if (consecs && consecs.length > 0) opciones.consecs = consecs;
        if (limite && !opciones.consecs) opciones.limite = limite; // consecs tiene prioridad

        if (opciones.consecs) {
            console.log(`--- 🔄 Recibida petición HTTP para reprocesar consecs: ${opciones.consecs.join(', ')} ---`);
        } else if (opciones.limite) {
            console.log(`--- 🔄 Recibida petición HTTP para sincronizar ${opciones.limite} factura(s) ---`);
        } else {
            console.log('--- 🔄 Recibida petición HTTP para sincronizar ventas (modo normal) ---');
        }

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
 *   - tipo=CFE|CNC|CPE      → filtra por tipo de documento
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
        if (solo_pendientes === '1' || estado === 'FALLO') query = query.eq('estado', 'FALLO');
        else if (estado === 'OK') query = query.eq('estado', 'OK');
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
        
        const { data: ultima } = await logger.supabase.from('sps_facturas').select('ultima_corrida').order('ultima_corrida', { ascending: false }).limit(1).single();

        const resumen = {
            total: total || 0,
            ok: ok || 0,
            fallo: fallo || 0,
            pendientes_unicos: fallo || 0,
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
        console.log(`=================================================`);
    });
}

// Exportar la app para Vercel (serverless)
module.exports = app;
