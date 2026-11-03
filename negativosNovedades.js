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

// ──────────────────────────────────────────────────────────
// Email section (pure HTML string, Spanish, non-technical)
// ──────────────────────────────────────────────────────────
const ETIQUETA_SEVERIDAD = { ALTA: 'Alta', MEDIA: 'Media', INFO: 'Informativa' };
const COLOR_SEVERIDAD = { ALTA: '#c0392b', MEDIA: '#e67e22', INFO: '#7f8c8d' };
const ETIQUETA_DOCUMENTO = { CEI: 'Entrada (CEI)', CSA: 'Salida (CSA)' };

function esc(valor) {
    return String(valor ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Groups the novedades by store; stores with the most severe novedad come first, ALTA first inside each store.
// Returns '' when there is nothing to report.
function renderSeccionHtml(novedades = []) {
    const lista = ordenarNovedades(Array.isArray(novedades) ? novedades : []);
    if (lista.length === 0) return '';

    const tiendas = new Map();
    for (const n of lista) {
        const k = `${n.co}|${n.bodega}`;
        if (!tiendas.has(k)) tiendas.set(k, { co: n.co, bodega: n.bodega, items: [] });
        tiendas.get(k).items.push(n);
    }
    // Map insertion order already follows the severity-sorted list, so the most severe store is first.
    const bloques = [...tiendas.values()].map(t => {
        const filas = t.items.map(n => {
            const sev = ETIQUETA_SEVERIDAD[n.severidad] || esc(n.severidad);
            const color = COLOR_SEVERIDAD[n.severidad] || '#555';
            const doc = ETIQUETA_DOCUMENTO[n.tipo_dto] ? ` · ${ETIQUETA_DOCUMENTO[n.tipo_dto]}` : '';
            return `<li><strong style="color: ${color};">${sev}</strong>${doc}: ${esc(n.mensaje)}</li>`;
        }).join('');
        return `<p style="margin: 10px 0 4px; font-weight: bold; color: #333;">CO ${esc(t.co)} · Bodega ${esc(t.bodega)}</p>`
            + `<ul style="margin: 0; padding-left: 20px; color: #555; font-size: 13px; line-height: 1.6;">${filas}</ul>`;
    }).join('');

    return `<div style="margin-top: 20px; padding: 12px; background: #fdf2e9; border-left: 4px solid #e67e22; border-radius: 4px;">`
        + `<p style="margin: 0 0 4px; font-weight: bold; color: #e67e22;">Novedades de la corrida (${lista.length}):</p>`
        + `<p style="margin: 0; font-size: 12px; color: #777;">Situaciones que conviene revisar. No detienen el proceso.</p>`
        + bloques + '</div>';
}

module.exports = { CODIGOS, SEVERIDADES, crearNovedad, ordenarNovedades, renderSeccionHtml };
