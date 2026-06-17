const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);

function categorizarError(detalleSiesa) {
    if (!Array.isArray(detalleSiesa) || detalleSiesa.length === 0) {
        return { categoria: 'OTRO', resumen: 'Error sin detalle' };
    }

    const txt = detalleSiesa.map(d => (d.f_detalle || '') + ' ' + (d.f_valor || '')).join(' | ').toLowerCase();

    if (txt.includes('cliente no existe') || txt.includes('sucursal del cliente') || txt.includes('la sucursal de la remisión')) {
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
        return { categoria: 'PUNTO_ENVIO_FALTA', resumen: 'Punto de envio no existe' };
    }
    if (txt.includes('valor unitario')) {
        return { categoria: 'DATO_INVALIDO', resumen: 'Valor unitario invalido en linea' };
    }
    if (txt.includes('tama') && txt.includes('permitido')) {
        return { categoria: 'CAMPO_LARGO', resumen: 'Campo excede tamano permitido' };
    }
    if (txt.includes('la fecha del documento debe estar abierta') || txt.includes('periodo cerrado')) {
        return { categoria: 'PERIODO_CERRADO', resumen: 'La fecha del documento corresponde a un periodo cerrado en Siesa' };
    }
    if (txt.includes('la base de datos no existe')) {
        return { categoria: 'ERROR_CONEXION_SIESA', resumen: 'Siesa PROD caido o DB no existe' };
    }
    if (txt.includes('valor cartera') && txt.includes('valor cxc')) {
        return { categoria: 'CARTERA_CXC', resumen: 'Diferencia cartera vs CxC por redondeo' };
    }
    return { categoria: 'OTRO', resumen: detalleSiesa[0]?.f_detalle?.slice(0, 120) || 'Error desconocido' };
}

function parsearError(mensajeRaw) {
    if (!mensajeRaw) return { detalle: [], categoria: 'OTRO', resumen: 'Sin mensaje' };
    try {
        // El mensaje puede venir con prefijos antes del JSON de Siesa, como
        // "Reintento falló: {...}", "Sin más automatización posible: {...}" o
        // "Agotadas N ronda(s) de automatización: {...}". Tomamos desde el primer '{'
        // para extraer el JSON real (si no hay '{', se intenta parsear tal cual y cae al catch).
        const idx = mensajeRaw.indexOf('{');
        const limpio = idx >= 0 ? mensajeRaw.slice(idx) : mensajeRaw;
        const obj = JSON.parse(limpio);
        const detalle = obj.detalle || [];
        const cat = categorizarError(detalle);
        return { detalle, ...cat, mensaje_siesa: obj.mensaje || 'Error' };
    } catch (e) {
        // En caso de que sea un string de conexión de Siesa y no JSON (ej. "La base de datos...")
        const isDbError = mensajeRaw.toLowerCase().includes('base de datos no existe');
        const cat = isDbError ? 'ERROR_CONEXION_SIESA' : 'OTRO';
        return { detalle: [], categoria: cat, resumen: mensajeRaw.slice(0, 200), mensaje_siesa: null };
    }
}

async function obtenerConsecsExitosos() {
    const { data, error } = await supabase
        .from('sps_facturas')
        .select('tipo, consec, co, caja')
        .eq('estado', 'OK');
        
    if (error) {
        console.error('⚠️ Error leyendo consecs exitosos de Supabase:', error.message);
        return new Set();
    }
    return new Set(data.map(r => `${r.tipo}:${(r.co || '').trim()}:${(r.caja || '').trim()}:${r.consec}`));
}

async function registrarResultado(resultado, meta = {}) {
    const co = meta?.co || '';
    const caja = meta?.caja || '';
    const id = `${resultado.tipo}:${co.trim()}:${caja.trim()}:${resultado.consecutivo}`;
    const errorInfo = resultado.ok ? null : parsearError(resultado.mensaje);
    
    // Primero, obtener el registro actual (para incrementar intentos)
    const { data: existente } = await supabase
        .from('sps_facturas')
        .select('intentos, automatizaciones_aplicadas')
        .eq('id', id)
        .single();
        
    const esSinRecaudo = resultado.mensaje && resultado.mensaje.includes('SIN RECAUDO');
    const payload = {
        id,
        consec: String(resultado.consecutivo),
        tipo: resultado.tipo,
        estado: resultado.ok ? (esSinRecaudo ? 'SIN_RECAUDO' : 'OK') : 'FALLO',
        intentos: existente ? (existente.intentos || 1) + 1 : 1,
        ultima_corrida: new Date().toISOString(),
        categoria_error: errorInfo ? errorInfo.categoria : null,
        error: errorInfo
    };

    if (meta.fecha_factura) payload.fecha_factura = meta.fecha_factura;
    if (meta.cliente_nit) payload.cliente_nit = meta.cliente_nit;
    if (meta.items) payload.items = meta.items;
    if (meta.neto !== undefined) payload.neto = meta.neto;
    if (meta.co) payload.co = meta.co;
    if (meta.caja) payload.caja = meta.caja;
    
    if (meta.automatizaciones && meta.automatizaciones.length > 0) {
        const prevAuto = existente ? (existente.automatizaciones_aplicadas || []) : [];
        payload.automatizaciones_aplicadas = [...new Set([...prevAuto, ...meta.automatizaciones])];
    }

    if (meta.cpeItems && meta.cpeItems.length > 0) {
        payload.cpe_items = meta.cpeItems;
    }

    if (meta.impuestos && meta.impuestos.length > 0) {
        payload.impuestos = meta.impuestos;
    }

    if (!existente) {
        payload.primera_corrida = payload.ultima_corrida;
        if (!payload.automatizaciones_aplicadas) payload.automatizaciones_aplicadas = [];
    }

    const { error } = await supabase
        .from('sps_facturas')
        .upsert(payload, { onConflict: 'id' });
        
    if (error) {
        console.error(`⚠️ Error guardando factura ${id} en Supabase:`, error.message);
    }
}

async function guardarCorrida(resumen) {
    const payload = {
        total: resumen.total || 0,
        ok: resumen.ok || 0,
        fail: resumen.fail || 0,
        resultados: resumen.detalle || []
    };
    
    const { data, error } = await supabase
        .from('sps_corridas')
        .insert(payload)
        .select('id')
        .single();
        
    if (error) {
        console.error('⚠️ Error guardando corrida en Supabase:', error.message);
    }
    
    return data ? data.id : null;
}

async function generarReporteMaestras() {
    // Buscar facturas fallidas que tengan error jsonb
    const { data: fallidas, error } = await supabase
        .from('sps_facturas')
        .select('consec, tipo, error')
        .eq('estado', 'FALLO')
        .not('error', 'is', null);

    if (error) return;

    const mensajesNuevos = new Set();
    const mapeo = [];

    for (const f of fallidas) {
        if (!f.error || !f.error.detalle) continue;
        for (const d of f.error.detalle) {
            const txt = (d.f_detalle || '').toLowerCase();
            const val = (d.f_valor || '').trim();
            if (!val) continue;
            
            let msg = '';
            if (txt.includes('el item') && txt.includes('no existe')) msg = `ITEM MAESTRA FALTANTE: ${val}`;
            else if (txt.includes('unidad de medida')) msg = `UM INEXISTENTE: ${val}`;
            else if (txt.includes('no existe equivalencia')) msg = `EQUIVALENCIA FALTANTE: ${val}`;
            else if (txt.includes('punto de envio')) msg = `PUNTO ENVIO FALTANTE: ${val}`;
            else if (txt.includes('sucursal')) msg = `SUCURSAL FALTANTE: ${val}`;
            else continue; // Solo nos interesan maestras puras

            mensajesNuevos.add(msg);
            mapeo.push({ consec: `${f.tipo} ${f.consec}`, msg });
        }
    }

    if (mensajesNuevos.size === 0) return;

    // Obtener los actuales
    const { data: actuales } = await supabase.from('sps_errores_maestras').select('mensaje');
    const setActuales = new Set((actuales || []).map(a => a.mensaje));

    const inserts = [];
    for (const msg of mensajesNuevos) {
        if (!setActuales.has(msg)) {
            const m = mapeo.find(x => x.msg === msg);
            inserts.push({ mensaje: msg, consec: m ? m.consec : null });
        }
    }

    if (inserts.length > 0) {
        await supabase.from('sps_errores_maestras').insert(inserts);
    }
}

module.exports = {
    supabase,
    obtenerConsecsExitosos,
    registrarResultado,
    guardarCorrida,
    generarReporteMaestras,
    categorizarError,
    parsearError
};