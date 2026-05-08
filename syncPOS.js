require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

// Función para formatear fecha de "2023-10-13T00:00:00" a "20231013"
function formatearFechaSiesa(fechaISO) {
    if (!fechaISO) return "";
    return fechaISO.split('T')[0].replace(/-/g, '');
}

async function probarSincronizacion() {
    try {
        console.log('----------------------------------------------------');
        console.log('1. Consultando 100 clientes desde el API Dinámica (POS)...');
        console.log('----------------------------------------------------');
        
        // Cambiamos tamPag a 100 para traer 100 clientes de una vez
        const responseGet = await axios.get(
            'https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=7375&descripcion=merkahorro_Cliente_pos_dev&paginacion=numPag=1|tamPag=10',
            {
                headers: {
                    'ConniKey': process.env.CONNI_KEY,
                    'ConniToken': process.env.CONNI_TOKEN
                }
            }
        );

        const dataSiesa = responseGet.data; 
        
        let clientesDatos = [
            {
                "NIT": "21683653",
                "IND_TIPO_TERCERO": 1,
                "ID_TIPO_IDENT": "C",
                "RAZON_SOCIAL": "BUSTAMANTE QUICENO MARIA AURORA",
                "NOMBRES": "MARIA AURORA",
                "APELLIDO1": "BUSTAMANTE",
                "FECHA_INGRESO": "2023-10-13T00:00:00"
            },
            {
                "NIT": "000",
                "IND_TIPO_TERCERO": 1,
                "ID_TIPO_IDENT": "C",
                "RAZON_SOCIAL": "PUNTO DE ENVIO 000",
                "NOMBRES": "CAJA",
                "APELLIDO1": "000",
                "FECHA_INGRESO": "2023-10-13T00:00:00"
            }
        ];

        if (clientesDatos.length === 0) {
            console.log('\n⚠️ No se encontraron clientes.');
            return;
        }

        console.log(`\n✅ Se extrajeron ${clientesDatos.length} clientes. Procesando...`);

        console.log('\n----------------------------------------------------');
        console.log('2. Armando el Payload MASIVO para QA (GenericTransfer)...');
        console.log('----------------------------------------------------');
        
        const payloadSiesa = {
            "Terceros": [],
            "Clientes": []
        };

        // Recorremos los 5 clientes y los metemos en los arrays
        for (const cliente of clientesDatos) {
            const fechaSiesa = formatearFechaSiesa(cliente.FECHA_INGRESO);

            let tipoTercero = cliente.IND_TIPO_TERCERO;
            if (tipoTercero === 0 || tipoTercero === "0") {
                tipoTercero = (cliente.ID_TIPO_IDENT === 'C' || cliente.NOMBRES) ? 1 : 2;
            }

            payloadSiesa.Terceros.push({
                "ID": cliente.NIT || "", 
                "NIT": cliente.NIT || "",
                "ID_TIPO_IDENT": tipoTercero === 0 ? "" : (cliente.ID_TIPO_IDENT || ""),
                "IND_TIPO_TERCERO": tipoTercero,
                "RAZON_SOCIAL": cliente.RAZON_SOCIAL || "",
                "APELLIDO1": cliente.APELLIDO1 || "",
                "APELLIDO2": cliente.APELLIDO2 || "",
                "NOMBRES": cliente.NOMBRES || "",
                "CONTACTO": cliente.CONTACTO || "",
                "DIRECCION1": cliente.DIRECCION1 || "",
                "DIRECCION2": cliente.DIRECCION2 || "",
                "DIRECCION3": cliente.DIRECCION3 || "",
                "ID_PAIS": cliente.ID_PAIS || "",
                "ID_DEPTO": cliente.ID_DEPTO || "",
                "ID_CIUDAD": cliente.ID_CIUDAD || "",
                "BARRIO": cliente.BARRIO || "",
                "TELEFONO": cliente.TELEFONO || "",
                "EMAIL": cliente.EMAIL || "",
                "FECHA_INGRESO": fechaSiesa,
                "ID_CIIU": cliente.ID_CIIU || "",
                "CELULAR": cliente.CELULAR || ""
            });

            payloadSiesa.Clientes.push({
                "ID_TERCERO": cliente.NIT || "", 
                "ID_SUCURSAL": "001",
                "IND_ESTADO_ACTIVO": 1,
                "RAZON_SOCIAL": cliente.RAZON_SOCIAL || "",
                "ID_MONEDA": "COP",
                "IND_CALIFICACION": "A",
                "CUPO_CREDITO": "+000000000000000.0000",
                "ID_TIPO_CLI": "C001",
                "ID_LISTA_PRECIO": "P99",
                "IND_PEDIDO_BACKORDER": 4,
                "PORC_EXCESO_VENTA": "0000.00",
                "PORC_MIN_MARGEN": "0000.00",
                "PORC_MAX_MARGEN": "0000.00",
                "CONTACTO": cliente.CONTACTO || "",
                "DIRECCION1": cliente.DIRECCION1 || "",
                "DIRECCION2": cliente.DIRECCION2 || "",
                "DIRECCION3": cliente.DIRECCION3 || "",
                "ID_PAIS": cliente.ID_PAIS || "",
                "ID_DEPTO": cliente.ID_DEPTO || "",
                "ID_CIUDAD": cliente.ID_CIUDAD || "",
                "BARRIO": cliente.BARRIO || "",
                "TELEFONO": cliente.TELEFONO || "",
                "EMAIL": cliente.EMAIL || "",
                "FECHA_INGRESO": fechaSiesa,
                "CELULAR": cliente.CELULAR || "",
                "FRECUENCIA_ENTREGA": "1111111",
                "VALIDA_CUPO_DESPACHO": 0
            });
        }

        console.log(`Se armaron ${payloadSiesa.Terceros.length} Terceros y ${payloadSiesa.Clientes.length} Clientes.`);

        // Guardar el JSON generado en un archivo local para que el usuario pueda revisarlo
        fs.writeFileSync('clientes_enviados_100.json', JSON.stringify(payloadSiesa, null, 2));
        console.log('\n✅ Archivo "clientes_enviados_100.json" generado en esta carpeta para que puedas corroborar en Siesa.');

        console.log('\n----------------------------------------------------');
        console.log('3. Haciendo el POST MASIVO a Siesa QA...');
        console.log('----------------------------------------------------');

        const urlQA = 'https://serviciosqa.siesacloud.com/api/siesa/v3.1/conectoresimportar?idCompania=7375&idSistema=1&idDocumento=242590&nombreDocumento=TERCEROS_DEV_POS';
        
        const responsePost = await axios.post(urlQA, payloadSiesa, {
            headers: {
                'Content-Type': 'application/json',
                'ConniKey': process.env.CONNI_KEY,
                'ConniToken': process.env.CONNI_TOKEN
            }
        });

        console.log('\n✅ ¡Respuesta exitosa masiva de Siesa QA!');
        console.log(responsePost.data);
        return responsePost.data;

    } catch (error) {
        console.error('\n❌ Error en la conexión con Siesa:');
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Data:', JSON.stringify(error.response.data, null, 2));
            throw new Error(JSON.stringify(error.response.data));
        } else {
            console.error(error.message);
            throw error;
        }
    }
}

// Exportamos la función en lugar de llamarla directamente
module.exports = { syncPOS: probarSincronizacion };