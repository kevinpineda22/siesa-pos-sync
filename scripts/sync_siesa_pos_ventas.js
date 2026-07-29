const { createClient } = require('@supabase/supabase-js');
const dotenv = require('dotenv');
const path = require('path');
const process = require('process');



require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;
const siesaKey = process.env.CONNI_KEY;
const siesaToken = process.env.CONNI_TOKEN;
const siesaCompany = process.env.SIESA_POS_COMPANY || '7375';
const queryDescription = process.env.SIESA_POS_QUERY_DESCRIPTION
  || 'merkahorro_informe_acumulados';
const upsertBatchSize = Number(process.env.SIESA_POS_UPSERT_BATCH_SIZE || 500);
const maxRetries = 3;
const supabaseMaxRetries = 5;
const GENERIC_NIT = '222222222222';

if (!supabaseUrl || !supabaseKey || !siesaKey || !siesaToken) {
  throw new Error(
    'Faltan variables para Siesa o Supabase. Revisa VITE_SUPABASE_URL, '
      + 'SUPABASE_SERVICE_ROLE_KEY/VITE_SUPABASE_ANON_KEY, '
      + 'VITE_CONNEKTA_KEY y VITE_CONNEKTA_TOKEN.',
  );
}

if (!Number.isInteger(upsertBatchSize) || upsertBatchSize < 1) {
  throw new Error('SIESA_POS_UPSERT_BATCH_SIZE debe ser un entero positivo.');
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const firstValue = (...values) => values.find((value) => value !== undefined && value !== null && value !== '');
const cleanText = (value) => {
  const normalized = value == null ? '' : String(value).trim();
  return normalized || null;
};
const dateOnly = (value) => cleanText(value)?.slice(0, 10) || null;
const numberValue = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
};
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function parseRows(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      return parseRows(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (!value || typeof value !== 'object') return [];
  return ['Datos', 'Table', 'datos', 'table'].flatMap((key) => parseRows(value[key]));
}

function extractRows(json) {
  const candidates = [json?.detalle?.Datos, json?.detalle?.Table, json?.Datos, json?.Table, json?.datos];
  for (const candidate of candidates) {
    const rows = parseRows(candidate);
    if (rows.length > 0) return rows;
  }
  return [];
}

function buildQueryUrl() {
  const url = new URL('https://servicios.siesacloud.com/api/connekta/v3/ejecutarconsulta');
  url.searchParams.set('idCompania', siesaCompany);
  url.searchParams.set('descripcion', queryDescription);
  return url;
}

async function fetchSiesaRows() {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetch(buildQueryUrl(), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          conniKey: siesaKey,
          conniToken: siesaToken,
        },
      });
      const text = await response.text();
      if (!response.ok) throw new Error(`Siesa HTTP ${response.status}: ${text.slice(0, 240)}`);
      if (!text.trim()) throw new Error('Siesa devolvio una respuesta vacia.');
      return extractRows(JSON.parse(text));
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) await wait(750 * attempt);
    }
  }
  throw lastError;
}

function mapSiesaRow(row) {
  return {
    rowid_mvto: cleanText(firstValue(row.RowidMvto, row.rowid_mvto, row.ROWID_MVTO)),
    linea_registro: firstValue(row.LineaRegistro, row.linea_registro, row.LINEA_REGISTRO),
    cia: firstValue(row.Cia, row.cia),
    co_doc: cleanText(firstValue(row.CoDoc, row.co_doc)),
    id_tipo_docto: cleanText(firstValue(row.ID_TIPO_DOCTO, row.id_tipo_docto)),
    consec_docto: firstValue(row.CONSEC_DOCTO, row.consec_docto),
    concepto: row.Concepto,
    id_motivo: cleanText(row.IDMotivo),
    fecha_docto: firstValue(row.FECHA_DOCTO, row.fecha_docto),
    id_clase_docto: row.ID_CLASE_DOCTO,
    id_caja: cleanText(row.id_caja),
    ind_estado: row.IndEstado,
    vr_bruto_docto: row.VrBrutoDocto,
    valor_dscto_docto: row.ValorDsctoDocto,
    valor_dscto_global_docto: row.ValorDsctoGlobalDocto,
    vr_impto_docto: row.VrImptoDocto,
    vr_neto_docto: firstValue(row.VrNetoDocto, row.vr_neto_docto),
    cantidad: firstValue(row.CANTIDAD, row.cantidad),
    precio_unit_det: row.PrecioUnitDet,
    valor_bruto: firstValue(row.VALOR_BRUTO, row.valor_bruto),
    dscto_linea_det: row.DsctoLineaDet,
    vr_dscto_global_det: row.VrDsctoGlobalDet,
    vr_impto_det: row.VrImptoDet,
    vr_neto_det: firstValue(row.VrnetoDet, row.VrNetoDet, row.vr_neto_det),
    id_tercero: cleanText(firstValue(row.IdTercero, row.id_tercero)),
    nit_tercero: cleanText(firstValue(row.NitTercero, row.nit_tercero)) || GENERIC_NIT,
    razon_social: cleanText(firstValue(row.RazonSocial, row.razon_social)),
    bodega: cleanText(firstValue(row.BODEGA, row.bodega)),
    desc_bodega: cleanText(firstValue(row.DescBodega, row.desc_bodega)),
    unidad_medida: cleanText(firstValue(row.UNIDAD_MEDIDA, row.unidad_medida)),
    id_item: firstValue(row.id_item, row.IdItem, row.ID_ITEM),
    desc_item: cleanText(firstValue(row.DescItem, row.desc_item)),
    vlr_uni_dscto: row.vlr_uni_dscto,
    vlr_tot_dscto: row.vlr_tot_dscto,
    iv03_llave_impuesto: cleanText(row.IV03_Llave_Impuesto),
    iv03_porcentaje_base: row.IV03_Porcentaje_Base,
    iv03_tasa: row.IV03_Tasa,
    iv03_vlr_uni: row.IV03_Vlr_Uni,
    iv03_vlr_tot: row.IV03_Vlr_Tot,
    iv02_llave_impuesto: cleanText(row.IV02_Llave_Impuesto),
    iv02_porcentaje_base: row.IV02_Porcentaje_Base,
    iv02_tasa: row.IV02_Tasa,
    iv02_vlr_uni: row.IV02_Vlr_Uni,
    iv02_vlr_tot: row.IV02_Vlr_Tot,
    ico_llave_impuesto: cleanText(row.ICO_Llave_Impuesto),
    ico_porcentaje_base: row.ICO_Porcentaje_Base,
    ico_tasa: row.ICO_Tasa,
    ico_vlr_uni: row.ICO_Vlr_Uni,
    ico_vlr_tot: row.ICO_Vlr_Tot,
    iv08_llave_impuesto: cleanText(row.IV08_Llave_Impuesto),
    iv08_porcentaje_base: row.IV08_Porcentaje_Base,
    iv08_tasa: row.IV08_Tasa,
    iv08_vlr_uni: row.IV08_Vlr_Uni,
    iv08_vlr_tot: row.IV08_Vlr_Tot,
    iv07_llave_impuesto: cleanText(row.IV07_Llave_Impuesto),
    iv07_porcentaje_base: row.IV07_Porcentaje_Base,
    iv07_tasa: row.IV07_Tasa,
    iv07_vlr_uni: row.IV07_Vlr_Uni,
    iv07_vlr_tot: row.IV07_Vlr_Tot,
    iv01_llave_impuesto: cleanText(row.IV01_Llave_Impuesto),
    iv01_porcentaje_base: row.IV01_Porcentaje_Base,
    iv01_tasa: row.IV01_Tasa,
    iv01_vlr_uni: row.IV01_Vlr_Uni,
    iv01_vlr_tot: row.IV01_Vlr_Tot,
    otros_impuestos_vlr_uni: row.Otros_Impuestos_Vlr_Uni,
    otros_impuestos_vlr_tot: row.Otros_Impuestos_Vlr_Tot,
    total_vlr_uni_impto: row.Total_Vlr_Uni_Impto,
    total_vlr_tot_impto: row.Total_Vlr_Tot_Impto,
    referencia: cleanText(row.Referencia),
    f9930_id_causal_devol: cleanText(row.f9930_id_causal_devol),
    f9930_id_lista_precio: cleanText(row.f9930_id_lista_precio),
    f9930_id_unidad_precio: cleanText(row.f9930_id_unidad_precio),
    f9930_factor: row.f9930_factor,
    f9930_cant_base: row.f9930_cant_base,
    f9930_cant_2: row.f9930_cant_2,
    f9930_vlr_base_impto_asum: row.f9930_vlr_base_impto_asum,
    f9930_fecha_ts_creacion: row.f9930_fecha_ts_creacion,
    f9930_fecha_ts_actualizacion: row.f9930_fecha_ts_actualizacion,
    f9930_usuario_creacion: cleanText(row.f9930_usuario_creacion),
    f9930_usuario_actualizacion: cleanText(row.f9930_usuario_actualizacion),
    f9930_usuario_cambio_cant: cleanText(row.f9930_usuario_cambio_cant),
    f9930_usuario_cambio_precio: cleanText(row.f9930_usuario_cambio_precio),
    f9930_usuario_cambio_dscto: cleanText(row.f9930_usuario_cambio_dscto),
    unidad_de_negocio: cleanText(row.unidad_de_negocio),
  };
}

async function upsertRows(rows) {
  for (let offset = 0; offset < rows.length; offset += upsertBatchSize) {
    const batch = rows.slice(offset, offset + upsertBatchSize);
    let lastError;
    for (let attempt = 1; attempt <= supabaseMaxRetries; attempt += 1) {
      const { error } = await supabase
        .from('siesa_pos_ventas_lineas')
        .upsert(batch, { onConflict: 'rowid_mvto' });
      if (!error) {
        lastError = null;
        break;
      }
      lastError = error;
      if (attempt < supabaseMaxRetries) {
        console.warn(`Lote ${offset / upsertBatchSize + 1}: intento ${attempt} fallo (${error.message}). Reintentando...`);
        await wait(1000 * attempt);
      }
    }
    if (lastError) throw new Error(`Supabase no pudo guardar el lote ${offset / upsertBatchSize + 1}: ${lastError.message}`);
    console.log(`Supabase: ${Math.min(offset + batch.length, rows.length)}/${rows.length} movimientos almacenados.`);
  }
}

async function getStoredRows() {
  const storedRows = [];
  const columns = [
    'rowid_mvto', 'cia', 'bodega', 'co_doc', 'id_tipo_docto', 'consec_docto',
    'fecha_docto', 'desc_bodega', 'id_tercero', 'nit_tercero', 'razon_social',
    'cantidad', 'id_item', 'desc_item', 'vr_bruto_docto', 'valor_dscto_docto',
    'vr_impto_docto', 'vr_neto_docto', 'valor_bruto', 'vlr_tot_dscto',
    'vr_impto_det', 'vr_neto_det',
  ].join(',');
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    let data;
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      const result = await supabase
        .from('siesa_pos_ventas_lineas')
        .select(columns)
        .order('rowid_mvto', { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (!result.error) {
        data = result.data;
        break;
      }
      lastError = result.error;
      if (attempt < maxRetries) await wait(500 * attempt);
    }
    if (!data) throw new Error(`No se pudieron recuperar las lineas POS almacenadas: ${lastError?.message}`);
    storedRows.push(...(data || []));
    if (data.length < pageSize) break;
  }
  return storedRows;
}

async function replaceRange(table, rows, startDate, endDateExclusive, onConflict) {
  let deleteError;
  for (let attempt = 1; attempt <= supabaseMaxRetries; attempt += 1) {
    const result = await supabase
      .from(table)
      .delete()
      .gte('fecha', startDate)
      .lt('fecha', endDateExclusive);
    deleteError = result.error;
    if (!deleteError) break;
    if (attempt < supabaseMaxRetries) await wait(1000 * attempt);
  }
  if (deleteError) throw new Error(`Supabase no pudo limpiar ${table}: ${deleteError.message}`);

  for (let offset = 0; offset < rows.length; offset += upsertBatchSize) {
    const batch = rows.slice(offset, offset + upsertBatchSize);
    let lastError;
    for (let attempt = 1; attempt <= supabaseMaxRetries; attempt += 1) {
      const { error } = await supabase.from(table).upsert(batch, { onConflict });
      if (!error) {
        lastError = null;
        break;
      }
      lastError = error;
      if (attempt < supabaseMaxRetries) await wait(1000 * attempt);
    }
    if (lastError) throw new Error(`Supabase no pudo materializar ${table}: ${lastError.message}`);
  }
  console.log(`${table}: ${rows.length} registros materializados.`);
}

function buildAnalytics(rows) {
  const invoiceMap = new Map();
  const itemMap = new Map();

  rows.forEach((row) => {
    const fecha = dateOnly(row.fecha_docto);
    const bodega = cleanText(row.bodega) || 'SIN_BODEGA';
    const coDoc = cleanText(row.co_doc) || 'SIN_CO';
    const caja = cleanText(row.id_tipo_docto) || 'SIN_CAJA';
    const invoiceKey = [row.cia, bodega, coDoc, caja, row.consec_docto].join('|');
    if (!invoiceMap.has(invoiceKey)) {
      invoiceMap.set(invoiceKey, {
        cia: row.cia,
        bodega,
        co_doc: coDoc,
        caja,
        consec_docto: row.consec_docto,
        fecha,
        desc_bodega: cleanText(row.desc_bodega),
        id_tercero: cleanText(row.id_tercero),
        nit_tercero: cleanText(row.nit_tercero),
        razon_social: cleanText(row.razon_social),
        total_bruto: 0,
        total_descuento: 0,
        total_impuestos: 0,
        total_neto: 0,
        cantidad_lineas: 0,
        cantidad_unidades: 0,
        tiene_valores_negativos: false,
        productIds: new Set(),
        brutoDocumento: [],
        descuentoDocumento: [],
        impuestoDocumento: [],
        netoDocumento: [],
      });
    }
    const invoice = invoiceMap.get(invoiceKey);
    invoice.cantidad_lineas += 1;
    invoice.cantidad_unidades += numberValue(row.cantidad);
    if (row.id_item != null) invoice.productIds.add(String(row.id_item));
    if (row.vr_bruto_docto != null) invoice.brutoDocumento.push(numberValue(row.vr_bruto_docto));
    if (row.valor_dscto_docto != null) invoice.descuentoDocumento.push(numberValue(row.valor_dscto_docto));
    if (row.vr_impto_docto != null) invoice.impuestoDocumento.push(numberValue(row.vr_impto_docto));
    if (row.vr_neto_docto != null) invoice.netoDocumento.push(numberValue(row.vr_neto_docto));
    invoice.total_bruto += numberValue(row.valor_bruto);
    invoice.total_descuento += numberValue(row.vlr_tot_dscto);
    invoice.total_impuestos += numberValue(row.vr_impto_det);
    invoice.total_neto += numberValue(row.vr_neto_det);
    if (numberValue(row.vr_neto_det) < 0 || numberValue(row.valor_bruto) < 0) {
      invoice.tiene_valores_negativos = true;
    }

    if (row.id_item != null) {
      const itemKey = [fecha, caja, bodega, row.id_item].join('|');
      if (!itemMap.has(itemKey)) {
        itemMap.set(itemKey, {
          fecha,
          caja,
          bodega,
          id_item: row.id_item,
          desc_item: cleanText(row.desc_item),
          cantidad: 0,
          neto: 0,
          invoiceKeys: new Set(),
        });
      }
      const item = itemMap.get(itemKey);
      item.cantidad += numberValue(row.cantidad);
      item.neto += numberValue(row.vr_neto_det);
      item.invoiceKeys.add(invoiceKey);
    }
  });

  const invoices = [...invoiceMap.values()].map((invoice) => {
    const documentValue = (values, fallback) => values.length > 0 ? Math.max(...values) : fallback;
    const totalNeto = documentValue(invoice.netoDocumento, invoice.total_neto);
    const nitTercero = cleanText(invoice.nit_tercero) || GENERIC_NIT;
    return {
      cia: invoice.cia,
      bodega: invoice.bodega,
      co_doc: invoice.co_doc,
      caja: invoice.caja,
      consec_docto: invoice.consec_docto,
      fecha: invoice.fecha,
      desc_bodega: invoice.desc_bodega,
      id_tercero: invoice.id_tercero,
      nit_tercero: nitTercero,
      razon_social: invoice.razon_social,
      es_cliente_generico: nitTercero === GENERIC_NIT,
      total_bruto: documentValue(invoice.brutoDocumento, invoice.total_bruto),
      total_descuento: documentValue(invoice.descuentoDocumento, invoice.total_descuento),
      total_impuestos: documentValue(invoice.impuestoDocumento, invoice.total_impuestos),
      total_neto: invoice.tiene_valores_negativos ? -Math.abs(totalNeto) : totalNeto,
      cantidad_lineas: invoice.cantidad_lineas,
      cantidad_productos: invoice.productIds.size,
      cantidad_unidades: invoice.cantidad_unidades,
      tiene_valores_negativos: invoice.tiene_valores_negativos,
      actualizado_en: new Date().toISOString(),
    };
  });

  const dailyMap = new Map();
  invoices.forEach((invoice) => {
    const key = [invoice.fecha, invoice.caja, invoice.bodega].join('|');
    if (!dailyMap.has(key)) {
      dailyMap.set(key, {
        fecha: invoice.fecha,
        caja: invoice.caja,
        bodega: invoice.bodega,
        desc_bodega: invoice.desc_bodega,
        transacciones: 0,
        neto_total: 0,
        transacciones_genericas: 0,
        neto_generico: 0,
        transacciones_reales: 0,
        neto_real: 0,
        actualizado_en: new Date().toISOString(),
      });
    }
    const daily = dailyMap.get(key);
    daily.transacciones += 1;
    daily.neto_total += invoice.total_neto;
    if (invoice.es_cliente_generico) {
      daily.transacciones_genericas += 1;
      daily.neto_generico += invoice.total_neto;
    } else {
      daily.transacciones_reales += 1;
      daily.neto_real += invoice.total_neto;
    }
  });

  const items = [...itemMap.values()].map(({ invoiceKeys, ...item }) => ({
    ...item,
    facturas: invoiceKeys.size,
    actualizado_en: new Date().toISOString(),
  }));
  return { invoices, daily: [...dailyMap.values()], items };
}


(async () => {
  try {
    let received = 0;
let minDate = null;
let maxDate = null;
const storedOnly = process.argv.includes('--stored');

const rowsByMovement = new Map();
let sourceRows;
let loadedFromSiesa = !storedOnly;
if (storedOnly) {
  console.log('Reconstruyendo analitica desde las lineas POS almacenadas en Supabase...');
  sourceRows = await getStoredRows();
  received = sourceRows.length;
} else {
  console.log(`Consultando Siesa POS sin paginacion: "${queryDescription}"...`);
  try {
    sourceRows = await fetchSiesaRows();
    received = sourceRows.length;
  } catch (error) {
    loadedFromSiesa = false;
    console.warn(`Siesa no esta disponible (${error.message}). Reconstruyendo desde Supabase...`);
    sourceRows = await getStoredRows();
    received = sourceRows.length;
  }
}

(loadedFromSiesa ? sourceRows.map(mapSiesaRow) : sourceRows).forEach((row) => {
  if (row.rowid_mvto && row.fecha_docto) rowsByMovement.set(row.rowid_mvto, row);
});
const rows = [...rowsByMovement.values()];

const invoiceKeysWithDate = new Set(rows.map((row) => [
  dateOnly(row.fecha_docto),
  row.cia,
  cleanText(row.bodega) || 'SIN_BODEGA',
  cleanText(row.co_doc) || 'SIN_CO',
  cleanText(row.id_tipo_docto) || 'SIN_CAJA',
  row.consec_docto,
].join('|')));

if (loadedFromSiesa) await upsertRows(rows);
for (const row of rows) {
  const date = dateOnly(row.fecha_docto);
  if (!minDate || date < minDate) minDate = date;
  if (!maxDate || date > maxDate) maxDate = date;
}
console.log(`${received} lineas ${loadedFromSiesa ? 'recibidas' : 'recuperadas'}; ${rows.length} movimientos unicos procesados.`);

if (rows.length > 0) {
  const finalDate = new Date(`${maxDate}T00:00:00Z`);
  finalDate.setUTCDate(finalDate.getUTCDate() + 1);
  const endDateExclusive = finalDate.toISOString().slice(0, 10);
  const analytics = buildAnalytics(rows);
  console.log(`Conciliacion facturas: ${analytics.invoices.length} clave actual; ${invoiceKeysWithDate.size} incluyendo fecha.`);
  await replaceRange(
    'siesa_pos_facturas', analytics.invoices, minDate, endDateExclusive,
    'cia,bodega,co_doc,caja,consec_docto',
  );
  await replaceRange(
    'siesa_pos_estadisticas_diarias', analytics.daily, minDate, endDateExclusive,
    'fecha,caja,bodega',
  );
  await replaceRange(
    'siesa_pos_items_diarios', analytics.items, minDate, endDateExclusive,
    'fecha,caja,bodega,id_item',
  );
}

console.log(JSON.stringify({ received, stored: rows.length, minDate, maxDate }, null, 2));
  } catch (error) {
    console.error('Error fatal:', error);
    process.exit(1);
  }
})();
