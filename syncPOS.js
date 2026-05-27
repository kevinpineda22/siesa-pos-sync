require('dotenv').config();
const axios = require('axios');

// Función para formatear fecha de "2023-10-13T00:00:00" a "20231013"
function formatearFechaSiesa(fechaISO) {
    if (!fechaISO) return "";
    return fechaISO.split('T')[0].replace(/-/g, '');
}

// Trunca un string al tamaño máximo permitido por Siesa.
// Siesa rechaza el lote completo si UN campo excede su largo.
function truncar(valor, maxLen) {
    if (valor === null || valor === undefined) return "";
    const s = String(valor).trim();
    return s.length > maxLen ? s.slice(0, maxLen) : s;
}

async function probarSincronizacion(nitsRequeridos = null) {
    try {
        console.log('----------------------------------------------------');
        if (nitsRequeridos && nitsRequeridos.length > 0) {
            console.log(`1. Consultando clientes POS (filtrando ${nitsRequeridos.length} NIT(s) faltante(s): ${nitsRequeridos.join(', ')})...`);
        } else {
            console.log('1. Consultando clientes POS (últimos 60 días + activos en doctos)...');
        }
        console.log('----------------------------------------------------');
        
        // Connekta no acepta parámetros: el query trae todo el pool relevante y filtramos en Node.
        const responseGet = await axios.get(
            'https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=7375&descripcion=merkahorro_Cliente_pos_dev&paginacion=numPag=1|tamPag=500',
            {
                headers: {
                    'ConniKey': process.env.CONNI_KEY,
                    'ConniToken': process.env.CONNI_TOKEN
                }
            }
        );

        // Extraer los datos del response de Connekta (usualmente en data.detalle.Datos o data directamente)
        const dataSiesa = responseGet.data;
        let clientesDatos = [];
        
        if (dataSiesa && dataSiesa.detalle && dataSiesa.detalle.Datos) {
            clientesDatos = dataSiesa.detalle.Datos;
        } else if (Array.isArray(dataSiesa)) {
            clientesDatos = dataSiesa;
        }

        // Si Siesa nos dijo qué NITs faltan, filtramos solo esos. Si no, mandamos todo el pool.
        if (nitsRequeridos && nitsRequeridos.length > 0) {
            const setNits = new Set(nitsRequeridos.map(n => String(n).trim()));
            const antes = clientesDatos.length;
            clientesDatos = clientesDatos.filter(c => setNits.has(String(c.NIT).trim()));
            console.log(`🔍 Filtrado por NITs requeridos: ${antes} → ${clientesDatos.length} cliente(s) a enviar.`);

            const encontrados = new Set(clientesDatos.map(c => String(c.NIT).trim()));
            const noEncontrados = [...setNits].filter(n => !encontrados.has(n));
            if (noEncontrados.length > 0) {
                console.warn(`⚠️ ${noEncontrados.length} NIT(s) NO existen en la maestra POS y no se podrán crear en Siesa: ${noEncontrados.join(', ')}`);
            }
        }

        if (clientesDatos.length === 0) {
            console.log('\n⚠️ No se encontraron clientes para sincronizar.');
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
            if (tipoTercero === 0 || tipoTercero === "0" || tipoTercero === 1 || tipoTercero === "1") {
                // Forzar 2 (Empresa) si el tipo de identificación es NIT (N) o si no tiene nombres pero tiene razón social, o si tiene O (Otro)
                if (cliente.ID_TIPO_IDENT === 'N' || cliente.ID_TIPO_IDENT === 'O' || (!cliente.NOMBRES && cliente.RAZON_SOCIAL)) {
                    tipoTercero = 2;
                } else {
                    tipoTercero = 1;
                }
            }

            payloadSiesa.Terceros.push({
                "ID": truncar(cliente.NIT, 20),
                "NIT": truncar(cliente.NIT, 20),
                "ID_TIPO_IDENT": tipoTercero === 0 ? "" : (cliente.ID_TIPO_IDENT || ""),
                "IND_TIPO_TERCERO": tipoTercero,
                "RAZON_SOCIAL": truncar(cliente.RAZON_SOCIAL, 40),
                "APELLIDO1": truncar(cliente.APELLIDO1, 30),
                "APELLIDO2": truncar(cliente.APELLIDO2, 30),
                "NOMBRES": truncar(cliente.NOMBRES, 30),
                "CONTACTO": truncar(cliente.CONTACTO, 40),
                "DIRECCION1": truncar(cliente.DIRECCION1, 40),
                "DIRECCION2": truncar(cliente.DIRECCION2, 40),
                "DIRECCION3": truncar(cliente.DIRECCION3, 40),
                "ID_PAIS": cliente.ID_PAIS || "",
                "ID_DEPTO": cliente.ID_DEPTO || "",
                "ID_CIUDAD": cliente.ID_CIUDAD || "",
                "BARRIO": truncar(cliente.BARRIO, 30),
                "TELEFONO": truncar(cliente.TELEFONO, 20),
                "EMAIL": truncar(cliente.EMAIL, 60),
                "FECHA_INGRESO": fechaSiesa,
                "ID_CIIU": cliente.ID_CIIU || "",
                "CELULAR": truncar(cliente.CELULAR, 20)
            });

            payloadSiesa.Clientes.push({
                "ID_TERCERO": truncar(cliente.NIT, 20),
                "ID_SUCURSAL": "001",
                "IND_ESTADO_ACTIVO": 1,
                "RAZON_SOCIAL": truncar(cliente.RAZON_SOCIAL, 40),
                "ID_MONEDA": "COP",
                "IND_CALIFICACION": "A",
                "CUPO_CREDITO": "+000000000000000.0000",
                "ID_TIPO_CLI": "C001",
                "ID_LISTA_PRECIO": "P99",
                "IND_PEDIDO_BACKORDER": 4,
                "PORC_EXCESO_VENTA": "0000.00",
                "PORC_MIN_MARGEN": "0000.00",
                "PORC_MAX_MARGEN": "0000.00",
                "CONTACTO": truncar(cliente.CONTACTO, 40),
                "DIRECCION1": truncar(cliente.DIRECCION1, 40),
                "DIRECCION2": truncar(cliente.DIRECCION2, 40),
                "DIRECCION3": truncar(cliente.DIRECCION3, 40),
                "ID_PAIS": cliente.ID_PAIS || "",
                "ID_DEPTO": cliente.ID_DEPTO || "",
                "ID_CIUDAD": cliente.ID_CIUDAD || "",
                "BARRIO": truncar(cliente.BARRIO, 30),
                "TELEFONO": truncar(cliente.TELEFONO, 20),
                "EMAIL": truncar(cliente.EMAIL, 60),
                "FECHA_INGRESO": fechaSiesa,
                "CELULAR": truncar(cliente.CELULAR, 20),
                "FRECUENCIA_ENTREGA": "1111111",
                "VALIDA_CUPO_DESPACHO": 0
            });
        }

        console.log(`Se armaron ${payloadSiesa.Terceros.length} Terceros y ${payloadSiesa.Clientes.length} Clientes.`);

        // Se omite respaldo local (ahora todo se persiste en Supabase via logger.js)

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