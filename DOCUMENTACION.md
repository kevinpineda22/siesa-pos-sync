# Sincronizador POS → Siesa PROD — Documentación Completa

**Última actualización:** 23 de Junio de 2026

Backend Node.js + Frontend React que sincroniza ventas de un POS hacia el ERP Siesa PROD, con auto-corrección, trazabilidad completa e idempotencia.

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
14. [Dashboard — Frontend React](#14-dashboard--frontend-react)
15. [Componentes del Frontend](#15-componentes-del-frontend)
16. [GitHub Actions — Workflows](#16-github-actions--workflows)
17. [Scripts de diagnóstico](#17-scripts-de-diagnóstico)
18. [Deploy](#18-deploy)
19. [Resolución de problemas comunes](#19-resolución-de-problemas-comunes)
20. [Historial de cambios](#20-historial-de-cambios)

---

## 1. Visión general

El sistema toma las ventas del POS (consultadas vía Connekta) y las replica como documentos contables en Siesa PROD mediante su API de importación de planos (`conectoresimportar`). Incluye un **dashboard en React** para monitoreo en tiempo real.

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
├── server.js                  # Express: 12 endpoints HTTP
├── syncVentas.js              # Motor principal de sincronización
├── syncPOS.js                 # Sincronización de clientes
├── logger.js                  # Trazabilidad + Supabase
├── reportes.js                # Generación PDF + envío SMTP
├── vercel.json                # Config Vercel serverless
├── package.json
├── .env                       # Credenciales (NO commitear)
├── DOCUMENTACION.md           # Este archivo
├
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

### Frontend — `Pagina-web_React/`

```
src/pages/SiesaPosSync/
├── SiesaPosSync.jsx           # Layout principal + sidebar
├── SiesaPosSync.css           # ~2750 líneas de estilos
├── ReportesPanel.jsx          # Config/generación de reportes
├── ReportesPanel.css          # Estilos reportes
│
└── components/
    ├── DashboardSiesaPos.jsx  # Vista Dashboard
    ├── KPICards.jsx           # 6 tarjetas KPI
    ├── DashboardCharts.jsx    # 5 gráficas (Recharts)
    ├── ResumenDiario.jsx      # Resumen diario POS vs Sync
    ├── TrazabilidadPanel.jsx  # Trazabilidad CO/Caja
    ├── FacturasTable.jsx      # Tabla de facturas con filtros
    ├── ModalDetalle.jsx       # Modal detalle de factura
    ├── AjustesInventario.jsx  # Tabla de ajustes CPE
    ├── HistorialCorridas.jsx  # Historial de ejecuciones
    ├── ErroresMaestras.jsx    # Errores de maestras
    ├── ActionsPanel.jsx       # Panel de acciones (sync)
    ├── helpers.js             # Funciones utilitarias
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
| `estado` | TEXT | OK / FALLO / SIN_RECAUDO |
| `fecha_factura` | TEXT | Fecha de la factura |
| `cliente_nit` | TEXT | NIT del cliente |
| `items` | INTEGER | Cantidad de items |
| `neto` | NUMERIC | Valor neto |
| `intentos` | INTEGER | Intentos realizados |
| `categoria_error` | TEXT | Categoría del error |
| `error` | JSONB | Detalle del error |
| `impuestos` | JSONB | Array de impuestos extraídos |
| `cpe_items` | JSONB | Array de ajustes de inventario |
| `automatizaciones_aplicadas` | JSONB | Array de acciones tomadas |
| `cxcConvergido` | BOOLEAN | Si se aplicó convergencia cartera vs CxC |
| `primera_corrida` | TIMESTAMPTZ | Primera vez que se procesó |
| `ultima_corrida` | TIMESTAMPTZ | Última vez que se procesó |

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
| `/api/reportes/config` | — | Configuración de reportes |
| `/api/reportes/historial` | `limit` | Historial de reportes |

### Acción (POST)

| Ruta | Body | Descripción |
|------|------|-------------|
| `/api/sync-ventas` | `{ consecs?, limite?, co?, caja? }` | Ejecuta sincronización |
| `/api/sync-clientes` | — | Sincroniza clientes POS → Siesa |
| `/api/reportes/generar` | `{ periodo, fecha_inicio, fecha_fin, destinatarios }` | Genera y envía PDF |
| `/api/reportes/config` | `{ destinatarios, programacion, hora_envio, dia_semana, activo }` | Guarda configuración |

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

### Ejemplo: `GET /api/logs/ajustes`

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
│     → Filtra idempotencia (omite OKs previos)
│     → Si CONSEC_ESPECIFICOS: ignora CO/Caja/soloHoy
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
│
├── 4. logger.guardarCorrida(resumen)
│     → Snapshot en sps_corridas
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
- Facturas en estado `OK` → se omiten
- Facturas en `FALLO` → se reintentan (intentos++)
- Forzar reproceso: marcar manualmente en BD como no-OK o cambiar estado

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

## 14. Dashboard — Frontend React

### Vistas (sidebar)

| Vista | Componente | Descripción |
|-------|-----------|-------------|
| Dashboard | `DashboardSiesaPos` | KPIs + gráficas + resumen diario |
| Trazabilidad | `TrazabilidadPanel` | Detalle por CO/Caja con documentos |
| Historial Facturas | `FacturasTable` | Tabla filtrable con acciones |
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

### ModalDetalle (al hacer clic en 👁️)

Secciones:
1. Grid informativo: Fecha, Cliente NIT, CO·Caja, Items, Neto, Intentos, Última corrida, **Impuestos por llave** (una tarjeta por IV03/IV04/ICO)
2. Tabla de Impuestos (línea por línea)
3. Callout SIN_RECAUDO (si aplica)
4. Automatizaciones aplicadas
5. Tabla CPE (ajustes de inventario)
6. Error (si aplica)
7. JSON crudo (colapsable)

### AjustesInventario (nuevo)

Tabla plana con todos los ajustes CPE: Consec, Tipo, CO, Caja, Fecha, Ítem, Bodega, Cantidad, UN, Costo. Botón 👁️ abre modal de la factura relacionada.

### ResumenDiario

- Rango de fechas con presets (Hoy, 7 días, Este mes, Personalizado)
- Filtro por caja (Todas, Z01, Z02)
- 3 tarjetones: Total transacciones, Neto sincronizado, Genéricos
- Desglose por caja
- POS vs Sincronizado

---

## 15. Componentes del Frontend

| Componente | Props | Estado interno |
|-----------|-------|---------------|
| `SiesaPosSync` | — | data, vista, modals, polling |
| `DashboardSiesaPos` | `data` | desde, hasta, estadisticas |
| `KPICards` | `facturas, ultimaCorrida, estadisticas` | — |
| `DashboardCharts` | `facturas, estadisticas` | — |
| `ResumenDiario` | — | fechaInicio, fechaFin, cajaActiva, data, loading |
| `TrazabilidadPanel` | `data, onVerDetalle` | busqueda, seleccion |
| `FacturasTable` | `data, onRefrescar, onVerDetalle` | filtros, pagina |
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

### Servicio (`siesaPosSyncService.js`)

Endpoints consumidos vía axios (base URL de `VITE_SIESA_POS_SYNC_URL`, fallback `localhost:4000`):

| Función | Método | Ruta |
|---------|--------|------|
| `getLogs(filtros)` | GET | `/api/logs` |
| `getCorridas(limit)` | GET | `/api/logs/corridas` |
| `getResumenDiario(...)` | GET | `/api/logs/resumen-diario` |
| `getEstadisticas(...)` | GET | `/api/logs/estadisticas` |
| `getAjustes()` | GET | `/api/logs/ajustes` |
| `ejecutarSyncVentas(...)` | POST | `/api/sync-ventas` |
| `ejecutarSyncClientes()` | POST | `/api/sync-clientes` |
| `generarReporte(opts)` | POST | `/api/reportes/generar` |
| `getConfigReportes()` | GET | `/api/reportes/config` |
| `saveConfigReportes(cfg)` | POST | `/api/reportes/config` |
| `getHistorialReportes(limit)` | GET | `/api/reportes/historial` |
| `ping()` | GET | `/api/logs?limit=1` |

---

## 16. GitHub Actions — Workflows

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

## 17. Scripts de diagnóstico

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

## 18. Deploy

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

## 19. Resolución de problemas comunes

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

---

## 20. Historial de cambios

### Junio 2026 (semana 4)
- Nuevo endpoint `/api/logs/ajustes` + componente `AjustesInventario.jsx`
- Tarjetas de impuestos por llave en `ModalDetalle.jsx`
- Fix CSS: unclosed block `.sps-modal-tax-cards`

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
