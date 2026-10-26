// Normaliza un documento de identidad (NIT / cédula / pasaporte) quitando TODOS los espacios,
// incluidos los internos. En el POS a veces se digita con espacios (ej. "CR555 662") y Siesa
// los elimina al responder ("CR555662"), así que sin normalizar no coinciden la factura, el
// tercero creado en Siesa y la búsqueda en la maestra POS.
function normalizarDocumento(valor) {
    if (valor === null || valor === undefined) return valor;
    return String(valor).replace(/\s+/g, '');
}

// Pesos oficiales de la DIAN para el dígito de verificación, desde el dígito más a la derecha.
const PESOS_DV = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];

// Calcula el dígito de verificación (DV) DIAN de un NIT numérico. Devuelve null si el valor
// no es una cadena de dígitos (o excede los pesos disponibles).
function calcularDV(nit) {
    if (nit === null || nit === undefined) return null;
    const s = String(nit);
    if (!/^\d+$/.test(s) || s.length > PESOS_DV.length) return null;
    let suma = 0;
    for (let i = 0; i < s.length; i++) {
        suma += Number(s[s.length - 1 - i]) * PESOS_DV[i];
    }
    const r = suma % 11;
    return r > 1 ? 11 - r : r;
}

// Compara el código del cliente en el POS (IdTercero, f9740_id) con su NIT (NitTercero).
// Coinciden cuando son iguales, cuando solo difieren por el sufijo "-DV", o cuando uno es el
// otro con su dígito de verificación pegado (caso benigno: "9007451372" vs "900745137").
// Si alguno viene vacío no hay nada que comparar y se considera coincidente.
function compararIdNitCliente(idTercero, nitTercero) {
    const id = normalizarDocumento(idTercero);
    const nit = normalizarDocumento(nitTercero);
    if (!id || !nit) return { coincide: true };

    const sinSufijo = v => String(v).replace(/-\d+$/, '');
    const a = sinSufijo(id);
    const b = sinSufijo(nit);
    if (id === nit || a === b) return { coincide: true };

    const conDV = (base, completo) => {
        const dv = calcularDV(base);
        return dv !== null && completo === `${base}${dv}`;
    };
    if (conDV(a, b) || conDV(b, a)) return { coincide: true };

    return { coincide: false };
}

module.exports = { normalizarDocumento, calcularDV, compararIdNitCliente };
