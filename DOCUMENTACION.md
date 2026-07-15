# Sincronizador POS → Siesa PROD — Documentación Completa

**Última actualización:** 14 de Julio de 2026

Backend Node.js + Frontend React que sincroniza ventas de un sistema POS hacia el ERP Siesa PROD, con auto-corrección, trazabilidad completa e idempotencia. Incluye panel de monitoreo con dashboard, historial de facturas, ajustes de inventario, resumen de impuestos, notificaciones por correo, y envío de facturas con Impuesto al Consumo (ICO) corregido.

---

## Índice

1. [Visión general](#1-visión-general)
2. [Arquitectura del proyecto](#2-arquitectura-del-proyecto)
3. [Variables de entorno (.env)](#3-variables-de-entorno-env)
4. [Supabase — Esquema de tablas](#4-supabase--esquema-de-tablas)
5. [Inyección manual de datos en el Dashboard](#5-inyección-manual-de-datos-en-el-dashboard)
    - [5.1 Tablas de datos manuales](#51-tablas-de-datos-manuales)
    - [5.2 ¿Cuándo se injectan datos manualmente?](#52-cuándo-se-inyectan-datos-manualmente)
    - [5.3 Proceso paso a paso](#53-proceso-paso-a-paso-para-inyectar-datos-manualmente)
    - [5.4 Cómo el backend lee los datos manuales](#54-cómo-el-backend-lee-los-datos-manuales)
    - [5.5 Resumen visual del flujo](#55-resumen-visual-del-flujo-de-datos)
    - [5.6 Notas importantes](#56-notas-importantes)
6. [Endpoints HTTP](#6-endpoints-http)
7. [Queries Connekta](#7-queries-connekta)
8. [Limitaciones de Connekta](#8-limitaciones-de-connekta)
9. [Flujo de sincronización (syncVentas)](#9-flujo-de-sincronización-syncventas)
10. [Documentos enviados a Siesa](#10-documentos-enviados-a-siesa)
11. [Reglas de negocio críticas](#11-reglas-de-negocio-críticas)
12. [Lógica de auto-corrección](#12-lógica-de-auto-corrección)
13. [Idempotencia](#13-idempotencia)
14. [Categorías de error](#14-categorías-de-error)
15. [Conversión automática DOM → EFE](#15-conversión-automática-dom--efe)
16. [Impuesto al Consumo (ICO)](#16-impuesto-al-consumo-ico)
17. [Notificaciones por correo](#17-notificaciones-por-correo)
18. [Dashboard — Frontend React](#18-dashboard--frontend-react)
19. [Componentes del Frontend](#19-componentes-del-frontend)
20. [GitHub Actions — Workflows](#20-github-actions--workflows)
21. [Scripts de diagnóstico](#21-scripts-de-diagnóstico)
22. [Deploy](#22-deploy)
23. [Resolución de problemas comunes](#23-resolución-de-problemas-comunes)
24. [Historial de cambios](#24-historial-de-cambios)

---

## 1. Visión general

El sistema toma las ventas del POS (consultadas vía Connekta) y las replica como documentos contables en Siesa PROD mediante su API de importación de planos (`conectoresimportar`). Incluye un **dashboard en React** para monitoreo en tiempo real, **resumen de impuestos** por llave (IVA, ICO), **ajustes de inventario** CPE, y **notificaciones por correo** (errores, ajustes CPE, conversiones DOM→EFE).

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
├── server.js                  # Express: 15 endpoints HTTP
├── syncVentas.js              # Motor principal de sincronización (~1500 líneas)
├── syncPOS.js                 # Sincronización de clientes POS → Siesa
├── logger.js                  # Trazabilidad + Supabase (sps_facturas, sps_corridas)
├── notifier.js                # 3 tipos de notificaciones por correo (error, CPE, conversión)
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
    ├── FacturasTable.jsx      # Tabla de facturas con filtros
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

# === Query de estadísticas POS (resumen diario) ===
QUERY_STATS=merkahorro_venta_pos_stats_dev

# === Supabase ===
SUPABASE_URL=...
SUPABASE_SERVICE_KEY=...

# === SMTP (Notificaciones y Reportes) ===
SMTP_HOST=smtp.office365.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=notificacion@merkahorro.com
SMTP_PASS=...
SMTP_FROM=notificacion@merkahorro.com

NOTIFY_ERROR_EMAILS=juanmerkahorro@gmail.com,mjgil00813a@gmail.com
NOTIFY_CPE_EMAILS=juanmerkahorro@gmail.com

# === Puerto ===
PORT=4000
```

**Nota:** En GitHub Actions, `NOTIFY_ERROR_EMAILS`, `NOTIFY_CPE_EMAILS` y las credenciales SMTP se pasan como Secrets. Quien invoca el workflow manualmente puede sobrescribir CO/CAJA/limite/soloHoy.

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
| `error` | JSONB | Detalle del error parseado (categoria, resumen, detalle[], mensaje_siesa) |
| `impuestos` | JSONB | Array de impuestos extraídos (IVA, ICO) con BASE_GRAVABLE |
| `cpe_items` | JSONB | Array de ajustes de inventario inyectados |
| `automatizaciones_aplicadas` | JSONB | Array de acciones tomadas (sync_cliente, ajuste_inventario, cuadre_cxc, conversion_dom_efe) |
| `cxcConvergido` | BOOLEAN | Si se aplicó convergencia cartera vs CxC |
| `primera_corrida` | TIMESTAMPTZ | Primera vez que se procesó |
| `ultima_corrida` | TIMESTAMPTZ | Última vez que se procesó |

**Nota:** El estado `'ICO'` existió en versiones anteriores cuando ICO se saltaba. Ahora ICO se envía a Siesa con correcciones (ver [sección 15](#15-impuesto-al-consumo-ico)). Los registros viejos con estado `'ICO'` se reintentan y migran a OK/FALLO.

### `sps_estadisticas_diarias` — Snapshots diarios

| Columna | Tipo | Descripción |
|---------|------|-------------|
| `fecha` | DATE PK | Fecha del snapshot |
| `total_pos` | INTEGER | Total facturas POS |
| `total_sync` | INTEGER | Total sincronizadas en esa fecha |
| `genericas` | INTEGER | Facturas genéricas |
| `reales` | INTEGER | Facturas reales |
| `neto_total` | NUMERIC | Neto total |
| `por_caja` | JSONB | `{ "Z01": { trans, neto }, "Z02": {...} }` |
| `por_nit` | JSONB | `{ "generico": { trans, neto }, "sinNit": { trans, neto }, "real": { trans, neto } }` |
| `actualizado_en` | TIMESTAMPTZ | Última actualización |

### `sps_impuestos_offline` — Impuestos históricos (carga manual)

| Columna | Tipo | Descripción |
|---------|------|-------------|
| `fecha` | DATE PK | Fecha del snapshot manual |
| `total_base` | NUMERIC | Suma de netos de facturas con impuestos |
| `total_impuestos` | NUMERIC | Suma de VALOR_TOTAL de todos los impuestos |
| `total_facturas` | INTEGER | Facturas que contribuyeron |
| `por_llave` | JSONB | `{ "IV03": { valorTotal, baseGravable, count }, ... }` |

Usada para días donde los datos de Connekta no están disponibles o se requiere precisión manual (ej. todo junio 2026 se cargó manualmente desde Excel de Siesa).

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

## 5. Inyección manual de datos en el Dashboard

### ¿Por qué es necesario?

Connekta (middleware del POS) solo mantiene datos de los últimos **~2 días**. Si querés ver el dashboard de una fecha anterior (ej. del 11 al 18 de junio, o cualquier día del mes pasado), Connekta ya no tiene esos registros. Sin datos POS, el dashboard mostraba cero en genéricas, neto total, y desglose por caja — el resumen diario quedaba incompleto.

Además, el sistema extrae impuestos (IVA, ICO) de las facturas que logra sincronizar. Pero si una factura no se sincronizó (ej. porque nunca llegó a procesarse), sus impuestos no existen en `sps_facturas.impuestos` y el resumen de impuestos del dashboard se queda corto.

**Solución:** dos tablas en Supabase para datos "offline" (cargados manualmente) que el backend consulta ANTES de intentar fuentes automáticas.

---

### 5.1 Tablas de datos manuales

#### `sps_estadisticas_diarias` — Snapshot diario del POS

Creada automáticamente **cada corrida de sync** (se hace upsert en `guardarEstadisticasDiarias()`), pero también se puede insertar/actualizar **a mano** para días pasados.

```sql
CREATE TABLE IF NOT EXISTS sps_estadisticas_diarias (
    fecha          DATE PRIMARY KEY,
    total_pos      INTEGER NOT NULL DEFAULT 0,     -- Total facturas POS del día
    total_sync     INTEGER NOT NULL DEFAULT 0,     -- Total sincronizadas ese día
    genericas      INTEGER NOT NULL DEFAULT 0,     -- Facturas genéricas (2222222222)
    reales         INTEGER NOT NULL DEFAULT 0,     -- Facturas con cliente real
    neto_total     NUMERIC NOT NULL DEFAULT 0,     -- Neto total facturado
    por_caja       JSONB NOT NULL DEFAULT '{}',    -- { "Z01": { transacciones, neto }, ... }
    por_nit        JSONB NOT NULL DEFAULT '{}',    -- { generico: { trans, neto }, sinNit: { trans, neto }, real: { trans, neto } }
    actualizado_en TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Campos clave:**
- `fecha` → PK. Se upserta por fecha, si ya existe se reemplaza
- `por_caja` → JSONB con desglose por tipo de caja (Z01, Z02)
- `por_nit` → JSONB con desglose por tipo de cliente (genérico 2222222222, sin NIT, cliente real)
- `total_sync` → cuántas facturas sincronizó el flujo ese día (se llena automáticamente)

#### `sps_impuestos_offline` — Impuestos históricos detallados

Esta tabla **no se crea automáticamente**. Hay que crearla a mano en Supabase SQL Editor:

```sql
CREATE TABLE IF NOT EXISTS sps_impuestos_offline (
    fecha           DATE PRIMARY KEY,
    total_base      NUMERIC NOT NULL DEFAULT 0,     -- Suma de netos de facturas que tienen impuestos
    total_impuestos NUMERIC NOT NULL DEFAULT 0,     -- Suma de VALOR_TOTAL de todos los impuestos
    total_facturas  INTEGER NOT NULL DEFAULT 0,     -- Facturas únicas que contribuyeron
    por_llave       JSONB NOT NULL DEFAULT '{}',    -- { "IV03": { valorTotal, baseGravable, count }, ... }
    actualizado_en  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Campos clave:**
- `fecha` → PK. Una fila por día
- `por_llave` → JSONB. Cada llave de impuesto (IV02–IV08, ICO) con sus agregados del día
- Esta tabla es la **única fuente** para impuestos de días históricos donde Connekta no tiene datos

---

### 5.2 ¿Cuándo se injectan datos manualmente?

Hay dos escenarios:

| Escenario | Qué se injecta | Tabla | Motivo |
|-----------|---------------|-------|--------|
| **Día sin datos POS** | Estadísticas del POS (total transacciones, neto, por caja, por NIT) | `sps_estadisticas_diarias` | Connekta ya no tiene el día. Se obtienen los datos desde Siesa (reporte Excel o consulta directa) |
| **Día con impuestos incompletos** | Desglose de impuestos por llave (IV03, IV04, ICO, etc.) | `sps_impuestos_offline` | Las facturas de ese día no se sincronizaron automáticamente, o los valores de Connekta son parciales |

**Ejemplos reales:**

1. **10-jun-2026 (Z02):** se insertaron 48 facturas (2 reales + 46 genéricas), neto $1.219.525, base $1.150.178, impuestos $69.347. Solo caja Z02.
2. **07-jul-2026:** se corrigieron datos con 320 facturas (313 genéricas + 7 reales), neto $8.253.737, base $7.494.095, impuestos $28.778.
3. **Semana del 11/06 al 18/06:** se insertaron datos día por día desde Excel de Siesa para llenar el vacío.

---

### 5.3 Proceso paso a paso para injectar datos manualmente

#### Paso 1: Obtener los datos fuente

Los datos se obtienen desde **Siesa PROD** directamente. Hay dos formas:

**Opción A — Reporte Excel desde Siesa:**
- En Siesa, generar un reporte de facturación por día
- Extraer: total facturas, neto total, desglose por tipo de cliente (genérico 2222222222 vs reales vs sin NIT), desglose por caja (Z01/Z02)
- Para impuestos: extraer el valor total por cada llave de impuesto (IV03, IV04, ICO, etc.) y su base gravable

**Opción B — Consulta directa en Siesa:**
- Para stats del POS: sumar facturas emitidas en el día, agrupar por caja y por tipo de cliente NIT
- Para impuestos: sumar VALOR_TOTAL y BASE_GRAVABLE agrupado por ID_LLAVE_IMPUESTO

#### Paso 2: Estructurar el JSON

Para `sps_estadisticas_diarias`, el `por_caja` y `por_nit` deben tener esta estructura exacta:

```json
{
  "total_pos": 48,
  "neto_total": 1219525,
  "por_caja": {
    "Z02": { "transacciones": 48, "neto": 1219525 }
  },
  "por_nit": {
    "generico": { "transacciones": 46, "neto": 1160000, "etiqueta": "2222222222" },
    "sinNit":  { "transacciones": 0,  "neto": 0,      "etiqueta": "Sin NIT" },
    "real":    { "transacciones": 2,  "neto": 59525,   "etiqueta": "Clientes reales" }
  }
}
```

Para `sps_impuestos_offline`, el `por_llave` debe tener esta estructura:

```json
{
  "total_base": 1150178,
  "total_impuestos": 69347,
  "total_facturas": 48,
  "por_llave": {
    "IV03": { "valorTotal": 65000, "baseGravable": 342105, "count": 42 },
    "IV04": { "valorTotal": 4347,  "baseGravable": 22877,  "count": 6 },
    "ICO":  { "valorTotal": 0,     "baseGravable": 0,       "count": 0 }
  }
}
```

#### Paso 3: Insertar en Supabase

Ir a **Supabase Dashboard → SQL Editor** y ejecutar:

```sql
-- Para sps_estadisticas_diarias
INSERT INTO sps_estadisticas_diarias (fecha, total_pos, total_sync, genericas, reales, neto_total, por_caja, por_nit)
VALUES (
    '2026-06-10',
    48,
    0,  -- total_sync en 0 si no se sincronizaron (o el valor real si se sincronizaron algunas)
    46,
    2,
    1219525,
    '{"Z02": {"transacciones": 48, "neto": 1219525}}',
    '{"generico": {"transacciones": 46, "neto": 1160000, "etiqueta": "2222222222"}, "sinNit": {"transacciones": 0, "neto": 0, "etiqueta": "Sin NIT"}, "real": {"transacciones": 2, "neto": 59525, "etiqueta": "Clientes reales"}}'
)
ON CONFLICT (fecha) DO UPDATE SET
    total_pos = EXCLUDED.total_pos,
    neto_total = EXCLUDED.neto_total,
    por_caja = EXCLUDED.por_caja,
    por_nit = EXCLUDED.por_nit;

-- Para sps_impuestos_offline
INSERT INTO sps_impuestos_offline (fecha, total_base, total_impuestos, total_facturas, por_llave)
VALUES (
    '2026-06-10',
    1150178,
    69347,
    48,
    '{"IV03": {"valorTotal": 65000, "baseGravable": 342105, "count": 42}, "IV04": {"valorTotal": 4347, "baseGravable": 22877, "count": 6}}'
)
ON CONFLICT (fecha) DO UPDATE SET
    total_base = EXCLUDED.total_base,
    total_impuestos = EXCLUDED.total_impuestos,
    total_facturas = EXCLUDED.total_facturas,
    por_llave = EXCLUDED.por_llave;
```

**⚠️ Importante:** Los `total_sync`, `genericas`, y `reales` en `sps_estadisticas_diarias` se pueden dejar en 0 si no se sincronizaron facturas ese día. El dashboard usa `total_pos` y `por_nit`/`por_caja` para las tarjetas y gráficas.

#### Paso 4: Verificar en el dashboard

Una vez insertados:
- **Resumen Diario** (vista Dashboard o la pestaña ResumenDiario): ya muestra los datos POS del día inyectado, combinados con los sincronizados de `sps_facturas`
- **Resumen de Impuestos** (sección debajo de las gráficas): muestra los impuestos del día inyectado con su desglose por llave

---

### 5.4 Cómo el backend lee los datos manuales

El backend tiene lógica específica para **priorizar datos manuales** sobre automáticos. Hay dos endpoints clave:

#### `GET /api/logs/resumen-diario` — Lectura de stats POS

```js
// Flujo resumido del endpoint:
// 1. Si es HOY → consulta Connekta en vivo (stats query)
// 2. Si es PASADO (fecha única o rango):
//    a. Consulta sps_estadisticas_diarias para las fechas del rango
//    b. Si el rango incluye hoy, también consulta Connekta para hoy
//    c. Días SIN snapshot en sps_estadisticas_diarias →
//       rellena desde sps_facturas (clientes reales)
// 3. Si no hay datos POS de ninguna fuente →
//    usa sps_facturas como fallback absoluto
```

**Prioridad de fuentes:**
1. `sps_estadisticas_diarias` (datos manuales o snapshots automáticos)
2. Connekta en vivo (solo para el día de hoy)
3. `sps_facturas` (fallback: calcula stats desde las facturas sincronizadas)

#### `GET /api/logs/resumen-impuestos` — Lectura de impuestos

```js
// Flujo resumido (server.js ~línea 767):
// 1. Cargar sps_impuestos_offline para el rango de fechas
//    → Acumula totalBase, totalFacturas, porLlave desde offline
//    → Guarda las fechas cubiertas en un Set (fechasConOffline)
// 2. Cargar sps_facturas.impuestos para el rango
//    → Pero EXCLUYE las fechas que ya están en fechasConOffline
//    → Así se evita doble conteo
// 3. Combinar ambos: offline + no-offline
```

**Regla de deduplicación (línea 838):**
```js
if (fechasConOffline.has(f.fecha_factura)) return; // ya cubierto por offline
```

Esto significa: si un día tiene datos en `sps_impuestos_offline`, los impuestos de `sps_facturas` para ESE día se IGNORAN por completo. Solo se leen de `sps_facturas` los días NO cubiertos por offline.

**¿Por qué esta separación?** Porque los datos offline vienen de Siesa directamente (son la verdad absoluta). Las facturas sincronizadas pueden tener valores parciales si no se sincronizaron todas, o pueden no existir si el flujo no las procesó. Los datos de Siesa son más completos y confiables.

---

### 5.5 Resumen visual del flujo de datos

```
                    ┌──────────────────────────┐
                    │   PETICIÓN DEL DASHBOARD  │
                    │  (rango de fechas X-Y)   │
                    └────────────┬─────────────┘
                                 │
                    ┌────────────▼─────────────┐
                    │   ¿Es hoy o día reciente? │
                    └────────────┬─────────────┘
                                 │
              ┌──────────────────┴──────────────────┐
              │                                     │
              ▼                                     ▼
    ┌──────────────────┐              ┌──────────────────────┐
    │   CONNEKTA       │              │  TABLAS MANUALES     │
    │  (en vivo SQL)   │              │                      │
    │                  │              │  sps_estadisticas_   │
    │  merkahorro_     │              │  diarias (stats POS) │
    │  venta_pos_stats │              │                      │
    │  _dev            │              │  sps_impuestos_      │
    │                  │              │  offline (impuestos) │
    └──────────────────┘              └──────────────────────┘
              │                                     │
              └──────────────────┬──────────────────┘
                                 │
                                 ▼
                    ┌──────────────────────────┐
                    │      COMBINACIÓN         │
                    │                          │
                    │  Stats: offline +        │
                    │  Connekta + sps_facturas │
                    │                          │
                    │  Impuestos: offline      │
                    │  + sps_facturas (solo    │
                    │  días no cubiertos)      │
                    └────────────┬─────────────┘
                                 │
                                 ▼
                    ┌──────────────────────────┐
                    │   RESPUESTA AL DASHBOARD │
                    │   (datos completos)      │
                    └──────────────────────────┘
```

### 5.6 Notas importantes

| Situación | Comportamiento |
|-----------|---------------|
| Insertaste stats pero no impuestos | El dashboard muestra POS correcto, pero impuestos solo de facturas sincronizadas |
| Insertaste impuestos pero no stats | Impuestos correctos, pero POS stats usan sps_facturas como fallback (solo reales, no genéricas) |
| Insertaste ambas | Todo funciona completo. Los datos offline tienen prioridad |
| Día tiene offline + facturas sincronizadas | Impuestos: solo offline (se ignoran facturas). Stats: offline + facturas del mismo día se suman |
| Día sin offline ni Connekta | Fallback a sps_facturas (estadísticas parciales, solo facturas sincronizadas) |
| Querés corregir un día | Hacé UPSERT en ambas tablas con la misma fecha. El backend siempre lee la última versión |

---

## 6. Endpoints HTTP

### Lectura (GET)

| Ruta | Parámetros | Descripción |
|------|-----------|-------------|
| `/api/logs` | `estado`, `tipo`, `categoria`, `consec`, `limit`, `solo_pendientes`, `fecha_desde`, `fecha_hasta` | Facturas procesadas |
| `/api/logs/corridas` | `limit` | Snapshots de corridas |
| `/api/logs/resumen-diario` | `fechaInicio`, `fechaFin`, `caja` | Resumen diario híbrido POS vs Sync |
| `/api/logs/estadisticas` | `fechaInicio`, `fechaFin` | Estadísticas día por día |
| `/api/logs/ajustes` | — | Ajustes de inventario CPE aplanados |
| `/api/logs/resumen-impuestos` | `fechaInicio`, `fechaFin` | Agregado de impuestos por llave |
| `/api/logs/resumen-ajustes` | `fechaInicio`, `fechaFin` | Agregado de ajustes CPE |
| `/api/reportes/config` | — | Configuración de reportes |
| `/api/reportes/historial` | `limit` | Historial de reportes |
| `/api/diagnostico/env` | — | Diagnóstico de vars de entorno |

### Acción (POST)

| Ruta | Body | Descripción |
|------|------|-------------|
| `/api/sync-ventas` | `{ consecs?, limite?, co?, caja? }` | Ejecuta sincronización |
| `/api/sync-clientes` | `{ nits?: string[] }` | Sincroniza clientes POS → Siesa |
| `/api/reportes/generar` | `{ periodo, fecha_inicio, fecha_fin, destinatarios }` | Genera y envía PDF |
| `/api/reportes/config` | `{ destinatarios, programacion, hora_envio, dia_semana, activo }` | Guarda configuración |

### GET `/api/diagnostico/env`

Diagnóstico rápido de configuración:

```json
{
  "NOTIFY_ERROR_EMAILS": "✅ configurado",
  "NOTIFY_CPE_EMAILS": "✅ configurado",
  "SMTP_HOST": "✅ smtp.office365.com",
  "SMTP_USER": "✅ not***@merkahorro.com",
  "VERCEL_ENV": "(no Vercel)"
}
```

### GET `/api/logs/resumen-diario`

Resumen híbrido: combina Connekta (POS en vivo) con `sps_estadisticas_diarias` (histórico).

```json
{
  "success": true,
  "fecha": "2026-07-14",
  "total_pos": 148,
  "total_sync": 14,
  "ok": 14,
  "fallo": 0,
  "sin_recaudo": 0,
  "neto_total": 625112,
  "neto_sync": 600000,
  "por_caja": {
    "Z01": { "transacciones": 80, "neto": 350000 },
    "Z02": { "transacciones": 68, "neto": 275112 }
  },
  "por_nit": {
    "generico": { "transacciones": 120, "neto": 500000, "etiqueta": "2222222222" },
    "sinNit": { "transacciones": 5, "neto": 15000, "etiqueta": "Sin NIT" },
    "real": { "transacciones": 23, "neto": 110112, "etiqueta": "Clientes reales" }
  },
  "por_nit_sync": { ... }
}
```

**Categoría Sin NIT:** documentos sin cliente POS (`NitTercero` NULL) se agrupan aparte en `por_nit.sinNit`. Antes se incluían en `generico` y subestimaban el conteo de genéricas reales (2222222222).

**Rango de fechas:** soporta `fechaInicio`/`fechaFin`. Si el rango incluye hoy, consulta Connekta para el día de hoy y lo agrega al histórico. Días sin snapshot se rellenan desde `sps_facturas` (clientes reales).

### GET `/api/logs/resumen-impuestos`

Agrega impuestos por `ID_LLAVE_IMPUESTO` (IV02-IV08, ICO). Combina dos fuentes:

1. **`sps_impuestos_offline`** — datos cargados manualmente (ej. junio entero desde Excel Siesa)
2. **`sps_facturas.impuestos`** — datos extraídos automáticamente

Las fechas cubiertas por offline tienen prioridad y excluyen las facturas de ese día. Deduplica facturas del mismo `{co}:{caja}:{consec}` priorizando FALLO > SIN_RECAUDO > OK.

```json
{
  "success": true,
  "totalBase": 12345678,
  "totalBaseGravable": 6500000,
  "totalImpuestos": 2345678,
  "totalFacturas": 123,
  "totalDocumentos": 246,
  "porLlave": [
    { "llave": "IV03", "descripcion": "IVA 19% BIENES", "valorTotal": 1234567, "baseGravable": 6500000, "count": 45 }
  ]
}
```

Descripciones (`TAX_DESCRIPTIONS`) incluidas tanto en backend como frontend:

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

---

## 7. Queries Connekta

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

Usada para el resumen diario. Igual que `merkahorro_venta_pos_dev` pero **sin** filtro de cliente genérico (incluye 222222222222 para conteo de genéricas y Sin NIT). Solo Z01/Z02. Configurable via `QUERY_STATS` en `.env`.

---

## 8. Limitaciones de Connekta

| Limitación | Impacto |
|------------|---------|
| No acepta `@variables` | Traer superset y filtrar en Node |
| No acepta `ORDER BY` sin `TOP`/`OFFSET` | Inventario sin orden |
| `tamPag` máximo = 1000 | Paginación obligatoria en grandes queries |
| Pool pesado causa `ECONNRESET` | Usar `PAGINACION_CONCURRENCIA` (default 4) |
| Claves con tildes (`tamaño_página`) | Búsqueda case-insensitive por substring |
| Ventana de fecha: últimos ~2 días | Las queries de ventas solo traen ~2 días |

---

## 9. Flujo de sincronización (syncVentas)

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
│     → Construye payload Siesa con generarPayloadDocumento()
│     → Recalcula impuestos (VLR_UNI=0 si TASA>0, ICO se respeta)
│     → Cuadre de caja direccional (sobrante/faltante)
│     → Si hay pagos DOM → convierte a EFE automáticamente
│     → Envía a Siesa con pool de concurrencia
│     → Si falla: auto-corrección (CPE/syncPOS) + reintento
│     → Guarda resultado en Supabase
│
├── 3. ejecutarPaso(3, ...)  → CFZ (Facturas)
│     → Mismo flujo, pero con pagos reales del POS
│     → ICO se envía a Siesa (no se salta)
│
├── 4. logger.guardarCorrida(resumen)
│     → Snapshot en sps_corridas
│
├── 5. guardarEstadisticasDiarias()
│     → Snapshot diario en sps_estadisticas_diarias
│     → Si Connekta devuelve 0 registros, omite upsert (no sobrescribe con ceros)
│
└── 6. logger.generarReporteMaestras()
      → Detecta maestras faltantes y persiste en sps_errores_maestras
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

### Construcción del payload para Siesa

`generarPayloadDocumento(fac, enc, tipoDoc, co, caja, conversiones)` construye el JSON completo:

1. **Cabecera:** tipo de documento, concepto, clase, motivo, CO, auto-consec
2. **Movimientos** (items): ítem, bodega, cantidad, valor bruto, descuento, UN, unidad de negocio
3. **Impuestos:** por cada línea, si TASA>0 → VLR_UNI=0 (IVA porcentual), si TASA=0 → VLR_UNI>0 (ICO valor fijo). Recalcula VALOR_TOTAL al peso con Math.round
4. **Pagos/Caja:** medios de pago reales + ajuste direccional. Si es CNZ, fuerza todo a EFE. Si hay DOM, convierte a EFE sintético
5. **Descuentos:** si aplica

### Impuestos — Extracción para metadata

Se extraen de `payload.Movimientos`/`payload.Descuentos` y se guardan en `meta.impuestos` con `BASE_GRAVABLE` calculada:

```js
meta.impuestos.push({
  NRO_REGISTRO: ...,
  ID_LLAVE_IMPUESTO: "...",   // IV03, IV04, ICO
  TASA: ...,
  BASE_GRAVABLE: Math.round(VALOR_BRUTO - dscto),
  VALOR_TOTAL: Math.round(...),
  VLR_UNI: ...,
  PORCENTAJE_BASE: ...
})
```

`BASE_GRAVABLE` se computa solo en `meta.impuestos` — **no** se agrega al array `Impuestos` que va a Siesa.

**Impuesto dedup:** se usa un `Set("RowidMvto|ID_LLAVE_IMPUESTO")` para evitar duplicados (primera aparición gana).

### Convergencia Cartera vs CxC

Cuando `VALOR_TOTAL` del CxC no coincide exactamente con la cartera del CFZ, y la diferencia `|delta| ≤ $10`:

- Se fuerza el estado a `SIN_RECAUDO` (en lugar de FALLO)
- Se marca `cxcConvergido: true`
- Se suma el delta a la línea de IVA con TASA>0 más grande y a la línea de Caja más grande
- En el frontend aparece un callout amarillo indicando que falta completar el recaudo manualmente

### Ajuste de caja direccional

Se aplica cuando el total de los pagos no cuadra con el neto del documento:

| Caso | Acción |
|------|--------|
| `dif > 0` (sobra) | Agrega línea EFE+ extra |
| `dif < 0` + hay EFE | Resta del EFE existente |
| `dif < 0` + no EFE | Resta proporcional DOM/TR2 |
| `\|dif\| > 5` | Warning, no ajusta |

### DOM → EFE: lógica de cuadre cuando no hay pagos POS

Las transacciones DOM (domicilio) no generan entradas en la tabla de pagos de Connekta (`merkahorro_pagos_pos_dev` filtra por `EFE`). Sin pago, el cuadre de caja falla porque no hay `Caja` que enviar. Para solventarlo:

1. Se detecta cuando el total del documento > 0 pero el array `cajaConsolidada` está vacío
2. Se crea un **pago EFE sintético** por el valor total del documento
3. Esto permite que el documento se envíe a Siesa con un medio de pago válido
4. Se registra `conversion_dom_efe` en `automatizaciones_aplicadas`

---

## 10. Documentos enviados a Siesa

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

## 11. Reglas de negocio críticas

### Recálculo de IVA

`VLR_IMPTO = Math.round((VALOR_BRUTO - vlr_tot_dscto) * TASA / 100)` — solo para tasas > 0. ICO (TASA=0) se envía tal cual: su `VALOR_TOTAL` viene de `VLR_UNI × CANTIDAD` y se respeta.

### VLR_UNI vs TASA (regla FACTURA_DEV)

Según documentación de Siesa FACTURA_DEV:

- **TASA > 0 → VLR_UNI debe ser 0** (el impuesto se calcula como porcentaje)
- **VLR_UNI > 0 → TASA debe ser 0** (el impuesto es valor fijo)

Siesa tolera VLR_UNI>0 con TASA>0 cuando solo hay IVA, pero si aparece ICO (TASA=0, VLR_UNI>0) en la misma factura, activa una validación estricta y rechaza. El código fuerza esta regla SIEMPRE.

### normalizarUM()

| Entrada | Salida |
|---------|--------|
| P6, P12, P24 | UND |
| KG, LT | KG, LT (se respeta) |
| Vacío | UND |
| Otros | Tal cual |

### Servicios en CPE

Items con `tipo_inv_serv` iniciando en `S-` (ej. `S-OTRIPV`) no se inyectan en ajustes de inventario.

### Guard stats en vacío

`guardarEstadisticasDiarias()` **omite** el upsert si Connekta devuelve 0 registros para el día, para no sobrescribir datos previos con ceros.

---

## 12. Lógica de auto-corrección

Cuando Siesa rechaza un documento, se analiza y dispara la corrección antes de reintentar (hasta `MAX_RONDAS_AJUSTE` veces).

| Error Siesa | Categoría | Acción automática |
|-------------|-----------|-------------------|
| "cliente no existe" | CLIENTE_FALTANTE | syncPOS(NIT) → reintenta |
| "Item sin cantidad disponible" | INVENTARIO_INSUFICIENTE | CPE (ajuste 601/17) → reintenta + notificación |
| "El item no existe" | ITEM_INEXISTENTE | Reporta en errores_maestras |
| "unidad de medida no existe" | UM_INEXISTENTE | Reporta en errores_maestras |
| "No existe equivalencia" | EQUIVALENCIA_FALTA | Reporta en errores_maestras |
| "punto de envío" | PUNTO_ENVIO_FALTA | Reporta en errores_maestras |
| "Valor cartera: ... Valor CxC: ..." | CARTERA_CXC | Convergencia (delta ≤ $10) |

**Reintento de cortesía:** si `ajustarInventario` lanza error, se reintenta el documento una vez más (por si el stock se inyectó parcialmente de otra factura concurrente). Solo si falla 2 veces seguidas se marca FALLO.

---

## 13. Idempotencia

- Clave compuesta: `{tipo}:{co}:{caja}:{consec}`
- Facturas en estado `OK` → se omiten (no se reintentan)
- Facturas en `FALLO` → se reintentan (intentos++)
- Facturas en `SIN_RECAUDO` → se reintentan
- Forzar reproceso: marcar manualmente en BD como no-OK o cambiar estado

**Nota sobre ICO:** Anteriormente las facturas ICO se omitían (estado `'ICO'`). Con el cambio a envío real, las facturas con ICO se procesan normalmente. Registros legacy con estado `'ICO'` se reintentarán automáticamente.

---

## 14. Categorías de error

| Categoría | Regex de detección | Acción |
|-----------|-------------------|--------|
| CLIENTE_FALTANTE | `cliente no existe` | syncPOS automático |
| INVENTARIO_INSUFICIENTE | `Item sin cantidad disponible` | CPE automático + notificación |
| ITEM_INEXISTENTE | `El item - extension no existe` | Reporta en maestras |
| UM_INEXISTENTE | `unidad de medida.*no existe` | Reporta en maestras |
| EQUIVALENCIA_FALTA | `No existe equivalencia` | Reporta en maestras |
| PUNTO_ENVIO_FALTA | `punto de envío` | Reporta en maestras |
| DATO_INVALIDO | `El valor.*no es válido` | Sin acción automática |
| CAMPO_LARGO | `excede el largo del campo` / `demasiado largo` | Sin acción automática |
| PERIODO_CERRADO | `periodo cerrado` | Sin acción automática |
| ERROR_CONEXION_SIESA | `base de datos no existe` | Sin acción automática |
| CARTERA_CXC | `Valor cartera:` | Convergencia delta ≤ $10 |
| OTRO | Cualquier otro | Sin acción automática |

---

## 15. Conversión automática DOM → EFE

### ¿Por qué?

Cuando un cajero selecciona **DOM** (domicilio) como medio de pago en el POS:
- Connekta no genera registros en `merkahorro_pagos_pos_dev` (que filtra por `EFE`)
- El array `cajaConsolidada` queda vacío
- Siesa rechaza el documento con `"El valor de la cartera debe ser igual al valor de las CxC"`

### Flujo de conversión

1. **Detección:** durante `generarPayloadDocumento()`, si hay un medio de pago con valor `'DOM'`, se reemplaza por `'EFE'` en el payload
2. **Pago sintético:** si no hay ningún pago (caja vacía pero neto > 0), se crea una línea EFE por el total del documento
3. **Tracking:** se agrega `conversion_dom_efe` al array `automatizaciones_aplicadas` en `sps_facturas`
4. **Notificación:** después del envío exitoso, se dispara `sendConversionNotification()` por correo
5. **Automatizaciones:** se persisten en `automatizaciones_aplicadas` para trazabilidad

### Notificación de conversión

Las conversiones DOM→EFE generan un correo con:
- Documento (tipo + consecutivo)
- CO / Caja / Fecha
- Valor neto
- Detalle de cada conversión aplicada

---

## 16. Impuesto al Consumo (ICO)

### ¿Qué es ICO?

El **Impuesto al Consumo** (ICO) es un impuesto colombiano que aplica a productos específicos (cervezas, gaseosas). En Connekta aparece como `TASA=0` y `VLR_UNI>0` (valor fijo por unidad).

### Estado actual: ICO se envía a Siesa

A diferencia de versiones anteriores donde el ICO se **saltaba** (estado `'ICO'`, skip de envío), ahora las facturas con ICO **se envían a Siesa** con las correcciones necesarias.

### Reglas de envío

1. ICO tiene `TASA=0` y `VLR_UNI > 0` (impuesto de valor fijo)
2. En el payload de Siesa, las líneas con `TASA=0` **no se recalculan**: su `VALOR_TOTAL` viene de `VLR_UNI × CANTIDAD` y se respeta tal cual
3. Si en la misma factura coexisten IVA (`TASA>0`) e ICO (`TASA=0`), se fuerza `VLR_UNI=0` en las líneas de IVA para cumplir con la regla de FACTURA_DEV
4. El `BASE_GRAVABLE` se calcula solo para `meta.impuestos`, no se envía a Siesa

### Código clave

```js
// ~line 816-831: Regla FACTURA_DEV
// TASA > 0 → VLR_UNI debe ser 0
// VLR_UNI > 0 → TASA debe ser 0
const vlrUniFinal = tasaNum > 0 ? 0 : Math.round(vlrUniCalc);
```

```js
// ~line 870: ICO no se recalcula
// ICO (TASA = 0) NO se toca: su VALOR_TOTAL viene de VLR_UNI × CANT y se respeta tal cual.
```

### Migración desde versión anterior

Registros legacy con estado `'ICO'` se reintentan automáticamente (el idempotency check ya no los excluye). Al reprocesarse, se envían a Siesa con `VLR_UNI` corregido y quedan como OK/FALLO.

---

## 17. Notificaciones por correo

`notifier.js` implementa 3 tipos de notificaciones vía nodemailer (SMTP Office365).

### Configuración SMTP

| Variable | Descripción |
|----------|-------------|
| `SMTP_HOST` | smtp.office365.com |
| `SMTP_PORT` | 587 |
| `SMTP_SECURE` | false (STARTTLS) |
| `SMTP_USER` | notificacion@merkahorro.com |
| `SMTP_PASS` | App password |
| `SMTP_FROM` | notificacion@merkahorro.com |
| `NOTIFY_ERROR_EMAILS` | Destinatarios de errores (coma-separado) |
| `NOTIFY_CPE_EMAILS` | Destinatarios de CPE y conversiones (coma-separado) |

### 1. Error de sincronización (`sendErrorNotification`)

Cuando una factura queda en estado `FALLO` después de agotar reintentos.

- Template: rojo, tabla de datos + detalle del error
- Asunto: `❌ [SiesaPOS] Error en {tipo} {consecutivo}`
- Incluye: documento, CO/Caja, fecha, cliente NIT, neto, detalle del error
- Disparador: `enviarFacturaASiesa()` cuando se registra un resultado `ok: false`

### 2. Ajuste de inventario CPE (`sendCpeNotification`)

Cuando se inyecta stock automáticamente por inventario insuficiente.

- Template: azul, tabla de items inyectados + totales
- Asunto: `📦 [SiesaPOS] Ajuste inventario en {tipo} {consecutivo} ({N} item(s))`
- Incluye: documento, CO/Caja, fecha, detalle de items (ítem, bodega, cantidad, UN, costo, total)
- Disparador: `ejecutarPaso()` después de inyectar items vía CPE
- Fire-and-forget: `.catch()` para no bloquear el flujo

### 3. Conversión DOM → EFE (`sendConversionNotification`)

Cuando un pago DOM se convierte a EFE automáticamente.

- Template: naranja, detalle de conversiones aplicadas
- Asunto: `🔄 [SiesaPOS] Conversión pago en {tipo} {consecutivo} ({N} conversiones)`
- Incluye: documento, CO/Caja, fecha, valor, conversiones aplicadas
- Disparador: `ejecutarPaso()` después de envío exitoso con conversiones
- Fire-and-forget: `.catch()` para no bloquear el flujo

---

## 18. Dashboard — Frontend React

### Vistas (sidebar)

| Vista | Componente | Descripción |
|-------|-----------|-------------|
| Dashboard | `DashboardSiesaPos` | KPIs + gráficas + resumen diario + impuestos + ajustes |
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
4. Automatizaciones aplicadas (incluye conversion_dom_efe, sync_cliente, ajuste_inventario, cuadre_cxc)
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

### ResumenDiario

- Rango de fechas con presets (Hoy, 7 días, Este mes, Personalizado)
- Filtro por caja (Todas, Z01, Z02)
- 3 tarjetones: Total transacciones, Neto sincronizado, Genéricos
- Desglose por caja
- POS vs Sincronizado
- Categoría "Sin NIT" separada de genéricas

---

## 19. Componentes del Frontend

| Componente | Props | Estado interno |
|-----------|-------|---------------|
| `SiesaPosSync` | — | data, vista, modals, polling |
| `DashboardSiesaPos` | `data` | desde, hasta, estadisticas, resumenImpuestos, resumenAjustes |
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
| `getResumenImpuestos(desde, hasta)` | GET | `/api/logs/resumen-impuestos` |
| `getResumenAjustes(desde, hasta)` | GET | `/api/logs/resumen-ajustes` |
| `ejecutarSyncVentas(...)` | POST | `/api/sync-ventas` |
| `ejecutarSyncClientes(...)` | POST | `/api/sync-clientes` |
| `generarReporte(opts)` | POST | `/api/reportes/generar` |
| `getConfigReportes()` | GET | `/api/reportes/config` |
| `saveConfigReportes(cfg)` | POST | `/api/reportes/config` |
| `getHistorialReportes(limit)` | GET | `/api/reportes/historial` |
| `ping()` | GET | `/api/logs?limit=1` |

---

## 20. GitHub Actions — Workflows

### `sync-pos.yml` — Sincronización cada 1h

```yaml
schedule: '0 * * * *'   # Cada hora en punto UTC
workflow_dispatch:       # Manual con inputs co/caja/limite/solo_hoy
```

Ejecuta `node scripts/runSyncCron.js` con:
- `CO=001`, `Cajas=Z01,Z02` (fijo para PROD, sobrescribible en dispatch manual)
- `todas=true` (procesa todas las facturas filtradas)
- `soloHoy=true` (solo facturas de hoy)

**Node 22 requerido:** `@supabase/supabase-js` necesita WebSocket nativo. Node 20 crashea.

**Variables de entorno (GitHub Secrets):** CONNI_KEY, CONNI_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY, CIA, ENTORNO_SIESA, CONCURRENCIA, PAGINACION_CONCURRENCIA, MAX_RONDAS_AJUSTE, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, NOTIFY_ERROR_EMAILS, NOTIFY_CPE_EMAILS.

**Comportamiento:** el runner de GitHub Actions ejecuta el script Node directamente (no vía el endpoint de Vercel), así se evita el timeout serverless (el runner tiene hasta 60min).

**Caveats:**
- El cron se deshabilita tras ~60 días sin actividad en el repo
- Con `soloHoy`, fallos de días anteriores no se reintentan automáticamente
- `concurrency` evita que dos corridas se solapen

### `report-pos.yml` — Reportes diarios

Envía reportes PDF automáticos según la programación configurada en `sps_config_reportes`.

---

## 21. Scripts de diagnóstico

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
| `dumpPlano.js` | Dump de plano JSON para debug | — |

---

## 22. Deploy

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

**Node 22:** Vercel debe usar Node 22. Verificar en dashboard de Vercel → Project Settings → Node.js Version.

### Frontend (Vercel)

```bash
VITE_SIESA_POS_SYNC_URL=https://siesa-pos-sync.vercel.app
npm run build
```

### Variables en Vercel

Todas las variables de `.env` se configuran en el dashboard de Vercel (excepto `PORT`).

---

## 23. Resolución de problemas comunes

### Error 405 en Vercel

El endpoint de Vercel solo acepta el método configurado. Verificar `vercel.json` y que `app` se exporte correctamente (`module.exports = app`).

### Consec sin NIT

Facturas donde `f9820_id_cliente_pdv` está vacío o no tiene NIT real. Se tratan como genéricas (categoría `sinNit` en `por_nit`). Para evitarlo hacia adelante, el sync ahora identifica clientes primero.

### Caja=0 sin código fix

Ocurre cuando una factura no tiene pagos registrados en Connekta. El código no puede fijarlo — hay que revisar los datos en Connekta. Las transacciones DOM se convierten automáticamente a EFE.

### Doble conteo en rango de fechas

Resuelto: el endpoint `resumen-diario` excluye el día de hoy de `sps_estadisticas_diarias` (`.lt('fecha', hoy)`) si ya se consultó Connekta en vivo.

### Históricos sin datos (11/06 → 18/06)

Se corrigió insertando manualmente datos en `sps_estadisticas_diarias` y `sps_impuestos_offline` extraídos de Siesa vía Excel, día por día.

### ICO — Ya no se salta

Si ves una factura con estado `'ICO'` legacy, el sistema la reintentará automáticamente y la enviará a Siesa con `VLR_UNI` corregido. Ya no hay skip de ICO — todas las facturas con ICO se envían a Siesa.

### Genéricas 2222222222 no aparecen en dashboard

El query `merkahorro_venta_pos_dev` (usado para construir el payload de Siesa) excluye clientes `222222222222`. Las genéricas se capturan con `merkahorro_venta_pos_stats_dev` (configurable via `QUERY_STATS`) para el resumen diario. Si un día específico no se ven genéricas, verificar que el query stats esté configurado y que Connekta haya devuelto datos.

### Notificaciones no llegan

Verificar con `GET /api/diagnostico/env` que las variables SMTP y NOTIFY estén configuradas. En GitHub Actions, verificar que los Secrets estén creados.

### Node 20 + WebSocket error

`@supabase/supabase-js` requiere Node 22+ por WebSocket nativo. En Vercel, configurar Node 22 en Project Settings. En GitHub Actions, el workflow ya usa `node-version: '22'`.

---

## 24. Historial de cambios

### Julio 2026 (semana 2) — último
- **ICO ya no se salta:** se envía a Siesa con VLR_UNI corregido (VLR_UNI=0 cuando TASA>0, ICO con TASA=0 se respeta). Migración de registros legacy `'ICO'`.
- **Notificación de conversión DOM→EFE:** nueva función `sendConversionNotification()` en notifier.js con template naranja
- **Sin NIT en stats:** categoría `sinNit` separada en `por_nit` para documentos sin cliente POS
- **Pago EFE sintético para DOM:** si no hay pagos POS (DOM no genera registros), se crea EFE por el total
- **Mapeo DOM→EFE en syncVentas:** conversión automática de medio de pago DOM a EFE en el payload
- **sps_impuestos_offline:** nueva tabla para datos históricos de impuestos cargados manualmente
- **resumen-impuestos mejorado:** ahora combina `sps_impuestos_offline` + `sps_facturas.impuestos`
- **Endpoint `/api/diagnostico/env`:** diagnóstico rápido de variables de entorno
- **Stats seguros:** `guardarEstadisticasDiarias` omite upsert si Connekta devuelve 0 registros
- **Resumen diario con rango:** soporta `fechaInicio`/`fechaFin`, rellena días sin snapshot con sps_facturas, incluye hoy consultando Connekta en vivo
- **QUERY_STATS configurable:** desde `.env` para el query de estadísticas POS
- **Node 22 obligatorio:** por WebSocket nativo de `@supabase/supabase-js`

### Junio 2026 (semana 5)
- ICO skip flow (detección + skip + estado 'ICO') — **ya no aplica, reemplazado por envío a Siesa**
- Endpoint `GET /api/logs/resumen-impuestos` con dedup, agregación por llave, `TAX_DESCRIPTIONS`
- Endpoint `GET /api/logs/resumen-ajustes` con agregación de CPEs
- Dashboard secciones "Resumen de Impuestos" y "Ajustes de Inventario"
- Badge ICO azul + filtro "Solo ICO" en FacturasTable (**revisar: ICO ya no se salta**)

### Junio 2026 (semana 4)
- Endpoint `/api/logs/ajustes` + componente `AjustesInventario.jsx`
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
- Filtro ICO (VALOR_TOTAL > 0) — **revisar: ya no se filtra**
- IVA Math.round
- Convergencia Cartera vs CxC (delta ≤ $10, SIN_RECAUDO)
- BASE_GRAVABLE fix (no contamina array Impuestos)
- Impuesto dedup (Set RowidMvto|ID_LLAVE_IMPUESTO)
- normalizarUM(): P6/P12/P24 → UND
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
- Ventana de fecha máxima: ~2 días (las queries no pagan)
- Nuevos items de inventario: agregar al `CASE` en `merkahorro_venta_pos_dev`
