# Lecciones aprendidas: Sincronización multi-CO a Siesa

## Contexto

El sistema sincroniza facturas POS (Connekta) a Siesa. Originalmente solo operaba con
CO 001. Al extenderlo a CO 011 aparecieron errores por cómo Siesa califica ciertos campos.

---

## 1. ID_CO en el header define el rango de consecutivos

**Error original:** `"El próximo consecutivo a asignar no existe 011-CNZ-2"`

**Causa:** El header `ID_CO` se enviaba con el CO real del documento (`enc.CoDoc = "011"`).
Siesa busca el consecutivo como `{ID_CO}-{TIPO_DOCTO}-{CONSEC}`. Con `ID_CO="011"`
buscaba `011-CNZ-{n}` que **no existe** en Siesa.

**Solución:** Forzar `ID_CO` del header a `"001"` para que busque `001-CNZ-{n}` que sí existe.

```javascript
// syncVentas.js
"ID_CO": "001",  // forzado para que use el rango 001-CNZ
```

**Afecta:** `Docto. ventas comercial`, `Movimientos[].id_co`, `Impuestos[].ID_CO`,
`Descuentos[].id_co`, `Caja[].ID_CO` — TODOS deben ir con `"001"` para que Siesa los
asocie al mismo documento.

**Campo que NO se toca:** `id_co_fact` → queda con el CO real del documento (solo informativo).

---

## 2. id_caja NO es el tipo de documento POS

**Error:** `"La caja 001-Z01-COP no tiene configurada un auxiliar."`

**Causa:** Siesa arma la llave contable como `{ID_CO}-{id_caja}-{moneda}`.
Con `ID_CO="001"` e `id_caja="Z01"` busca el auxiliar `001-Z01-COP` que **no existe**.

`"Z01"` es el `ID_TIPO_DOCTO` de Connekta (tipo de documento POS), **no el código de caja en Siesa**.

**Solución:** Usar el código de caja real de Siesa. Para CO 011, la caja es `"001"`:

```javascript
// syncVentas.js — fallback por CO
"id_caja": (cajaPorCo[enc.CoDoc.trim()] || ({
    "003": "03 ",
    "011": "001",        // ← CORREGIDO: antes era "Z01"
}[enc.CoDoc.trim()] || enc.CoDoc.trim().padStart(3, '0'))).padEnd(3, ' ')
```

**Regla:** El `id_caja` debe ser el código de caja **contable de Siesa**, no el tipo de documento POS.

---

## 3. id_co_movto conserva el CO real de la operación

**Campo:** `Movimientos[].id_co_movto`

**Valor:** `enc.CoDoc` (el CO real del documento, ej. `"011"`)

**Propósito:** Campo informativo para Siesa. No afecta la validación del documento
ni la calificación de la caja. Se deja con el CO real para trazabilidad.

---

## 4. Bodega por CO

Para CO 011, la bodega es `"01101"` (viene de Connekta como `det.BODEGA`).
Para CO 001, es `"MG001"` por defecto.

No requiere cambio manual — Connekta envía la bodega correcta para cada CO.

---

## 5. Resumen de campos y sus valores (CO 011)

| Sección | Campo | Valor | ¿Por qué? |
|---------|-------|-------|-----------|
| Header | `ID_CO` | `"001"` | Rango consecutivo 001-CNZ |
| Header | `id_co_fact` | `enc.CoDoc` (`"011"`) | Solo informativo |
| Header | `id_caja` | `"001"` | Código de caja contable en Siesa |
| Movimiento | `id_co` | `"001"` | Asocia movimiento al documento |
| Movimiento | `id_co_movto` | `enc.CoDoc` (`"011"`) | CO real de la operación |
| Movimiento | `BODEGA` | `"01101"` | Bodega del CO 011 |
| Impuestos | `ID_CO` | `"001"` | Asocia impuestos al documento |
| Descuentos | `id_co` | `"001"` | Asocia descuentos al documento |
| Caja | `ID_CO` | `"001"` | Asocia pagos al documento |

---

## 6. Formato de campos que Siesa exige

| Campo | Formato | Ejemplo |
|-------|---------|---------|
| `FECHA_DOCTO` | YYYYMMDD (8 chars) | `"20260717"` |
| `FECHA_VCTO` | YYYYMMDD (8 chars) | `"20260717"` |
| `id_item` | Máx 7 caracteres | `"60"`, `"23"` |
| `VALOR_BRUTO` | Decimal | `39604.0000` |
| `CANTIDAD` | Decimal | `3.0000` |
| `VLR_UNITARIO` | Decimal | `10000.0000` |

---

## 7. Forma correcta de probar un CO nuevo

1. Identificar el `id_caja` real en Siesa para ese CO (NO usar el `ID_TIPO_DOCTO` de Connekta)
2. Verificar que la combinación `{ID_CO}-{id_caja}-COP` tenga auxiliar contable en Siesa
3. Probar primero solo CNZ (notas crédito) con items que existan
4. Luego probar CFZ (facturas)
5. Una vez que funcione, agregar el CO al `CO_FILTER` del `.env` y del workflow

---

## Historial de cambios

| Fecha | Archivo | Cambio |
|-------|---------|--------|
| Jul 2026 | `syncVentas.js` | Header `ID_CO` forzado a `"001"` |
| Jul 2026 | `syncVentas.js` | Movimiento `id_co` forzado a `"001"` |
| Jul 2026 | `syncVentas.js` | Impuestos/Descuentos/Caja `ID_CO` forzado a `"001"` |
| Jul 2026 | `syncVentas.js` | `id_caja` para CO 011 cambiado de `"Z01"` a `"001"` |
| Jul 2026 | `.github/workflows/sync-pos.yml` | `CO_FILTER` default quitó `011` |
| Jul 2026 | `.env` | `CO_FILTER` quitó `011` |
