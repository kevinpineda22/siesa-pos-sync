require('dotenv').config();
const axios = require('axios');

// ──────────────────────────────────────────────────────────
// ENTORNO: PROD (default) vs QA
// Connekta (lectura datos POS) → siempre PROD
// Siesa (escritura) → switchea según ENT
// ──────────────────────────────────────────────────────────
const ENTORNO = (process.env.ENTORNO_SIESA || 'PROD').toUpperCase();
const SIESA_DOMAIN = ENTORNO === 'QA' ? 'serviciosqa.siesacloud.com' : 'servicios.siesacloud.com';
const CONNEKTA_DOMAIN = 'servicios.siesacloud.com';

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
    const BASE = `https://${CONNEKTA_DOMAIN}/api/connekta/v3/ejecutarconsulta?idCompania=7375&descripcion=merkahorro_Cliente_pos_dev`;
    const TAM = 1000;       // máximo que acepta Connekta
    const MAX_PAGINAS = 500; // tope de seguridad (~500k clientes)
    const pendientes = (nitsRequeridos && nitsRequeridos.length > 0)
        ? new Set(nitsRequeridos.map(n => String(n).trim()))
        : null;
    const todos = [];
    let pagina = 0;
    let paginasRecorridas = 0;
    for (pagina = 1; pagina <= MAX_PAGINAS; pagina++) {
        paginasRecorridas = pagina;
        let registros = [];
        try {
            const r = await axios.get(`${BASE}&paginacion=numPag=${pagina}|tamPag=${TAM}`, {
                headers: { 'ConniKey': process.env.CONNI_KEY, 'ConniToken': process.env.CONNI_TOKEN },
                timeout: 15000,
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
        paginas: paginasRecorridas,
        total_clientes: todos.length
    };
}

async function probarSincronizacion(nitsRequeridos = null) {
    let fetchResult = null;
    let clientesDatos = [];
    let paginasTotales = 0;
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
        fetchResult = await fetchClientesPOS(nitsRequeridos);
        clientesDatos = fetchResult.datos;
        paginasTotales = fetchResult.paginas;
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
            "Clientes": [],
            "Imptos y Reten": []
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

            // Fallback: si APELLIDO1 está vacío y tenemos NOMBRES, extraer la última palabra como apellido
            // Soluciona el error "el nombre y el apellido 1 son obligatorios" en Siesa para Persona Natural
            let apellido1Final = (cliente.APELLIDO1 || '').trim();
            let nombresFinal = (nombresLimpios || cliente.NOMBRES || '').trim();
            if (!apellido1Final && nombresFinal && tipoTercero === 1) {
                const partes = nombresFinal.split(/\s+/);
                if (partes.length >= 2) {
                    apellido1Final = partes.pop();
                    nombresFinal = partes.join(' ');
                } else {
                    // Solo 1 palabra: usarla como apellido y nombres vacío (Siesa requiere al menos apellido)
                    apellido1Final = nombresFinal;
                    nombresFinal = '';
                }
            }

            payloadSiesa.Terceros.push({
                "ID": truncar(cliente.NIT, 20),
                "NIT": truncar(cliente.NIT, 20),
                "ID_TIPO_IDENT": tipoTercero === 0 ? "" : (cliente.ID_TIPO_IDENT || ""),
                "IND_TIPO_TERCERO": tipoTercero,
                "RAZON_SOCIAL": truncar(cliente.RAZON_SOCIAL, 40),
                "APELLIDO1": truncar(apellido1Final, 30),
                "APELLIDO2": truncar(cliente.APELLIDO2, 30),
                "NOMBRES": truncar(nombresFinal, 30),
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

            // Agregar configuración de impuestos/retenciones (IVA e ICO) para cada cliente
            payloadSiesa["Imptos y Reten"].push({
                "ID_TERCERO": truncar(cliente.NIT, 20),
                "ID_SUCURSAL": "001",
                "ID_CLASE": "1",
                "ID_VALOR_TERCERO": "1"
            });
            payloadSiesa["Imptos y Reten"].push({
                "ID_TERCERO": truncar(cliente.NIT, 20),
                "ID_SUCURSAL": "001",
                "ID_CLASE": "2",
                "ID_VALOR_TERCERO": "1"
            });
        }

        console.log(`Se armaron ${payloadSiesa.Terceros.length} Terceros, ${payloadSiesa.Clientes.length} Clientes y ${payloadSiesa["Imptos y Reten"].length} Imptos y Reten.`);

        // Se omite respaldo local (ahora todo se persiste en Supabase via logger.js)

        console.log('\n----------------------------------------------------');
        console.log(`3. Haciendo el POST MASIVO a Siesa ${ENTORNO}...`);
        console.log('----------------------------------------------------');

        const urlSiesa = `https://${SIESA_DOMAIN}/api/siesa/v3.1/conectoresimportar?idCompania=7375&idSistema=1&idDocumento=248059&nombreDocumento=TERCERO_POS_CLIENTES_DEV`;
        
        const responsePost = await axios.post(urlSiesa, payloadSiesa, {
            headers: {
                'Content-Type': 'application/json',
                'ConniKey': process.env.CONNI_KEY,
                'ConniToken': process.env.CONNI_TOKEN
            }
        });

        console.log(`\n✅ ¡Respuesta exitosa masiva de Siesa ${ENTORNO}!`);
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