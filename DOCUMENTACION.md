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
25. [Flujo 011 Genéricos (muestreo diario 9pm)](#25-flujo-011-genéricos-muestreo-diario-9pm)
26. [Flujo Transformación Tocino → Chicharrón (diario 10pm)](#26-flujo-transformación-tocino--chicharrón-diario-10pm)

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

**`IdTercero` vs `NitTercero`.** El query cruza el documento POS con la maestra `t9740_pdv_clientes` (`f9820_id_cliente_pdv = f9740_id`) y devuelve `f9740_id AS IdTercero` (código del cliente en el POS) y `f9740_nit AS NitTercero`. El flujo envía a Siesa siempre `NitTercero` (normalizado sin espacios) como `ID_TERCERO` / `TERCERO_REM`. Ambos campos pueden estar digitados distinto en el POS:

- Caso benigno: el código es el NIT con su dígito de verificación DIAN pegado (ej. `9007451372` vs `900745137`, DV = 2), o difieren solo por un sufijo `-DV`. No se alerta.
- Caso real: documentos distintos (ej. `1035428107` vs `1035867370`). La factura queda en Siesa bajo un ID diferente al que espera el reporte de cruce del POS.

Cuando difieren de verdad (`compararIdNitCliente` en `documento.js`), el flujo **no cambia el envío**, pero: registra un `console.warn` con co/caja/consec, agrega `cliente_id_nit_distinto:id=<IdTercero>,nit=<NitTercero>` a `sps_facturas.automatizaciones_aplicadas` y envía un correo por factura (solo en el paso CFZ) a `NOTIFY_ERROR_EMAILS` para que se confirme el documento real y se corrija el cliente en el POS.

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

### Flujo 011 genéricos procesa 0 facturas ("página 1 vacía")

**Causa más común: el job corrió DESPUÉS del cierre del POS.** Las queries del flujo leen las **tablas vivas** (`t9820_pdv_d_*`), que **solo conservan el día en curso**; al cerrar el día, el POS mueve los documentos a los **acumulados** (`t9920_pdv_a_*`) y la tabla viva queda vacía.

Ocurrió el 21 y 22-ago-2026 con el job a las 10pm (el 22 hubo 104 genéricas y procesó 0). El 19-ago a las 10:17pm sí funcionó porque ese día el cierre fue más tarde — **la hora de cierre varía**, por eso el síntoma es intermitente. **Solución aplicada:** bajar el cron a las **8:30pm**. Si vuelve a ocurrir, adelantar más la hora.

**Cómo verificar:** el flujo avisa qué días SÍ devolvió la query (`⚠️ La query SÍ devolvió datos, pero de otros días: ...`). Si no devolvió ninguno, el log indica explícitamente que lo más probable es que el POS ya haya cerrado el día.

**Ojo con los falsos "0":** si Connekta responde 500/429/timeout en la página 1, antes se reportaba como "página 1 vacía" y el job terminaba en verde. Ahora esa condición **lanza error** y el job queda en rojo (`Connekta falló en la página 1`).

### Notificaciones no llegan

Verificar con `GET /api/diagnostico/env` que las variables SMTP y NOTIFY estén configuradas. En GitHub Actions, verificar que los Secrets estén creados.

### Node 20 + WebSocket error

`@supabase/supabase-js` requiere Node 22+ por WebSocket nativo. En Vercel, configurar Node 22 en Project Settings. En GitHub Actions, el workflow ya usa `node-version: '22'`.

---

## 24. Historial de cambios

### Agosto 2026 — Flujo 011 Genéricos
- **Nuevo flujo `sync011Gen.js`** (fork de `syncVentas.js`): exclusivo CO 011 / caja Z01 / clientes genéricos (222222222222), muestreo del 10% diario, cron 10pm COT. Ver [sección 25](#25-flujo-011-genéricos-muestreo-diario-9pm).
- **3 queries Connekta nuevas** `_011_gen` (ventas/impuestos/pagos): invierten el filtro de NIT (solo `= 222222222222`), acotan `CO=011` y `Z01`, y usan `LEFT OUTER JOIN` de clientes.
- **Muestreo determinista distribuido**: toma el 10% de las genéricas del día repartido de punta a punta (reproducible).
- **Escritura aislada a QA** vía switch propio `ENTORNO_SIESA_011` (default QA), independiente del flujo normal (que sigue en PROD).
- **Workflow `sync-011-gen.yml`** + orquestador `scripts/runSync011GenCron.js`.

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

## 25. Flujo 011 Genéricos (muestreo diario 9pm)

Flujo **independiente y adicional** al normal. Procesa las facturas de **clientes genéricos** (`222222222222`) del **CO 011 / caja Z01**, tomando una **muestra del 10%** de las del día, una vez al día a las **8:30 pm (COT)**.

> ⚠️ **El horario es crítico: el job DEBE correr ANTES del cierre del POS.** Las queries leen las tablas **vivas** (`t9820_pdv_d_*`, prefijo **"d"**), que **solo conservan el día en curso**: cuando el POS cierra el día, mueve los documentos a las tablas de **acumulados** (`t9920_pdv_a_*`) y la tabla viva queda vacía. El 21 y 22-ago-2026 el flujo corría a las 10pm y procesó **0 facturas** por esa razón (el 19-ago a las 10:17pm sí funcionó: ese día el cierre fue más tarde). Se bajó a las 8:30pm para tener margen. Ver [sección 23](#23-resolución-de-problemas-comunes).

Reutiliza la MISMA mecánica del flujo normal (CNZ→CFZ, auto-corrección, DOM→EFE, CPE, idempotencia).

### ¿Por qué un flujo aparte?

El flujo normal (`syncVentas.js`) **excluye** los genéricos (`<> '222222222222'`) y procesa solo NIT reales. Este flujo hace lo **inverso**: solo genéricos del 011/Z01. Como la lógica de armado del documento debía ser idéntica y no se podía tocar `syncVentas.js`, se hizo un **fork** (`sync011Gen.js`).

> ⚠️ **`sync011Gen.js` es una copia de `syncVentas.js`.** Si se arregla un bug en la lógica de payload/cuadre/CxC/CPE del flujo normal, hay que **replicarlo en el fork** o los dos flujos divergen.

### Diferencias vs. flujo normal

| Aspecto | Flujo normal | Flujo 011 genéricos |
|---------|--------------|----------------------|
| Archivo | `syncVentas.js` | `sync011Gen.js` (fork) |
| CO / Caja | 001 (Z01,Z02) + 011 (Z01) | **011 / Z01 exclusivo** |
| Clientes | NIT reales (excluye 222222222222) | **Solo 222222222222** |
| Cadencia | Cada 1 h | **Diaria, 8:30pm COT (antes del cierre)** |
| Alcance | Todas las nuevas del día | **Muestra del 10%** de las genéricas del día |
| Entorno escritura | `ENTORNO_SIESA` (PROD) | **`ENTORNO_SIESA_011` (default QA)** |
| Estadísticas diarias | Las guarda | **No las toca** |

### Queries Connekta (`_011_gen`)

Espejo de las normales, con 3 cambios: (1) `f9820_id_cliente_pdv = '222222222222'` (filtro invertido), (2) `f9820_id_co = '011'` y `f9820_id_tipo_docto = 'Z01'`, (3) cliente en `LEFT OUTER JOIN`. El corte del día se hace en Node con hora Bogotá, **nunca** con la fecha del server SQL.

| Query | Base | Uso |
|-------|------|-----|
| `merkahorro_venta_pos_011_gen` | `merkahorro_venta_pos_dev` | Detalle de ventas |
| `merkahorro_imptos_pos_011_gen` | `merkahorro_imptos_pos_dev` | Impuestos por línea |
| `merkahorro_pagos_pos_011_gen` | `merkahorro_pagos_pos_dev` | Medios de pago (EFE/TR) |

**Nota sobre la ventana de fechas:** el `WHERE` usa `CAST(f9820_id_fecha_docto AS VARCHAR(8)) >= CONVERT(varchar(8), DATEADD(day,-2,GETDATE()), 112)`, pero ese `CAST` sobre un campo de fecha no produce `20260821` sino texto (`Aug 21 2`), así que **la comparación no filtra realmente**. No importa en la práctica: la tabla viva solo tiene el día en curso, y el día objetivo se recorta en Node.

**Si alguna vez se necesita el día ya cerrado**, hay que leer las tablas de acumulados: `t9820_pdv_d_doctos`→`t9920_pdv_a_doctos` (`f9820_`→`f9920_`), `t9830`→`t9930`, `t9831`→`t9931`, `t9832`→`t9932`, `t9821_pdv_d_movto_mp`→`t9921_pdv_a_movto_mp`. Las maestras (`t9740_pdv_clientes`, `t150_mc_bodegas`, `v121`) no cambian.

Inventario y costo (`merkahorro_consulta_inventario`, `merkahorro_costo_promedio_dev`) se **reutilizan** tal cual. El fork usa **paginación completa** (`tamPag=1000`), no solo la primera página de 100.

### Muestreo del 10% (determinista distribuido)

Se calcula UNA sola vez y se comparte entre CNZ y CFZ (ambos pasos procesan exactamente las mismas facturas). Sobre los consecutivos genéricos del día **ordenados**, toma el 10% repartido de punta a punta:

```
target = max(1, round(total * 10 / 100))     // redondeo al más cercano, mínimo 1
índice_i = round(i * total / target)          // i = 0..target-1  (espaciado uniforme)
```

Ejemplos: 60 → 6 (índices 0,10,20,30,40,50) · 43 → 4 · 7 → 1 · 0 → 0. Es **reproducible**: un reintento del job elige exactamente las mismas → seguro con la idempotencia.

### Escritura aislada a QA

El fork usa su **propio** switch `ENTORNO_SIESA_011` (default `QA`), distinto del `ENTORNO_SIESA` del flujo normal. Así, mientras se prueba, escribe **siempre a Siesa QA** sin afectar la producción del flujo normal. La **lectura** de Connekta siempre es PROD (solo SELECT, no inserta). Para pasar el flujo a producción: `ENTORNO_SIESA_011=PROD`.

### Variables de entorno del flujo

| Variable | Default | Descripción |
|----------|---------|-------------|
| `ENTORNO_SIESA_011` | `QA` (código) / `PROD` (cron) | Entorno de ESCRITURA de este flujo. Default `QA` en el código (seguro para correr local); el cron del workflow lo setea a `PROD` |
| `MUESTRA_PORCENTAJE_011` | `10` | Porcentaje del muestreo |
| `MUESTRA_FECHA_011` | hoy Bogotá | Fecha a procesar (YYYY-MM-DD). **Solo sirve para días que sigan en la tabla viva** (el día en curso) |
| `MUESTRA_SOLO_CNZ` | `false` | Corta en CNZ (no envía CFZ) |
| `MUESTRA_DRY_RUN` | `false` | Solo muestra la muestra y sale SIN escribir a Siesa |

### Archivos

| Archivo | Rol |
|---------|-----|
| `sync011Gen.js` | Motor (fork). Exporta `sync011Gen(opciones)` |
| `scripts/runSync011GenCron.js` | Orquestador del job (para GitHub Actions) |
| `.github/workflows/sync-011-gen.yml` | Cron `30 1 * * *` (= **8:30pm COT**, antes del cierre del POS). El cron escribe a **PROD**; el dispatch manual usa el input `entorno` (default QA). Inputs: porcentaje, fecha, solo_cnz, dry_run, entorno |

### Cómo probar

```bash
# 1) Ver la muestra del día SIN escribir nada (read-only)
MUESTRA_DRY_RUN=true node scripts/runSync011GenCron.js

# 2) Enviar UNA sola CNZ a QA (porcentaje 1 → mínimo 1 factura), sin correos
MUESTRA_PORCENTAJE_011=1 MUESTRA_SOLO_CNZ=true \
  NOTIFY_ERROR_EMAILS='' NOTIFY_CPE_EMAILS='' NOTIFY_EMAILS='' \
  node scripts/runSync011GenCron.js

# 3) Ciclo CNZ→CFZ del 10% real a QA
NOTIFY_ERROR_EMAILS='' NOTIFY_CPE_EMAILS='' NOTIFY_EMAILS='' \
  node scripts/runSync011GenCron.js
```

### Trazabilidad

Los documentos de este flujo quedan en `sps_facturas` con id `{tipo}:011:Z01:{consec}`. Se identifican de forma **inequívoca** por **`cliente_nit = '222222222222'`** (el flujo normal nunca envía genéricos). El frontend usa ese marcador para mostrar la actividad exclusiva del flujo 011-genéricos.

---

## 26. Flujo Transformación Tocino → Chicharrón (diario 10pm)

### Propósito

El CHICHARRON MERKAHORRO (ítem **15207**) se vende por unidad, pero se produce a partir de tocino (ítem **15202**, en KL). Cada noche el flujo toma las **unidades netas vendidas** del día y registra en Siesa la transformación:

- **ENTRADA (CEI)**: suma las unidades de chicharrón (15207) al inventario.
- **SALIDA (CSA)**: descuenta el tocino (15202) consumido = unidades netas × factor (0.38 KL por unidad).

Un par de documentos por cada **(fecha, CO, bodega)**.

### Horario y ejecución

| Dato | Valor |
|------|-------|
| Módulo | `transformacionCarnes.js` |
| Runner | `scripts/runTransformacionCron.js` |
| Workflow | `.github/workflows/transformacion-carnes.yml` |
| Cron | `0 3 * * *` UTC = **10:00 pm Bogotá** |
| Manual | `workflow_dispatch` con inputs `fecha` (YYYY-MM-DD), `dry_run` y `entorno` (QA/PROD, **default QA**) |
| Entorno de escritura | `ENTORNO_SIESA_TRANSF`: el **cron escribe a PROD**; el manual usa el input `entorno` (default QA). Sin la variable, el código cae en QA |

La lectura de Connekta es **siempre PROD** (solo SELECT). Solo la escritura a Siesa cambia según el entorno.

**Fecha objetivo y guardia horaria**

- El workflow calcula la fecha antes de correr: en `schedule` usa la fecha de Bogotá de **hace 4 horas** (`TZ=America/Bogota date -d '4 hours ago' +%F`), así que un retraso del cron de hasta 4 h sigue cayendo en el día correcto. En `workflow_dispatch` usa el input `fecha` tal cual; vacío = hoy en Bogotá (el código trata `''` como no definido).
- **Guardia de las 21:30 COT** (no aplica en dry-run): si el día objetivo es hoy en Bogotá y son menos de las 21:30, el flujo lanza error ("no se procesa el día en curso antes de las 21:30 COT: el día está incompleto") para no fijar un neto parcial. Fechas pasadas siempre se permiten; fechas futuras siempre dan error.

### Queries Connekta

Connekta **rompe las consultas con `UNION ALL`** (reporta columnas válidas como inválidas), por eso son **dos queries** que el código concatena y **deduplica por `RowidMvto`**:

| Query | Tablas | Alcance |
|-------|--------|---------|
| `merkahorro_venta_transformacion` | vivas (`t9820`/`t9830`) | Solo el día en curso |
| `merkahorro_venta_transformacion_acum` | acumulados (`t9920`/`t9930`) | Últimos 3 días |

Los nombres son configurables con `TRANSF_QUERY_VIVO` y `TRANSF_QUERY_ACUM`. Ambas devuelven las mismas columnas: `CoDoc, ID_TIPO_DOCTO, CONSEC_DOCTO, FECHA_DOCTO, ID_CLASE_DOCTO, IndEstado, IdClientePdv, RowidMvto, id_concepto, id_motivo, ind_naturaleza, CANTIDAD, UNIDAD_MEDIDA, BODEGA, id_item, DescItem, tipo_inv_serv`.

Query viva:

```sql
SELECT D.f9820_id_co AS CoDoc, D.f9820_id_tipo_docto AS ID_TIPO_DOCTO, D.f9820_consec_docto AS CONSEC_DOCTO, D.f9820_id_fecha_docto AS FECHA_DOCTO, D.f9820_id_clase_docto AS ID_CLASE_DOCTO, D.f9820_ind_estado AS IndEstado, D.f9820_id_cliente_pdv AS IdClientePdv, M.f9830_guid AS RowidMvto, M.f9830_id_concepto AS id_concepto, M.f9830_id_motivo AS id_motivo, M.f9830_ind_naturaleza AS ind_naturaleza, M.f9830_cant_1 AS CANTIDAD, M.f9830_id_unidad_medida AS UNIDAD_MEDIDA, B.f150_id AS BODEGA, I.v121_id_item AS id_item, I.v121_descripcion AS DescItem, LTRIM(RTRIM(I.v121_id_tipo_inv_serv)) AS tipo_inv_serv
FROM dbo.t9820_pdv_d_doctos D
INNER JOIN dbo.t9830_pdv_d_movto_venta M ON D.f9820_guid = M.f9830_guid_docto AND D.f9820_id_cia = M.f9830_id_cia
INNER JOIN dbo.t150_mc_bodegas B ON M.f9830_rowid_bodega = B.f150_rowid AND M.f9830_id_cia = B.f150_id_cia
INNER JOIN dbo.v121 I ON M.f9830_rowid_item_ext = I.v121_rowid_item_ext AND M.f9830_id_cia = I.v121_id_cia
WHERE D.f9820_id_cia = 1 AND I.v121_id_item IN (15207)
```

Query de acumulados: igual, con `t9920_pdv_a_doctos` / `t9930_pdv_a_movto_venta`, prefijos `f9920_` / `f9930_`, y el filtro adicional:

```sql
AND D.f9920_id_fecha_docto >= DATEADD(day, -3, CAST(GETDATE() AS date))
```

> Ambas solo traen el ítem 15207. Para agregar más ítems a la transformación hay que ampliar el `IN (...)` de las dos queries **y** el mapa `TRANSF_MAPA`.

La descarga es paginada completa (`tamPag=1000`, `TRANSF_TAM_PAGINA`) con reintentos. Si una página falla tras 3 intentos el flujo **aborta** (un total parcial daría unidades netas incorrectas).

### Reglas de negocio

1. **Día objetivo**: hoy en `America/Bogota` (nunca la hora del servidor). Override con `TRANSF_FECHA=YYYY-MM-DD` para reprocesar. Se compara solo la parte fecha de `FECHA_DOCTO`.
2. **Clasificación** (se usan **ambos** campos juntos):

   | Tipo | Condición | Efecto |
   |------|-----------|--------|
   | Venta | `ind_naturaleza = 2` y `ID_CLASE_DOCTO = 1231` | `+CANTIDAD` |
   | Devolución (nota crédito, tipo PN7) | `ind_naturaleza = 1` y `ID_CLASE_DOCTO = 1250` | `−CANTIDAD` |
   | Cualquier otra | — | **No se cuenta**; se informa en el correo de alertas |

3. **No se filtra por tipo de documento ni por cliente.** Las ventas vienen de muchos tipos (P03–P10, Z01, Z02) y clientes (incluido el genérico 222222222222). Cada unidad suele ser su propia línea: se **suman líneas**, nunca se deduplica por documento (solo por `RowidMvto`).
4. **Agrupación** por (fecha, `CoDoc`, `BODEGA`, ítem). Unidades netas = ventas − devoluciones. Si el neto es **≤ 0** no se envía nada para ese grupo y se alerta por correo.
5. **Mapa de transformaciones** (`TRANSF_MAPA`, JSON). Se valida al arrancar y el flujo falla si es inválido. Default:

   ```json
   [{ "itemVenta": 15207, "insumo": 15202, "factor": 0.38, "umVenta": "UND", "umInsumo": "KL", "unidadNegocio": "003", "costoUnitario": 9873 }]
   ```

   `costoUnitario` (obligatorio, > 0): costo unitario de la ENTRADA definido por contabilidad (9873 COP por unidad, confirmado 2026-10-23). Sin él Siesa rechaza el CEI con `46033-El costo promedio total debe ser mayor a cero` cuando el ítem no tiene costo promedio en la bodega. Si `TRANSF_MAPA` se define en GitHub sin este campo, el flujo falla al arrancar.

   Campo opcional `nombre` (default `chicharron`), usado en la NOTA.
6. Una fila con unidad de medida distinta a `umVenta` **se cuenta igual** pero se advierte en el correo.

### Documentos enviados a Siesa

Conector **259946 — `TRANSFORMACIONES_CARNES_DEV`** (configurable con `TRANSF_ID_DOCUMENTO` / `TRANSF_NOMBRE_DOCUMENTO`), por el mismo endpoint `conectoresimportar` que usan los demás flujos:

`POST https://{servicios|serviciosqa}.siesacloud.com/api/siesa/v3.1/conectoresimportar?idCompania={CIA}&idSistema=1&idDocumento=259946&nombreDocumento=TRANSFORMACIONES_CARNES_DEV` con headers `ConniKey` / `ConniToken`.

Por grupo se hacen **dos llamadas separadas, ENTRADA primero**. La salida solo se envía si la entrada quedó OK.

| | ENTRADA | SALIDA |
|---|---------|--------|
| `TIPO_DTO` | `CEI` | `CSA` |
| `CLASE_DTO` | `61` | `62` |
| `CONCEPTO` | `601` | `602` |
| `MOTIVO` | `06` | `10` |
| `ITEM` | `0015207` | `0015202` |
| `UNIDAD_MEDIDA` | `UND` | `KL` |
| `CANTIDAD` | unidades netas | unidades netas × factor (redondeado a 4 decimales) |
| `COSTO_PROMEDIO_UNITARIO` | `costoUnitario` del mapa | `0` (Siesa usa el costo promedio del tocino) |

Comunes: `BODEGA` = bodega de la fila de venta (nunca fija), `CENTRO_OPERA_MOVIMIENTO` = `CoDoc`, `UNIDAD_NEGOCIO` del mapa, `CONSECUTIVO` = `"0"`, `NRO_REGISTRO` = `"1"`, fecha = día objetivo `AAAAMMDD`, `NOTA` = `Transformacion chicharron 2026-10-19 CO 001 - 12 und`. `CANTIDAD` se formatea con `formatDecimal` (4 decimales, relleno a 20 caracteres).

```json
{
  "Documentos": [{ "TIPO_DTO": "CEI", "FECHA_DOCUMENTO=8 (AAAAMMDD)": "20261019", "CLASE_DTO": "61", "NOTA": "Transformacion chicharron 2026-10-19 CO 001 - 12 und", "CONCEPTO": "601" }],
  "Movimientos": [{ "TIPO_DTO": "CEI", "CONSECUTIVO": "0", "NRO_REGISTRO": "1", "BODEGA": "PV001", "CONCEPTO": "601", "MOTIVO": "06", "CENTRO_OPERA_MOVIMIENTO": "001", "UNIDAD_MEDIDA": "UND", "CANTIDAD": "000000000000012.0000", "ITEM": "0015207", "UNIDAD_NEGOCIO": "003" }]
}
```

Ya fijos en el conector (no se envían): compañía 001, CO 001, consecutivo automático, cant_2 = 0. El costo (`f470_costo_prom_uni`) ya **no** es fijo: se mapea a `COSTO_PROMEDIO_UNITARIO`. El conector exige la clave en TODOS los movimientos: el CEI envía `costoUnitario` y el CSA envía `0` (Siesa valoriza la salida con el costo promedio). Sin la clave en el CSA, Siesa responde "Error en la Estructura".

### Idempotencia

Tabla **`sps_transformaciones`** (migración `migrations/005_create_sps_transformaciones.sql`, se ejecuta a mano en Supabase). Una fila por documento, clave única `(fecha, co, bodega, item_venta, tipo_dto)`. Guarda payload, respuesta de Siesa, estado (`OK`/`ERROR`), unidades netas, cantidad, intentos y entorno.

- Documento `OK` → **nunca se reenvía**. Una corrida repetida de un día ya OK no envía nada.
- CEI `OK` y CSA `ERROR` → el reintento envía **solo CSA**.
- Documento en `ERROR` → se reintenta en la siguiente corrida (re-ejecutar el workflow con `fecha`).
- Si las unidades netas cambian después de un envío OK (p. ej. una devolución tardía), **no se corrige automáticamente**: se advierte en el log **y en el correo de alertas** y debe revisarse a mano. Si el CEI ya estaba OK y el CSA se envía en una corrida posterior, el CSA se calcula con las unidades del CEI ya registrado (no con el neto actual), para que la salida de tocino corresponda a la entrada.
- Si Siesa acepta pero falla el guardado en Supabase: antes de guardar se imprime en el log la fila completa y la respuesta de Siesa (líneas `RESPALDO`, para conciliar a mano); el guardado se reintenta 3 veces (1 s / 2 s). Si aun así falla, se alerta (“NO reenviar a mano”), se **aborta el resto de la corrida** (no se envía ningún documento más), se manda igual el correo resumen y el job queda en rojo.
- Filas del día sin `RowidMvto`: en corrida real se lanza error antes de enviar nada (sin RowidMvto no hay deduplicación y se contaría doble); en dry-run solo se advierte.
- `CoDoc` se normaliza con `padStart(3,'0')` (`"1"` → `"001"`).

**Resultado AMBIGUO del POST a Siesa**

El POST tiene `timeout` de 120 s. Un rechazo es **definitivo** solo si hay respuesta y (status 4xx, o `detalle` estructurado no vacío). Todo lo demás (sin respuesta, timeout, ECONNRESET, 5xx sin `detalle`) es **ambiguo**: no se sabe si Siesa creó el documento. En ese caso la fila queda en `ERROR` con el texto `AMBIGUO: ...` en la columna `error`, y:

- **No se reenvía automáticamente** en ninguna corrida posterior; se alerta por correo y el job queda en rojo.
- Si el CEI es ambiguo (ahora o previamente), el CSA de ese grupo **no se envía**.
- Procedimiento manual: (1) verificar en Siesa si el documento existe; (2) si **existe**, no reenviar: corregir la fila a mano en `sps_transformaciones` (`status = 'OK'`, `error = null`); si **no existe**, borrar la fila de `sps_transformaciones`; (3) re-ejecutar el workflow con `workflow_dispatch` indicando `fecha` (y `entorno` = PROD si es un día real).

**Reprocesar un día pasado cuyo CSA falló por falta de stock de tocino**

Cuando se corrija el stock: ejecutar `workflow_dispatch` con `fecha` = día a reprocesar y `entorno` = **PROD**. Solo funciona dentro de la ventana de la query de acumulados (**últimos 3 días**); fuera de ella no habrá filas. Como el CEI ya está OK, solo se reenvía el CSA (con las unidades del CEI registrado).

> La clave incluye `item_venta` (además de fecha/CO/bodega/tipo) para que más ítems en el mapa no colisionen.

### Variables de entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `ENTORNO_SIESA_TRANSF` | `QA` | Entorno de **escritura** (QA / PROD) |
| `TRANSF_FECHA` | hoy Bogotá | Día a procesar (YYYY-MM-DD) |
| `TRANSF_DRY_RUN` | — | `1`/`true`: no POST a Siesa, no escribe en Supabase, no envía correo |
| `TRANSF_MAPA` | ver arriba | JSON del mapa de transformaciones |
| `TRANSF_ID_DOCUMENTO` | `259946` | Id del conector Siesa |
| `TRANSF_NOMBRE_DOCUMENTO` | `TRANSFORMACIONES_CARNES_DEV` | Nombre del conector |
| `TRANSF_QUERY_VIVO` | `merkahorro_venta_transformacion` | Query Connekta (tablas vivas) |
| `TRANSF_QUERY_ACUM` | `merkahorro_venta_transformacion_acum` | Query Connekta (acumulados) |
| `TRANSF_TAM_PAGINA` | `1000` | Tamaño de página de Connekta |
| `NOTIFY_TRANSF_EMAILS` | `NOTIFY_EMAILS` | Destinatarios (separados por coma) |

Además usa `CONNI_KEY`, `CONNI_TOKEN`, `CIA`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` y las `SMTP_*`.

### Dry run

```bash
# Muestra totales por grupo y los payloads completos; no envía, no escribe, no manda correo
TRANSF_DRY_RUN=1 TRANSF_FECHA=2026-10-19 node scripts/runTransformacionCron.js
```

También disponible como input `dry_run` del workflow manual.

### Notificaciones

`notifier.sendTransformacionNotification` envía **un correo diario** a `NOTIFY_TRANSF_EMAILS || NOTIFY_EMAILS` con el resumen (grupos, unidades, kg, estado CEI/CSA) y las **alertas**: filas no clasificadas, ítems sin configuración, unidad de medida distinta, neto ≤ 0, rechazos de Siesa, errores al guardar en Supabase y **0 filas devueltas** (probable cierre del POS que vació las tablas vivas sin que los acumulados lo traigan aún).

El job queda en **rojo** ante rechazos de Siesa, resultados ambiguos o errores al registrar; las demás alertas no lo ponen en rojo. El notifier solo renderiza listas conocidas, por eso los casos ambiguos y los cambios de neto se reflejan también en la lista de errores de Siesa con un mensaje explícito (los títulos dirán "Siesa rechazó CEI AMBIGUO" / "(AVISO, no es rechazo)"; leer el detalle).

### Registro de corridas

Cada corrida **no dry-run** deja una fila en la tabla `sps_transformaciones_corridas` (migración `migrations/006_create_sps_transformaciones_corridas.sql`, **se ejecuta a mano** en Supabase). Así la vista de Transformaciones de Carnes puede mostrar también los días en que el flujo no envió nada.

- **Resultados:** `PROCESADO` (hubo grupos y todo OK), `SIN_VENTAS` (0 grupos; si las tablas vivas llegaron vacías, el mensaje avisa del posible hueco por cierre del POS), `CON_FALLO` (fallos de Siesa o errores al guardar) y `ERROR_FATAL` (el job terminó con excepción; lo registra `scripts/runTransformacionCron.js`).
- **Sin clave única:** una fila por corrida; se conserva el historial. La vista usa la última corrida por `(entorno, fecha)`.
- **Best-effort:** `registrarCorrida` nunca lanza; se llama después de la notificación, con tope de 10 s por intento y 2 intentos. Si falla solo emite un `console.warn` y no cambia el resultado ni el código de salida del job. Los rechazos de la guardia de fecha (`codigo = VALIDACION_FECHA`) no se registran como `ERROR_FATAL`.
- **Escritura y lectura:** solo la escribe siesa-pos-sync; la lee Backend-Carnes (`GET /api/transformaciones/corridas`).
- **Backfill:** la migración inserta el registro manual del 23/10/2026 (`PROD`, `SIN_VENTAS`, origen `manual`), anterior al registro de corridas. El INSERT es idempotente: no agrega nada si ya existe alguna corrida (de cualquier origen) de `PROD` para el 23/10, así que la migración se puede volver a ejecutar sin duplicar.

### Pendientes

- **Tocino insuficiente (decisión de negocio PENDIENTE).** Si la bodega no tiene tocino suficiente, Siesa rechazará la SALIDA (CSA). Hoy no hay manejo especial: se registra el error en `sps_transformaciones`, se notifica y el job queda en rojo. Queda un comentario `// PENDIENTE:` en `enviarASiesa` (`transformacionCarnes.js`). Opciones por definir: inyectar stock (como el CPE del flujo 011) u omitir.
- Salida a **PROD**: ya aplicada en el cron (`ENTORNO_SIESA_TRANSF` = PROD en `schedule`); las corridas manuales siguen en QA salvo que se elija PROD.

---

## 27. Flujo Transformación de Inventario Negativo (después de tocino)

### Propósito

Cuando un ítem destino de carnes queda con **inventario negativo** en una bodega, el flujo lo normaliza con una transformación en Siesa: una **ENTRADA (CEI)** del destino por la cantidad negativa y una o varias **SALIDAS (CSA)**, una por cada ítem origen con stock, según la tabla de equivalencias y prioridades. El costo del destino se toma de la consulta de inventario; si falta costo o unidad de medida (UM), el destino no se envía y se reporta.

### Ejecución y orden

| Dato | Valor |
|------|-------|
| Módulo | `transformacionNegativos.js` (planificador puro: `transformacionNegativosPlan.js`) |
| Runner | `scripts/runTransformacionNegativosCron.js` |
| Workflow | `.github/workflows/transformacion-carnes.yml`, job `transformacion-negativos` |
| Orden | corre **después** del job de tocino (`needs: transformacion-carnes`); si tocino falla, este job se omite |
| Concurrencia | grupo propio `transformacion-negativos`, `cancel-in-progress: false` |
| Entradas | las mismas del workflow manual: `fecha`, `dry_run`, `entorno` (default QA; el cron escribe a PROD) |

**Reglas de fecha:** el día en curso solo se procesa desde las 21:30 COT; una fecha futura se rechaza sin escribir nada; una **fecha pasada solo reanuda** documentos pendientes (no consulta inventario ni planifica nuevos destinos).

### Variables de entorno

| Variable | Default | Descripción |
|----------|---------|-------------|
| `TRANSF_NEG_QUERY_INVENTARIO` | `merkahorro_items_inventario_costo_dev_transformaciones` | Query Connekta de inventario. Vacía = falla rápida |
| `TRANSF_NEG_COLUMNAS` | (código) | JSON para sobreescribir nombres de columnas |
| `TRANSF_NEG_ITEMS_EXCLUIDOS` | `15207` | Ítems adicionales que nunca se tratan como destino (enteros separados por coma). **Se suman** al default: `15207` siempre queda excluido. Un token que no sea entero falla rápido con error de configuración |
| `TRANSF_NEG_DIAS_REANUDAR` | `7` | Ventana (días) para reanudar documentos pendientes |
| `TRANSF_NEG_UNIDAD_NEGOCIO` | `003` | Unidad de negocio |
| `NOTIFY_TRANSF_NEG_EMAILS` | `NOTIFY_TRANSF_EMAILS`, luego `NOTIFY_EMAILS` | Destinatarios (los definitivos aún no están confirmados por negocio) |

Comparte `TRANSF_ID_DOCUMENTO`, `TRANSF_NOMBRE_DOCUMENTO`, `TRANSF_FECHA`, `TRANSF_DRY_RUN`, `ENTORNO_SIESA_TRANSF`, `CONNI_*`, `CIA`, `SUPABASE_*` y `SMTP_*` con el flujo de tocino.

### Tablas (migraciones 007 y 008, **se ejecutan a mano** en Supabase)

- `sps_transformaciones_equivalencias`: origen -> destino, factor y UM (semilla de la migración 008).
- `sps_transformaciones_prioridad`: orden de consumo de orígenes por destino.
- `sps_transformaciones_negativos`: un documento por fila (CEI/CSA), con `status`.
- `sps_transformaciones_negativos_corridas`: una fila por corrida (`PROCESADO`, `SIN_NEGATIVOS`, `CON_FALLO`, `ERROR_FATAL`).

### Estados de un documento

| Estado | Significado |
|--------|-------------|
| `PLANNED` | Planificado y guardado; aún no enviado |
| `SENDING` | Marcado **antes** del POST a Siesa. Si la corrida muere en este punto, al iniciar la siguiente pasa a `AMBIGUO` |
| `OK` | Siesa lo aceptó |
| `ERROR` | Siesa lo rechazó; se reintenta en la siguiente corrida |
| `AMBIGUO` | No se sabe si Siesa lo recibió. **Nunca se reenvía automáticamente** |
| `CANCELADO` | Documento de un día previo no enviado (`PLANNED` con 0 intentos o `ERROR`), cancelado al iniciar antes de planificar los nuevos destinos |

Secuencia: se guarda **todo el plan** antes de enviar; la CEI se envía antes que las CSA; si la CEI falla o queda `AMBIGUO`, las CSA quedan **bloqueadas**. Si el guardado del plan quedó incompleto (la CEI espera N CSA y hay otro número guardado) se reporta `PLAN_INCOMPLETO`, no se envía nada y se cuenta como fallo.

### Ítem origen sin fila de inventario (stock desconocido)

La consulta de inventario de Connekta **no tiene `ORDER BY`**, por lo que la paginación puede **omitir filas**. Por eso un ítem origen que no aparece en la consulta para esa bodega se trata como **stock desconocido, no como cero**:

- Al recorrer los orígenes de un destino por prioridad, si se llega a un origen **sin fila** antes de cubrir la cantidad negativa, se **omite el destino completo** (ni CEI ni CSA) y se reporta como omitido `ORIGEN_SIN_DATO` (bodega, destino y código del origen faltante). Se reintenta de forma natural en la corrida de la noche siguiente.
- Si la cantidad ya quedó cubierta por orígenes anteriores, los orígenes faltantes posteriores no importan y el plan sigue normal.
- Una fila **presente** con stock 0 o negativo sí es información: se pasa al siguiente origen y, si ningún origen tiene stock, se envía solo la CEI. Los orígenes saltados por UM distinta mantienen su comportamiento.
- **Recomendación:** agregar `ORDER BY IdBodega, CodigoItem` a la query de Connekta; con un orden estable, la ausencia de fila podría volver a tratarse como cero. Si el mismo par destino/origen se reporta de forma recurrente, la fila realmente no existe (cero real) y conviene revisar esa equivalencia.

### Reserva de stock por CSA pendientes de corridas previas

El ledger de orígenes parte del inventario vivo y **descuenta** la cantidad de toda CSA de corridas anteriores en estado `PLANNED` o `ERROR`, es decir, las que todavía se reenviarán automáticamente. Las `AMBIGUO` y `SENDING` (que pasa a `AMBIGUO` al reanudar) **no** descuentan: nunca se reenvían solas, y si llegaron a Siesa el inventario vivo ya las refleja; descontarlas contaría dos veces, achicaría el origen disponible y produciría CEI completa con CSA parcial (inflado de inventario). Las `OK` (ya están en el inventario) y las `CANCELADO` tampoco descuentan. `disponible_snapshot` de cada CSA registra la disponibilidad viva del origen (descontando solo las asignaciones previas de la misma corrida), sin la reserva. Se calcula con las filas posteriores a la cancelación de días previos, en centavos enteros y con piso en 0. Sin esto, una CSA fallida de ayer más otra CSA de hoy sobre el mismo origen lo dejarían sobregirado (Siesa no valida stock en salidas).

### Corrida programada que cruza la medianoche de Bogotá

Si la corrida disparada por `schedule` (`GITHUB_EVENT_NAME=schedule`) cae en una fecha ya pasada, el modo pasa a `SOLO_REANUDAR` y no se planifica nada. Ahora eso se reporta como alerta `FECHA DESFASADA` en el correo y cuenta como fallo (el job queda en **rojo**, `CON_FALLO`). La seguridad de solo-reanudar no cambia: no planifica ni envía documentos nuevos. El dispatch manual con fecha pasada sigue siendo legítimo y no alerta.

### Notificación

`notifier.sendTransformacionNegativosNotification` envía un correo por corrida no dry-run con: documentos procesados, errores (sin costo/UM, filas de inventario duplicadas y conflictivas), `AMBIGUO` ("CEI possibly sent, CSAs blocked, manual review"), anomalías `PLAN_INCOMPLETO`, reintentos de CSA de días previos, omitidos (UM distinta, sin stock, bloqueado, `ORIGEN_SIN_DATO`) y las páginas/filas leídas de la consulta. El job queda en **rojo** ante fallos de Siesa, `AMBIGUO`, destinos bloqueados, `PLAN_INCOMPLETO` o errores al guardar.

### Resolución manual de un AMBIGUO

1. Buscar en Siesa si el documento (CEI o CSA) existe, con la nota `Transformacion negativos <fecha> CO <co>` y el ítem/bodega de la alerta.
2. Si **existe**: actualizar la fila a `status = 'OK'` en `sps_transformaciones_negativos`.
3. Si **no existe**: actualizar la fila a `status = 'ERROR'`; la siguiente corrida la reintenta.
4. Si el AMBIGUO es una **CEI**, las CSA de ese destino siguen bloqueadas hasta resolverla.
5. Nunca borrar la fila ni reenviar a mano un documento que Siesa sí aceptó.

### Dry run

```bash
# Muestra el plan y los payloads; no envía, no escribe en Supabase, no manda correo (NO ejecutar contra PROD sin revisar)
TRANSF_DRY_RUN=1 TRANSF_FECHA=2026-10-29 ENTORNO_SIESA_TRANSF=QA node scripts/runTransformacionNegativosCron.js
```

### Checklist de QA (manual)

- [ ] Ejecutar las migraciones 007 y 008 en Supabase.
- [ ] Dry run en QA; revisar el plan y el correo/log.
- [ ] Corrida real en QA: verificar que el conector acepta una CSA con costo distinto de cero y documentos reanudados con fecha pasada.
- [ ] Confirmar columnas de la query de inventario y la política cuando la UM de origen y destino difieren.
- [ ] PROD: confirmar `TRANSF_NEG_QUERY_INVENTARIO` y los destinatarios antes del primer cron.

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
