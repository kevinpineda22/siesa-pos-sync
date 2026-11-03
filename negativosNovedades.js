// Pure catalog of "novedades" (business events worth reporting) for the negative inventory job.
// No I/O, no env access. Codes and severities are the single source of truth for planner, sender,
// alertas, email and panel.

const SEVERIDADES = {
    SIN_STOCK: 'MEDIA',
    UM_DISTINTA: 'INFO',
    LINEA_AJUSTADA: 'INFO',
    LINEA_DESCARTADA: 'MEDIA',
    CEI_RECHAZADO: 'ALTA',
    CSA_RECHAZADO: 'ALTA',
    CSA_DESCARTADA_TOTAL: 'ALTA'
};

const ORDEN_SEVERIDAD = { ALTA: 0, MEDIA: 1, INFO: 2 };

const MENSAJES = {
    SIN_STOCK: (c) => `No había suficiente ${c.item_origen} para cubrir la transformación completa de ${c.item_destino}`,
    UM_DISTINTA: (c) => `La unidad de medida del origen ${c.item_origen} difiere de la del destino ${c.item_destino}; la línea no se planificó`,
    LINEA_AJUSTADA: (c) => `Se ajustó la cantidad de la línea ${c.item_destino ?? c.item_origen ?? ''} de ${c.anterior} a ${c.nueva} por faltante de inventario en Siesa (ronda ${c.ronda})`.replace('  ', ' '),
    LINEA_DESCARTADA: (c) => `Se descartó la línea ${c.item_destino ?? c.item_origen ?? ''} porque Siesa la siguió rechazando tras los ajustes (ronda ${c.ronda})`.replace('  ', ' '),
    CEI_RECHAZADO: () => 'Siesa rechazó el documento de entrada (CEI) de la tienda; no se contabilizó',
    CSA_RECHAZADO: () => 'Siesa rechazó el documento de salida (CSA) de la tienda; no se contabilizó',
    CSA_DESCARTADA_TOTAL: () => 'Se descartaron todas las líneas del documento de salida (CSA) de la tienda; solo se contabilizó la entrada (CEI)'
};

const CODIGOS = Object.fromEntries(Object.keys(SEVERIDADES).map(k => [k, k]));

// ctx: { co, bodega, tipo_dto, item_destino?, item_origen?, cantidad?, ronda?, anterior?, nueva? }
// `anterior`/`nueva` only feed the message; they are not persisted on the novedad.
function crearNovedad(codigo, ctx = {}) {
    if (!Object.prototype.hasOwnProperty.call(SEVERIDADES, codigo)) {
        throw new Error(`Unknown novedad code "${codigo}"`);
    }
    const n = { codigo, severidad: SEVERIDADES[codigo], co: ctx.co, bodega: ctx.bodega, tipo_dto: ctx.tipo_dto };
    for (const campo of ['item_destino', 'item_origen', 'cantidad', 'ronda']) {
        if (ctx[campo] !== undefined && ctx[campo] !== null) n[campo] = ctx[campo];
    }
    n.mensaje = MENSAJES[codigo](ctx);
    return n;
}

// Severity order ALTA > MEDIA > INFO. Stable and non-mutating.
function ordenarNovedades(lista = []) {
    return lista
        .map((n, i) => ({ n, i }))
        .sort((a, b) => (ORDEN_SEVERIDAD[a.n.severidad] ?? 9) - (ORDEN_SEVERIDAD[b.n.severidad] ?? 9) || a.i - b.i)
        .map(x => x.n);
}

module.exports = { CODIGOS, SEVERIDADES, crearNovedad, ordenarNovedades };
