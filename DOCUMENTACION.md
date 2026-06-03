# Sincronizador POS → Siesa QA

Backend Node.js que sincroniza ventas de un POS (Punto de Venta) hacia el ERP Siesa QA, automatizando la creación de facturas, notas crédito, clientes y ajustes de inventario, con trazabilidad completa e idempotencia.

---

## Tabla de contenido

1. [Visión general](#1-visión-general)
2. [Arquitectura del proyecto](#2-arquitectura-del-proyecto)
3. [Variables de entorno (.env)](#3-variables-de-entorno-env)
4. [Endpoints HTTP](#4-endpoints-http)
5. [Queries Connekta usadas](#5-queries-connekta-usadas)
6. [Limitaciones de Connekta](#6-limitaciones-de-connekta)
7. [Flujo del proceso de sincronización](#7-flujo-del-proceso-de-sincronización)
8. [Documentos enviados a Siesa](#8-documentos-enviados-a-siesa)
9. [Mapeo de campos POS → Siesa](#9-mapeo-de-campos-pos--siesa)
10. [Reglas de negocio críticas](#10-reglas-de-negocio-críticas)
11. [Lógica de automatización (auto-corrección)](#11-lógica-de-automatización-auto-corrección)
12. [Sistema de logs y trazabilidad](#12-sistema-de-logs-y-trazabilidad)
13. [Idempotencia](#13-idempotencia)
14. [Errores comunes y cómo se manejan](#14-errores-comunes-y-cómo-se-manejan)
15. [Comandos útiles](#15-comandos-útiles)
16. [Tareas pendientes](#16-tareas-pendientes)

---

## 1. Visión general

El sistema toma las ventas registradas en el POS (consultadas vía Connekta - un middleware de Siesa que ejecuta SQL contra la base de datos del ERP) y las **replica como documentos contables en Siesa QA** mediante su API de importación de planos (`conectoresimportar`).

Por cada venta del POS se generan **2 documentos en Siesa**:

| Documento | Naturaleza | Concepto | Clase | Motivo | Descripción |
|-----------|------------|----------|-------|--------|-------------|
| **CFE** (Factura de Venta) | 2 (Egreso de inv.) | 501 | 522 | 01 | Saca el inventario, genera el ingreso |
| **CNC** (Nota Crédito) | 1 (Entrada de inv.) | 502 | 525 | 01 | Devuelve inventario, anula con efectivo |

**Importante:** la CNC se envía con método de pago **forzado a EFE** (efectivo), sin importar cómo pagó el cliente. Es así por requerimiento contable de Merkahorro.

Adicionalmente, si Siesa rechaza una factura por **cliente inexistente** o **falta de inventario**, el script se auto-repara:
- Lanza `syncPOS` para crear el cliente faltante.
- Inyecta el stock necesario mediante un documento **CPE (Ajuste de Inventario, 241913)**.
- Reintenta la factura.

---

## 2. Arquitectura del proyecto

```
siesa-pos-sync/
├── server.js              # Servidor Express con endpoints HTTP
├── syncVentas.js          # Motor principal: lee POS, arma CFE/CNC/CPE, envía a Siesa
├── syncPOS.js             # Sub-módulo: sincroniza maestra de clientes desde POS a Siesa
├── logger.js              # Sistema de trazabilidad (logs JSON atómicos)
├── verLog.js              # CLI para consultar logs (--pendientes, --consec, --maestras)
├── package.json
├── .env                   # Credenciales y configuración (NO commitear)
├── .gitignore             # Incluye logs/ y .env
├── DOCUMENTACION.md       # Este archivo
│
├── logs/                  # (auto-generado, no commiteado)
│   ├── facturas_procesadas.json    # Histórico maestro (idempotencia)
│   ├── facturas_pendientes.json    # Solo las que están en FALLO
│   ├── corrida_<timestamp>.json    # Snapshot por cada ejecución
│   └── errores_maestras_siesa.txt  # Reporte para contabilidad
│
└── *.json                 # Snapshots del último payload enviado (debug)
    ├── factura_generada.json
    ├── nota_credito_generada.json
    └── clientes_enviados_100.json
```

### Módulos principales

| Archivo | Responsabilidad |
|---------|-----------------|
| `server.js` | Expone los endpoints `POST /api/sync-clientes` y `POST /api/sync-ventas`. Llama a `syncVentas()` o `syncPOS()`. |
| `syncVentas.js` | Orquesta toda la lógica: lee facturas de Connekta, arma los planos para Siesa, calcula cuadre de caja, recalcula impuestos, ejecuta CNC → CFE, dispara auto-correcciones. |
| `syncPOS.js` | Lee los clientes del POS, los trunca a los límites varchar de Siesa, y los envía como `GenericTransfer` al ERP. Acepta una lista de NITs específicos para reducir el payload. |
| `logger.js` | Lee/escribe los archivos en `logs/` de forma **atómica** (`.tmp` + rename). Categoriza errores. Mantiene contadores de intentos y automatizaciones aplicadas. |
| `verLog.js` | CLI para consultar logs. |

---

## 3. Variables de entorno (.env)

```env
# Credenciales de Connekta (Siesa Cloud)
CONNI_KEY=...
CONNI_TOKEN=...

# Id de Compañía en Siesa (Merkahorro = 7375)
CIA=7375

# Cantidad de facturas a procesar por corrida en modo normal.
# Toma las más recientes del rango de Connekta (últimos 30 días).
LIMITE_FACTURAS=5

# Cuántas facturas se envían a Siesa en paralelo (Promise.allSettled).
# Subir gradualmente 2 → 5 → 10 según resistencia del Siesa QA.
CONCURRENCIA=5

# Si tiene consecs separados por coma (ej. "63870,63899,124267") se procesan
# SOLO esos e ignora LIMITE_FACTURAS. Útil para reprocesar facturas puntuales.
# Dejar vacío para modo normal (filtra por fecha + LIMITE_FACTURAS).
CONSEC_ESPECIFICOS=

# Paginación del query de inventario (Connekta NO acepta tamPag > 1000).
INVENTARIO_TAM_PAGINA=1000
INVENTARIO_MAX_PAGINAS=100

# Páginas que se descargan EN PARALELO del inventario/costo (pool acotado).
# Subir = más rápido; bajar a 2 o 1 si Connekta da ECONNRESET. Default 4.
PAGINACION_CONCURRENCIA=4

# Máx. rondas de auto-corrección (inyección de stock / sync cliente) por factura
# antes de marcarla en FALLO. Cada ronda inyecta lo NUEVO que reporte Siesa. Default 3.
MAX_RONDAS_AJUSTE=3

# Puerto del servidor Express
PORT=4000
```

---

## 4. Endpoints HTTP

| Método | Ruta | Descripción | Body |
|--------|------|-------------|------|
| `POST` | `/api/sync-clientes` | Ejecuta `syncPOS()` para sincronizar todos los clientes del POS hacia Siesa. | — |
| `POST` | `/api/sync-ventas` | Ejecuta `syncVentas()`: lee facturas POS, arma documentos, los envía a Siesa con auto-corrección. | — |
| `GET` | `/api/logs` | Devuelve facturas procesadas con filtros opcionales (ver query params abajo). | — |
| `GET` | `/api/logs/corridas` | Lista los snapshots `corrida_*.json` (más reciente primero). | — |

### Query params de `GET /api/logs`

| Param | Ejemplo | Efecto |
|-------|---------|--------|
| `estado` | `OK` o `FALLO` | Filtra por estado |
| `tipo` | `CFE`, `CNC`, `CPE` | Filtra por tipo de documento |
| `categoria` | `CLIENTE_FALTANTE`, `INVENTARIO_INSUFICIENTE`, etc. | Filtra por categoría de error |
| `consec` | `63951` | Devuelve solo ese consec |
| `limit` | `50` | Máximo de registros (default 200) |
| `solo_pendientes` | `1` | Atajo equivalente a `estado=FALLO` |

### Respuesta de `GET /api/logs`

```json
{
  "success": true,
  "resumen": {
    "total": 1247,
    "ok": 1198,
    "fallo": 49,
    "pendientes_unicos": 49,
    "ultima_corrida": "2026-05-25T14:33:12.011Z"
  },
  "count": 200,
  "data": [ /* facturas */ ],
  "errores_maestras": "texto plano del reporte para contabilidad"
}
```

**Respuesta exitosa:**
```json
{
  "success": true,
  "data": {
    "total": 4,
    "ok": 4,
    "fail": 0,
    "detalle": [ /* array con cada factura procesada */ ]
  }
}
```

---

## 4.b Inventario de archivos del proyecto

Esta sección describe **qué hace cada archivo** del repo, para que cualquier desarrollador o IA pueda navegar el código rápidamente.

### Archivos de código (raíz)

| Archivo | Tipo | ¿Qué hace? |
|---------|------|------------|
| **`server.js`** | Entry point HTTP | Servidor Express. Levanta los endpoints `POST /api/sync-clientes`, `POST /api/sync-ventas`, `GET /api/logs`, `GET /api/logs/corridas`. Importa `syncPOS`, `syncVentas` y `logger`. Es el archivo que se arranca en producción con `node server.js`. |
| **`syncVentas.js`** | Motor principal | El cerebro del sistema. Lee las 5 queries de Connekta (ventas, pagos, imptos, cajas, inventario), agrupa por consec, recalcula impuestos, aplica cuadre de caja direccional, arma los planos para CFE/CNC/CPE, envía a Siesa con concurrencia paralela (`Promise.allSettled`), y dispara auto-correcciones cuando hay errores recuperables. Exporta `syncVentas()` (función principal) y helpers internos. |
| **`syncPOS.js`** | Sub-módulo clientes | Sincroniza la maestra de clientes del POS hacia Siesa. Trunca cada campo al largo varchar que Siesa exige (RAZON_SOCIAL=40, NOMBRES=30, etc.) y filtra el cliente genérico `222222222222`. Acepta opcionalmente una lista de NITs específicos (`probarSincronizacion(['42683051'])`) para reducir el payload cuando solo falta UN cliente. Es llamado por `server.js` y también por `syncVentas.js` (auto-corrección `CLIENTE_FALTANTE`). |
| **`logger.js`** | Trazabilidad | Lee/escribe todos los archivos en `logs/` de forma **atómica** (`.tmp` + rename). Funciones públicas: `obtenerConsecsExitosos()`, `registrarResultado(resultado, meta)`, `guardarCorrida(resumen)`, `generarReporteMaestras()`, `categorizarError(detalle)`, `parsearError(mensaje)`. Define las 9 categorías de error y sus regex de detección. |
| **`verLog.js`** | CLI de consulta | Herramienta de línea de comandos para inspeccionar los logs sin abrir los JSONs manualmente. Soporta flags `--pendientes`, `--consec N`, `--categoria X`, `--maestras`. Útil para diagnóstico rápido y para entregar reportes al equipo contable. |

### Configuración y dependencias

| Archivo | ¿Qué hace? |
|---------|------------|
| **`package.json`** | Dependencias npm: `express`, `cors`, `axios`, `dotenv`. Scripts npm (si se definen). |
| **`package-lock.json`** | Lockfile de npm (no editar a mano). |
| **`.env`** | Credenciales Connekta + parámetros de ejecución. **NO commitear** (está en `.gitignore`). |
| **`.gitignore`** | Excluye `node_modules/`, `logs/`, `.env` y snapshots `*_generada.json`. |

### Snapshots de debug (raíz, auto-generados)

Estos archivos se sobrescriben en cada corrida con el último payload enviado a Siesa. Sirven para inspección manual cuando algo falla.

| Archivo | Contenido |
|---------|-----------|
| **`factura_generada.json`** | Último plano CFE enviado a Siesa (formato `conectoresimportar`). |
| **`nota_credito_generada.json`** | Último plano CNC enviado. |
| **`clientes_enviados_100.json`** | Último lote de clientes que `syncPOS` envió a Siesa. |
| **`ajuste_inventario_generado.json`** (si existe) | Último CPE generado por auto-corrección de inventario. |

### Documentación

| Archivo | ¿Qué hace? |
|---------|------------|
| **`DOCUMENTACION.md`** | Este archivo. Documento de referencia completo del backend. |
| **`README.md`** (si existe) | Quick start. |

### Carpeta `logs/` (auto-generada, no commiteada)

| Archivo | ¿Qué hace? |
|---------|------------|
| **`facturas_procesadas.json`** | **Histórico maestro**. Contiene TODAS las facturas que se han intentado procesar alguna vez (OK + FALLO). Es la fuente de verdad para idempotencia: si un consec está aquí en estado `OK`, no se reenvía. |
| **`facturas_pendientes.json`** | Subconjunto de `procesadas` con solo las que están en `FALLO`. Es una vista derivada que se regenera automáticamente. Pensada para que el frontend/operador vea de un vistazo qué falta corregir. |
| **`corrida_<timestamp>.json`** | Snapshot de una corrida individual (ej. `corrida_2026-05-21T16-37-43.json`). Útil para reconstruir qué pasó en una ejecución puntual. Se acumulan; conviene purgar los viejos cada cierto tiempo. |
| **`errores_maestras_siesa.txt`** | Reporte de texto plano agregando errores de tipo `ITEM_INEXISTENTE`, `UM_INEXISTENTE`, `EQUIVALENCIA_FALTA` y `PUNTO_ENVIO_FALTA`. Pensado como entregable directo al equipo contable de Merkahorro: ellos lo leen y arreglan las maestras en Siesa. |

### Carpeta `node_modules/`

Dependencias instaladas con `npm install`. No editar.

---

## 4.c Diagrama de dependencias entre archivos

```
                          ┌─────────────┐
                          │  server.js  │  ← HTTP entry point
                          └──────┬──────┘
                  ┌──────────────┼──────────────┐
                  ▼              ▼              ▼
           ┌─────────────┐ ┌────────────┐ ┌───────────┐
           │ syncVentas  │ │  syncPOS   │ │  logger   │
           │     .js     │ │    .js     │ │    .js    │
           └──────┬──────┘ └─────┬──────┘ └─────┬─────┘
                  │              ▲              ▲
                  │  llama si    │              │
                  │  falta       │              │
                  │  cliente     │              │
                  └──────────────┘              │
                  │                             │
                  └─── lee/escribe ─────────────┘
                                                ▲
                                                │
                                         ┌──────┴──────┐
                                         │  verLog.js  │  ← CLI
                                         └─────────────┘
```

- `server.js` es el único que hace networking con el frontend.
- `syncVentas.js` orquesta TODO el flujo y es el único que habla con la API de Siesa.
- `syncPOS.js` es invocado desde dos puntos: el endpoint HTTP y como auto-corrección dentro de `syncVentas`.
- `logger.js` es la capa de persistencia. Todos los demás escriben a través de él (nunca con `fs` directo) para garantizar atomicidad.
- `verLog.js` es read-only sobre los archivos que produce `logger.js`.

---

## 5. Queries Connekta usadas

Connekta es una capa de **Siesa Cloud** que expone consultas SQL pre-definidas como endpoints HTTP. El backend consume estas 5 consultas:

### 5.1 `merkahorro_venta_pos_dev` — Detalle de items de la venta

Retorna el detalle de cada línea de las facturas del POS (un registro por ítem vendido).

**Campos relevantes que retorna:**
- `Cia`, `CoDoc`, `ID_TIPO_DOCTO`, `CONSEC_DOCTO`, `Concepto`, `FECHA_DOCTO`, `ID_CLASE_DOCTO`
- `id_cond_pago`, `IDMotivo`, `IndEstado`
- **Cabecera**: `VrBrutoDocto`, `ValorDsctoDocto`, `ValorDsctoGlobalDocto`, `VrImptoDocto`, `VrNetoDocto`
- **Detalle línea**: `CANTIDAD`, `PrecioUnitDet`, `VALOR_BRUTO`, `DsctoLineaDet`, `VrDsctoGlobalDet`, `VrImptoDet`, `VrnetoDet`
- **Cliente**: `IdTercero`, `NitTercero`, `RazonSocial`
- **Bodega**: `BODEGA`, `DescBodega`
- **Item**: `id_item`, `DescItem`, `UNIDAD_MEDIDA`
- **Descuento línea**: `vlr_uni_dscto`, `vlr_tot_dscto`
- **Rowid**: `RowidMvto`

**Cómo se usa:** se agrupa por `CONSEC_DOCTO`. Cada grupo = una factura.

### 5.2 `merkahorro_pagos_pos_dev` — Métodos de pago

Retorna los medios de pago usados por el cliente para cada venta (puede haber varios por factura: efectivo + tarjeta, etc.).

**Campos relevantes:**
- `CONSEC_DOCTO` (PK contra el query de ventas)
- `MEDIO_PAGO` (códigos: `EFE`, `DOM`, `TR2`, etc.)
- `VALOR` (monto pagado por ese medio)

**Cómo se usa:** se mapea cada `CONSEC_DOCTO` a un array de pagos. Esto alimenta las líneas tipo `220` del plano CFE.

### 5.3 `merkahorro_imptos_pos_dev` — Impuestos por línea

Retorna los impuestos aplicados a cada renglón de la factura (puede haber varios impuestos por ítem).

**Campos relevantes:**
- `CONSEC_DOCTO`, `RowidMvto` (relaciona con la línea exacta del detalle)
- `id_impto`, `tipo_impto`, `TASA`, `VALOR`

**Cómo se usa:** se agrupa por `RowidMvto` y se inyecta al detalle.
**IMPORTANTE:** el script **recalcula** el impuesto = `(VALOR_BRUTO - vlr_tot_dscto) * TASA / 100`, sin redondeo por línea, para evitar errores de centavos por descuentos.

### 5.4 `merkahorro_cajas_pos_dev` — Cierre de caja (totales declarados)

Retorna lo que el cajero declaró en cada medio de pago al cerrar caja, por factura.

**Campos relevantes:**
- `CONSEC_DOCTO`, `MEDIO_PAGO`, `TOTAL_CAJA`

**Cómo se usa:** se compara con el neto recalculado de la factura. Si hay diferencia, se aplica el [ajuste de caja direccional](#ajuste-de-caja-direccional).

### 5.5 `merkahorro_Cliente_pos_dev` — Maestra de clientes del POS

Retorna los clientes del POS junto con sus datos (dirección, teléfono, email, etc.).

**Cómo se usa:** consumido por `syncPOS.js`. Cuando Siesa rechaza una factura porque el cliente no existe, se llama este query filtrando solo los NITs faltantes, se trunca cada campo a sus largos máximos, y se envían como `GenericTransfer` a Siesa.

**Importante:** EXCLUYE al cliente genérico `222222222222` (se maneja por otro flujo).

### 5.6 `merkahorro_consulta_inventario` — Inventario y costos promedio

Retorna el stock y costo promedio de cada ítem por bodega.

**Query SQL real en Connekta (versión final, sin TOP):**
```sql
SELECT
    dbo.t150_mc_bodegas.f150_id_cia                 AS Cia,
    dbo.t285_co_centro_op.f285_id                   AS IDCO,
    dbo.t285_co_centro_op.f285_descripcion          AS DescCO,
    dbo.t150_mc_bodegas.f150_id                     AS IdBodega,
    dbo.t150_mc_bodegas.f150_descripcion            AS DescBodega,
    dbo.v121.v121_id_item                           AS IdItem,
    dbo.v121.v121_referencia                        AS Referencia,
    dbo.v121.v121_descripcion                       AS DescReferencia,
    dbo.t400_cm_existencia.f400_cant_existencia_1   AS Cantidad,
    dbo.t400_cm_existencia.f400_costo_prom_uni      AS CostoProm,
    GETDATE()                                       AS Fecha
FROM dbo.t400_cm_existencia
INNER JOIN dbo.v121
    ON dbo.t400_cm_existencia.f400_id_cia = dbo.v121.v121_id_cia
   AND dbo.t400_cm_existencia.f400_rowid_item_ext = dbo.v121.v121_rowid_item_ext
INNER JOIN dbo.t150_mc_bodegas
    ON dbo.t400_cm_existencia.f400_rowid_bodega = dbo.t150_mc_bodegas.f150_rowid
   AND dbo.t400_cm_existencia.f400_id_cia = dbo.t150_mc_bodegas.f150_id_cia
INNER JOIN dbo.t285_co_centro_op
    ON dbo.t285_co_centro_op.f285_id = dbo.t150_mc_bodegas.f150_id_co
   AND dbo.t285_co_centro_op.f285_id_cia = dbo.t150_mc_bodegas.f150_id_cia
WHERE dbo.t150_mc_bodegas.f150_id_cia = 1
  AND dbo.t400_cm_existencia.f400_cant_existencia_1 > 0
```

**Notas críticas sobre este query:**
- **NO tiene `TOP`**: si se pone `TOP 100 PERCENT`, Connekta lo envuelve en una subconsulta y SQL Server lo trata como `TOP 1`. Resultado: solo devuelve 1000 registros sin paginar.
- **NO tiene `ORDER BY`**: SQL Server prohíbe `ORDER BY` dentro de subconsultas sin `TOP/OFFSET`. Como Connekta envuelve la consulta, falla con error _"The ORDER BY clause is invalid in views..."_.
- **Filtra por `f400_cant_existencia_1 > 0`**: solo ítems con stock real. Reduce de ~470k registros a ~47k. El backend busca el costo promedio en TODAS las bodegas con stock, no solo en PV001.
- **Filtra por `f150_id_cia = 1`**: solo la compañía 1 (sucursales operativas, no consolidado).

**Total registros que retorna actualmente:** ~47,900 (48 páginas de 1000).

**Cómo se usa:** el backend pagina con el helper unificado `fetchPaginadoCompleto`: pide la página 1 para conocer `total_páginas` y luego baja el resto en un **pool de concurrencia acotada** (`PAGINACION_CONCURRENCIA`, default 4), con **reintento + backoff por página**. El paralelismo pesado (todas las páginas a la vez) sí tumba a Connekta, pero un pool pequeño lo tolera y es ~4× más rápido que secuencial. El orden de los registros no importa porque luego se indexan en un mapa `{ idItem → { bodega → { costo, disponible } } }` que se usa al inyectar stock vía CPE.

---

## 6. Limitaciones de Connekta

Connekta tiene comportamientos no documentados que afectan el diseño:

| Limitación | Consecuencia |
|------------|--------------|
| **No acepta parámetros (`@variable`)** en queries | Toca traer un superset y filtrar en Node.js. |
| **No acepta `ORDER BY` sin `TOP/OFFSET`** dentro del query | El query del inventario va sin `ORDER BY`. |
| **`tamPag` máximo permitido: 1000** | Pedir `tamPag=2000` o más devuelve HTTP 400. |
| **Paralelismo PESADO en queries grandes colapsa con `ECONNRESET`** | El paginado usa un pool de concurrencia ACOTADA (`PAGINACION_CONCURRENCIA`, default 4) con reintento+backoff por página. NO disparar todas las páginas a la vez. |
| **El campo `condicion=` no se aplica en algunos queries** | No depender de filtros server-side; verificar caso por caso. |
| **Las claves del response tienen tildes** (`tamaño_página`, `total_páginas`) | El código las busca de forma case-insensitive y por substring para evitar problemas de encoding. |
| **El response anida los datos en `detalle.Datos`** (no en `data` ni en `Table`) | El fetcher inspecciona varias rutas posibles. |

---

## 7. Flujo del proceso de sincronización

### Visión global

```
┌──────────────────────────────────────────────────────────────┐
│ syncVentas()                                                 │
│                                                              │
│  PASO 1: ejecutarPaso(1)  →  Procesa CNC (Notas Crédito)     │
│    │                                                         │
│    ├─ Lee Connekta (4 queries: ventas, pagos, imptos, cajas) │
│    ├─ Agrupa por CONSEC_DOCTO                                │
│    ├─ Filtra exitosos previos (idempotencia)                 │
│    ├─ Recalcula impuestos (sin redondear por línea)          │
│    ├─ Aplica cuadre de caja direccional                      │
│    ├─ Arma plano (concepto 502, ind_naturaleza 1, pago EFE)  │
│    └─ Envía POST a Siesa con concurrencia paralela           │
│         ├─ Si falla por CLIENTE  → syncPOS() → reintenta     │
│         ├─ Si falla por INVENT.  → CPE (241913) → reintenta  │
│         └─ Si pasa → guarda OK en logger                     │
│                                                              │
│  PASO 2: ejecutarPaso(3)  →  Procesa CFE (Facturas)          │
│    │                                                         │
│    └─ Mismo flujo, pero con ind_naturaleza 2 (salida) y los  │
│       medios de pago reales de la caja                       │
│                                                              │
│  PASO 3: logger.guardarCorrida()  +  reporteMaestras         │
└──────────────────────────────────────────────────────────────┘
```

### ¿Por qué CNC primero y CFE después?

La CNC (simulación, `ind_naturaleza` 1 = **ENTRADA**) ingresa/asegura el stock primero. Así, cuando el CFE (factura real, `ind_naturaleza` 2 = **SALIDA**) consume el inventario, las unidades ya existen y la factura no rebota por *"Item sin cantidad disponible"*. Si aun así faltara stock en cualquiera de los dos pasos, la auto-corrección (CPE) lo inyecta y reintenta. El flujo es: **CNC asegura stock → CFE lo consume**.

> Nota histórica: una versión previa procesaba CFE → CNC con el argumento de evitar descuadre. Se cambió a CNC → CFE (junio 2026) porque al asegurar el stock primero se reducen los rebotes por inventario en la factura real.

---

## 8. Documentos enviados a Siesa

### 8.1 CFE - Factura de Venta (Documento 242756 - FACTURA_DEV)

| Campo Siesa | Valor |
|-------------|-------|
| `id_concepto` | `501` |
| `ind_naturaleza` | `2` (Egreso de inventario) |
| `ID_CLASE_DOCTO` | `522` |
| `id_motivo` | `"01"` |
| `F_CONSEC_AUTO_REG` | `"1"` |
| `f9820_id_fecha_docto` | Entero `YYYYMMDD` (ej. 20260521) |

**Estructura del plano (registros):**
- **Tipo 100**: Cabecera del documento
- **Tipo 210**: Línea de detalle por ítem (cantidad, precio, descuento)
- **Tipo 220**: Línea de pago por cada medio (EFE, DOM, TR2)
- **Tipo 230**: Líneas de impuestos por detalle
- **Tipo 235**: ?
- **Tipo 250**: ?

### 8.2 CNC - Nota Crédito (Documento 242756 - FACTURA_DEV)

| Campo Siesa | Valor |
|-------------|-------|
| `id_concepto` | `502` |
| `ind_naturaleza` | `1` (Entrada de inventario) |
| `ID_CLASE_DOCTO` | `525` |
| `id_motivo` | `"01"` |
| `F_CONSEC_AUTO_REG` | `"1"` |

**Diferencia clave:** los pagos se fuerzan a `MEDIO_PAGO = "EFE"` sin importar lo que vino del POS.

### 8.3 CPE - Ajuste de Inventario (Documento 241913 - AJUSTE_INVENTARIO_DEV)

Se envía automáticamente cuando Siesa rechaza una factura por `"Item sin cantidad disponible"`.

| Campo Siesa | Valor |
|-------------|-------|
| `f470_id_concepto` | `601` (entero) |
| `f470_id_motivo` | `"03"` |
| `f350_consec_docto` | `"0"` |
| Items | Rellenados a **7 caracteres** con padding de ceros |

**Lógica de costo promedio (cascada de fallbacks):**
1. Buscar el ítem en la bodega del error (ej. PV001).
2. Si no tiene costo > 0, buscar en bodegas prioritarias: `['PV001', '00301', '00201', '00701']`.
3. Si no, buscar en **cualquier otra bodega** del mapa de inventario.
4. Si en ninguna parte hay costo, calcular **75% del precio de venta** de la factura original (asume 25% de margen comercial).
5. Como último recurso, `costo = 1` (solo si tampoco hay precio de venta).

---

## 9. Mapeo de campos POS → Siesa

### Cliente (de POS a Siesa via `syncPOS`)

| Campo POS | Campo Siesa | Largo máx | Truncado |
|-----------|-------------|-----------|----------|
| `RazonSocial` | `RAZON_SOCIAL` | 40 | Sí |
| `Apellido1` | `APELLIDO1` | 30 | Sí |
| `Apellido2` | `APELLIDO2` | 30 | Sí |
| `Nombres` | `NOMBRES` | 30 | Sí |
| `Barrio` | `BARRIO` | 30 | Sí |
| `Contacto` | `CONTACTO` | 40 | Sí |
| `Direccion` | `DIRECCION` | 40 | Sí |
| `Telefono` | `TELEFONO` | 20 | Sí |
| `Celular` | `CELULAR` | 20 | Sí |
| `NitTercero` | `NIT` | 20 | Sí |
| `Email` | `EMAIL` | 60 | Sí |

**Regla:** Siesa rechaza el **lote completo** si UN campo excede su largo. Por eso se trunca preventivamente.

### Detalle factura (POS → CFE)

| Campo POS | Campo Siesa |
|-----------|-------------|
| `CONSEC_DOCTO` | `f350_consec_docto` (entero) |
| `FECHA_DOCTO` | `f9820_id_fecha_docto` (`YYYYMMDD` entero) |
| `id_item` | `ITEM` (rellenado a 7 chars con ceros) |
| `UNIDAD_MEDIDA` | `ID_UM` |
| `BODEGA` | `ID_BODEGA` |
| `CANTIDAD` | `CANTIDAD` |
| `PrecioUnitDet` | `VLR_UNITARIO` |
| `VALOR_BRUTO` | `VLR_BRUTO` |
| `vlr_tot_dscto` | `VLR_DSCTO` |
| Recalculado | `VLR_IMPTO` = `(VALOR_BRUTO - vlr_tot_dscto) * TASA / 100` |

---

## 10. Reglas de negocio críticas

### 10.1 Recálculo de impuestos
**Nunca** se confía en el `VrImptoDet` que viene de Connekta (a veces es 0, a veces tiene errores de redondeo). Se recalcula con la fórmula exacta sin redondear por línea:

```
VLR_IMPTO_línea = (VALOR_BRUTO - vlr_tot_dscto) * TASA / 100
```

### 10.2 Descuentos
Solo se usa el campo `vlr_tot_dscto` por línea. Se ignoran `DsctoLineaDet`, `VrDsctoGlobalDet`, etc., para evitar doble descuento.

### 10.3 Ajuste de caja direccional

Si `total_factura ≠ total_caja_declarado`, se aplica esta lógica:

| Caso | Acción |
|------|--------|
| `dif > 0` (sobra plata en caja) | Agrega una línea EFE+ por la diferencia |
| `dif < 0` (falta plata) + hay EFE en la factura | Resta de EFE existente |
| `dif < 0` + NO hay EFE | Resta proporcionalmente de DOM/TR2 |
| `|dif| > 5` pesos | Solo warning, no se ajusta (descuadre real) |
| EFE quedaría negativo | NO se permite, se busca otra fuente |

### 10.4 Cliente genérico excluido

El NIT `222222222222` está **excluido en TODOS los queries** (clientes y ventas). Se maneja por otro flujo (factura POS general anónima).

### 10.5 Orden de pasos

**Siempre CNC → CFE** (Nota Crédito / simulación primero, luego Factura real), en QA y en PROD.

### 10.6 Concurrencia
Las facturas se procesan en paralelo con `Promise.allSettled` (no `Promise.all`, para que un fallo no aborte el lote). La concurrencia se controla con `CONCURRENCIA` en `.env`.

---

## 11. Lógica de automatización (auto-corrección)

Cuando Siesa rechaza una factura, el script analiza la respuesta y dispara una de estas automatizaciones **antes de reintentar**:

### 11.1 `CLIENTE_FALTANTE` → `syncPOS(nitsFaltantes)`
- Detección: `f_detalle` contiene `"cliente no existe"`.
- Acción: extrae el NIT del campo `f_valor` (puede venir como `NIT` o `NIT-sucursal`), llama `syncPOS([nits])`, reintenta.
- Marca: `automatizaciones_aplicadas: ["sync_cliente:42683051"]`.

### 11.2 `INVENTARIO_INSUFICIENTE` → CPE (Ajuste 241913)
- Detección: `f_detalle` contiene `"Item sin cantidad disponible"`.
- Acción:
  1. Carga el inventario completo paginado.
  2. Por cada ítem en error: extrae cantidad faltante (`Faltante Inv.: -X.XXX`), busca costo en cascada, arma línea CPE.
  3. Envía CPE a Siesa.
  4. Reintenta la factura original.
- Marca: `automatizaciones_aplicadas: ["ajuste_inventario:63951"]`.

### 11.3 `ITEM_INEXISTENTE` → Sin automatización
- Detección: `f_detalle` contiene `"El item - extension no existe"` o `"unidad de medida... no existe"`.
- Acción: NO se intenta corregir (sería maestra contable). Se reporta en `errores_maestras_siesa.txt` para que el área contable lo arregle manualmente.

### Mapeo del ID de ítem en errores
El error de Siesa viene como `Item:00050065006Bodega:PV001`. Siesa rellena el ID a 7 ceros + lo repite. El script extrae:
- Toma los primeros 7 chars de los dígitos
- Quita ceros a la izquierda
- Valida que coincida con un `id_item` real de Connekta

---

## 12. Sistema de logs y trazabilidad

### Archivos generados en `logs/`

| Archivo | Contenido | Propósito |
|---------|-----------|-----------|
| `facturas_procesadas.json` | Histórico maestro: TODAS las facturas que se han intentado procesar (OK + FALLO) | Idempotencia + auditoría |
| `facturas_pendientes.json` | Subconjunto solo con las FALLO | Vista rápida de lo que falta corregir |
| `corrida_<timestamp>.json` | Snapshot de una corrida individual | Histórico día a día |
| `errores_maestras_siesa.txt` | Reporte de texto de errores `ITEM_INEXISTENTE`, `UM_INEXISTENTE`, etc. | Entregable para el equipo contable |

### Estructura de un registro

```json
{
  "consec": "63951",
  "tipo": "CFE",
  "fecha_factura": "2026-05-21",
  "cliente_nit": "1011511961",
  "items": 8,
  "neto": 39057,
  "estado": "OK",
  "intentos": 2,
  "primera_corrida": "2026-05-21T16:33:45.221Z",
  "ultima_corrida": "2026-05-21T16:37:43.921Z",
  "automatizaciones_aplicadas": ["ajuste_inventario:63951"],
  "error": null
}
```

### Categorías de error (auto-detectadas por `logger.js`)

| Categoría | Mensaje Siesa que la dispara |
|-----------|------------------------------|
| `CLIENTE_FALTANTE` | "cliente no existe" |
| `INVENTARIO_INSUFICIENTE` | "Item sin cantidad disponible" |
| `ITEM_INEXISTENTE` | "El item - extension no existe" |
| `UM_INEXISTENTE` | "unidad de medida... no existe" |
| `EQUIVALENCIA_FALTA` | "No existe equivalencia" |
| `PUNTO_ENVIO_FALTA` | "punto de envío" |
| `DATO_INVALIDO` | Genérico de validación |
| `CAMPO_LARGO` | Excede largo del varchar |
| `OTRO` | Cualquier otro |

### Escritura atómica

Todos los archivos JSON se escriben con el patrón `escribir a .tmp + rename`. Esto garantiza que si el proceso muere a mitad de un `write`, el archivo previo queda intacto.

---

## 13. Idempotencia

El script **NO reenvía** facturas que ya están en estado `OK` en el log. La clave es `${tipo}:${consec}` (ej. `CFE:63951`).

Comportamiento:
- Factura en `OK` → se omite (se reporta como "omitida por idempotencia").
- Factura en `FALLO` → se reintenta, contador `intentos++`.
- Factura nueva → se procesa, entra al log.

**Forzar reproceso de una factura `OK`:**
```bash
node -e "const fs=require('fs'); ['logs/facturas_procesadas.json','logs/facturas_pendientes.json'].forEach(f=>{const d=JSON.parse(fs.readFileSync(f));fs.writeFileSync(f,JSON.stringify(d.filter(x=>x.consec!=='63951'),null,2));});"
```

---

## 14. Errores comunes y cómo se manejan

| Error Siesa | Categoría | Auto-corrección | Acción del operador |
|-------------|-----------|-----------------|---------------------|
| `cliente no existe` | `CLIENTE_FALTANTE` | ✅ syncPOS automático | Ninguna |
| `Item sin cantidad disponible` | `INVENTARIO_INSUFICIENTE` | ✅ CPE automático | Ninguna |
| `El item - extension no existe` | `ITEM_INEXISTENTE` | ❌ Manual | Crear el ítem en Siesa |
| `unidad de medida... no existe` | `UM_INEXISTENTE` | ❌ Manual | Crear la UM en Siesa |
| `No existe equivalencia 0-501-01` | `EQUIVALENCIA_FALTA` | ❌ Manual | Configurar equivalencia |
| `500 Internal Server Error` IIS | `OTRO` | 🔄 Reintenta solo | Ninguna |

---

## 15. Comandos útiles

### Ejecución
```bash
# Modo normal (procesa las últimas LIMITE_FACTURAS)
node -e "require('./syncVentas').syncVentas()"

# Procesar consec(s) específico(s)
$env:CONSEC_ESPECIFICOS="18831"; node -e "require('./syncVentas').syncVentas()"

# Arrancar el servidor Express
node server.js
```

### Consultar logs
```bash
# Resumen general
node verLog.js

# Solo las facturas en FALLO
node verLog.js --pendientes

# Detalle de un consec específico
node verLog.js --consec 63951

# Filtrar por categoría
node verLog.js --categoria INVENTARIO_INSUFICIENTE

# Mostrar reporte de maestras pendientes (para contabilidad)
node verLog.js --maestras
```

### Limpieza
```bash
# Borrar todos los logs (CUIDADO: pierdes idempotencia)
Remove-Item logs\*.json

# Borrar solo snapshots viejos (más de 7 días)
Get-ChildItem logs\corrida_*.json | Where-Object {$_.LastWriteTime -lt (Get-Date).AddDays(-7)} | Remove-Item
```

### Llamadas HTTP (desde el frontend o curl)
```bash
# Sincronizar clientes
curl -X POST http://localhost:4000/api/sync-clientes

# Sincronizar ventas
curl -X POST http://localhost:4000/api/sync-ventas
```

---

## 16. Tareas pendientes

### Para el equipo de Siesa/Contabilidad
- [ ] Crear el ítem `0188638` en la maestra de Siesa.
- [ ] Crear la UM `UND` (Unidad) en la maestra de Siesa.
- [ ] Configurar equivalencias `0-501-01` y `0-502-01` para movimientos de inventario.

### Mejoras futuras del backend
- [ ] Implementar un job programado (cron) para sincronización automática cada N minutos.
- [ ] Agregar tests unitarios para las funciones críticas (cuadre, recalculo impuestos, paginación).
- [x] ~~Ampliar el rango de Connekta de 30 días a 180 días en los 4 queries~~ (hecho en Connekta).
- [x] ~~Crear endpoint `GET /api/logs`~~ (hecho).

### Frontend (React, fuera de este repo)
- [ ] Página `SiesaSyncPage.jsx` con dashboard de:
  - Última corrida (timestamp, OK/FAIL) → consumir `GET /api/logs` (`resumen.ultima_corrida`)
  - Lista de pendientes con motivo → `GET /api/logs?solo_pendientes=1`
  - Botón "Reintentar" por factura → `POST /api/sync-ventas` con `CONSEC_ESPECIFICOS` (requiere ajuste para aceptar body)
  - Visor de errores de maestras → `GET /api/logs` campo `errores_maestras`
  - Histórico de corridas → `GET /api/logs/corridas`

---

## Contacto / Soporte

Cualquier modificación al query `merkahorro_consulta_inventario` debe respetar estas reglas:
- **NO agregar `TOP`** (rompe paginación).
- **NO agregar `ORDER BY`** (Connekta lo prohíbe en su subconsulta interna).
- **Mantener `f400_cant_existencia_1 > 0`** (reduce el dataset 10x).
- **Mantener `f150_id_cia = 1`** (filtra sucursales operativas).

---

## 17. Estado actual del proyecto (Mayo 2026)

### 17.1 Supabase (100% operativo)
La persistencia migro completamente de archivos JSON locales a PostgreSQL en Supabase.

| Tabla | Proposito | PK |
|-------|-----------|----|
| sps_facturas | Historial de cada factura procesada (idempotencia + auditoria) | id text (tipo:consec) |
| sps_corridas | Snapshot de cada ejecucion | id uuid |
| sps_errores_maestras | Errores de maestras Siesa para contabilidad | id uuid |

- Se usa SUPABASE_SERVICE_KEY (rol service) para saltar RLS.
- logger.js reescrito para usar @supabase/supabase-js con upsert().
- Los archivos locales (logs/, erLog.js, actura_generada.json, clientes_enviados_100.json) fueron eliminados.

### 17.2 Vercel (desplegado)
URL: https://siesa-pos-sync.vercel.app

Archivos de configuracion:
- ercel.json: usa @vercel/node como builder, apunta a server.js.
- server.js: exporta module.exports = app para Vercel serverless. En local usa pp.listen() envuelto en if (!process.env.VERCEL).

**Para hacer deploy:**
1. git push origin main (Vercel auto-detects el push y redeployea).
2. Las variables de entorno (CONNI_KEY, SUPABASE_URL, etc.) se configuran en el dashboard de Vercel.

### 17.3 Frontend React
El proyecto frontend vive en: \C:\Users\PC\Desktop\merkaPage\Pagina-web_React\

- Pagina: src/pages/SiesaPosSync/SiesaPosSync.jsx
- Servicio: src/services/siesaPosSyncService.js
- La URL del backend se configura via variable de entorno VITE: VITE_SIESA_POS_SYNC_URL
- En local usa http://localhost:4000, en produccion la URL de Vercel.

### 17.4 Costo promedio en ajustes de inventario

#### Como funciona hoy
En `ajustarInventario()` (CPE, dentro de syncVentas.js):

1. Llama a `fetchCostoPromedioCompleto()` (vía caché `getCostoCached`) que usa la query merkahorro_costo_promedio_dev.
2. Esa query lee `t132_mc_items_instalacion.f132_costo_prom_uni` → una fila por item+instalacion.
3. Construye `costoMap = { idItem -> { instalacion -> costo } }` y elige el costo de la instalacion de la bodega del error (`PV001` -> `001`), con prioridad `001/003/002/007`.
4. Si el item no tiene costo > 0, lo OMITE del ajuste (NO hay fallback de estimacion).

#### DECISION RESUELTA: fuente de costo = merkahorro_costo_promedio_dev (exclusiva)
El antiguo dilema "Opcion A vs B" **ya esta resuelto**. El DBA corrigio la query (antes venia todo en `0.0`) y ahora trae costos reales; ej. el item 773 devuelve `CostoPromInst = 5975.0` en todas las instalaciones (001, 002, 003, 004, 007, 008). Se usa **exclusivamente** `merkahorro_costo_promedio_dev` para valorizar (regla de "costo estricto"); `merkahorro_consulta_inventario` solo se usa para disponibilidad por bodega (y como cross-check de divergencia, no como fuente).

#### Caso investigado: 5975 (query) vs 5894 (Siesa) — junio 2026
Se observo un CPE del item 773 con costo unitario **5894** cuando la query devuelve **5975**. Un dry-run que replica la logica de seleccion con datos reales confirmo que **el codigo actual selecciona y envia 5975** (elige instalacion `001` = 5975).
- El `5894` **no lo produce el codigo actual** con estos datos. Solo puede venir de (A) un movimiento de una corrida vieja (el promedio cambia con cada movimiento), o (B) un **recalculo de Siesa**: el motivo `03 ENTRADA INCONSISTENCIA` sobre stock residual negativo promedia ponderadamente y estampa otro valor en la linea.
- Para cerrar el punto ciego, `ajustarInventario` ahora **loguea el `COSTO_PROMEDIO` exacto que envia** (`🧾 [CPE movimiento]`, `📤 [CPE payload]`) y un `⚠️ [DIVERGENCIA COSTO]` si `t132` (por instalacion) difiere de `t400` (por bodega, de `consulta_inventario`).

### 17.5 Pendientes
- [ ] Confirmar en vivo si el CPE envia 5975 (leer log `🧾 [CPE movimiento]`); actuar solo si Siesa lo recalcula (cambiar `id_motivo`/`id_concepto` o sanear stock negativo, validar con el funcional de Siesa).
- [ ] Tunear `PAGINACION_CONCURRENCIA` en produccion segun lo que tolere Connekta (empezar en 4).
- [ ] Hacer deploy del frontend React a Vercel con la variable VITE_SIESA_POS_SYNC_URL.
- [ ] Implementar job programado (cron) si se requiere sincronizacion automatica.

---

## 18. Sistema de Reportes Profesionales (Nuevo)

A partir de junio 2026 el sistema incluye un módulo de **reportes profesionales en PDF** con envío automático por correo SMTP.

### 18.1 Visión general

El módulo `reportes.js` genera un documento PDF profesional con:
- **Header corporativo** de Merkahorro
- **4 tarjetas KPI**: Procesadas, Exitosas, Fallidas, Efectividad
- **Resumen detallado** del período (desglose CFE/CNC/CPE, total neto)
- **Tabla de facturas** con estado, cliente, neto, intentos
- **Sección de automatizaciones** aplicadas (clientes creados, inventario inyectado)
- **Errores de maestras** que requieren acción manual del equipo Siesa
- **Footer** con marca de agua y timestamp

El PDF se envía como adjunto por **SMTP corporativo** con un cuerpo HTML profesional.

### 18.2 Arquitectura

```
Frontend (ReportesPanel.jsx)                    Backend (reportes.js)
┌─────────────────────┐                    ┌──────────────────────┐
│ Configuración       │  POST /config      │  saveConfig()        │
│ · Destinatarios     │ ──────────────────→│  · Guarda en Supabase│
│ · Programación      │ ←──────────────────│  sps_config_reportes │
│ · Hora / Día        │                    └──────────────────────┘
│ Estado ON/OFF       │
├─────────────────────┤                    ┌──────────────────────┐
│ Generar Reporte     │  POST /generar     │  generarYEnviar()     │
│ · Hoy               │ ──────────────────→│  · Consulta facturas  │
│ · Esta semana       │ ←──────────────────│  · Genera PDF (pdfkit)│
│ · Personalizado     │                    │  · Envía SMTP         │
├─────────────────────┤                    │  · Guarda historial   │
│ Historial           │  GET /historial    └──────────────────────┘
│ · Fecha, período    │ ──────────────────→
│ · KPIs, estado      │ ←──────────────────
│ · Expandible        │
└─────────────────────┘
```

### 18.3 Endpoints del API

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST` | `/api/reportes/generar` | Genera y envía el reporte PDF. Body opcional: `{ periodo, fecha_inicio, fecha_fin, destinatarios }` |
| `GET`  | `/api/reportes/config`  | Obtiene la configuración actual (destinatarios, programación, hora) |
| `POST` | `/api/reportes/config`  | Guarda la configuración. Body: `{ destinatarios, programacion, hora_envio, dia_semana, activo }` |
| `GET`  | `/api/reportes/historial` | Historial de reportes enviados. Query: `?limit=20` |

### 18.4 Variables de entorno (.env)

Adicionales a las existentes, se requieren estas variables para el envío SMTP:

```env
# Servidor SMTP corporativo
SMTP_HOST=smtp.correo-empresa.com
SMTP_PORT=587
SMTP_SECURE=false      # true para 465, false para 587
SMTP_USER=tu-correo@empresa.com
SMTP_PASS=tu-contraseña
SMTP_FROM=reportes@empresa.com  # Opcional, default = SMTP_USER
```

Para la creación de tablas en Supabase se necesita adicionalmente:

```env
# Connection string de PostgreSQL (para setup inicial)
DATABASE_URL=postgresql://postgres:****@db.pitpougbnibmfrjyk.supabase.co:5432/postgres
```

### 18.5 Setup inicial

1. **Crear tablas en Supabase**:
   ```bash
   node setup_reportes.js
   ```
   O manualmente desde el SQL Editor de Supabase con el contenido de `setup_reportes.sql`.

2. **Configurar SMTP** en el archivo `.env` (ver sección 18.4).

3. **Configurar destinatarios** desde el frontend (pestaña "Reportes" → Configuración).

4. **Programar envío automático** (opcional):
   - Usar Vercel Cron Jobs (si está disponible)
   - O un servicio externo como cron-job.org que llame a `POST /api/reportes/generar` periódicamente.
   - El frontend permite activar/desactivar la programación.

### 18.6 Archivos del módulo

| Archivo | Ubicación | Propósito |
|---------|-----------|-----------|
| `reportes.js` | Backend (raíz) | Lógica de generación PDF (pdfkit) + envío SMTP (nodemailer) + configuración/historial en Supabase |
| `setup_reportes.js` | Backend (raíz) | Script para crear tablas en Supabase automáticamente |
| `setup_reportes.sql` | Backend (raíz) | SQL para crear tablas manualmente desde el Supabase Dashboard |
| `ReportesPanel.jsx` | Frontend (`src/pages/SiesaPosSync/`) | Componente React con 3 tabs: Configuración, Generar, Historial |
| `ReportesPanel.css` | Frontend (`src/pages/SiesaPosSync/`) | Estilos consistentes con el dashboard principal (dark mode, verde/azul) |

### 18.7 Dependencias nuevas

| Paquete | Versión | Uso |
|---------|---------|-----|
| `pdfkit` | ^0.15.x | Generación de PDF profesional en servidor |
| `nodemailer` | ^6.x | Envío de correos SMTP con adjunto PDF |
| `pg` | ^8.x | Conexión directa a PostgreSQL para setup de tablas |

### 18.8 Personalización del reporte

El PDF generado por `reportes.js` usa estas constantes de diseño editables:

```javascript
const COLORS = {
    verde:      '#2ecc71',
    azul:       '#210d65',
    rojo:       '#e74c3c',
    gris:       '#7f8c8d',
    fondo:      '#fafafa',
    texto:      '#2c3e50',
    textoSec:   '#7f8c8d',
    borde:      '#dcdde1',
    blanco:     '#ffffff',
};
```
