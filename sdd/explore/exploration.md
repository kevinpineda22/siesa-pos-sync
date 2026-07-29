# Exploration: Existing Patterns for Supabase, Cron/Sync, Resumen-Impuestos, and Frontend Consumption

## Current State

### 1. Supabase Connection Pattern

**Client init** (`logger.js:1-7`):
```js
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
);
```

**Env vars**: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (service role key, not anon).

**Export**: The `supabase` instance is exported from `logger.js` as a module-level singleton, then accessed everywhere as `logger.supabase`.

**All Supabase tables used** (prefix pattern `sps_*`):
| Table | Purpose | Primary Key(s) |
|---|---|---|
| `sps_facturas` | Core facturas log | `id` (composite: `tipo:co:caja:consec`) |
| `sps_corridas` | Sync run history | auto `id` |
| `sps_estadisticas_diarias` | Daily POS stats per CO | `fecha,co` |
| `sps_errores_maestras` | Master data error catalog | auto |
| `sps_config_reportes` | Report config (email recipients, toggle) | `id: 1` singleton |
| `sps_historial_reportes` | Report send history | auto |
| `sps_impuestos_offline` | Manually loaded historical tax data | `fecha` |

**Read pattern** (query builder):
```js
const { data, error } = await logger.supabase
    .from('sps_facturas')
    .select('*')
    .eq('estado', 'OK')
    .gte('fecha_factura', fechaInicio)
    .lte('fecha_factura', fechaFin);
```

### 2. Upsert Patterns

**Pattern A — Single-row upsert with `onConflict`** (`logger.js:137-139`):
```js
const { error } = await supabase
    .from('sps_facturas')
    .upsert(payload, { onConflict: 'id' });
```

**Pattern B — Composite key upsert** (`syncVentas.js:1419-1428`):
```js
await logger.supabase.from('sps_estadisticas_diarias').upsert({
    fecha: hoy,
    co: stat.co,
    total_pos: stat.total_pos,
    total_sync: totalSync,
    neto_total: stat.neto_total,
    por_caja: stat.por_caja,
    por_nit: stat.por_nit,
    actualizado_en: new Date().toISOString()
}, { onConflict: 'fecha,co' });
```

**Pattern C — Singleton config upsert** (`reportes.js:821-822`):
```js
.from('sps_config_reportes')
.upsert({ id: 1, ...payload }, { onConflict: 'id' })
```

**Insert pattern** (used for corridas, errors):
```js
const { data, error } = await supabase
    .from('sps_corridas')
    .insert(payload)
    .select('id')
    .single();
```

### 3. Full `resumen-impuestos` Endpoint (server.js:882-1096)

The endpoint does NOT read from Supabase. It fetches live from Connekta API (`merkahorro_informe_acumulados` query), with pagination (1000 rows/page, concurrent fetches). Flow:

1. **Fetch from Connekta** with pagination (page 1 determines total pages; pages 2..N in concurrent batches of `PAGINACION_CONCURRENCIA`)
2. **Filter** by date range + optional CO filter
3. **Aggregate** taxes via `aggregateTaxes()` helper — groups by tax key (IV02, IV03, ICO, IV08, IV07, IV01, OTROS), tracking `valorTotal`, `baseGravable`, and unique doc count
4. **Breakdown by type**: real clients vs generic NIT `222222222222`
5. **Breakdown by caja** (filtered by `CAJA_FILTER` env)

**Response structure** (lines 1078-1092):
```json
{
  "success": true,
  "totalBase": 12345678,
  "totalBaseGravable": 10000000,
  "totalImpuestos": 2345678,
  "totalFacturas": 123,
  "totalDocumentos": 80,
  "porLlave": [
    {
      "llave": "IV03",
      "descripcion": "IVA 19% BIENES",
      "valorTotal": 1234567,
      "baseGravable": 6500000,
      "count": 45
    }
  ],
  "porTipo": {
    "reales": { "porLlave": [...], "totalImpuestos": ..., ... },
    "genericos": { "porLlave": [...], "totalImpuestos": ..., ... }
  },
  "porCaja": {
    "P05": { "porLlave": [...], "totalImpuestos": ..., ... },
    "P01": { "porLlave": [...], "totalImpuestos": ..., ... }
  },
  "cajas": ["P05", "P01", "P03"]
}
```

**IMPORTANT**: This endpoint is a LIVE Connekta query — no Supabase caching. There's a separate `sps_impuestos_offline` table for manual historical tax data, but the current `resumen-impuestos` endpoint does NOT use it (despite the docs claiming it does). The endpoint only reads from Connekta.

### 4. Frontend Consumption

**Service call** (`siesaPosSyncService.js:157-162`):
```js
export async function getResumenImpuestos(fechaInicio, fechaFin, co) {
  const params = { fechaInicio, fechaFin };
  if (co) params.co = co;
  const { data } = await api.get("/api/logs/resumen-impuestos", { params });
  return data;
}
```

**Dashboard component** (`DashboardSiesaPos.jsx`) consumes these fields:
- `resumenImpuestos.success` — guards rendering
- `resumenImpuestos.porLlave[]` — iterates `{ llave, valorTotal, baseGravable, count }`
- `resumenImpuestos.totalFacturas` — displays count
- `resumenImpuestos.totalDocumentos` — displays count
- `resumenImpuestos.porTipo.reales` / `.porTipo.genericos` — filter switching
- `resumenImpuestos.porCaja[cajaFilter]` — caja dropdown filter, same shape as root
- `resumenImpuestos.cajas[]` — string array for dropdown options
- `impuestosFiltrados?.porLlave` — the filtered array to render
- `impuestosFiltrados?.totalImpuestos` — total card
- `impuestosFiltrados?.totalImpuestos` accessed via `impuestosFiltrados?.porLlave?.length > 0` guard

### 5. Cron/Sync Patterns

**No `.github/workflows/` directory exists** — workflows must be configured directly in GitHub (or deleted locally).

**Scripts directory** (`scripts/`):
| Script | Purpose | Pattern |
|---|---|---|
| `runSyncCron.js` | Hourly POS→Siesa sync | Reads env vars directly, calls `syncVentas()`, exits 0/1 |
| `runReporte.js` | Daily report email (6am Bogotá) | Reads env vars, calls `reportes.generarYEnviar()`, exits 0/1 |

**`runSyncCron.js` pattern** (the canonical cron entry point):
1. `require('dotenv').config()`
2. Read env vars: `CO_FILTER`, `CAJA_FILTER`, `CRON_LIMITE`, `CRON_SOLO_HOY`
3. Call `syncVentas(opciones)` — the same function the HTTP endpoint uses
4. Classify failures (critical vs non-critical)
5. `process.exit(0)` or `process.exit(1)` — GitHub Actions uses exit code for job status

**`runReporte.js` pattern**:
1. `require('dotenv').config()`
2. Call `reportes.getConfig()` to check if reports are enabled
3. Call `reportes.generarYEnviar(opts)`
4. `process.exit(0)` or `process.exit(1)`

### 6. Key Env Vars

| Variable | Used by | Purpose |
|---|---|---|
| `SUPABASE_URL` | logger.js | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | logger.js | Supabase service role key |
| `CONNI_KEY`, `CONNI_TOKEN` | Connekta API calls | Auth headers |
| `CIA` | server.js, scripts | Company ID for Siesa/Connekta |
| `CONNEKTA_DOMAIN` | server.js | Base URL for Connekta API |
| `QUERY_ACUMULADOS` | server.js | Query name for tax report |
| `CO_FILTER` | runSyncCron.js | Centers of operation filter |
| `CAJA_FILTER` | server.js, runSyncCron.js | Cash register/document type filter |
| `ENTORNO_SIESA` | runSyncCron.js | QA/PROD environment |
| `INVENTARIO_TAM_PAGINA` | server.js | Page size (default 1000) |
| `INVENTARIO_MAX_PAGINAS` | server.js | Max pages (default 200) |
| `PAGINACION_CONCURRENCIA` | server.js | Concurrent page fetches (default 4) |
| `VERCEL` | server.js | Detects Vercel serverless env |

## Affected Areas

- `logger.js` — Supabase client init, upsert helpers
- `server.js:882-1096` — resumen-impuestos endpoint (the target)
- `syncVentas.js:1400-1429` — upsert pattern reference
- `scripts/runSyncCron.js` — cron entry point pattern
- `scripts/runReporte.js` — cron report pattern
- `Pagina-web_React/src/services/siesaPosSyncService.js:157-162` — API call
- `Pagina-web_React/src/pages/SiesaPosSync/components/DashboardSiesaPos.jsx` — consumer

## Recommendation

The existing patterns are clear and consistent:
1. **Supabase**: singleton from `logger.js`, access via `logger.supabase.from('sps_*')`
2. **Upserts**: always use `{ onConflict: 'column_name' }` or composite `onConflict: 'col1,col2'`
3. **Cron**: standalone Node scripts in `scripts/` that `require('dotenv').config()` and call business logic directly, exit with code 0/1
4. **Tables**: always prefixed `sps_`
5. **Frontend contract**: `{ success, porLlave[], totalFacturas, totalDocumentos, porTipo, porCaja, cajas[] }` — any changes to this shape need frontend updates

## Risks

- The `resumen-impuestos` endpoint is a LIVE Connekta query (slow, up to 200 pages). If we add Supabase caching, the frontend contract stays the same but latency drops dramatically.
- The frontend reads `porLlave`, `totalFacturas`, `totalDocumentos`, `porTipo`, `porCaja`, `cajas` — all must remain in any new response shape.
- `sps_impuestos_offline` exists but the current endpoint doesn't use it — docs are out of sync.

## Ready for Proposal

Yes — all patterns are well-understood. The project has consistent conventions for Supabase access, upserts, cron scripts, and table naming.
