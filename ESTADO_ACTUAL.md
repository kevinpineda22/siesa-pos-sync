# Estado Actual del Proyecto: Sincronizador POS → Siesa QA
**Última actualización:** 05 de Junio de 2026 — Sesión completada: CPE dinámico (CO mov, UN), filtro EFE en query pagos, plan de producción

Este documento resume el estado actual del proyecto, las lógicas implementadas recientemente, las correcciones aplicadas y las tareas pendientes, sirviendo como contexto para desarrolladores o IAs futuras.

## 1. Resumen Ejecutivo
El sistema es un backend en Node.js que sincroniza las facturas de un sistema POS hacia Siesa QA utilizando Connekta. 
El flujo cuenta con auto-corrección para inyectar inventario faltante (CPE) y sincronizar clientes inexistentes (`syncPOS`). Actualmente, el flujo principal de facturación (CFZ) y simulación (CNZ) está estable y operando con altos niveles de optimización mediante cachés en memoria para consultas pesadas.

## 2. Lógica y Arquitectura Actual
- **Entornos y Orden de Ejecución:**
  - **QA y PROD:** Ejecutan primero Notas Crédito (Simulación - Paso 1) y luego Facturas Reales (`CFZ` - Paso 3).
- **Mapeo de Documentos:**
  - Toda venta del POS genera un documento contable de clase **522 (CFZ)** con naturaleza **2 (Salida)**.
  - Toda simulación de venta genera un documento contable de clase **525 (CNZ)** con naturaleza **1 (Entrada)**.
- **Auto-Correcciones:**
  - **Falta Inventario:** Si Siesa rechaza por falta de inventario, se crea un Ajuste de Inventario (`CPE`, concepto `601`, clase `61`). 
  - **Falta Cliente:** Si Siesa rechaza por cliente inexistente, extrae el NIT, busca en el POS y lo inyecta a Siesa vía plano genérico (`syncPOS`).
- **Idempotencia:** Guardada en PostgreSQL vía Supabase. Facturas marcadas como `OK` no se vuelven a procesar.

## 3. Últimas Correcciones y Optimizaciones (Completadas)
1. **Renombrado de Tipos de Documento (`CNC` → `CNZ`, `CFE` → `CFZ`):**
   - Se renombraron todos los tipos de documento en `syncVentas.js`, `reportes.js`, `server.js`, frontend y documentación.
   - `CNC` (Nota Crédito) pasó a `CNZ`; `CFE` (Factura) pasó a `CFZ`.
   - La idempotencia en Supabase cambió de `CFE:consec`/`CNC:consec` a `CFZ:consec`/`CNZ:consec`.
   - La BD de Supabase fue limpiada para empezar desde cero con la nueva nomenclatura.
2. **Actualización de Motivos (`id_motivo`):**
   - `CNZ` y `CFZ` ahora se envían con `f470_id_motivo = "03"` (antes era `"01"`). Siesa los reconoce con el nuevo comportamiento contable.
   - `CPE` (ajuste de inventario) ahora se envía con `f470_id_motivo = "17"` (antes era `"03"`), alineado con el nuevo catálogo de motivos de Siesa.
3. **Corrección del Mapeo `P03`:** 
   - Se eliminaron las condicionales que trataban a las facturas con `ID_TIPO_DOCTO === 'P03'` como Notas Crédito (CNZ). `P03` es solo el identificador de la caja en el POS. Ahora **todos** los documentos reales entran como `CFZ`.
4. **Optimización de Caché Global (Anti-Timeouts):**
   - Antes, múltiples facturas sin inventario disparaban descargas paralelas de 176 páginas de inventario y 100 páginas de costo en Siesa, colapsando el servidor (Timeout).
   - Se implementó un patrón **Singleton con Caché (TTL 5 min)** (`getInventarioCached`, `getCostoCached`). Si varias facturas fallan, esperan a que la primera descarga termine y comparten los datos en memoria.
5. **Corrección del Ajuste de Inventario (CPE):**
   - El envío del CPE estaba rebotando con el error *"30049-El número del documento contable ya existe (CPE-0)"*.
   - Se agregó `"F_CONSEC_AUTO_REG": "1"` en la cabecera del CPE, para indicar a Siesa que debe auto-numerar el documento internamente basándose en sus tablas, evitando colisiones.
6. **Costo Promedio Estricto:**
   - Para valorizar las inyecciones de inventario, el sistema lee los costos exclusivamente de `merkahorro_costo_promedio_dev`. `merkahorro_consulta_inventario` se usa únicamente para saber en qué bodegas hay disponibilidad de stock.
7. **Paginación Concurrente (más rápida y segura):**
   - Las funciones de paginado (`fetchInventarioCompleto`, `fetchCostoPromedioCompleto`) se unificaron en un solo helper `fetchPaginadoCompleto`.
   - Ya **no** es 100% secuencial: descarga la página 1 para conocer `total_páginas` y luego baja el resto en un **pool de concurrencia acotada** (`PAGINACION_CONCURRENCIA`, default `4`).
   - Cada página tiene **reintento + backoff incremental** (3 intentos). Si una página falla con `ECONNRESET`, se reintenta sola; nunca se pierde data. Si Connekta colapsa, bajar `PAGINACION_CONCURRENCIA` a `2` o `1`.
8. **Auto-corrección en bucle acotado (reintento profesional):**
   - `enviarFacturaASiesa` reintenta el envío en un **bucle de hasta `MAX_RONDAS_AJUSTE` rondas** (default `3`), inyectando en cada ronda lo NUEVO que pida Siesa.
   - Cubre el caso de que un reintento revele una falta **adicional** (ítem distinto o más cantidad). Funciona igual para CNZ y CFZ (la función es compartida).
   - Si el error no es automatizable (maestras, valor inválido) o una ronda no puede hacer nada nuevo → FALLO inmediato (no gasta rondas).
   - **Reintento de cortesía ante fallo de inyección (junio 2026):** si `ajustarInventario` lanza error, el stock pudo haberse inyectado parcialmente o por otra factura concurrente del mismo lote. Por eso se reintenta el documento UNA vez más; solo si la inyección falla **2 veces seguidas** (`fallosInyeccion >= 2`) se marca FALLO. Esto reduce los FALLO **transitorios** por orden/concurrencia (ej. la CNZ falla porque el stock aún no estaba, pero la CFZ —que corre después— ya lo encuentra). Lo que aun así quede en FALLO se auto-cura en la siguiente corrida del cron.
9. **Filtrado Dinámico por CO y Tipo de Caja (backend + frontend):**
   - **Motivación:** El dashboard (frontend) necesita poder elegir qué Centro de Operación (`CO`) y qué tipo de caja (`P03`, `P05`, etc.) sincronizar en cada corrida, sin tener que editar queries SQL ni reiniciar el servidor.
   - **Cómo estaba antes:** Los 3 queries de Connekta (`merkahorro_venta_pos_dev`, `merkahorro_pagos_pos_dev`, `merkahorro_imptos_pos_dev`) tenían filtros fijos `f9820_id_co = '001' AND f9820_id_tipo_docto IN ('P01','P03','P05')` en el WHERE. Para cambiar de CO o caja había que modificar las queries manualmente en la base de datos de Supabase (Connekta). El frontend no tenía control alguno sobre qué datos traer.
   - **Qué se hizo:**
     1. Se eliminaron esos filtros del WHERE de las 3 queries.
     2. Se movió el filtrado al código Node.js: `ejecutarPaso` recibe `filtros.co` y `filtros.caja`, filtra `detalles` por `CoDoc` e `ID_TIPO_DOCTO`, y luego filtra `pagosRaw` por `CONSEC_DOCTO` válidos para evitar procesar datos huérfanos.
     3. Se creó `parseFilterParam` con prioridad: parámetro explícito → variable de entorno (`CO_FILTER`/`CAJA_FILTER`) → sin filtro (trae todos los COs y cajas).
      4. Se agregaron `co` y `caja` al body del endpoint `POST /api/sync-ventas` en `server.js`.
      5. Se agregaron inputs de CO y Caja en el frontend (`ActionsPanel` dentro de un `<details>` plegable) con estilos en `SiesaPosSync.css`.
    - **Beneficio:** El frontend ahora envía `{ co: "001,003", caja: "P05,P03" }` y el backend sincroniza solo esas combinaciones. Sin filtros, sincroniza todo. Sin tocar SQL ni reiniciar.
    - **Robustez del filtro (junio 2026):**
      - **CO** se normaliza a 3 dígitos en ambos lados (`"1"` → `"001"`) para evitar fallos por padding.
      - **Caja** se normaliza a MAYÚSCULAS en ambos lados (`"p05"` → `"P05"`).
      - **Consec específico manda sobre el filtro:** cuando la corrida es por consecs (`{ consecs }` / `CONSEC_ESPECIFICOS`), el backend **ignora** los filtros CO/Caja/`soloHoy` y busca el consec en **su propio CO/Caja**. Así el filtro del panel nunca excluye un consec solicitado.
10. **Instrumentación del Costo en el CPE (trazabilidad):**
    - `ajustarInventario` ahora loguea el `COSTO_PROMEDIO` exacto que se envía por ítem/bodega/instalación (`🧾 [CPE movimiento]`, `📤 [CPE payload]`), tanto en éxito como en error.
    - Cross-check defensivo: avisa con `⚠️ [DIVERGENCIA COSTO]` si el costo por instalación (`t132`) difiere del costo por bodega (`t400`/`consulta_inventario`).
    - **Selección por CO de la factura (prioridad):** el costo se busca PRIMERO en la instalación = **CO de la factura** (`itemsFactura[0].CoDoc`); solo si ese CO no tiene costo para el ítem se buscan otras instalaciones (luego la instalación de la bodega, luego `001/003/002/007`, luego cualquier otra).
    - **Fuente:** el query de costo (`merkahorro_costo_promedio_dev`) se lee de **PRODUCCIÓN** (`servicios.siesacloud.com`, `tamPag=1000` paginado) a propósito, porque solo se consulta (GET) y así trae el costo real. Inventario (`merkahorro_consulta_inventario`) y los POST de Siesa siguen en **QA** (`serviciosqa`).
    - **Hallazgo:** con los datos actuales de la query (todas las instalaciones del ítem 773 en `5975`), el código **selecciona y envía 5975 correctamente**. El `5894` observado en Siesa NO sale del código actual → es un movimiento de una corrida vieja, o un **recálculo de Siesa** (promedio ponderado sobre stock residual en el motivo `03 ENTRADA INCONSISTENCIA`). Pendiente confirmar en una corrida en vivo leyendo el log del costo enviado.
11. **Prueba de Regresión (CNZ/CFZ con motivo 03, CPE con motivo 17):**
    - Ejecutada prueba con los cambios de nomenclatura y motivos.
    - Los logs confirman: `[CNZ 142116]`, `[CNZ 142115]`, `[CNZ 142114]` (paso 1) y luego `[CFZ 142116]`, etc. (paso 3).
12. **Sincronización Automática (GitHub Actions, cada 2 horas):**
    - **Objetivo:** procesar sin intervención las facturas del día (CO/Caja indicados), y en cada corrida solo las nuevas (la idempotencia omite las ya `OK`).
    - **Dónde corre:** dentro del runner de GitHub Actions (`node scripts/runSyncCron.js`), NO vía el endpoint de Vercel → así se evita el límite de ejecución serverless (el runner tiene hasta 6h). Vercel queda solo para el frontend y el disparo manual del API.
    - **Opciones nuevas en `syncVentas`:** `todas: true` (procesa todas las filtradas, ignora `LIMITE_FACTURAS`) y `soloHoy: true` (solo facturas con `FECHA_DOCTO` = hoy en `America/Bogota`). Se propagan por la misma tubería de `filtros` que `co`/`caja` en `ejecutarPaso`.
    - **Archivos:** `.github/workflows/sync-pos.yml` (cron `0 */2 * * *` UTC + `workflow_dispatch` con inputs `co`/`caja`) y `scripts/runSyncCron.js` (llama `syncVentas({ co, caja, todas:true, soloHoy:true })`, sale con código 1 si hubo FALLOS).
    - **Filtro de fecha (decisión):** el control fino del "día" vive en el código (`soloHoy`, zona Bogotá). El SQL conserva una **ventana corta de 2 días** como cota de volumen (ya aplicada en Connekta: `DATEADD(day, -2, GETDATE())`), porque las queries de ventas/pagos/impuestos usan `fetchFromConnekta` (un solo GET **sin paginar**) y una ventana grande podría truncar la respuesta. Con 2 días el volumen es chico y no hay truncamiento.
    - **⚠️ Consecuencia de la ventana de 2 días:** el modo "Consec específico" solo puede reprocesar consecs **de los últimos 2 días** (el query no trae más). Para reprocesar fallos más viejos habría que ampliar temporalmente la ventana.
    - **Secrets requeridos en GitHub:** `CONNI_KEY`, `CONNI_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `CIA`, `ENTORNO_SIESA`, `CONCURRENCIA`, `PAGINACION_CONCURRENCIA`, `MAX_RONDAS_AJUSTE`. `CO_FILTER`/`CAJA_FILTER` se pasan por input del dispatch o usan el default (`001` / `P01,P03,P05`).
    - **Caveats:** el cron de GitHub puede retrasarse minutos y se deshabilita tras ~60 días sin actividad del repo. Con `soloHoy`, los FALLOS de días previos NO se reintentan en el cron de 2h (dejar una corrida diaria sin `soloHoy` si se requiere catch-up).
    - Siesa reporta `Motivo : 502 -03` y `501 -03` correctamente en los documentos.
    - El payload CPE muestra `"f470_id_motivo": "17"`.
    - Las únicas fallas observadas son por maestras faltantes en Siesa QA (equivalencias, ítems, UMs), no por errores de código.
13. **Modo PRUEBA del job (`runSyncCron.js` + workflow):**
    - Nuevas variables que lee el runner: `CRON_LIMITE` (>0 → procesa solo N facturas en vez de todas) y `CRON_SOLO_HOY` (`"false"` → no filtra por hoy, útil cuando hoy aún no hay facturas).
    - El `workflow_dispatch` ganó inputs `limite` y `solo_hoy` (se mapean a esas variables). El cron automático los deja vacíos → comportamiento de producción (todas las del día).
    - Ejemplo local: `CRON_LIMITE=5 CRON_SOLO_HOY=false node scripts/runSyncCron.js`.
14. **Captura de CO/Caja en histórico + Frontend:**
    - El `meta` de cada factura ya incluye `co` (`CoDoc`) y `caja` (`ID_TIPO_DOCTO`); `logger.js` los persiste en las columnas `co`/`caja` de `sps_facturas`.
    - Los resultados también llevan `co`/`caja` (en `registrar` y en el objeto `fallo`), así que los snapshots de corrida (`sps_corridas`) los incluyen → el **Historial de corridas** del frontend los muestra.
    - **Frontend (`SiesaPosSync.jsx`):** columna **"CO · Caja"** con chips en la tabla, tarjeta CO·Caja en el modal de detalle, chip en el Historial, y nuevo **filtro por CO y por Caja** en la barra de filtros de la tabla (selects poblados con los valores existentes).
    - ⚠️ Las facturas/corridas **viejas** tienen `co`/`caja` en `null` (se muestran como "—"); solo las nuevas o reprocesadas los traen.
15. **Frontend: rediseño visual + Reportes en modal + se quitó "Sincronizar Clientes":**
    - Mejoras visuales en `SiesaPosSync.css` (fondo con profundidad, header con acento, KPIs con glass + barra de acento, botones con gradiente, animaciones, respeta `prefers-reduced-motion`).
    - **Reportes** ahora abre en un **modal** (botón en el header), ya no ocupa espacio fijo. Cierra con clic afuera, botón ✕ o `Escape`.
    - Se **eliminó el botón "Sincronizar Clientes"** del panel: ese proceso ocurre **automático** dentro del flujo cuando Siesa rechaza por cliente faltante (`syncPOS`).
16. **Fix de parseo de errores (Detalle vacío en frontend):**
    - `logger.parsearError` ahora extrae el JSON de Siesa **desde el primer `{`**, sin importar el prefijo del mensaje (`"Reintento falló: "`, `"Sin más automatización posible: "`, `"Agotadas N ronda(s)...: "`). Antes esos mensajes no se parseaban y el frontend mostraba `Detalle: []`.
17. **Prueba en vivo del job validada (junio 2026):**
    - Corrida real contra Siesa QA (`CRON_LIMITE=5`): `Total=10 (5 CNZ + 5 CFZ) | OK=5 | FALLO=5`.
    - Confirmado funcionando: filtro CO/Caja, límite, orden CNZ→CFZ, auto-sync de clientes, auto-inyección de inventario (CPE) con costo por CO de la factura, instrumentación del costo, retry acotado, idempotencia y logging en Supabase.
    - Los 5 FALLO fueron por **maestras faltantes** (no código). Un FALLO transitorio de inventario (CNZ 142194) se **auto-curó al reprocesar** (la CFZ ya lo había dejado con stock) — caso que motivó el "reintento de cortesía" del punto 8.
18. **UNIDAD_NEGOCIO dinámica por ítem en el CPE (05-Jun-2026):**
    - El campo `"UNIDAD_NEGOCIO"` del ajuste de inventario (CPE) ya **no es fijo `"001"`**: se resuelve por ítem con la función `unidadNegocio(tipo_inv_serv)`, que mapea el `v121_id_tipo_inv_serv` (incluido ahora en el SELECT de `merkahorro_venta_pos_dev`) a su unidad de negocio: abarrotes→`001`, fruver→`002`, carnes→`003`.
    - **Regla dura:** un ítem **nunca** se inyecta con una UN que no le pertenece. El manejo en `ajustarInventario` es:
      1. **Servicio** (`tipo_inv_serv` empieza por `S-`, ej. `S-OTRIPV`) → no maneja stock, se **omite del CPE** con log informativo `ℹ️` (no es error, no lleva UN).
      2. **Ítem de inventario con UN mapeada** → se inyecta con su UN correcta (se loguea `... | UN xxx`).
      3. **Ítem de inventario SIN UN mapeada** → se **omite del CPE** con `⚠️` fuerte (jamás se envía `null` ni una UN inventada). El warning indica qué `tipo_inv_serv` agregar al mapa.
    - **Verificación contra datos reales (1.447 filas):** los 9 códigos de inventario presentes están todos mapeados; el único código no mapeado era `S-OTRIPV`, que es un **servicio** (correctamente sin ajuste de inventario). El mapa queda completo para el inventario existente.

## 3b. Últimos Cambios (Sesión 05-Jun-2026)

### 19. CPE: `C.O MOVIMIENTO` dinámico (usa el CO de la factura)
   - El campo `"C.O MOVIMIENTO"` del CPE estaba hardcodeado a `"001"` → ahora usa `coFactura || "001"`.
   - Si la factura es CO=003, el ajuste de inventario también se mueve contra CO=003.
   - `"C.O."` (f470_id_co) y `"f350_id_co"` del documento cabecera se mantienen en `"001"` (el asiento contable cierra en CO 001 por requerimiento de Siesa).

### 20. CPE: `UNIDAD_NEGOCIO` dinámica por ítem (completado y verificado en vivo)
   - **Contexto:** el campo estaba hardcodeado a `"001"`. Se descubrió que cada tipo de inventario tiene su propia unidad de negocio (abarrotes→001, fruver→002, carnes→003, etc.).
   - **Solución:**
     1. Se agregó `dbo.v121.v121_id_tipo_inv_serv AS tipo_inv_serv` al SELECT de la query Connekta `merkahorro_venta_pos_dev` (con `LTRIM/RTRIM` para evitar trailing spaces).
     2. Se creó la función `unidadNegocio(tipoInvServ)` en `syncVentas.js` con el mapeo proporcionado por el equipo de Siesa.
     3. El CPE ahora resuelve la UN por ítem antes de pushear el movimiento.
   - **Regla dura (3 casos):**
     1. **Servicios** (`tipo_inv_serv` empieza por `S-`, ej. `S-OTRIPV`) → se omiten con `ℹ️` (no manejan stock, no llevan UN).
     2. **Ítem de inventario con UN mapeada** → se inyecta con su UN correcta (log: `... | UN xxx`).
     3. **Ítem de inventario SIN UN mapeada** → se **omite del CPE** con `⚠️` fuerte indicando exactamente qué `tipo_inv_serv` falta en el mapa. **Nunca se envía `null` ni una UN inventada.**
   - **Verificado en vivo:** corrida con 16 facturas, 2 CPE disparados y ejecutados exitosamente.

### 21. Filtro de medio de pago EFE en query `merkahorro_pagos_pos_dev`
   - **Problema:** facturas que usan medio de pago "AJP" (Aval Jefe de Piso) fallan en CFZ porque ese medio no existe en Siesa QA. El CNZ pasa porque fuerza EFE.
   - **Solución:** se agregó `AND MedioPago.f9821_id_medio_pago = 'EFE'` al WHERE de `merkahorro_pagos_pos_dev`.
   - **Motivación:** en producción las cajas Z01/Z02 solo reciben efectivo. Este filtro es una **válvula de seguridad en el origen** para garantizar que nunca llegue un medio de pago diferente a EFE al flujo de Node.js, incluso si el POS emitiera otro medio por error.
   - **Impacto:** el flujo solo procesa pagos en efectivo. Facturas con otros medios no tendrán registro de pago → el código que mapea pagos las ignorará.

### 22. Mapa `unidadNegocio()` ampliado (cubiertos todos los casos reales)
   - Se verificó contra 1.447 registros reales de Connekta que todos los `tipo_inv_serv` de inventario están mapeados.
   - Se agregó el servicio `S-OTRIPV` como caso explícito de servicio (se omite con `ℹ️`).
   - El mapa queda completo y verificado contra datos reales.

## 4. Tareas Pendientes / Bloqueos Actuales
El código fuente ya opera correctamente, pero existen bloqueos a nivel de datos y reglas de negocio:

### A. Tareas para el Equipo Contable (Maestras Siesa)
Las siguientes facturas fallan por falta de configuración en el ERP, lo cual no se puede solucionar desde el código:
- **Equivalencias faltantes:** `0-501-03`, `0-502-03`, `INEXCAB01-502-03`, `INEXCCA01-502-03`, `ING05AB03-502-03`.
- **Artículos inexistentes:** Algunos ítems del POS (ej. `0188892`, `0188857`) no existen en la base de datos de Siesa.
- **Unidad de Medida (UM):** La unidad `UND` no está asociada o registrada correctamente para ciertos artículos.
- **Datos de Clientes POS:** Algunos clientes (ej. NIT `900663118`) están incompletos en el POS (no tienen nombre o apellido). Siesa exige nombre/apellido obligatoriamente, por lo que `syncPOS` rebota.

### C. Medio de pago AJP no existe en Siesa QA
- **Problema:** Varias facturas (CFZ) fallan con *"Movimiento de recaudos: El medio de pago no existe."* porque el POS usa `AJP` (Aval Jefe de Piso) como medio de pago.
- **Causa:** `AJP` no está creado en la maestra de medios de pago de Siesa QA.
- **Solución temporal:** se agregó filtro `AND MedioPago.f9821_id_medio_pago = 'EFE'` en `merkahorro_pagos_pos_dev` para que solo ingresen pagos en efectivo (ver punto 21).
- **Solución definitiva (QA):** el equipo de Siesa debe crear el medio de pago `AJP` en QA si se requiere procesar esos pagos. En producción no aplica porque las cajas Z01/Z02 solo usan EFE.

### D. Regla de Negocio Pendiente (Ítems en $0)
- **Problema:** Siesa rechaza facturas que contengan productos gratuitos o con descuento del 100% arrojando el error: *"Documento venta comercial: el valor unitario deben ser mayor a 0."*
- **Estado:** En pausa. A la espera de que el usuario decida la regla de negocio (Opción A: eliminarlos del plano; Opción B: enviarlos con valor $1; Opción C: mapearlos a un concepto diferente de Siesa).

## 5. Notas para IAs Futuras
- **Regla de Oro (`P03`/`P05` ≠ tipo de documento):** **NO** reintroduzcas reglas que mapeen un código de caja a `CNZ`/`CFZ`. El tipo de documento se decide SOLO por el paso: paso 1 = `CNZ`, paso 3 = `CFZ`. El código de caja (`ID_TIPO_DOCTO`: `P01`/`P03`/`P05`) se usa **únicamente para FILTRAR** qué facturas se sincronizan (vía `CAJA_FILTER` o `{ caja }`), nunca para decidir si una factura es nota crédito o factura. Filtrar ≠ mapear.
- **Motivos actuales:** `CNZ` y `CFZ` se envían con `f470_id_motivo = "03"` (no `"01"`). `CPE` se envía con `f470_id_motivo = "17"` (no `"03"`). NO revertir estos valores a los anteriores.
- **UNIDAD_NEGOCIO del CPE (regla dura):** se resuelve por ítem con `unidadNegocio(tipo_inv_serv)`. **NUNCA** enviar `null` ni un default (`"001"`) cuando el ítem no mapea: un ajuste con UN ajena al ítem es un error contable. Si no mapea → se OMITE el ítem con `⚠️`. Los servicios (`tipo_inv_serv` que empieza por `S-`) se omiten en silencio (no llevan inventario). Para agregar productos nuevos, ampliar el mapa `unidadNegocio()` (abarrotes→`001`, fruver→`002`, carnes→`003`), NO poner fallbacks.
- **Paginación:** el paginado vive en `fetchPaginadoCompleto`. Connekta **sí colapsa con paralelismo pesado** (todas las páginas a la vez), pero tolera un **pool acotado**. La concurrencia es configurable con `PAGINACION_CONCURRENCIA`; ante `ECONNRESET` repetido, bajarla. NO subir `tamPag` por encima de `1000` (Connekta devuelve 400) ni meter `TOP/ORDER BY` en el query.
- **Variables de entorno nuevas:** `PAGINACION_CONCURRENCIA` (default 4), `MAX_RONDAS_AJUSTE` (default 3), `CO_FILTER` (default `001`) y `CAJA_FILTER` (default `P01,P03,P05`). Estos dos últimos tienen **default seguro** que replica el filtro que antes vivía en el SQL; dejarlos **vacíos** = traer TODOS los COs/cajas (dentro de la ventana del SQL, hoy **2 días** — ver punto 12). El frontend los sobrescribe con `{ co, caja }`.
- El sistema de base de datos actual es **Supabase (PostgreSQL)**, ya no se usan los archivos locales `logs/` para la persistencia.

## 6. Plan de Configuración para Producción

### Cambios necesarios vs QA

| Aspecto | QA (actual) | Producción | Dónde se configura |
|---------|-------------|------------|-------------------|
| **CO_FILTER** | `001` | `001` | `.env` / GitHub Secrets |
| **CAJA_FILTER** | `P01,P03,P05` | `Z01,Z02` | `.env` / GitHub Secrets |
| **Medio de pago** | Todos (filtrado a EFE en query) | Solo EFE (las cajas Z01/Z02 solo reciben efectivo) | Query `merkahorro_pagos_pos_dev` ya filtrada |
| **Query pagos** | `MedioPago.f9821_id_medio_pago = 'EFE'` | Misma query (el filtro EFE ya está aplicado) | Sin cambios |
| **Query ventas** | Con `tipo_inv_serv` agregado | Misma query | Sin cambios |
| **Entorno Siesa** | QA (`serviciosqa.siesacloud.com`) | PROD (`servicios.siesacloud.com`) | `ENTORNO_SIESA=PROD` en `.env` |

### Queries de Connekta para Producción

**`merkahorro_venta_pos_dev`** — incluye `tipo_inv_serv` al final del SELECT:
```sql
LTRIM(RTRIM(dbo.v121.v121_id_tipo_inv_serv)) AS tipo_inv_serv
```

**`merkahorro_pagos_pos_dev`** — filtro EFE al final del WHERE:
```sql
AND MedioPago.f9821_id_medio_pago = 'EFE'
```

### Medio de pago AJP
- En **QA** falla porque `AJP` no existe. Se solucionó con el filtro EFE en la query de pagos.
- En **PROD** no aplica: las cajas Z01/Z02 solo emiten pagos en efectivo (EFE). No se requiere crear AJP en producción.

### Resumen de cambios de código (ninguno para producción)
Todo el código está listo para producción. Los cambios son solo de configuración (`.env`, queries Connekta). No requiere nuevo deploy de código.
