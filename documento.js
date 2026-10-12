// Normaliza un documento de identidad (NIT / cédula / pasaporte) quitando TODOS los espacios,
// incluidos los internos. En el POS a veces se digita con espacios (ej. "CR555 662") y Siesa
// los elimina al responder ("CR555662"), así que sin normalizar no coinciden la factura, el
// tercero creado en Siesa y la búsqueda en la maestra POS.
function normalizarDocumento(valor) {
    if (valor === null || valor === undefined) return valor;
    return String(valor).replace(/\s+/g, '');
}

module.exports = { normalizarDocumento };
