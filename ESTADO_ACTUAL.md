# Estado Actual del Proyecto: Sincronizador POS → Siesa QA
**Última actualización:** 03 de Junio de 2026

Este documento resume el estado actual del proyecto, las lógicas implementadas recientemente, las correcciones aplicadas y las tareas pendientes, sirviendo como contexto para desarrolladores o IAs futuras.

## 1. Resumen Ejecutivo
El sistema es un backend en Node.js que sincroniza las facturas de un sistema POS hacia Siesa QA utilizando Connekta. 
El flujo cuenta con auto-corrección para inyectar inventario faltante (CPE) y sincronizar clientes inexistentes (`syncPOS`). Actualmente, el flujo principal de facturación (CFE) y simulación (CNC) está estable y operando con altos niveles de optimización mediante cachés en memoria para consultas pesadas.

## 2. Lógica y Arquitectura Actual
- **Entornos y Orden de Ejecución:**
  - **QA y PROD:** Ejecutan primero Notas Crédito (Simulación - Paso 1) y luego Facturas Reales (`CFE` - Paso 3).
- **Mapeo de Documentos:**
  - Toda venta del POS genera un documento contable de clase **522 (CFE)** con naturaleza **2 (Salida)**.
  - Toda simulación de venta genera un documento contable de clase **525 (CNC)** con naturaleza **1 (Entrada)**.
- **Auto-Correcciones:**
  - **Falta Inventario:** Si Siesa rechaza por falta de inventario, se crea un Ajuste de Inventario (`CPE`, concepto `601`, clase `61`). 
  - **Falta Cliente:** Si Siesa rechaza por cliente inexistente, extrae el NIT, busca en el POS y lo inyecta a Siesa vía plano genérico (`syncPOS`).
- **Idempotencia:** Guardada en PostgreSQL vía Supabase. Facturas marcadas como `OK` no se vuelven a procesar.

## 3. Últimas Correcciones y Optimizaciones (Completadas)
1. **Corrección del Mapeo `P03`:** 
   - Se eliminaron las condicionales que trataban a las facturas con `ID_TIPO_DOCTO === 'P03'` como Notas Crédito (CNC). `P03` es solo el identificador de la caja en el POS. Ahora **todos** los documentos reales entran como `CFE`.
2. **Optimización de Caché Global (Anti-Timeouts):**
   - Antes, múltiples facturas sin inventario disparaban descargas paralelas de 176 páginas de inventario y 100 páginas de costo en Siesa, colapsando el servidor (Timeout).
   - Se implementó un patrón **Singleton con Caché (TTL 5 min)** (`getInventarioCached`, `getCostoCached`). Si varias facturas fallan, esperan a que la primera descarga termine y comparten los datos en memoria.
3. **Corrección del Ajuste de Inventario (CPE):**
   - El envío del CPE estaba rebotando con el error *"30049-El número del documento contable ya existe (CPE-0)"*.
   - Se agregó `"F_CONSEC_AUTO_REG": "1"` en la cabecera del CPE, para indicar a Siesa que debe auto-numerar el documento internamente basándose en sus tablas, evitando colisiones.
4. **Costo Promedio Estricto:**
   - Para valorizar las inyecciones de inventario, el sistema lee los costos exclusivamente de `merkahorro_costo_promedio_dev`. `merkahorro_consulta_inventario` se usa únicamente para saber en qué bodegas hay disponibilidad de stock.
5. **Paginación Concurrente (más rápida y segura):**
   - Las funciones de paginado (`fetchInventarioCompleto`, `fetchCostoPromedioCompleto`) se unificaron en un solo helper `fetchPaginadoCompleto`.
   - Ya **no** es 100% secuencial: descarga la página 1 para conocer `total_páginas` y luego baja el resto en un **pool de concurrencia acotada** (`PAGINACION_CONCURRENCIA`, default `4`).
   - Cada página tiene **reintento + backoff incremental** (3 intentos). Si una página falla con `ECONNRESET`, se reintenta sola; nunca se pierde data. Si Connekta colapsa, bajar `PAGINACION_CONCURRENCIA` a `2` o `1`.
6. **Auto-corrección en bucle acotado (reintento profesional):**
   - `enviarFacturaASiesa` reintenta el envío en un **bucle de hasta `MAX_RONDAS_AJUSTE` rondas** (default `3`), inyectando en cada ronda lo NUEVO que pida Siesa.
   - Cubre el caso de que un reintento revele una falta **adicional** (ítem distinto o más cantidad). Funciona igual para CNC y CFE (la función es compartida).
   - Si el error no es automatizable (maestras, valor inválido) o una ronda no puede hacer nada nuevo → FALLO inmediato (no gasta rondas).
7. **Instrumentación del Costo en el CPE (trazabilidad):**
   - `ajustarInventario` ahora loguea el `COSTO_PROMEDIO` exacto que se envía por ítem/bodega/instalación (`🧾 [CPE movimiento]`, `📤 [CPE payload]`), tanto en éxito como en error.
   - Cross-check defensivo: avisa con `⚠️ [DIVERGENCIA COSTO]` si el costo por instalación (`t132`) difiere del costo por bodega (`t400`/`consulta_inventario`).
   - **Hallazgo:** con los datos actuales de la query (todas las instalaciones del ítem 773 en `5975`), el código **selecciona y envía 5975 correctamente**. El `5894` observado en Siesa NO sale del código actual → es un movimiento de una corrida vieja, o un **recálculo de Siesa** (promedio ponderado sobre stock residual en el motivo `03 ENTRADA INCONSISTENCIA`). Pendiente confirmar en una corrida en vivo leyendo el log del costo enviado.

## 4. Tareas Pendientes / Bloqueos Actuales
El código fuente ya opera correctamente, pero existen bloqueos a nivel de datos y reglas de negocio:

### A. Tareas para el Equipo Contable (Maestras Siesa)
Las siguientes facturas fallan por falta de configuración en el ERP, lo cual no se puede solucionar desde el código:
- **Equivalencias faltantes:** `0-501-01` y `0-502-01`.
- **Artículos inexistentes:** Algunos ítems del POS (ej. `0188892`, `0188857`) no existen en la base de datos de Siesa.
- **Unidad de Medida (UM):** La unidad `UND` no está asociada o registrada correctamente para ciertos artículos.
- **Datos de Clientes POS:** Algunos clientes (ej. NIT `900663118`) están incompletos en el POS (no tienen nombre o apellido). Siesa exige nombre/apellido obligatoriamente, por lo que `syncPOS` rebota.

### B. Regla de Negocio Pendiente (Ítems en $0)
- **Problema:** Siesa rechaza facturas que contengan productos gratuitos o con descuento del 100% arrojando el error: *"Documento venta comercial: el valor unitario deben ser mayor a 0."*
- **Estado:** En pausa. A la espera de que el usuario decida la regla de negocio (Opción A: eliminarlos del plano; Opción B: enviarlos con valor $1; Opción C: mapearlos a un concepto diferente de Siesa).

## 5. Notas para IAs Futuras
- **Regla de Oro:** **NO modifiques** el archivo `syncVentas.js` para reintroducir reglas basadas en `P03` para `CNC`. Todo es `CFE` (paso 3) o `CNC` (paso 1). El código de caja (`P03`/`P05`/`P01`) NO se usa en la lógica; solo cambia qué facturas trae el query.
- **Paginación:** el paginado vive en `fetchPaginadoCompleto`. Connekta **sí colapsa con paralelismo pesado** (todas las páginas a la vez), pero tolera un **pool acotado**. La concurrencia es configurable con `PAGINACION_CONCURRENCIA`; ante `ECONNRESET` repetido, bajarla. NO subir `tamPag` por encima de `1000` (Connekta devuelve 400) ni meter `TOP/ORDER BY` en el query.
- **Variables de entorno nuevas:** `PAGINACION_CONCURRENCIA` (default 4) y `MAX_RONDAS_AJUSTE` (default 3).
- El sistema de base de datos actual es **Supabase (PostgreSQL)**, ya no se usan los archivos locales `logs/` para la persistencia.
