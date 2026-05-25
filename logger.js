// logger.js
// Persistencia estructurada del estado de cada factura procesada/fallida.
// Diseñado para soportar idempotencia y trazabilidad.

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs');
const FILE_PROCESADAS = path.join(LOG_DIR, 'facturas_procesadas.json');
const FILE_PENDIENTES = path.join(LOG_DIR, 'facturas_pendientes.json');
const FILE_ERRORES_MAESTRAS = path.join(LOG_DIR, 'errores_maestras_siesa.txt');

// Asegura que la carpeta logs/ exista.
function ensureDir() {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Lectura segura (devuelve [] si no existe o está corrupto).
function leerJSON(file) {
    try {
        if (!fs.existsSync(file)) return [];
        const txt = fs.readFileSync(file, 'utf8');
        if (!txt.trim()) return [];
        return JSON.parse(txt);
    } catch (e) {
        console.warn(`⚠️ Log corrupto en ${file}, se reinicia. (${e.message})`);
        return [];
    }
}

// Escritura atómica: escribe a .tmp y renombra.
// Si el proceso muere a mitad, el archivo original queda intacto.
function escribirJSON(file, data) {
    ensureDir();
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
}

// Categoriza un error de Siesa en una clase semántica para agrupación.
function categorizarError(detalleSiesa) {
    if (!Array.isArray(detalleSiesa) || detalleSiesa.length === 0) {
        return { categoria: 'OTRO', resumen: 'Error sin detalle' };
    }

    const txt = detalleSiesa.map(d => (d.f_detalle || '') + ' ' + (d.f_valor || '')).join(' | ').toLowerCase();

    if (txt.includes('cliente no existe') || txt.includes('sucursal del cliente')) {
        return { categoria: 'CLIENTE_FALTANTE', resumen: 'Cliente o sucursal no existe en Siesa' };
    }
    if (txt.includes('item sin cantidad') || txt.includes('cantidad disponible')) {
        return { categoria: 'INVENTARIO_INSUFICIENTE', resumen: 'Inventario insuficiente' };
    }
    if (txt.includes('el item') && txt.includes('no existe')) {
        return { categoria: 'ITEM_INEXISTENTE', resumen: 'Item no existe en la maestra de Siesa' };
    }
    if (txt.includes('unidad de medida') && txt.includes('no existe')) {
        return { categoria: 'UM_INEXISTENTE', resumen: 'Unidad de medida no existe en Siesa' };
    }
    if (txt.includes('no existe equivalencia')) {
        return { categoria: 'EQUIVALENCIA_FALTA', resumen: 'Falta equivalencia de inventario/ventas' };
    }
    if (txt.includes('punto de envio')) {
        return { categoria: 'PUNTO_ENVIO_FALTA', resumen: 'Punto de envío no existe' };
    }
    if (txt.includes('valor unitario')) {
        return { categoria: 'DATO_INVALIDO', resumen: 'Valor unitario inválido en línea' };
    }
    if (txt.includes('tama') && txt.includes('permitido')) {
        return { categoria: 'CAMPO_LARGO', resumen: 'Campo excede tamaño permitido' };
    }
    return { categoria: 'OTRO', resumen: detalleSiesa[0]?.f_detalle?.slice(0, 120) || 'Error desconocido' };
}

// Parsea el mensaje crudo de error que devuelve syncVentas a un objeto con detalle.
function parsearError(mensajeRaw) {
    if (!mensajeRaw) return { detalle: [], categoria: 'OTRO', resumen: 'Sin mensaje' };
    try {
        const limpio = mensajeRaw.replace(/^Reintento falló: /, '');
        const obj = JSON.parse(limpio);
        const detalle = obj.detalle || [];
        const cat = categorizarError(detalle);
        return { detalle, ...cat, mensaje_siesa: obj.mensaje || 'Error' };
    } catch (e) {
        return { detalle: [], categoria: 'OTRO', resumen: mensajeRaw.slice(0, 200), mensaje_siesa: null };
    }
}

// ===== API pública =====

// Devuelve el Set de consecs ya procesados con estado OK (para skip de idempotencia).
function obtenerConsecsExitosos() {
    const historial = leerJSON(FILE_PROCESADAS);
    return new Set(historial.filter(r => r.estado === 'OK').map(r => `${r.tipo}:${r.consec}`));
}

// Registra/actualiza el resultado de una factura procesada.
// resultado = { consecutivo, tipo, ok, mensaje }
// meta = { fecha_factura, cliente_nit, items, neto, automatizaciones }
function registrarResultado(resultado, meta = {}) {
    ensureDir();
    const historial = leerJSON(FILE_PROCESADAS);
    const clave = `${resultado.tipo}:${resultado.consecutivo}`;
    const ahora = new Date().toISOString();

    const existente = historial.find(r => `${r.tipo}:${r.consec}` === clave);
    const errorInfo = resultado.ok ? null : parsearError(resultado.mensaje);

    if (existente) {
        existente.estado = resultado.ok ? 'OK' : 'FALLO';
        existente.intentos = (existente.intentos || 1) + 1;
        existente.ultima_corrida = ahora;
        existente.error = errorInfo;
        existente.automatizaciones_aplicadas = meta.automatizaciones || existente.automatizaciones_aplicadas || [];
        if (meta.fecha_factura) existente.fecha_factura = meta.fecha_factura;
        if (meta.cliente_nit) existente.cliente_nit = meta.cliente_nit;
        if (meta.items) existente.items = meta.items;
        if (meta.neto !== undefined) existente.neto = meta.neto;
    } else {
        historial.push({
            consec: resultado.consecutivo,
            tipo: resultado.tipo,
            fecha_factura: meta.fecha_factura || null,
            cliente_nit: meta.cliente_nit || null,
            items: meta.items || null,
            neto: meta.neto || null,
            estado: resultado.ok ? 'OK' : 'FALLO',
            intentos: 1,
            primera_corrida: ahora,
            ultima_corrida: ahora,
            automatizaciones_aplicadas: meta.automatizaciones || [],
            error: errorInfo
        });
    }

    escribirJSON(FILE_PROCESADAS, historial);

    // Actualizar pendientes (solo los FALLO).
    const pendientes = historial.filter(r => r.estado === 'FALLO');
    escribirJSON(FILE_PENDIENTES, pendientes);
}

// Guarda snapshot de una corrida individual con timestamp.
function guardarCorrida(resumen) {
    ensureDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.join(LOG_DIR, `corrida_${stamp}.json`);
    escribirJSON(file, { timestamp: new Date().toISOString(), ...resumen });
    return file;
}

// Genera el reporte de "errores de maestras Siesa" para que contabilidad/inventario actúe.
function generarReporteMaestras() {
    const historial = leerJSON(FILE_PROCESADAS);
    const fallidas = historial.filter(r => r.estado === 'FALLO' && r.error);

    // Agrupar por categoría > valor específico.
    const items = new Set();
    const ums = new Set();
    const equivalencias = new Set();
    const puntosEnvio = new Set();
    const sucursales = new Set();
    const otros = [];

    for (const f of fallidas) {
        for (const d of (f.error.detalle || [])) {
            const txt = (d.f_detalle || '').toLowerCase();
            const val = (d.f_valor || '').trim();
            if (!val) continue;
            if (txt.includes('el item') && txt.includes('no existe')) items.add(val);
            else if (txt.includes('unidad de medida')) ums.add(val);
            else if (txt.includes('no existe equivalencia')) equivalencias.add(val);
            else if (txt.includes('punto de envio')) puntosEnvio.add(val);
            else if (txt.includes('sucursal')) sucursales.add(val);
            else otros.push(`[${f.tipo} ${f.consec}] ${d.f_detalle} (${val})`);
        }
    }

    const lineas = [];
    lineas.push('=================================================');
    lineas.push(' REPORTE DE MAESTRAS FALTANTES EN SIESA QA');
    lineas.push(` Generado: ${new Date().toISOString()}`);
    lineas.push(' Acción: enviar al equipo de contabilidad/inventario');
    lineas.push('=================================================\n');

    lineas.push(`ITEMS QUE NO EXISTEN EN MAESTRA (${items.size}):`);
    [...items].sort().forEach(i => lineas.push(`  - ${i}`));
    lineas.push('');

    lineas.push(`UNIDADES DE MEDIDA QUE NO EXISTEN (${ums.size}):`);
    [...ums].sort().forEach(u => lineas.push(`  - ${u}`));
    lineas.push('');

    lineas.push(`EQUIVALENCIAS FALTANTES (${equivalencias.size}):`);
    [...equivalencias].sort().forEach(e => lineas.push(`  - ${e}`));
    lineas.push('');

    lineas.push(`SUCURSALES FALTANTES (${sucursales.size}):`);
    [...sucursales].sort().forEach(s => lineas.push(`  - ${s}`));
    lineas.push('');

    lineas.push(`PUNTOS DE ENVÍO FALTANTES (${puntosEnvio.size}):`);
    [...puntosEnvio].sort().forEach(p => lineas.push(`  - ${p}`));
    lineas.push('');

    if (otros.length > 0) {
        lineas.push(`OTROS ERRORES (${otros.length}):`);
        otros.forEach(o => lineas.push(`  - ${o}`));
    }

    ensureDir();
    fs.writeFileSync(FILE_ERRORES_MAESTRAS, lineas.join('\n'), 'utf8');
    return FILE_ERRORES_MAESTRAS;
}

module.exports = {
    obtenerConsecsExitosos,
    registrarResultado,
    guardarCorrida,
    generarReporteMaestras,
    categorizarError,
    parsearError,
    LOG_DIR,
    FILE_PROCESADAS,
    FILE_PENDIENTES,
    FILE_ERRORES_MAESTRAS
};
