const esSimulacionCNZ = false;
const tipoDoctoSiesa = esSimulacionCNZ ? 'CNZ' : 'CFZ';
const consecDoc = '999';
const enc = { CoDoc: '001', CONSEC_DOCTO: '999' };

function formatDecimal(number, isQuantity = false) {
    if (number === null || number === undefined) return isQuantity ? "000000000000000.0000" : "000000000000000.0000";
    return parseFloat(number).toFixed(4).padStart(20, '0');
}

const absIfCNZ = (val) => {
    if (val === null || val === undefined) return val;
    return esSimulacionCNZ ? Math.abs(parseFloat(val)) : parseFloat(val);
};

const items = [
    {
      "id_item": "5007",
      "CANTIDAD": 2.395,
      "VALOR_BRUTO": 17364,
      "PrecioUnitDet": 7250,
      "UNIDAD_MEDIDA": "KL"
    },
    {
      "id_item": "16714",
      "CANTIDAD": 1.000,
      "VALOR_BRUTO": 3529,
      "PrecioUnitDet": 4200,
      "UNIDAD_MEDIDA": "UND"
    }
];

const Movimientos = [];

items.forEach((det, index) => {
    const lineaItem = index + 1;

    Movimientos.push({
        "id_co": enc.CoDoc,
        "id_tipo_docto": tipoDoctoSiesa,
        "consec_docto": consecDoc,
        "nro_registro": lineaItem,
        "BODEGA": det.BODEGA || "MG001",
        "id_concepto": esSimulacionCNZ ? 502 : ({"1201": 501, "1202": 502}[det.Concepto] || 501),
        "id_motivo": "03",
        "ind_naturaleza": esSimulacionCNZ ? 1 : 2,
        "id_co_movto": enc.CoDoc,
        "UNIDAD_MEDIDA": det.UNIDAD_MEDIDA ? det.UNIDAD_MEDIDA.trim() : "UND",
        "CANTIDAD": formatDecimal(absIfCNZ(det.CANTIDAD || det.cant_1), true),
        "VALOR_BRUTO": formatDecimal(absIfCNZ(det.VALOR_BRUTO)),
        "id_item": det.id_item,
        "id_un_movto": (det?.unidad_de_negocio ?? '').trim() || "001",
        "VR_UNIT": formatDecimal(det.PrecioUnitDet || 0)
    });
});

console.log(JSON.stringify(Movimientos, null, 2));
