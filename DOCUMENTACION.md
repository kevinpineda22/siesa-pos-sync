# Documentación Técnica - Sincronizador POS a Siesa (Generic Transfer)

## 0. 🤖 CONTEXTO DE HANDOFF PARA LA IA ACTUAL (Mayo 2026)
*Si eres una IA leyendo esto porque el desarrollador acaba de cambiar de PC, aquí tienes el resumen exacto de dónde estamos y qué hacer:*

**1. Estado del Backend (COMPLETADO):**
- Ya convertimos los scripts independientes en una API REST funcional.
- Se creó `server.js` con Express y CORS habilitado (corre en el puerto 4000).
- Se expusieron las rutas `POST /api/sync-clientes` y `POST /api/sync-ventas`.
- `syncPOS.js` y `syncVentas.js` fueron refactorizados para exportar sus funciones y devolver la promesa con la respuesta, en lugar de ejecutarse solos.
- Puedes iniciar el backend simplemente corriendo `npm start`.

**2. Estado de las validaciones Siesa:**
- Las integraciones estructuradas están perfectas.
- **ERROR IGNORADO INTENCIONALMENTE:** Al probar `syncVentas` con la factura 138007, Siesa QA nos arroja el error 461: *"El contacto de puntos de envio es obligatorio."*. 
- **DECISIÓN:** Ignoramos este error desde el código, porque **no es un error de programación**. Es una regla de negocio y datos *dentro de Siesa*: Ese cliente/NIT en particular (21683653) no tiene un contacto de envío asociado correctamente en la base de datos de QA. El JSON está bien formado e incluye los nodos correctos (`TERCERO_REM`). No modifiques `syncVentas.js` tratando de arreglar esto; es un tema administrativo/de QA de Siesa.

**3. TUS SIGUIENTES PASOS:**
1. Levantar el backend en segundo plano (`npm start` o `node server.js`).
2. Mover tu `workdir` a la carpeta del Frontend: `C:\Users\DESARROLLO-PC\Desktop\merkaPage\Pagina-web_React`.
3. Crear los botones / interfaz en React para consumir `http://localhost:4000/api/sync-clientes` y `http://localhost:4000/api/sync-ventas`.

---

## 1. Descripción General del Proyecto
Este proyecto es un middleware (backend en Node.js) diseñado para extraer información del sistema POS (Connekta) e integrarla automáticamente en el ERP Siesa Enterprise (Generic Transfer V3.1). 
Actualmente, el sistema sincroniza **Clientes/Terceros** y **Facturas de Venta / Notas Crédito**.

## 2. Arquitectura y Entorno
- **Lenguaje:** Node.js
- **Librerías principales:** `express` (Servidor API), `cors`, `axios` (para peticiones HTTP), `dotenv` (manejo de credenciales).
- **Entorno Siesa Destino:** Siesa QA (`serviciosqa.siesacloud.com`)
- **Compañía Siesa (CIA):** 7375 (Compañía 1)
- **Autenticación:** Vía Headers (`ConniKey`, `ConniToken`)

## 3. Archivos del Proyecto
- `server.js`: Controlador principal de Express, expone la API REST en el puerto 4000.
- `syncPOS.js`: Extrae clientes del POS y los envía a Siesa.
- `syncVentas.js`: Extrae ventas, cruza encabezado, detalle, descuentos, impuestos y caja.
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

### B. Manejo de Caja / Punto de Envío
- **Punto de Envío (id_caja):** En el encabezado (`Docto. ventas comercial`), se fuerza explícitamente la caja a `"001"`. 

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
  4. Pasar el `VALOR_TOTAL` normal.
  5. **Filtro Exentos:** Si un impuesto tiene `VALOR_TOTAL` igual o menor a 0, NO se incluye el bloque de impuesto.