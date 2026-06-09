require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

const CIA = process.env.CIA || '7375';
const URL_VENTAS_DETALLE = `https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=merkahorro_venta_pos_dev`;

async function main() {
    try {
        const response = await axios.get(URL_VENTAS_DETALLE, {
            headers: {
                'ConniKey': process.env.CONNI_KEY,
                'ConniToken': process.env.CONNI_TOKEN
            }
        });
        
        let data = response.data.detalle ? (response.data.detalle.Datos || response.data.detalle.Table) : response.data.Table || response.data;
        const itemsMatch = data.filter(d => String(d.CONSEC_DOCTO) === '93305');
        console.log("Items de consec 93305:");
        console.table(itemsMatch.map(d => ({
            nro_registro: itemsMatch.indexOf(d) + 1,
            id_item: d.id_item,
            CANTIDAD: d.CANTIDAD,
            PrecioUnitDet: d.PrecioUnitDet,
            VALOR_BRUTO: d.VALOR_BRUTO
        })));
    } catch (e) {}
}
main();
