// Validación compartida de las opciones de reproceso manual: tipo de documento y fecha de inserción.
// La usan syncVentas (fuente de verdad), server.js y reprocesoAcumulado.js, para que todas las
// entradas apliquen exactamente las mismas reglas.

const TIPOS_DOCUMENTO = ['CNZ', 'CFZ'];

// Normaliza los tipos de documento a reprocesar. Acepta un array o un string ("CNZ", "CFZ",
// "CNZ,CFZ", "AMBAS"). Vacío o "AMBAS" = ambos. Devuelve siempre un subconjunto de ['CNZ','CFZ']
// en el orden de ejecución (CNZ primero, luego CFZ).
function normalizarTipos(raw) {
    const items = (Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,]+/))
        .map(x => String(x ?? '').trim().toUpperCase())
        .filter(Boolean);
    if (items.length === 0 || items.includes('AMBAS')) return [...TIPOS_DOCUMENTO];
    const invalidos = items.filter(t => !TIPOS_DOCUMENTO.includes(t));
    if (invalidos.length > 0) {
        throw new Error(`tipos inválidos: "${invalidos.join(', ')}". Valores permitidos: CNZ | CFZ | AMBAS.`);
    }
    return TIPOS_DOCUMENTO.filter(t => items.includes(t));
}

// Valida la fecha de inserción forzada: YYYY-MM-DD, fecha real y no futura (hoy en America/Bogota).
// Devuelve el string validado, o null si viene vacío.
function validarFechaDocto(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return null;
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) throw new Error(`fechaDocto inválida: "${s}". Formato esperado YYYY-MM-DD.`);
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    if (d.getUTCFullYear() !== Number(m[1]) || d.getUTCMonth() !== Number(m[2]) - 1 || d.getUTCDate() !== Number(m[3])) {
        throw new Error(`fechaDocto inválida: "${s}" no es una fecha real.`);
    }
    const hoyBogota = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    if (s > hoyBogota) {
        throw new Error(`fechaDocto inválida: "${s}" es una fecha futura (hoy en Bogotá es ${hoyBogota}).`);
    }
    return s;
}

// Los tipos distintos de "ambos" y la fecha forzada solo se permiten con documentos explícitos.
function exigirDocumentos({ tipos, fechaDocto, hayDocumentos }) {
    const tiposNoDefault = tipos.length !== TIPOS_DOCUMENTO.length;
    if ((fechaDocto || tiposNoDefault) && !hayDocumentos) {
        throw new Error('`fechaDocto` y `tipos` (distinto de ambos) solo se permiten junto con una lista explícita de `documentos`.');
    }
}

module.exports = { TIPOS_DOCUMENTO, normalizarTipos, validarFechaDocto, exigirDocumentos };
