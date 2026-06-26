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

// Limpia el campo NOMBRES cuando detecta que contiene apellidos que ya están
// en APELLIDO1 o APELLIDO2. Esto pasa cuando en el POS meten el nombre completo
// (nombre + apellido) en el campo de nombres, y también el apellido en el campo
// de apellidos — Siesa termina mostrando "MONICA SIERRA SIERRA" (duplicado).
//
// Caso real: NOMBRES="MONICA SIERRA", APELLIDO1="SIERRA" → NOMBRES="MONICA"
function limpiarNombres(nombres, apellido1, apellido2) {
    let n = (nombres || '').trim();
    if (!n) return '';

    const a1 = (apellido1 || '').trim().toUpperCase();
    const a2 = (apellido2 || '').trim().toUpperCase();

    // Si NOMBRES termina con APELLIDO1, quitarlo
    let nUpper = n.toUpperCase();
    if (a1 && nUpper.endsWith(' ' + a1)) {
        n = n.slice(0, n.length - a1.length - 1).trim();
        nUpper = n.toUpperCase();
    }
    // Si NOMBRES termina con APELLIDO2, quitarlo
    if (a2 && nUpper.endsWith(' ' + a2)) {
        n = n.slice(0, n.length - a2.length - 1).trim();
        nUpper = n.toUpperCase();
    }
    // Si NOMBRES empieza con APELLIDO1 (formato "APELLIDO NOMBRE")
    if (a1 && nUpper.startsWith(a1 + ' ')) {
        n = n.slice(a1.length + 1).trim();
    }

    return n;
}

// Consulta la maestra de clientes del POS PAGINANDO. Connekta no acepta parámetros y trunca
// en una sola página (tamPag), así que paginamos. Si se pasan nitsRequeridos, corta apenas
// los encuentra a todos (eficiente: no recorre toda la maestra si no hace falta).
async function fetchClientesPOS(nitsRequeridos = null) {
    const BASE = 'https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta?idCompania=7375&descripcion=merkahorro_Cliente_pos_dev';
    const TAM = 1000;       // máximo que acepta Connekta
    const MAX_PAGINAS = 50; // tope de seguridad (~50k clientes)
    const pendientes = (nitsRequeridos && nitsRequeridos.length > 0)
        ? new Set(nitsRequeridos.map(n => String(n).trim()))
        : null;
    const todos = [];
    let pagina = 0;
    for (pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
        let registros = [];
        try {
            const r = await axios.get(`${BASE}&paginacion=numPag=${pagina}|tamPag=${TAM}`, {
                headers: { 'ConniKey': process.env.CONNI_KEY, 'ConniToken': process.env.CONNI_TOKEN },
                timeout: 60000,
            });
            const d = r.data;
            registros = (d && d.detalle && d.detalle.Datos) ? d.detalle.Datos : (Array.isArray(d) ? d : []);
        } catch (e) {
            console.warn(`⚠️ Error consultando clientes POS pág ${pagina}: ${e.message}`);
            break;
        }
        if (!registros.length) break;
        todos.push(...registros);
        // Corte temprano: si ya aparecieron todos los NITs requeridos, no seguimos paginando.
        if (pendientes) {
            registros.forEach(c => pendientes.delete(String(c.NIT).trim()));
            if (pendientes.size === 0) { console.log(`   📥 NIT(s) requerido(s) encontrado(s) en la página ${pagina}.`); break; }
        }
        if (registros.length < TAM) break; // última página
    }
    return {
        datos: todos,
        paginas: pagina,  // última página recorrida
        total_clientes: todos.length
    };
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
        
        // Connekta no acepta parámetros y trunca en una sola página: paginamos la maestra de
        // clientes (con corte temprano si ya encontramos los NITs requeridos).
        const fetchResult = await fetchClientesPOS(nitsRequeridos);
        let clientesDatos = fetchResult.datos;
        const paginasTotales = fetchResult.paginas;
        console.log(`   📥 Clientes POS descargados (paginado): ${clientesDatos.length} registros en ${paginasTotales} página(s)`);

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
            return { success: true, creados: 0, paginas: paginasTotales, total_clientes_pos: fetchResult.total_clientes, no_encontrados: nitsRequeridos || [], mensaje: 'Ningún cliente encontrado en la maestra POS' };
        }

        console.log(`\n✅ Se extrajeron ${clientesDatos.length} clientes. Procesando...`);

        console.log('\n----------------------------------------------------');
        console.log('2. Armando el Payload MASIVO para PROD (GenericTransfer)...');
        console.log('----------------------------------------------------');
        
        const payloadSiesa = {
            "Terceros": [],
            "Clientes": []
        };

        // Recorremos los 5 clientes y los metemos en los arrays
        for (const cliente of clientesDatos) {
            const fechaSiesa = formatearFechaSiesa(cliente.FECHA_INGRESO);
            const nombresLimpios = limpiarNombres(cliente.NOMBRES, cliente.APELLIDO1, cliente.APELLIDO2);

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
                "NOMBRES": truncar(nombresLimpios || cliente.NOMBRES, 30),
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
        console.log('3. Haciendo el POST MASIVO a Siesa PROD...');
        console.log('----------------------------------------------------');

        const urlSiesa = 'https://servicios.siesacloud.com/api/siesa/v3.1/conectoresimportar?idCompania=7375&idSistema=1&idDocumento=242590&nombreDocumento=TERCEROS_DEV_POS';
        // QA: serviciosqa.siesacloud.com
        
        const responsePost = await axios.post(urlSiesa, payloadSiesa, {
            headers: {
                'Content-Type': 'application/json',
                'ConniKey': process.env.CONNI_KEY,
                'ConniToken': process.env.CONNI_TOKEN
            }
        });

        console.log('\n✅ ¡Respuesta exitosa masiva de Siesa PROD!');
        console.log(responsePost.data);
        return {
            success: true,
            creados: payloadSiesa.Terceros.length,
            paginas: paginasTotales,
            total_clientes_pos: fetchResult.total_clientes,
            no_encontrados: nitsRequeridos && nitsRequeridos.length > 0
                ? [...new Set(nitsRequeridos.map(n => String(n).trim()))].filter(n => !clientesDatos.some(c => String(c.NIT).trim() === n))
                : [],
            siesa: responsePost.data
        };

    } catch (error) {
        console.error('\n❌ Error en la conexión con Siesa:');
        let detalle = '(sin detalle)';
        if (error.response) {
            console.error('Status:', error.response.status);
            console.error('Data:', JSON.stringify(error.response.data, null, 2));
            detalle = typeof error.response.data === 'string' ? error.response.data : JSON.stringify(error.response.data);
        } else {
            console.error(error.message);
            detalle = error.message;
        }
        // Retornamos error estructurado con datos de paginación
        return {
            success: false,
            error: detalle,
            paginas: typeof paginasTotales !== 'undefined' ? paginasTotales : null,
            total_clientes_pos: fetchResult ? fetchResult.total_clientes : null
        };
    }
}

// Exportamos la función en lugar de llamarla directamente
module.exports = { syncPOS: probarSincronizacion };