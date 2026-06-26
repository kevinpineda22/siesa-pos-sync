# Sincronizador POS → Siesa PROD — Documentación Completa

**Última actualización:** 26 de Junio de 2026

Backend Node.js + Frontend React que sincroniza ventas de un sistema POS hacia el ERP Siesa PROD, con auto-corrección, trazabilidad completa e idempotencia. Incluye panel de monitoreo con dashboard, historial de facturas, ajustes de inventario, resumen de impuestos, y detección/skip de Impuesto al Consumo (ICO).

---

## Índice

1. [Visión general](#1-visión-general)
2. [Arquitectura del proyecto](#2-arquitectura-del-proyecto)
3. [Variables de entorno (.env)](#3-variables-de-entorno-env)
4. [Supabase — Esquema de tablas](#4-supabase--esquema-de-tablas)
5. [Endpoints HTTP](#5-endpoints-http)
6. [Queries Connekta](#6-queries-connekta)
7. [Limitaciones de Connekta](#7-limitaciones-de-connekta)
8. [Flujo de sincronización (syncVentas)](#8-flujo-de-sincronización-syncventas)
9. [Documentos enviados a Siesa](#9-documentos-enviados-a-siesa)
10. [Reglas de negocio críticas](#10-reglas-de-negocio-críticas)
11. [Lógica de auto-corrección](#11-lógica-de-auto-corrección)
12. [Idempotencia](#12-idempotencia)
13. [Categorías de error](#13-categorías-de-error)
14. [ICO — Impuesto al Consumo](#14-ico--impuesto-al-consumo)
15. [Dashboard — Frontend React](#15-dashboard--frontend-react)
16. [Componentes del Frontend](#16-componentes-del-frontend)
17. [GitHub Actions — Workflows](#17-github-actions--workflows)
18. [Scripts de diagnóstico](#18-scripts-de-diagnóstico)
19. [Deploy](#19-deploy)
20. [Resolución de problemas comunes](#20-resolución-de-problemas-comunes)
21. [Historial de cambios](#21-historial-de-cambios)

---

## 1. Visión general

El sistema toma las ventas del POS (consultadas vía Connekta) y las replica como documentos contables en Siesa PROD mediante su API de importación de planos (`conectoresimportar`). Incluye un **dashboard en React** para monitoreo en tiempo real, **resumen de impuestos** por llave (IVA, ICO), **ajustes de inventario** CPE, y **detección de ICO** con trazabilidad sin envío a Siesa.

### Documentos generados por venta

| Documento | Naturaleza | Concepto | Clase | Motivo |
|-----------|------------|----------|-------|--------|
| **CFZ** (Factura) | 2 (Egreso) | 501 | 522 | 03 |
| **CNZ** (Nota Crédito) | 1 (Ingreso) | 502 | 525 | 03 |
| **CPE** (Ajuste Inventario) | — | 601 | 61 | 17 |

La CNZ se envía con método de pago **forzado a EFE**. Si Siesa rechaza por cliente faltante o inventario insuficiente, el sistema se auto-corrige y reintenta.

### Stack tecnológico

| Capa | Tecnología |
|------|-----------|
| Backend | Node.js + Express + Supabase |
| Frontend | React 19 + Vite + Recharts + Framer Motion |
| Base de datos | PostgreSQL (Supabase) |
| API Siesa | `conectoresimportar` (SOAP/XML a JSON) |
| Middleware POS | Connekta (SQL como HTTP) |
| CI/CD | GitHub Actions + Vercel |

---

## 2. Arquitectura del proyecto

### Backend — `siesa-pos-sync/`

```
siesa-pos-sync/
├── server.js                  # Express: 14 endpoints HTTP
├── syncVentas.js              # Motor principal de sincronización
├── syncPOS.js                 # Sincronización de clientes
├── logger.js                  # Trazabilidad + Supabase
├── reportes.js                # Generación PDF + envío SMTP
├── vercel.json                # Config Vercel serverless
├── package.json
├── .env                       # Credenciales (NO commitear)
├── DOCUMENTACION.md           # Este archivo
│
├── scripts/                   # Scripts de diagnóstico y cron
│   ├── runSyncCron.js         # Orquestador para GitHub Actions
│   ├── runReporte.js          # Generador de reportes vía CLI
│   ├── reprocesarConsec.js    # Reprocesa consecs específicos
│   ├── testUM.js              # Prueba normalizarUM
│   ├── testCarteraCxC.js      # Prueba convergencia cartera
│   ├── testStatsPOS.js        # Prueba queries stats POS
│   ├── testImpuestos.js       # Prueba extraction impuestos
│   └── ... (más scripts)
│
├── .github/workflows/
│   ├── sync-pos.yml           # Sync cada 1h
│   └── report-pos.yml         # Reportes diarios
│
└── *.sql                      # Migraciones Supabase
    ├── setup_estadisticas_diarias.sql
    └── setup_reportes.sql
```

### Frontend — `Pagina-web_React/` (proyecto separado)

```
src/pages/SiesaPosSync/
├── SiesaPosSync.jsx           # Layout principal + sidebar
├── SiesaPosSync.css           # ~2800 líneas de estilos
├── ReportesPanel.jsx          # Config/generación de reportes
├── ReportesPanel.css          # Estilos reportes
│
└── components/
    ├── DashboardSiesaPos.jsx  # Vista Dashboard (KPIs + impuestos + ajustes)
    ├── KPICards.jsx           # 6 tarjetas KPI
    ├── DashboardCharts.jsx    # 5 gráficas (Recharts)
    ├── ResumenDiario.jsx      # Resumen diario POS vs Sync
    ├── TrazabilidadPanel.jsx  # Trazabilidad CO/Caja
    ├── FacturasTable.jsx      # Tabla de facturas con filtros (incl. "Solo ICO")
    ├── ModalDetalle.jsx       # Modal detalle de factura (con tarjetas de impuestos)
    ├── AjustesInventario.jsx  # Tabla de ajustes CPE
    ├── HistorialCorridas.jsx  # Historial de ejecuciones
    ├── ErroresMaestras.jsx    # Errores de maestras
    ├── ActionsPanel.jsx       # Panel de acciones (sync)
    ├── helpers.js             # Funciones utilitarias (incl. TAX_DESCRIPTIONS)
    └── Paginacion.jsx         # Componente de paginación

src/services/
└── siesaPosSyncService.js     # Cliente HTTP (axios)
```

---

## 3. Variables de entorno (.env)

```env
# === Connekta (middleware Siesa Cloud) ===
CONNI_KEY=...
CONNI_TOKEN=...

# === Compañía Siesa ===
CIA=7375

# === Límites de procesamiento ===
LIMITE_FACTURAS=5        # Facturas por corrida en modo normal
CONCURRENCIA=5           # Envío paralelo a Siesa
MAX_RONDAS_AJUSTE=3      # Reintentos auto-corrección
PAGINACION_CONCURRENCIA=4 # Pool de páginas paralelas

# === Filtros de sincronización ===
ENTORNO_SIESA=PROD       # PROD | QA
CO_FILTER=001            # Centro(s) de operación
CAJA_FILTER=Z01,Z02      # Tipo(s) de caja

# === Supabase ===
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=...

# === SMTP (Reportes) ===
SMTP_HOST=smtp.correo.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM=reportes@merkahorro.com

# === Puerto ===
PORT=4000
```

---

## 4. Supabase — Esquema de tablas

### `sps_facturas` — Trazabilidad de facturas

| Columna | Tipo | Descripción |
|---------|------|-------------|
| `id` | TEXT PK | `{tipo}:{co}:{caja}:{consec}` |
| `consec` | TEXT | Consecutivo del documento |
| `tipo` | TEXT | CFZ / CNZ / CPE |
| `co` | TEXT | Centro de operación |
| `caja` | TEXT | Tipo de caja (Z01/Z02) |
| `estado` | TEXT | OK / FALLO / SIN_RECAUDO / **ICO** |
| `fecha_factura` | TEXT | Fecha de la factura |
| `cliente_nit` | TEXT | NIT del cliente |
| `items` | INTEGER | Cantidad de items |
| `neto` | NUMERIC | Valor neto |
| `intentos` | INTEGER | Intentos realizados |
| `categoria_error` | TEXT | Categoría del error |
| `error` | JSONB | Detalle del error |
| `impuestos` | JSONB | Array de impuestos extraídos (IVA, ICO) |
| `cpe_items` | JSONB | Array de ajustes de inventario |
| `automatizaciones_aplicadas` | JSONB | Array de acciones tomadas |
| `cxcConvergido` | BOOLEAN | Si se aplicó convergencia cartera vs CxC |
| `primera_corrida` | TIMESTAMPTZ | Primera vez que se procesó |
| `ultima_corrida` | TIMESTAMPTZ | Última vez que se procesó |

**Nota:** El estado `'ICO'` indica que la factura tenía Impuesto al Consumo y **no se envió a Siesa**. Se guardan todos los datos (items, neto, impuestos, cliente) para trazabilidad, pero nunca se llama al endpoint de Siesa. El workflow **no reintenta** estas facturas (ver sección [ICO](#14-ico--impuesto-al-consumo)).

### `sps_estadisticas_diarias` — Snapshots diarios

| Columna | Tipo | Descripción |
|---------|------|-------------|
| `fecha` | DATE PK | Fecha del snapshot |
| `total_pos` | INTEGER | Total facturas POS |
| `total_sync` | INTEGER | Total sincronizadas |
| `genericas` | INTEGER | Facturas genéricas |
| `reales` | INTEGER | Facturas reales |
| `neto_total` | NUMERIC | Neto total |
| `por_caja` | JSONB | `{ "Z01": { trans, neto }, "Z02": {...} }` |
| `por_nit` | JSONB | `{ "generico": { trans, neto }, "real": { trans, neto } }` |
| `actualizado_en` | TIMESTAMPTZ | Última actualización |

### `sps_corridas` — Snapshots de ejecuciones

| Columna | Tipo | Descripción |
|---------|------|-------------|
| `id` | UUID PK | Identificador único |
| `fecha` | TIMESTAMPTZ | Fecha de la corrida |
| `resumen` | JSONB | `{ total, ok, fail }` |
| `resultados` | JSONB | Array de resultados individuales |

### `sps_errores_maestras` — Errores de maestras

| Columna | Tipo | Descripción |
|---------|------|-------------|
| `id` | UUID PK | Identificador único |
| `fecha` | TIMESTAMPTZ | Fecha del error |
| `consec` | TEXT | Consecutivo relacionado |
| `mensaje` | TEXT | Descripción del error |

### `sps_config_reportes` — Configuración reportes

| Columna | Tipo | Descripción |
|---------|------|-------------|
| `id` | SERIAL PK | |
| `destinatarios` | TEXT[] | Correos destino |
| `programacion` | TEXT | diario / semanal |
| `hora_envio` | TIME | Hora de envío |
| `dia_semana` | INTEGER | 1=Lunes…7=Domingo |
| `activo` | BOOLEAN | |
| `ultimo_envio` | TIMESTAMP | |
| `created_at` / `updated_at` | TIMESTAMP | |

### `sps_historial_reportes` — Historial de reportes enviados

| Columna | Tipo | Descripción |
|---------|------|-------------|
| `id` | UUID PK | |
| `tipo_periodo` | TEXT | diario / semanal |
| `fecha_inicio` / `fecha_fin` | DATE | Período del reporte |
| `destinatarios` | TEXT[] | |
| `resumen` | JSONB | `{ total, ok, fail, pct_exito, total_neto }` |
| `enviado_ok` | BOOLEAN | |
| `error` | TEXT | |
| `created_at` | TIMESTAMP | |

---

## 5. Endpoints HTTP

### Lectura (GET)

| Ruta | Parámetros | Descripción |
|------|-----------|-------------|
| `/api/logs` | `estado`, `tipo`, `categoria`, `consec`, `limit`, `solo_pendientes` | Facturas procesadas |
| `/api/logs/corridas` | `limit` | Snapshots de corridas |
| `/api/logs/resumen-diario` | `fecha`, `caja`, `fechaInicio`, `fechaFin` | Resumen diario híbrido |
| `/api/logs/estadisticas` | `fechaInicio`, `fechaFin` | Estadísticas día por día |
| `/api/logs/ajustes` | — | Ajustes de inventario CPE aplanados |
| `/api/logs/resumen-impuestos` | `fechaInicio`, `fechaFin` | Agregado de impuestos por llave |
| `/api/logs/resumen-ajustes` | `fechaInicio`, `fechaFin` | Agregado de ajustes CPE |
| `/api/reportes/config` | — | Configuración de reportes |
| `/api/reportes/historial` | `limit` | Historial de reportes |

### Acción (POST)

| Ruta | Body | Descripción |
|------|------|-------------|
| `/api/sync-ventas` | `{ consecs?, limite?, co?, caja? }` | Ejecuta sincronización |
| `/api/sync-clientes` | — | Sincroniza clientes POS → Siesa |
| `/api/reportes/generar` | `{ periodo, fecha_inicio, fecha_fin, destinatarios }` | Genera y envía PDF |
| `/api/reportes/config` | `{ destinatarios, programacion, hora_envio, dia_semana, activo }` | Guarda configuración |

### Endpoints nuevos (Junio 2026, semana 4-5)

#### `GET /api/logs/resumen-impuestos`

Agrega impuestos por `ID_LLAVE_IMPUESTO` (IV02-IV08, ICO) para un rango de fechas. **Deduplica** facturas del mismo `{co}:{caja}:{consec}` priorizando FALLO > SIN_RECAUDO > OK (misma lógica que el frontend).

```json
{
  "success": true,
  "totalBase": 12345678,           // Suma de netos de facturas con impuestos
  "totalBaseGravable": 6500000,    // Suma de BASE_GRAVABLE de todos los impuestos
  "totalImpuestos": 2345678,       // Suma de todos los VALOR_TOTAL
  "totalFacturas": 123,            // Facturas deduplicadas que contribuyeron
  "totalDocumentos": 246,          // Total crudo (sin dedup, CNZ+CFZ separados)
  "porLlave": [
    { "llave": "IV03", "descripcion": "IVA 19% BIENES", "valorTotal": 1234567, "baseGravable": 6500000, "count": 45 }
  ]
}
```

Descripciones incluidas en el backend (`TAX_DESCRIPTIONS`):
| Llave | Descripción |
|-------|------------|
| IV02 | IVA 5% BIENES |
| IV03 | IVA 19% BIENES |
| IV04 | IVA 19% SERVICIOS |
| IV05 | IVA 19% HONORARIOS |
| IV06 | IVA 19% ARRENDAMIENTOS |
| IV07 | IVA 19% CERVEZA |
| IV08 | IVA DEL 19% EN GASEOSAS |
| ICO | IMPUESTO AL CONSUMO |

#### `GET /api/logs/resumen-ajustes`

Agrega ajustes de inventario (CPE) para un rango de fechas. Procesa `cpe_items` aplanados desde `sps_facturas`.

```json
{
  "success": true,
  "totalItems": 45,              // Suma de cantidades de todos los ajustes
  "totalValor": 12345678,        // Suma de (cantidad × costo) de todos los ajustes
  "totalProductos": 12,          // Cantidad de ítems únicos ajustados
  "totalFacturas": 8,            // Facturas que tienen CPE
  "totalFilas": 15               // Filas totales (items × facturas)
}
```

#### `GET /api/logs/ajustes`

Devuelve todos los ajustes de inventario aplanados (sin agregación, uno por fila).

```json
{
  "success": true,
  "count": 15,
  "data": [
    { "consec": "1234", "tipo": "CFZ", "co": "001", "caja": "Z01", "fecha": "2026-06-22",
      "item": "773", "bodega": "PV001", "cantidad": 5, "un": "001", "costo": 5975 }
  ]
}
```

### Ejemplo: `GET /api/logs`

```json
{
  "success": true,
  "resumen": { "total": 1247, "ok": 1198, "fallo": 49, "pendientes_unicos": 49, "ultima_corrida": "2026-06-23T14:33:12.011Z" },
  "count": 200,
  "data": [ /* facturas */ ],
  "errores_maestras": "Reporte de maestras..."
}
```

### Ejemplo: `GET /api/logs/resumen-diario`

Responde con un objeto híbrido: si la fecha es hoy, consulta Connekta en vivo; si es pasado, lee de `sps_estadisticas_diarias`. Incluye `neto_sync` y `por_nit_sync` para comparativa POS vs Sincronizado.

---

## 6. Queries Connekta

Connekta expone consultas SQL pre-definidas. Todas apuntan a base SQL Server del POS.

### `merkahorro_venta_pos_dev` — Detalle de ventas

Campos clave: `CoDoc`, `ID_TIPO_DOCTO`, `CONSEC_DOCTO`, `FECHA_DOCTO`, `NitTercero`, `id_item`, `CANTIDAD`, `VALOR_BRUTO`, `vlr_tot_dscto`, `UNIDAD_MEDIDA`, `BODEGA`, `tipo_inv_serv`, `unidad_de_negocio`.

Filtro en código: excluye `f9820_id_cliente_pdv = '222222222222'`.

### `merkahorro_pagos_pos_dev` — Medios de pago

Campos: `CONSEC_DOCTO`, `MEDIO_PAGO`, `VALOR`.
Filtro fijo en query: `MedioPago.f9821_id_medio_pago = 'EFE'`.

### `merkahorro_imptos_pos_dev` — Impuestos por línea

Campos: `CONSEC_DOCTO`, `RowidMvto`, `id_impto`, `tipo_impto`, `TASA`, `VALOR`.

### `merkahorro_cajas_pos_dev` — Cierre de caja

Campos: `CONSEC_DOCTO`, `MEDIO_PAGO`, `TOTAL_CAJA`.

### `merkahorro_Cliente_pos_dev` — Maestra de clientes

Campos: todos los datos del cliente. Excluye `NIT = '222222222222'`.

### `merkahorro_consulta_inventario` — Stock por bodega

Query sin `TOP` ni `ORDER BY`. Filtra `f400_cant_existencia_1 > 0` y `f150_id_cia = 1`.
~47,900 registros, paginado a 1000.

### `merkahorro_costo_promedio_dev` — Costo por instalación

Lectura de costo desde `t132_mc_items_instalacion.f132_costo_prom_uni`.

### `merkahorro_venta_pos_stats_dev` — Estadísticas POS

Usada para el resumen diario. Igual que `merkahorro_venta_pos_dev` pero **sin** filtro de cliente genérico (incluye 222222222222 para conteo de genéricas). Solo Z01/Z02.

---

## 7. Limitaciones de Connekta

| Limitación | Impacto |
|------------|---------|
| No acepta `@variables` | Traer superset y filtrar en Node |
| No acepta `ORDER BY` sin `TOP`/`OFFSET` | Inventario sin orden |
| `tamPag` máximo = 1000 | Paginación obligatoria en grandes queries |
| Pool pesado causa `ECONNRESET` | Usar `PAGINACION_CONCURRENCIA` (default 4) |
| Claves con tildes (`tamaño_página`) | Búsqueda case-insensitive por substring |
| Ventana de fecha: últimos 2 días | Las queries de ventas solo traen 2 días |

---

## 8. Flujo de sincronización (syncVentas)

### Orden de ejecución (desde `server.js`)

```
POST /api/sync-ventas → syncVentas({ co?, caja?, consecs?, limite?, todas?, soloHoy? })
```

### Pasos internos

```
syncVentas()
├── 1. fetchVentasDesdePOS()
│     → Consulta Connekta (ventas, pagos, impuestos, cajas)
│     → Agrupa por CONSEC_DOCTO
│     → Filtra por CO/Caja (en memoria, no en SQL)
│     → Filtra idempotencia (omite OKs previos, omite ICOs)
│     → Si CONSEC_ESPECIFICOS: ignora CO/Caja/soloHoy
│     → Detecta ICO en meta.impuestos (ver sección 14)
│
├── 2. ejecutarPaso(1, ...)  → CNZ (Notas Crédito)
│     → Construye payload Siesa
│     → Recalcula impuestos
│     → Cuadre de caja direccional
│     → Envía a Siesa con concurrencia
│     → Si falla: auto-corrección (CPE/syncPOS) + reintento
│     → Guarda resultado en Supabase
│
├── 3. ejecutarPaso(3, ...)  → CFZ (Facturas)
│     → Mismo flujo, pero con pagos reales
│     → Detecta ICO → no envía, registra con estado 'ICO'
│
├── 4. logger.guardarCorrida(resumen)
│     → Snapshot en sps_corridas
│     → Mergea resultados ICO como ok: true
│
└── 5. guardarEstadisticasDiarias()
      → Snapshot diario en sps_estadisticas_diarias
```

### CNZ primero, CFZ después

La CNZ (entrada de inventario) asegura stock primero. Cuando el CFZ (salida) consume inventario, las unidades ya existen. Esto reduce rebotes por `"Item sin cantidad disponible"`.

### `ejecutarSyncVentas` — Firma

```js
syncVentas({
  co: "001,003",      // Filtro CO (opcional)
  caja: "Z01,Z02",    // Filtro caja (opcional)
  consecs: [...],     // Consecs específicos (opcional)
  limite: 10,         // Límite de facturas (opcional)
  todas: true,        // Ignora LIMITE_FACTURAS (opcional)
  soloHoy: true       // Solo facturas de hoy (opcional)
})
```

### Idempotencia — Clave compuesta

Cada factura se identifica con: `{tipo}:{co}:{caja}:{consec}` (ej. `CFZ:001:Z01:63951`).

### Impuestos — Extracción y recálculo

Se extraen en `meta.impuestos` desde `payload.Movimientos`/`payload.Descuentos` (líneas ~1160-1203 de syncVentas.js):

```js
// Por cada movimiento con impuesto
meta.impuestos.push({
  NRO_REGISTRO: ...,
  ID_LLAVE_IMPUESTO: "...",   // IV03, IV04, ICO
  TASA: ...,
  BASE_GRAVABLE: ...,
  VALOR_TOTAL: Math.round(...)
})
```

`BASE_GRAVABLE` se computa solo en `meta.impuestos` — **no** se agrega al array `Impuestos` que va a Siesa.

**Impuesto dedup:** se usa un `Set("RowidMvto|ID_LLAVE_IMPUESTO")` para evitar duplicados (primera aparición gana).

### Convergencia Cartera vs CxC

Cuando `VALOR_TOTAL` del CxC no coincide exactamente con la cartera del CFZ, y la diferencia `|delta| ≤ $10`:
- Se fuerza el estado a `SIN_RECAUDO` (en lugar de FALLO)
- Se marca `cxcConvergido: true`
- En el frontend aparece un callout amarillo indicando que falta completar el recaudo manualmente

### ICO — Detección y skip

Ver sección [14 - ICO](#14-ico--impuesto-al-consumo).

---

## 9. Documentos enviados a Siesa

### CFZ (Factura de Venta)

| Campo | Valor |
|-------|-------|
| Concepto | 501 |
| Clase | 522 |
| Naturaleza | 2 (Egreso) |
| Motivo | "03" |
| Auto consec | "1" |
| Medios de pago | Reales (del POS) |

### CNZ (Nota Crédito)

| Campo | Valor |
|-------|-------|
| Concepto | 502 |
| Clase | 525 |
| Naturaleza | 1 (Ingreso) |
| Motivo | "03" |
| Auto consec | "1" |
| Medios de pago | **Forzado a EFE** |

### CPE (Ajuste de Inventario)

| Campo | Valor |
|-------|-------|
| Concepto cabecera | 601 |
| Clase | 61 |
| Motivo | "17" |
| C.O. | "001" (fijo) |
| C.O. MOVIMIENTO | CO de la factura (dinámico) |
| UNIDAD_NEGOCIO | Desde `unidad_de_negocio` de Connekta |

---

## 10. Reglas de negocio críticas

### Recálculo de IVA

`VLR_IMPTO = Math.round((VALOR_BRUTO - vlr_tot_dscto) * TASA / 100)` — solo para tasas > 0. ICO se envía tal cual (`VALOR_TOTAL > 0`).

### normalizarUM()

| Entrada | Salida |
|---------|--------|
| P6, P12, P24 | UND |
| KG, LT | KG, LT (se respeta) |
| Vacío | UND |
| Otros | Tal cual |

### Ajuste de caja direccional

| Caso | Acción |
|------|--------|
| `dif > 0` (sobra) | Agrega línea EFE+ extra |
| `dif < 0` + hay EFE | Resta del EFE existente |
| `dif < 0` + no EFE | Resta proporcional DOM/TR2 |
| `\|dif\| > 5` | Warning, no ajusta |

### Filtro ICO

Documentos con `VALOR_TOTAL === 0` no se envían (Siesa lo auto-agrega).

### Servicios en CPE

Items con `tipo_inv_serv` iniciando en `S-` (ej. `S-OTRIPV`) no se inyectan en ajustes de inventario.

### ICO — Regla de no envío

Facturas con `ID_LLAVE_IMPUESTO = 'ICO'` en `meta.impuestos` **no se envían a Siesa**. Se registran con estado `'ICO'` para trazabilidad. Ver sección [14 - ICO](#14-ico--impuesto-al-consumo).

---

## 11. Lógica de auto-corrección

Cuando Siesa rechaza un documento, se analiza y dispara la corrección antes de reintentar (hasta `MAX_RONDAS_AJUSTE` veces).

| Error Siesa | Categoría | Acción automática |
|-------------|-----------|-------------------|
| "cliente no existe" | CLIENTE_FALTANTE | syncPOS(NIT) → reintenta |
| "Item sin cantidad disponible" | INVENTARIO_INSUFICIENTE | CPE (ajuste 601/17) → reintenta |
| "El item no existe" | ITEM_INEXISTENTE | Reporta en errores_maestras |
| "unidad de medida no existe" | UM_INEXISTENTE | Reporta en errores_maestras |
| "No existe equivalencia" | EQUIVALENCIA_FALTA | Reporta en errores_maestras |
| "punto de envío" | PUNTO_ENVIO_FALTA | Reporta en errores_maestras |

**Reintento de cortesía:** si `ajustarInventario` lanza error, se reintenta el documento una vez más (por si el stock se inyectó parcialmente de otra factura concurrente). Solo si falla 2 veces seguidas se marca FALLO.

---

## 12. Idempotencia

- Clave compuesta: `{tipo}:{co}:{caja}:{consec}`
- Facturas en estado `OK` o `ICO` → se omiten (no se reintentan)
- Facturas en `FALLO` → se reintentan (intentos++)
- Forzar reproceso: marcar manualmente en BD como no-OK o cambiar estado

**ICO en idempotencia:** `obtenerConsecsExitosos()` en `logger.js` usa `estado IN ('OK', 'ICO')`. Las facturas con ICO no se vuelven a procesar ni reintentar.

---

## 13. Categorías de error

| Categoría | Regex de detección |
|-----------|-------------------|
| CLIENTE_FALTANTE | `cliente no existe` |
| INVENTARIO_INSUFICIENTE | `Item sin cantidad disponible` |
| ITEM_INEXISTENTE | `El item - extension no existe` |
| UM_INEXISTENTE | `unidad de medida.*no existe` |
| EQUIVALENCIA_FALTA | `No existe equivalencia` |
| PUNTO_ENVIO_FALTA | `punto de envío` |
| DATO_INVALIDO | `El valor.*no es válido` |
| CAMPO_LARGO | `excede el largo del campo` / `demasiado largo` |
| CARTERA_CXC | `CARTERA` (convergencia) |
| OTRO | Cualquier otro |

---

## 14. ICO — Impuesto al Consumo

### ¿Qué es ICO?

El **Impuesto al Consumo** (ICO) es un impuesto colombiano que aplica a productos específicos (cervezas, gaseosas). En Siesa, estos documentos no se procesan mediante el plano estándar de facturación — requieren un tratamiento manual.

### Flujo ICO en el sincronizador

Cuando una factura del POS contiene ítems gravados con ICO:

1. **Detección:** Durante la construcción del payload para Siesa, se extraen los impuestos a `meta.impuestos`. Si algún impuesto tiene `ID_LLAVE_IMPUESTO = 'ICO'`, la factura se marca como ICO.

2. **Skip (no envío):** La factura **no se envía a Siesa**. No se llama al endpoint `conectoresimportar`. En su lugar, se recolecta en un array `icoskips[]` durante el procesamiento.

3. **Registro post-loop:** Después del loop de envíos, se registra cada factura ICO en Supabase mediante `registrarResultado` con `estadoOverride: 'ICO'`. Esto persiste **todos los datos**: consecutivo, tipo, neto, items, impuestos, fecha, cliente, etc.

4. **Resumen de corrida:** Los resultados ICO se mergean en el array `resultados` con `ok: true` para que el resumen final (`Total: X | OK: Y | FALLO: Z`) cuente las ICO como exitosas. El contador no se descuadra.

5. **Idempotencia:** `obtenerConsecsExitosos()` incluye `estado IN ('OK', 'ICO')`. Las facturas marcadas ICO nunca se reintentan automáticamente.

### Código clave (syncVentas.js)

```js
// ~line 1138: Inicialización
const icoskips = [];

// ~line 1181 (CNZ) y ~line 1218 (CFZ): Detección
const impuestosMeta = meta.impuestos || [];
if (impuestosMeta.some(imp => imp.ID_LLAVE_IMPUESTO === 'ICO')) {
  icoskips.push({ consecutivo, tipo, meta });
  continue; // No envía a Siesa
}

// ~line 1236: Registro post-loop
for (const skip of icoskips) {
  await logger.registrarResultado(
    { consecutivo: skip.consecutivo, tipo: skip.tipo, ok: true,
      estadoOverride: 'ICO',
      mensaje: 'ICO detectado — envío manual en Siesa' },
    meta
  );
}
```

### Frontend — Visualización ICO

- **Badge azul** `sps-estado-ico` en la columna Estado de `FacturasTable`
- **Filtro** "Solo ICO" en el dropdown de estados
- **Botón Reintentar** no aparece (solo para FALLO/SIN_RECAUDO)
- **ModalDetalle** muestra todos los datos de la factura (items, impuestos, neto, cliente)
- **Descripción de impuesto** en tarjetas: "IMPUESTO AL CONSUMO" como label, "ICO" como secundario

### Trabajo manual requerido

Las facturas con ICO requieren que un usuario cree el documento manualmente en Siesa. El sistema provee **todos los datos** para facilitar el proceso:

| Dato | Dónde verlo |
|------|------------|
| Consecutivo, Tipo, CO, Caja | Badge ICO + tabla de facturas |
| Items, cantidades, valores | Modal detalle (ojo 👁️) |
| Impuestos desglosados | Tarjetas de impuestos en modal |
| Neto total | Modal detalle |
| Fecha y cliente | Modal detalle |

### TAX_DESCRIPTIONS (helpers.js — frontend)

Constante compartida entre `ModalDetalle.jsx` y `helpers.js`:

```js
const TAX_DESCRIPTIONS = {
  'IV02': 'IVA 5% BIENES',
  'IV03': 'IVA 19% BIENES',
  'IV04': 'IVA 19% SERVICIOS',
  'IV05': 'IVA 19% HONORARIOS',
  'IV06': 'IVA 19% ARRENDAMIENTOS',
  'IV07': 'IVA 19% CERVEZA',
  'IV08': 'IVA DEL 19% EN GASEOSAS',
  'ICO': 'IMPUESTO AL CONSUMO'
};

function getTaxDescription(llave) {
  return TAX_DESCRIPTIONS[llave] || llave;
}
```

Se usa en:
- **ModalDetalle:** label principal de tarjetas de impuestos (descripción) + `small` con llave + tooltip
- **Backend `resumen-impuestos`:** descripción en el response de `porLlave[]`
- **Dashboard:** tarjetas de impuestos en sección "Resumen de Impuestos"

---

## 15. Dashboard — Frontend React

### Vistas (sidebar)

| Vista | Componente | Descripción |
|-------|-----------|-------------|
| Dashboard | `DashboardSiesaPos` | KPIs + gráficas + resumen diario + impuestos + ajustes |
| Trazabilidad | `TrazabilidadPanel` | Detalle por CO/Caja con documentos |
| Historial Facturas | `FacturasTable` | Tabla filtrable con acciones (incl. filtro ICO) |
| Corridas | `HistorialCorridas` + `ErroresMaestras` | Ejecuciones y maestras |
| Ajustes Inv. | `AjustesInventario` | Tabla de ajustes CPE |

### KPICards (6 tarjetas)

1. **Facturas procesadas por el flujo** — Total deduplicado + neto sincronizado
2. **Facturas genéricas POS** — Transacciones genéricas (222222 + sin NIT) + neto
3. **Neto total facturado (POS)** — Neto total + promedio/día
4. **% Neto flujo real** — Porcentaje del neto que es real vs genérico
5. **% Flujo real vs genérico** — Porcentaje por transacciones
6. **Última corrida** — Tiempo transcurrido + fecha completa

### DashboardCharts (5 gráficas)

1. **Tendencia de facturas** — Stacked area: OK vs Fallo por día
2. **Neto facturado por caja** — Barra: Z01 vs Z02
3. **Genérico vs Real — Transacciones** — Stacked bar diario
4. **Genérico vs Real — Neto** — Stacked area diaria
5. **Resumen del período** — Donut gen/real + mini KPIs

### Sección "Resumen de Impuestos" (Dashboard)

Aparece debajo de las gráficas en `DashboardSiesaPos.jsx`. Muestra:

- **Header** con total base, total impuestos, total facturas
- **Grid** de tarjetas por llave de impuesto (IV03, IV04, ICO, etc.):
  - Descripción del impuesto + código de llave
  - Base Gravable formateada
  - Valor Total del impuesto
  - Cantidad de registros
- Fetch vía `getResumenImpuestos(desde, hasta)` en el mismo useEffect del dashboard

### Sección "Ajustes de Inventario" (Dashboard)

Debajo de "Resumen de Impuestos". Muestra 3 tarjetas:

| Tarjeta | Descripción |
|---------|-------------|
| Productos ajustados | Ítems únicos en el período |
| Unidades ajustadas | Suma total de cantidades |
| Valor total ajustado | Suma de (cantidad × costo) |

Fetch vía `getResumenAjustes(desde, hasta)` en el mismo useEffect.

### ModalDetalle (al hacer clic en 👁️)

Secciones:
1. Grid informativo: Fecha, Cliente NIT, CO·Caja, Items, Neto, Intentos, Última corrida, **Impuestos por llave** (una tarjeta por IV03/IV04/ICO con descripción + llave + tooltip)
2. Tabla de Impuestos (línea por línea)
3. Callout SIN_RECAUDO (si aplica)
4. Automatizaciones aplicadas
5. Tabla CPE (ajustes de inventario)
6. Error (si aplica)
7. JSON crudo (colapsable)

### AjustesInventario

Tabla plana con todos los ajustes CPE: Consec, Tipo, CO, Caja, Fecha, Ítem, Bodega, Cantidad, UN, Costo Und., **Valor Total** (cantidad × costo, verde). Botón 👁️ abre modal de la factura relacionada.

Tarjetas resumen arriba de la tabla:
- Productos ajustados (ítems únicos)
- Unidades ajustadas (suma cantidades)
- Valor total ajustado (suma cantidad × costo)

Búsqueda por consec, ítem o bodega.

### FacturasTable — Filtro ICO

En el dropdown de filtro de estados se agregó la opción **"Solo ICO"** que filtra las facturas con `estado === 'ICO'`. Las filas ICO se muestran con badge azul (`.sps-estado-ico`). El botón "Reintentar" se oculta para estas filas.

### ResumenDiario

- Rango de fechas con presets (Hoy, 7 días, Este mes, Personalizado)
- Filtro por caja (Todas, Z01, Z02)
- 3 tarjetones: Total transacciones, Neto sincronizado, Genéricos
- Desglose por caja
- POS vs Sincronizado

---

## 16. Componentes del Frontend

| Componente | Props | Estado interno |
|-----------|-------|---------------|
| `SiesaPosSync` | — | data, vista, modals, polling |
| `DashboardSiesaPos` | `data` | desde, hasta, estadisticas, resumenImpuestos, resumenAjustes |
| `KPICards` | `facturas, ultimaCorrida, estadisticas` | — |
| `DashboardCharts` | `facturas, estadisticas` | — |
| `ResumenDiario` | — | fechaInicio, fechaFin, cajaActiva, data, loading |
| `TrazabilidadPanel` | `data, onVerDetalle` | busqueda, seleccion |
| `FacturasTable` | `data, onRefrescar, onVerDetalle` | filtros (incl. ICO), pagina |
| `ModalDetalle` | `factura, onClose` | — |
| `AjustesInventario` | `facturas, onVerDetalle` | rows, loading, busqueda, pagina |
| `ActionsPanel` | `onRunningChange, onAfterRun` | modo, consecs, limite, co, caja, ejecutando, resultado |
| `HistorialCorridas` | `refrescarKey` | corridas, expandido |
| `ErroresMaestras` | `contenido` | copiado |
| `Paginacion` | `pagina, totalPaginas, onCambio, totalItems, porPagina, onPorPagina, unidad` | — |
| `ReportesPanel` | — | config, historial, generando |

### Helpers (`helpers.js`)

| Función | Descripción |
|---------|-------------|
| `formatoCOP(n)` | Formato COP (es-CO, 0 decimales) |
| `formatoFecha(iso)` | Fecha local Colombia |
| `tiempoTranscurrido(iso)` | "hace 5m", "hace 2h" |
| `hoyBogota()` | Fecha hoy en YYYY-MM-DD (Colombia) |
| `haceDias(n)` | Fecha hace N días |
| `dedupFacturas(filas)` | Deduplica CNZ+CFZ → una factura (peor estado gana) |
| `filtrarPorRango(filas, desde, hasta)` | Filtra por rango de fecha |
| `getTaxDescription(llave)` | Retorna descripción legible de llave de impuesto |

### Servicio (`siesaPosSyncService.js`)

Endpoints consumidos vía axios (base URL de `VITE_SIESA_POS_SYNC_URL`, fallback `localhost:4000`):

| Función | Método | Ruta |
|---------|--------|------|
| `getLogs(filtros)` | GET | `/api/logs` |
| `getCorridas(limit)` | GET | `/api/logs/corridas` |
| `getResumenDiario(...)` | GET | `/api/logs/resumen-diario` |
| `getEstadisticas(...)` | GET | `/api/logs/estadisticas` |
| `getAjustes()` | GET | `/api/logs/ajustes` |
| **`getResumenImpuestos(desde, hasta)`** | **GET** | **`/api/logs/resumen-impuestos`** |
| **`getResumenAjustes(desde, hasta)`** | **GET** | **`/api/logs/resumen-ajustes`** |
| `ejecutarSyncVentas(...)` | POST | `/api/sync-ventas` |
| `ejecutarSyncClientes()` | POST | `/api/sync-clientes` |
| `generarReporte(opts)` | POST | `/api/reportes/generar` |
| `getConfigReportes()` | GET | `/api/reportes/config` |
| `saveConfigReportes(cfg)` | POST | `/api/reportes/config` |
| `getHistorialReportes(limit)` | GET | `/api/reportes/historial` |
| `ping()` | GET | `/api/logs?limit=1` |

---

## 17. GitHub Actions — Workflows

### `sync-pos.yml` — Sincronización cada 1h

```yaml
schedule: '0 * * * *'   # Cada hora en punto UTC
workflow_dispatch:       # Manual con inputs co/caja
```

Ejecuta `node scripts/runSyncCron.js` con:
- `CO=001`, `Cajas=Z01,Z02` (fijo para PROD)
- `todas=true` (procesa todas las facturas filtradas)
- `soloHoy=true` (solo facturas de hoy)

**Variables de entorno (GitHub Secrets):** CONNI_KEY, CONNI_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY, CIA, ENTORNO_SIESA, CONCURRENCIA, PAGINACION_CONCURRENCIA, MAX_RONDAS_AJUSTE.

**Comportamiento:** el runner de GitHub Actions ejecuta el script Node directamente (no vía el endpoint de Vercel), así se evita el timeout serverless (el runner tiene hasta 6h).

**Caveats:** El cron se deshabilita tras ~60 días sin actividad. Con `soloHoy`, fallos de días anteriores no se reintentan automáticamente.

### `report-pos.yml` — Reportes diarios

Envía reportes PDF automáticos según la programación configurada.

---

## 18. Scripts de diagnóstico

| Script | Propósito | Uso |
|--------|-----------|-----|
| `runSyncCron.js` | Orquestador para GitHub Actions | `node scripts/runSyncCron.js` |
| `runReporte.js` | Generar reporte vía CLI | `node scripts/runReporte.js` |
| `reprocesarConsec.js` | Reprocesar consecs específicos | `node scripts/reprocesarConsec.js 123,456` |
| `testUM.js` | Prueba de `normalizarUM()` | `node scripts/testUM.js` |
| `testCarteraCxC.js` | Prueba convergencia cartera vs CxC | `node scripts/testCarteraCxC.js` |
| `testStatsPOS.js` | Prueba queries de stats | `node scripts/testStatsPOS.js` |
| `testImpuestos.js` | Prueba extracción de impuestos | `node scripts/testImpuestos.js` |
| `testClienteFaltante.js` | Simula error cliente | `node scripts/testClienteFaltante.js` |
| `testNitGenerico.js` | Prueba filtro NIT genérico | — |
| `testPagoConsec.js` | Prueba pago por consec | — |
| `testFacturasSinPago.js` | Diagnóstico facturas sin pago | — |
| `testResumenRango.js` | Prueba resumen por rango | — |
| `testItemMapping.js` | Prueba mapeo de items | — |
| `testCxcFix.js` | Prueba fix CxC | — |
| `diagnosticoCarteraCxC.js` | Diagnóstico cartera vs CxC | — |

---

## 19. Deploy

### Backend (Vercel)

```json
// vercel.json
{
  "builds": [{ "src": "server.js", "use": "@vercel/node" }],
  "routes": [{ "src": "/(.*)", "dest": "server.js" }]
}
```

URL: `https://siesa-pos-sync.vercel.app`

Deploy automático: `git push origin main` → Vercel redeployea.

### Frontend (Vercel)

```bash
VITE_SIESA_POS_SYNC_URL=https://siesa-pos-sync.vercel.app
npm run build
```

### Variables en Vercel

Todas las variables de `.env` se configuran en el dashboard de Vercel (excepto `PORT`).

---

## 20. Resolución de problemas comunes

### Error 405 en Vercel

El endpoint de Vercel solo acepta el método configurado. Verificar `vercel.json` y que `app` se exporte correctamente (`module.exports = app`).

### Consec sin NIT

Facturas donde `f9820_id_cliente_pdv` está vacío o no tiene NIT real. Se tratan como genéricas. Para evitarlo hacia adelante, el sync ahora identifica clientes primero.

### Caja=0 sin código fix

Ocurre cuando una factura no tiene pagos registrados en Connekta. El código no puede fijarlo — hay que revisar los datos en Connekta.

### Doble conteo en rango de fechas

Resuelto: el endpoint `resumen-diario` excluye el día de hoy de `sps_estadisticas_diarias` (`.lt('fecha', hoy)`) si ya se consultó Connekta en vivo.

### Históricos sin datos (11/06 → 18/06)

Se corrigió insertando manualmente datos en `sps_estadisticas_diarias` extraídos de Siesa vía Excel, día por día. Antes de esa corrección, los días sin snapshot no tenían datos de genéricos.

### ICO — Factura no se envía a Siesa

Si una factura tiene ICO, el sistema la salta automáticamente. No es un error. Ver sección [14 - ICO](#14-ico--impuesto-al-consumo). Si se necesita forzar el envío, cambiar el estado manualmente en BD de `'ICO'` a `'FALLO'` (o eliminar el registro).

---

## 21. Historial de cambios

### Junio 2026 (semana 5)
- **ICO skip flow:** detección en `syncVentas.js` + registro con estado `'ICO'` + idempotencia (`obtenerConsecsExitosos` incluye `'ICO'`)
- Nuevo endpoint `GET /api/logs/resumen-impuestos` con dedup, agregación por llave, `TAX_DESCRIPTIONS`
- Nuevo endpoint `GET /api/logs/resumen-ajustes` con agregación de CPEs (items, valor, productos)
- Dashboard secciones "Resumen de Impuestos" y "Ajustes de Inventario" en `DashboardSiesaPos.jsx`
- Badge ICO azul (`.sps-estado-ico`) + filtro "Solo ICO" en `FacturasTable.jsx`
- `TAX_DESCRIPTIONS` + `getTaxDescription()` en `helpers.js` (frontend y backend)
- Descripciones de impuestos en `ModalDetalle.jsx` (tarjetas con descripción + llave + tooltip)
- `getResumenImpuestos()` y `getResumenAjustes()` en `siesaPosSyncService.js`
- CSS para `.sps-dash-impuestos`, `.sps-tax-card`, `.sps-estado-ico`
- Documentación completa actualizada

### Junio 2026 (semana 4)
- Nuevo endpoint `/api/logs/ajustes` + componente `AjustesInventario.jsx`
- Tarjetas de impuestos por llave en `ModalDetalle.jsx`
- Fix CSS: unclosed block `.sps-modal-tax-cards`
- Backend endpoint resumen-impuestos + resumen-ajustes

### Junio 2026 (semana 3)
- KPICards rediseñado: 6 tarjetas, eliminadas "Fallidas" y "Exitosas (OK)"
- DashboardCharts simplificado: 5 gráficas (eliminadas 4 redundantes)
- ResumenDiario: híbrido POS vs Sync, rango fechas
- Fix doble conteo hoy en rango
- Datos históricos corregidos (11/06 → 18/06)
- Endpoint `/api/logs/estadisticas`
- Tabla `sps_estadisticas_diarias` + `guardarEstadisticasDiarias`

### Junio 2026 (semana 2)
- Consec 639 resuelto (cliente ANAVA creado manualmente)
- Consec 1489 resuelto (documento creado manualmente)
- Filtro ICO (`VALOR_TOTAL > 0`)
- IVA Math.round
- Convergencia Cartera vs CxC (delta ≤ $10, `SIN_RECAUDO`)
- `BASE_GRAVABLE` fix (no contamina array Impuestos)
- Impuesto dedup (Set `RowidMvto|ID_LLAVE_IMPUESTO`)
- `normalizarUM()`: P6/P12/P24 → UND
- GitHub Actions cada 2h → cada 1h

### Junio 2026 (semana 1)
- Deploy a PRODUCCIÓN (Vercel)
- Filtro EFE en query pagos
- CO/Caja dinámico en CPE
- Reportes PDF mejorados
- Scripts de diagnóstico creados

### Mayo 2026
- Migración de archivos JSON → Supabase
- Renombrado CNC→CNZ, CFE→CFZ
- Motivos actualizados (03 para CFZ/CNZ, 17 para CPE)
- Auto-corrección con reintento acotado
- Costo promedio por instalación
- Filtros CO/Caja dinámicos
- GitHub Actions implementado

---

## Contacto / Soporte

**Backend:** `siesa-pos-sync` (este repo)
**Frontend:** `Pagina-web_React` (`src/pages/SiesaPosSync/`)
**URL Producción:** `https://siesa-pos-sync.vercel.app`
**Base de datos:** Supabase (PostgreSQL)

Para modificar queries Connekta:
- No agregar `TOP` ni `ORDER BY` (los rompe Connekta)
- Ventana de fecha máxima: 2 días (las queries no pagan)
- Nuevos items de inventario: agregar al `CASE` en `merkahorro_venta_pos_dev`
