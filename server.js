const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { syncPOS } = require('./syncPOS');
const { syncVentas } = require('./syncVentas');
const logger = require('./logger');

const app = express();
const PORT = process.env.PORT || 4000;

// Middlewares
app.use(cors());
app.use(express.json());

// Helper: lee un JSON del directorio de logs sin reventar si no existe.
function leerLog(nombreArchivo) {
    try {
        const ruta = path.join(logger.LOG_DIR, nombreArchivo);
        if (!fs.existsSync(ruta)) return [];
        return JSON.parse(fs.readFileSync(ruta, 'utf8'));
    } catch (err) {
        return [];
    }
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
        console.log('--- 🔄 Recibida petición HTTP para sincronizar ventas ---');
        const result = await syncVentas();
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
app.get('/api/logs', (req, res) => {
    try {
        const { estado, tipo, categoria, consec, limit, solo_pendientes } = req.query;

        let procesadas = leerLog('facturas_procesadas.json');
        const pendientes = leerLog('facturas_pendientes.json');

        // Filtros
        if (consec) {
            procesadas = procesadas.filter(f => String(f.consec) === String(consec));
        }
        if (solo_pendientes === '1' || estado === 'FALLO') {
            procesadas = procesadas.filter(f => f.estado === 'FALLO');
        } else if (estado === 'OK') {
            procesadas = procesadas.filter(f => f.estado === 'OK');
        }
        if (tipo) {
            procesadas = procesadas.filter(f => f.tipo === tipo.toUpperCase());
        }
        if (categoria) {
            procesadas = procesadas.filter(f =>
                (f.categoria_error || '').toUpperCase() === categoria.toUpperCase()
            );
        }

        // Ordena por última corrida descendente (más reciente primero)
        procesadas.sort((a, b) => {
            const fa = new Date(a.ultima_corrida || 0).getTime();
            const fb = new Date(b.ultima_corrida || 0).getTime();
            return fb - fa;
        });

        // Limite
        const max = limit ? parseInt(limit, 10) : 200;
        const truncadas = isNaN(max) || max <= 0 ? procesadas : procesadas.slice(0, max);

        // Resumen rápido
        const todas = leerLog('facturas_procesadas.json');
        const resumen = {
            total: todas.length,
            ok: todas.filter(f => f.estado === 'OK').length,
            fallo: todas.filter(f => f.estado === 'FALLO').length,
            pendientes_unicos: pendientes.length,
            ultima_corrida: todas.reduce((max, f) => {
                const t = f.ultima_corrida || '';
                return t > max ? t : max;
            }, '')
        };

        // Reporte de maestras (texto plano para contabilidad)
        let erroresMaestras = '';
        try {
            const ruta = path.join(logger.LOG_DIR, 'errores_maestras_siesa.txt');
            if (fs.existsSync(ruta)) {
                erroresMaestras = fs.readFileSync(ruta, 'utf8');
            }
        } catch (_) { /* opcional */ }

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
app.get('/api/logs/corridas', (req, res) => {
    try {
        if (!fs.existsSync(logger.LOG_DIR)) {
            return res.status(200).json({ success: true, data: [] });
        }
        const archivos = fs.readdirSync(logger.LOG_DIR)
            .filter(f => f.startsWith('corrida_') && f.endsWith('.json'))
            .sort()
            .reverse(); // más reciente primero

        const limit = req.query.limit ? parseInt(req.query.limit, 10) : 20;
        const seleccion = archivos.slice(0, limit);

        const data = seleccion.map(nombre => {
            try {
                const contenido = JSON.parse(fs.readFileSync(path.join(logger.LOG_DIR, nombre), 'utf8'));
                return { archivo: nombre, ...contenido };
            } catch (_) {
                return { archivo: nombre, error: 'no se pudo parsear' };
            }
        });

        res.status(200).json({ success: true, count: data.length, data });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Iniciar el servidor
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
