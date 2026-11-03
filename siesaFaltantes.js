// Pure parser of the structured rejections Siesa returns when a document exceeds the available stock
// ("Faltante Inv."). No I/O, no env access. Same proven pattern as costos-acumulacion/ajusteCostos.js, which is
// intentionally left untouched (different connector, zero regression risk).
//
// A rejection detail looks like:
//   { f_detalle: 'Item sin cantidad disponible ... Faltante Inv.: -5.84', f_valor: 'Item:0189243Bodega:00201' }
// "Faltante Inv." is what STILL lacks with the quantity we sent, so callers accumulate it across rounds.

const ESTADOS_BUSCABLES = new Set(['ACTIVA', 'AJUSTADA']);

function sinCeros(v) {
    const t = String(v ?? '').trim();
    return t.replace(/^0+/, '') || (t === '' ? '' : '0');
}

// -> [{ itemTexto, bodega, faltante }] with faltante as a positive magnitude. Entries that do not carry both a
// faltante and an item, or whose magnitude is not positive, are ignored.
function parsearFaltantes(detalle) {
    if (!Array.isArray(detalle)) return [];
    const salida = [];
    for (const e of detalle) {
        const mFaltante = String((e && e.f_detalle) || '').match(/Faltante Inv\.:\s*(-?[\d.]+)/);
        const mItem = String((e && e.f_valor) || '').match(/Item:(.+?)Bodega:(\S*)/);
        if (!mFaltante || !mItem) continue;
        const faltante = Math.abs(parseFloat(mFaltante[1]));
        if (!Number.isFinite(faltante) || !(faltante > 0)) continue;
        salida.push({ itemTexto: mItem[1].trim(), bodega: mItem[2].trim(), faltante });
    }
    return salida;
}

// Finds the line a rejection refers to. Siesa prints the item with leading zeros and sometimes concatenated with
// its extension ("0001705A-0001705"), so: exact match without leading zeros, else the longest line item the text
// starts with. DESCARTADA lines are never in the payload, so they never match.
function ubicarLinea(lineas, itemTexto) {
    const buscado = sinCeros(itemTexto);
    const candidatas = (lineas || []).filter(l => ESTADOS_BUSCABLES.has(l.estado));
    const exacta = candidatas.find(l => sinCeros(l.item) === buscado);
    if (exacta) return exacta;
    return candidatas
        .filter(l => sinCeros(l.item) !== '' && buscado.startsWith(sinCeros(l.item)))
        .sort((a, b) => sinCeros(b.item).length - sinCeros(a.item).length)[0];
}

// -> [{ linea, faltante, itemTexto }]: entries of this bodega that match an active line. Empty means the rejection
// is not correctable (the sender must stop instead of looping).
function faltantesAplicables(detalle, lineas, bodega) {
    const objetivo = sinCeros(bodega).toUpperCase();
    const salida = [];
    for (const f of parsearFaltantes(detalle)) {
        if (sinCeros(f.bodega).toUpperCase() !== objetivo) continue;
        const linea = ubicarLinea(lineas, f.itemTexto);
        if (!linea) continue;
        salida.push({ linea, faltante: f.faltante, itemTexto: f.itemTexto });
    }
    return salida;
}

module.exports = { parsearFaltantes, ubicarLinea, faltantesAplicables };
