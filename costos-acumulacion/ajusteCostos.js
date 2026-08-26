/**
 * ajusteCostos.js — Ajuste diario de costos / acumulación
 * ============================================================================
 * Proyecto INDEPENDIENTE del sincronizador de ventas (syncVentas.js / sync011Gen.js):
 * no importa ni comparte código con ellos.
 *
 * Qué hace, una vez al día:
 *   1. Lee `merkahorro_consultas_diarias_costo` → ítems vendidos hoy que necesitan ajuste:
 *        · TipoItem = "Kit"   → se ajusta la CANTIDAD VENDIDA del día (suma de las líneas)
 *        · CostoPromInst = 0  → se ajusta 1 UNIDAD para fijarle el costo. Si Siesa rechaza
 *          por "Item sin cantidad disponible", se reintenta con el FALTANTE que él reporta.
 *   2. Lee `merkahorro_costo_promedio_dev` → busca el costo del ítem en otra instalación.
 *      Si no tiene costo en ninguna, usa COSTO_FALLBACK ($1).
 *   3. Envía el ajuste a Siesa con el conector 253797 (AJUSTE_INVENTARIO_DEV_ACUMULACION),
 *      agrupando UN DOCUMENTO POR BODEGA.
 *
 * Idempotencia:
 *   · Ítems con costo 0 → NATURAL: al quedar con costo > 0 dejan de aparecer en la query.
 *   · Kits → NO es idempotente (aparecen siempre). Correr dos veces el mismo día duplicaría
 *     la cantidad ajustada. Por eso el job debe ejecutarse UNA sola vez al día.
 * ============================================================================
 */
const axios = require('axios');
require('dotenv').config();

// ── Configuración ───────────────────────────────────────────────────────────
const CIA = process.env.CIA || '7375';
const ENTORNO = (process.env.COSTOS_ENTORNO || 'PROD').toUpperCase();
const SIESA_DOMAIN = ENTORNO === 'QA' ? 'serviciosqa.siesacloud.com' : 'servicios.siesacloud.com';
const CONNEKTA_DOMAIN = 'servicios.siesacloud.com'; // la lectura del POS siempre es PROD

const URL_ITEMS = `https://${CONNEKTA_DOMAIN}/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=merkahorro_consultas_diarias_costo`;
const URL_COSTOS = `https://${CONNEKTA_DOMAIN}/api/connekta/v3/ejecutarconsulta?idCompania=${CIA}&descripcion=merkahorro_costo_promedio_dev`;
const URL_SIESA = `https://${SIESA_DOMAIN}/api/siesa/v3.1/conectoresimportar?idCompania=${CIA}&idSistema=1&idDocumento=253797&nombreDocumento=AJUSTE_INVENTARIO_DEV_ACUMULACION`;

const COSTO_FALLBACK = 1;   // ítem sin costo en ninguna instalación
const UN_FALLBACK = '001';  // unidad de negocio cuando el tipo_inv_serv no está mapeado
const LARGO_MAX_ITEM = 7;   // f470_id_item admite 7 caracteres
const TAM_PAGINA = 1000;
const MAX_RONDAS_FALTANTE = 3;  // reintentos cuando Siesa pide cubrir un faltante de inventario

// Orden de prioridad para tomar el costo de otra instalación (definido por negocio).
// El código del POS (P0x) equivale al centro/instalación del mismo número:
//   001 Copacabana Plaza · 002 Villahermosa · 003 Girardota
//   007 Barbosa          · 004 Girardota Llano · 008 Copacabana San Juan
// Nota: 006 (Copacabana Vegas) queda fuera a propósito — merkahorro_costo_promedio_dev
// la excluye (NOT IN ('006','010')), así que nunca podría aportar un costo.
const PRIORIDAD_INSTALACIONES = ['001', '002', '003', '007', '004', '008'];

const headers = () => ({
    ConniKey: process.env.CONNI_KEY,
    ConniToken: process.env.CONNI_TOKEN,
    'Content-Type': 'application/json',
});

// ── Utilidades ──────────────────────────────────────────────────────────────
const hoyBogota = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
const soloFecha = (v) => String(v || '').split('T')[0];
const txt = (v) => (v == null ? '' : String(v).trim());
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// Formato decimal que exige Siesa: 15 enteros + punto + 4 decimales (20 caracteres).
const decimalSiesa = (valor) => num(valor).toFixed(4).padStart(20, '0');

// Extrae las filas de una respuesta de Connekta.
function filasDe(respuesta) {
    const d = (respuesta && respuesta.detalle) || {};
    return d.Datos || d.Table || respuesta.Table || [];
}

async function consultar(url, etiqueta) {
    const r = await axios.get(url, { headers: headers(), timeout: 180000 });
    const filas = filasDe(r.data);
    console.log(`   📦 ${etiqueta}: ${filas.length} fila(s).`);
    return filas;
}

// Descarga completa de un query paginado. Reintenta ante 429 (Connekta limita el ritmo).
async function consultarPaginado(baseUrl, etiqueta) {
    const todas = [];
    for (let pagina = 1; pagina <= 500; pagina++) {
        let filas = null;
        for (let intento = 1; intento <= 4 && filas === null; intento++) {
            try {
                const url = `${baseUrl}&paginacion=numPag=${pagina}|tamPag=${TAM_PAGINA}`;
                const r = await axios.get(url, { headers: headers(), timeout: 120000 });
                filas = filasDe(r.data);
            } catch (error) {
                const status = error.response && error.response.status;
                if (intento === 4) {
                    throw new Error(`${etiqueta}: falló la página ${pagina} (${status || error.message}).`);
                }
                console.warn(`   ⚠️ ${etiqueta} pág ${pagina} (intento ${intento}/4): ${status || error.message}`);
                await esperar(1200 * intento);
            }
        }
        if (filas.length === 0) break;
        todas.push(...filas);
        if (filas.length < TAM_PAGINA) break;
    }
    console.log(`   📦 ${etiqueta}: ${todas.length} fila(s) en total.`);
    return todas;
}

// ── Paso 1: clasificar los ítems que necesitan ajuste ───────────────────────
// Devuelve { ajustes, descartes }. Un ajuste = un par (ítem + bodega).
function clasificar(filas, fechaObjetivo) {
    const porClave = new Map();
    const descartes = [];

    filas.forEach((f) => {
        if (soloFecha(f.FECHA_DOCTO) !== fechaObjetivo) return;

        const item = txt(f.id_item);
        const bodega = txt(f.BODEGA);
        const esKit = txt(f.TipoItem).toLowerCase() === 'kit';
        const costoActual = num(f.CostoPromInst);

        // El query ya filtra, pero nos aseguramos de no ajustar algo que no corresponde.
        if (!esKit && costoActual !== 0) return;

        const clave = `${item}|${bodega}`;
        if (!porClave.has(clave)) {
            porClave.set(clave, {
                item,
                bodega,
                esKit,
                co: txt(f.CoDoc),
                unidadMedida: txt(f.UNIDAD_MEDIDA),
                unidadNegocio: txt(f.unidad_de_negocio),
                tipoInvServ: txt(f.TipoInventarioServicio),
                descripcion: txt(f.DescItem),
                costoActual,
                cantidadVendida: 0,
                lineas: 0,
            });
        }
        const a = porClave.get(clave);
        a.cantidadVendida += num(f.CANTIDAD);
        a.lineas += 1;
        // Si alguna línea lo marca como Kit, manda la regla del Kit.
        if (esKit) a.esKit = true;
    });

    const ajustes = [];
    porClave.forEach((a) => {
        // Kit → la cantidad vendida del día. Resto → 1 unidad para fijarle el costo.
        a.cantidad = a.esKit ? a.cantidadVendida : 1;
        a.motivo = a.esKit ? 'KIT (cantidad vendida)' : 'COSTO 0 (1 unidad)';

        // Sin unidad de negocio (tipo_inv_serv no mapeado en el CASE de la query) se usa la
        // 001 por defecto. Igual se marca para que quede visible en el log: conviene agregar
        // ese tipo_inv_serv al CASE para que tome la UN que le corresponde.
        if (!a.unidadNegocio) {
            a.unidadNegocio = UN_FALLBACK;
            a.unPorDefecto = true;
        }
        if (a.item.length > LARGO_MAX_ITEM) {
            descartes.push({ ...a, razon: `id_item de ${a.item.length} caracteres (el campo admite ${LARGO_MAX_ITEM})` });
            return;
        }
        if (a.cantidad <= 0) {
            descartes.push({ ...a, razon: `cantidad a ajustar = ${a.cantidad} (devoluciones que anulan la venta)` });
            return;
        }
        ajustes.push(a);
    });

    return { ajustes, descartes };
}

// ── Paso 2: costo del ítem tomado de otra instalación ───────────────────────
function mapaDeCostos(filas) {
    const mapa = new Map(); // item -> { instalacion: costo }
    filas.forEach((f) => {
        const item = txt(f.IdItem);
        const inst = txt(f.IdInstalacion);
        if (!item || !inst) return;
        if (!mapa.has(item)) mapa.set(item, {});
        mapa.get(item)[inst] = num(f.CostoPromInst);
    });
    return mapa;
}

// La instalación se identifica con el mismo número que el centro de operación, pero en los
// datos aparece con y sin ceros a la izquierda (ej. el CO 011 figura como "11"). Se prueban
// todas las variantes para no perder el costo propio por un tema de formato.
function variantesInstalacion(co) {
    const base = txt(co);
    if (!base) return [];
    return [...new Set([base, base.padStart(3, '0'), base.replace(/^0+/, '')])].filter(Boolean);
}

// Busca el costo del ítem en este orden:
//   1. Su PROPIO centro de operación.
//   2. La lista de prioridad de sedes (001 › 002 › 003 › 007 › 004 › 008).
//   3. Cualquier otra instalación con costo (mejor un costo real que uno inventado).
//   4. COSTO_FALLBACK ($1).
function resolverCosto(item, mapa, co) {
    const porInst = mapa.get(item) || {};
    const tieneCosto = (inst) => porInst[inst] > 0;

    const propia = variantesInstalacion(co).find(tieneCosto);
    if (propia) {
        return { costo: porInst[propia], origen: `su propio centro (instalación ${propia})` };
    }

    const prioritaria = PRIORIDAD_INSTALACIONES.find(tieneCosto);
    if (prioritaria) {
        return { costo: porInst[prioritaria], origen: `instalación ${prioritaria} (prioridad)` };
    }

    const otra = Object.keys(porInst).sort().find(tieneCosto);
    if (otra) {
        return { costo: porInst[otra], origen: `instalación ${otra} (fuera de la lista de prioridad)` };
    }

    return { costo: COSTO_FALLBACK, origen: `sin costo en ninguna instalación → fallback $${COSTO_FALLBACK}` };
}

// ── Paso 3: payload del conector 253797 (un documento por bodega) ───────────
function armarPayloads(ajustes, fechaDocto) {
    const porBodega = new Map();
    ajustes.forEach((a) => {
        if (!porBodega.has(a.bodega)) porBodega.set(a.bodega, []);
        porBodega.get(a.bodega).push(a);
    });

    return [...porBodega.entries()].map(([bodega, lista]) => ({
        bodega,
        ajustes: lista,
        payload: {
            Documentos: [{
                // f350_consec_docto es obligatorio para Siesa pero el conector no le asignó
                // campo variable ni fijo, así que se manda con su nombre crudo. Va en 0
                // porque F_CONSEC_AUTO_REG = 1 (fijo): el consecutivo lo asigna Siesa.
                // OJO: es Entero — debe ir como número, no como string ("0" lo rechaza).
                f350_consec_docto: 0,
                FECHA_DOCTO: fechaDocto,
                BODEGA: bodega,
            }],
            Movimientos: lista.map((a, i) => ({
                CONSECUTIVO_DOCTO: 0,                // Entero. Siesa lo asigna (F_CONSEC_AUTO_REG = 1)
                NRO_REGISTRO: i + 1,
                BODEGA: a.bodega,
                'C.O MOVIMIENTO': a.co,
                UNIDAD_MEDIDA: a.unidadMedida,
                '1': decimalSiesa(a.cantidad),       // f470_cant_base
                COSTO_PROMEDIO: decimalSiesa(a.costo),
                ITEM: a.item.padStart(LARGO_MAX_ITEM, '0'),
                UNIDAD_NEGOCIO: a.unidadNegocio,
            })),
        },
    }));
}

// Ubica el movimiento del payload al que se refiere un error de Siesa.
// Siesa devuelve el ítem en f_valor con formato "Item:0189243Bodega:00201" y a veces lo
// concatena con su extensión ("Item:0001705A-0001705Bodega:PV001"), así que se compara sin
// ceros a la izquierda y aceptando que el texto del error empiece por nuestro código.
function movimientoDelError(payload, itemDelError) {
    const buscado = txt(itemDelError).replace(/^0+/, '');
    const movimientos = payload.Movimientos;
    const normal = (m) => String(m.ITEM).replace(/^0+/, '');
    return movimientos.find((m) => normal(m) === buscado)
        || movimientos.find((m) => buscado.startsWith(normal(m)));
}

// Lee los "Item sin cantidad disponible" que reporta Siesa y SUMA el faltante a la cantidad
// que se está enviando. Devuelve el detalle de lo que cambió.
//
// OJO: el "Faltante Inv." es lo que TODAVÍA falta con la cantidad que mandamos, no el total.
// Verificado en producción con el ítem 189243 (necesitaba 3):
//     enviamos 1 → reporta faltante 2   (1 + 2 = 3)
//     enviamos 2 → reporta faltante 1   (2 + 1 = 3)
// Por eso se acumula (anterior + faltante) en vez de reemplazar.
function aplicarFaltantes(payload, detalle) {
    const cambios = [];
    detalle.forEach((e) => {
        const texto = String(e.f_detalle || '');
        if (!texto.includes('Item sin cantidad disponible')) return;

        const mFaltante = texto.match(/Faltante Inv\.:\s*(-?[\d.]+)/);
        const mItem = String(e.f_valor || '').match(/Item:(.+?)Bodega:/);
        if (!mFaltante || !mItem) return;

        const faltante = Math.abs(parseFloat(mFaltante[1]));
        const mov = movimientoDelError(payload, mItem[1]);
        if (!mov || !(faltante > 0)) return;

        const anterior = num(mov['1']);
        const nueva = anterior + faltante;
        mov['1'] = decimalSiesa(nueva);
        cambios.push({ item: mov.ITEM, anterior, faltante, nueva });
    });
    return cambios;
}

// Envía un documento. Si Siesa rechaza por faltante de inventario, sube la cantidad al
// faltante que él mismo reporta y reintenta (hasta MAX_RONDAS_FALTANTE veces).
async function enviarDocumento(doc) {
    const { payload, bodega } = doc;

    for (let ronda = 0; ronda <= MAX_RONDAS_FALTANTE; ronda++) {
        try {
            const r = await axios.post(URL_SIESA, payload, { headers: headers(), timeout: 180000 });
            const mensaje = (r.data && r.data.mensaje) || 'OK';
            return { ok: true, mensaje: ronda > 0 ? `${mensaje} (tras ajustar el faltante)` : mensaje };
        } catch (error) {
            const data = error.response && error.response.data;
            const detalle = data && Array.isArray(data.detalle) ? data.detalle : null;
            const resumen = data ? JSON.stringify(data) : error.message;

            if (!detalle || ronda === MAX_RONDAS_FALTANTE) {
                return { ok: false, mensaje: resumen };
            }

            const cambios = aplicarFaltantes(payload, detalle);
            if (cambios.length === 0) {
                return { ok: false, mensaje: resumen };   // no es un faltante corregible
            }
            cambios.forEach((c) => {
                console.log(`   🔁 [Bodega ${bodega}] Item ${c.item}: faltan ${c.faltante} → cantidad ${c.anterior} → ${c.nueva}. Reintentando...`);
            });
        }
    }
    return { ok: false, mensaje: `Se agotaron los ${MAX_RONDAS_FALTANTE} reintentos por faltante de inventario.` };
}

function listarDescartes(descartes) {
    console.log(`\n⚠️ DESCARTADOS (${descartes.length}) — no se pueden ajustar:`);
    descartes.forEach((d) => {
        console.log(`   · Item ${d.item} | Bodega ${d.bodega} | ${d.descripcion}`);
        console.log(`     motivo: ${d.razon}`);
    });
}

// ── Flujo principal ─────────────────────────────────────────────────────────
async function ajustarCostos(opciones = {}) {
    const fechaObjetivo = txt(opciones.fecha || process.env.COSTOS_FECHA || hoyBogota());
    const fechaDocto = fechaObjetivo.replace(/-/g, '');
    const dryRun = opciones.dryRun === true || String(process.env.COSTOS_DRY_RUN || '').toLowerCase() === 'true';

    console.log('==========================================');
    console.log('💰 AJUSTE DE COSTOS / ACUMULACIÓN');
    console.log(`   Fecha=${fechaObjetivo} | Entorno escritura=${ENTORNO} | Conector=253797`);
    if (dryRun) console.log('   🧪 DRY-RUN: no se envía nada a Siesa.');
    console.log('==========================================');

    // 1. Ítems del día que necesitan ajuste.
    const filasItems = await consultar(URL_ITEMS, 'Items del día');
    if (filasItems.length === 0) {
        console.warn('⚠️ La query no devolvió NINGÚN registro.');
        console.warn('   Ojo: lee las tablas vivas del POS (t9820/t9830), que solo conservan el día en curso.');
        console.warn('   Si el POS ya cerró el día, hay que correr el job más temprano.');
    }

    const { ajustes, descartes } = clasificar(filasItems, fechaObjetivo);
    if (ajustes.length === 0) {
        console.log(`ℹ️ No hay ajustes para ${fechaObjetivo}.`);
        if (descartes.length > 0) listarDescartes(descartes);
        return { total: 0, ok: 0, fail: 0, ajustes: 0, descartes: descartes.length };
    }

    // 2. Costos por instalación.
    console.log('\n🔍 Consultando costos promedio por instalación...');
    const costos = mapaDeCostos(await consultarPaginado(URL_COSTOS, 'Costos'));
    ajustes.forEach((a) => {
        const { costo, origen } = resolverCosto(a.item, costos, a.co);
        a.costo = costo;
        a.origenCosto = origen;
    });

    // 3. Listado de lo que se va a ajustar.
    console.log('\n==========================================');
    console.log(`📋 AJUSTES A APLICAR (${ajustes.length})`);
    console.log('==========================================');
    ajustes.forEach((a, i) => {
        console.log(`  ${i + 1}. Item ${a.item} | Bodega ${a.bodega} | CO ${a.co} | ${a.motivo}`);
        const notaUN = a.unPorDefecto ? ` ⚠️ (por defecto: "${a.tipoInvServ || 'sin tipo'}" no está en el CASE de la query)` : '';
        console.log(`     cant=${a.cantidad} · costo=$${a.costo} (${a.origenCosto}) · UM=${a.unidadMedida} · UN=${a.unidadNegocio}${notaUN}`);
        console.log(`     ${a.descripcion} — ${a.lineas} línea(s) de venta en el día`);
    });
    const conUnDefecto = ajustes.filter((a) => a.unPorDefecto).length;
    if (conUnDefecto > 0) {
        console.log(`\n⚠️ ${conUnDefecto} ítem(s) salieron con UNIDAD_NEGOCIO ${UN_FALLBACK} por defecto.`);
        console.log('   Conviene agregar su tipo_inv_serv al CASE de merkahorro_consultas_diarias_costo.');
    }
    if (descartes.length > 0) listarDescartes(descartes);

    const documentos = armarPayloads(ajustes, fechaDocto);
    console.log(`\n🚚 ${documentos.length} documento(s) a enviar (uno por bodega).`);

    if (dryRun) {
        console.log('\n🧪 DRY-RUN — payload del primer documento:');
        console.log(JSON.stringify(documentos[0].payload, null, 2));
        return { total: 0, ok: 0, fail: 0, ajustes: ajustes.length, descartes: descartes.length, dryRun: true };
    }

    // 4. Envío a Siesa.
    let ok = 0;
    let fail = 0;
    const errores = [];
    for (const doc of documentos) {
        const resultado = await enviarDocumento(doc);
        if (resultado.ok) {
            ok++;
            console.log(`✅ [Bodega ${doc.bodega}] ${doc.ajustes.length} ítem(s): ${resultado.mensaje}`);
        } else {
            fail++;
            errores.push({ bodega: doc.bodega, detalle: resultado.mensaje });
            console.error(`❌ [Bodega ${doc.bodega}] ${resultado.mensaje}`);
        }
    }

    console.log('\n==========================================');
    console.log('📊 RESUMEN');
    console.log('==========================================');
    console.log(`Ajustes=${ajustes.length} | Documentos=${documentos.length} | ✅ OK=${ok} | ❌ Fallidos=${fail} | Descartados=${descartes.length}`);
    console.log('==========================================\n');

    return { total: documentos.length, ok, fail, ajustes: ajustes.length, descartes: descartes.length, errores };
}

module.exports = { ajustarCostos };
