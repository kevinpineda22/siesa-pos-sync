const express = require('express');
const cors = require('cors');
const { syncPOS } = require('./syncPOS');
const { syncVentas } = require('./syncVentas');

const app = express();
const PORT = process.env.PORT || 4000;

// Middlewares
app.use(cors());
app.use(express.json());

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

// Iniciar el servidor
app.listen(PORT, () => {
    console.log(`=================================================`);
    console.log(`🚀 Servidor API de Integración POS <-> Siesa`);
    console.log(`📡 Corriendo en http://localhost:${PORT}`);
    console.log(`=================================================`);
    console.log(`Rutas disponibles para tu Frontend en React:`);
    console.log(`- POST http://localhost:${PORT}/api/sync-clientes`);
    console.log(`- POST http://localhost:${PORT}/api/sync-ventas`);
    console.log(`=================================================`);
});
