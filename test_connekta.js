const axios = require('axios');
require('dotenv').config();

const CIA = process.env.CIA || '7375';
const url = 'https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=' + CIA + '&descripcion=merkahorro_venta_pos_dev';

async function run() {
    try {
        const response = await axios.get(url, {
            headers: {
                'ConniKey': process.env.CONNI_KEY,
                'ConniToken': process.env.CONNI_TOKEN
            }
        });
        let data = response.data;
        if (data.detalle && data.detalle.Datos) {
            data = data.detalle.Datos;
        } else if (data.detalle && data.detalle.Table) {
            data = data.detalle.Table;
        } else if (data.Table) {
            data = data.Table;
        }

        if (Array.isArray(data) && data.length > 0) {
            console.log(Object.keys(data[0]));
        } else {
            console.log('Array is empty or not an array:', typeof data);
            console.log(data);
        }
    } catch (e) {
        console.error(e.message);
    }
}
run();
