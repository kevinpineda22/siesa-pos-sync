# Documentación Técnica - Sincronizador POS a Siesa (Generic Transfer)

## 1. Descripción General del Proyecto
Este proyecto es un middleware (backend en Node.js) diseñado para extraer información del sistema POS (Connekta) e integrarla automáticamente en el ERP Siesa Enterprise (Generic Transfer V3.1). 
Actualmente, el sistema sincroniza **Clientes/Terceros** y **Facturas de Venta / Notas Crédito**.

## 2. Arquitectura y Entorno
- **Lenguaje:** Node.js
- **Librerías principales:** `axios` (para peticiones HTTP), `dotenv` (manejo de credenciales).
- **Entorno Siesa Destino:** Siesa QA (`serviciosqa.siesacloud.com`)
- **Compañía Siesa (CIA):** 7375 (Compañía 1)
- **Autenticación:** Vía Headers (`ConniKey`, `ConniToken`)

## 3. Archivos del Proyecto
- `syncPOS.js`: Script encargado de extraer los clientes del POS y mandarlos al conector de Siesa (Crea el bloque `Terceros` y `Clientes`).
- `syncVentas.js`: Script core encargado de construir la factura. Cruza los datos de encabezado, detalle, descuentos, impuestos y caja, formatea las cifras con ceros a la izquierda y lo envía a Siesa.
- `.env`: Contiene las llaves de integración.

## 4. Orígenes de Datos (Queries de Connekta)
El sistema extrae la data utilizando 3 queries principales creados por el equipo de Base de Datos:
1. `merkahorro_Cliente_pos_dev`: Trae los datos maestros de clientes.
2. `merkahorro_venta_pos_dev`: Trae encabezado, detalle de ítems, descuentos e impuestos de la venta.
3. `merkahorro_pagos_pos_dev`: Trae los medios de pago asociados al documento.

## 5. Reglas de Negocio Estrictas (Siesa Generic Transfer)
*NOTA PARA IAs FUTURAS: Estas reglas fueron descubiertas tras resolver múltiples rechazos de la API de Siesa. No alterar estas lógicas.*

### A. Tipos de Documento y Conceptos
- **Homologación de Documento:** Si el POS envía `P03` (Devolución/Nota), se envía a Siesa como `CNC`. Cualquier otro tipo (`P01`, `P05`...) se asume Factura y se envía como `CFE`.
- **Clase de Documento:** Factura = `522`. Nota Crédito = `525`.
- **Conceptos de Movimiento:** Venta = `501`. Devolución = `502`.
- **Motivo:** Obligatorio fijo en `"01"`.

### B. Manejo de Caja / Punto de Envío
- **Punto de Envío (id_caja):** En el encabezado (`Docto. ventas comercial`), se fuerza explícitamente la caja a `"001"`. Anteriormente enviar `"000"` o vacío fallaba por configuraciones de tesorería y contabilidad en Siesa.
- **Condición de Pago:** Se envía la variable mapeada directamente desde el query `IdCondPago`. Si viene nula, se asume `"001"`.

### C. Matemática de Caja (Vueltas/Cambio)
- Los queries del POS traen filas separadas para ingresos y egresos (vueltas) en la misma forma de pago (Ej. `EFE`).
- **Regla:** Siesa rechaza valores negativos o en cero. 
- **Solución:** El script agrupa por `ID_MEDIOS_PAGO` y envía a Siesa únicamente la diferencia neta: `(Ingreso - Egreso)`. Solo se envían medios de pago donde el Neto > 0.

### D. Impuestos (La regla más compleja)
- Siesa QA rechaza el plano si hay contradicciones en los valores del impuesto.
- **Regla definitiva que funciona:** 
  1. Pasar el `PORCENTAJE_BASE` normal (ej. `100.0000`).
  2. Pasar la `TASA` normal (ej. `019.0000`).
  3. **Obligatorio:** Forzar el `VLR_UNI` estrictamente a ceros: `000000000000000.0000`.
  4. Pasar el `VALOR_TOTAL` normal (ej. `000000000002491.0000`).
  5. **Filtro Exentos:** Si un impuesto tiene `VALOR_TOTAL` igual o menor a 0 (ej. ICO exento), NO se incluye el bloque de impuesto en el JSON, ya que Siesa arroja error *"El valor unitario debe ser mayor a 0"*.

### E. Descuentos
- Si el POS envía un `vlr_tot_dscto` > 0 pero el `vlr_uni_dscto` en 0, el script calcula el valor unitario dividiendo: `vlr_tot_dscto / CANTIDAD`.

### F. Formato de Cifras
- Numéricos: `padStart(20, '0')` con 4 decimales.
- Tasas/Porcentajes: `padStart(8, '0')` con 4 decimales.
- Fechas: ISO (`2026-05-08T00:00:00`) transformada a `YYYYMMDD` (`20260508`).

## 6. Estado Actual
- **Sincronización de Clientes:** Completada y exitosa.
- **Sincronización de Ventas:** Completada y exitosa (100% de inserción en QA).
- **Próximo Paso:** Integrar `express` para convertir estos scripts en una API REST consumible desde el Frontend (React).