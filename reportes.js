/**
 * reportes.js
 *
 * Sistema de reportes profesionales PDF para la sincronización POS → Siesa.
 * - Genera PDF con KPIs, tablas y resúmenes
 * - Envía por correo SMTP (PDF adjunto)
 * - Configuración programable (diario/semanal)
 * - Historial de envíos en Supabase
 *
 * Dependencias: pdfkit, pdfkit-table, nodemailer, pg (para setup inicial)
 */

const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const logger = require('./logger');
require('dotenv').config();

// =============================================================================
// CONSTANTES DE DISEÑO DEL PDF
// =============================================================================

const COLORS = {
    verde:      '#2ecc71',
    verdeSoft:  '#d5f5e3',
    azul:       '#210d65',
    azulSoft:   '#e8e4f3',
    rojo:       '#e74c3c',
    rojoSoft:   '#fde8e8',
    gris:       '#7f8c8d',
    grisSoft:   '#f0f0f0',
    fondo:      '#fafafa',
    texto:      '#2c3e50',
    textoSec:   '#7f8c8d',
    borde:      '#dcdde1',
    blanco:     '#ffffff',
};

const MARGEN = 50;
const ANCHO_PAGINA = 595.28;  // A4
const ANCHO_UTIL = ANCHO_PAGINA - MARGEN * 2;

// =============================================================================
// HELPER: Configuración SMTP desde .env
// =============================================================================

function getTransporter() {
    const host = process.env.SMTP_HOST;
    if (!host) {
        throw new Error('SMTP_HOST no configurado en .env');
    }
    return nodemailer.createTransport({
        host,
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
    });
}

// =============================================================================
// GENERACIÓN DEL PDF PROFESIONAL
// =============================================================================

/**
 * Genera un buffer PDF con el reporte profesional.
 *
 * @param {object} datos
 * @param {string} datos.fechaInicio  - ISO date string
 * @param {string} datos.fechaFin     - ISO date string
 * @param {number} datos.total
 * @param {number} datos.ok
 * @param {number} datos.fail
 * @param {number} datos.totalNeto    - suma de netos COP
 * @param {number} datos.automatizaciones - total de auto-correcciones
 * @param {Array}  datos.facturas     - lista de objetos { consec, tipo, estado, fecha_factura, cliente_nit, items, neto, categoria_error, automatizaciones_aplicadas }
 * @param {Array}  datos.erroresMaestras - lista de strings
 * @returns {Promise<Buffer>}
 */
async function generarPDF(datos) {
    const doc = new PDFDocument({
        size: 'A4',
        margins: { top: MARGEN, bottom: MARGEN, left: MARGEN, right: MARGEN },
        info: {
            Title: `Reporte Sincronización POS → Siesa`,
            Author: 'Siesa POS Sync',
            Subject: `Período: ${formatearFecha(datos.fechaInicio)} - ${formatearFecha(datos.fechaFin)}`,
        },
    });

    const buffers = [];
    doc.on('data', (chunk) => buffers.push(chunk));

    // =====================================================================
    // PÁGINA 1: HEADER + KPIs + RESUMEN
    // =====================================================================

    // Barra decorativa superior
    doc.rect(0, 0, ANCHO_PAGINA, 8).fill(COLORS.azul);

    // Título principal
    doc.fontSize(22)
        .font('Helvetica-Bold')
        .fillColor(COLORS.azul)
        .text('MERKAHORRO', MARGEN, 32, { align: 'left' });

    doc.fontSize(14)
        .font('Helvetica')
        .fillColor(COLORS.texto)
        .text('Reporte de Sincronización POS → Siesa QA', MARGEN, 58);

    // Período
    doc.fontSize(10)
        .fillColor(COLORS.textoSec)
        .text(
            `Período: ${formatearFecha(datos.fechaInicio)} — ${formatearFecha(datos.fechaFin)}`,
            MARGEN, 78
        );

    // Generado el
    doc.fontSize(8)
        .fillColor(COLORS.gris)
        .text(
            `Generado el: ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}`,
            MARGEN, 93
        );

    // Línea separadora
    doc.moveTo(MARGEN, 108)
        .lineTo(ANCHO_PAGINA - MARGEN, 108)
        .strokeColor(COLORS.borde)
        .stroke();

    // =====================================================================
    // KPIs (tarjetas estilo dashboard)
    // =====================================================================
    const kpiY = 124;
    const kpiW = (ANCHO_UTIL - 18) / 4;
    const kpiH = 62;

    const kpis = [
        { label: 'PROCESADAS', value: String(datos.total || 0), sub: 'Total facturas', color: COLORS.azul, bg: COLORS.azulSoft },
        { label: 'EXITOSAS',   value: String(datos.ok || 0),    sub: 'En Siesa OK',     color: COLORS.verde, bg: COLORS.verdeSoft },
        { label: 'FALLIDAS',   value: String(datos.fail || 0),  sub: 'Requieren revisión', color: COLORS.rojo, bg: COLORS.rojoSoft },
        { label: 'EFECTIVIDAD', value: calcularPct(datos.ok, datos.total) + '%', sub: `Neto: $${formatearCOP(datos.totalNeto)}`, color: COLORS.gris, bg: COLORS.grisSoft },
    ];

    kpis.forEach((k, i) => {
        const x = MARGEN + i * (kpiW + 6);
        // Fondo
        doc.roundedRect(x, kpiY, kpiW, kpiH, 6).fill(k.bg);
        // Barra lateral decorativa
        doc.rect(x, kpiY, 4, kpiH).fill(k.color);
        // Label
        doc.fontSize(7)
            .font('Helvetica-Bold')
            .fillColor(k.color)
            .text(k.label, x + 12, kpiY + 8, { width: kpiW - 16 });
        // Value
        doc.fontSize(18)
            .font('Helvetica-Bold')
            .fillColor(COLORS.texto)
            .text(k.value, x + 12, kpiY + 22, { width: kpiW - 16 });
        // Sub
        doc.fontSize(7)
            .font('Helvetica')
            .fillColor(COLORS.textoSec)
            .text(k.sub, x + 12, kpiY + 46, { width: kpiW - 16 });
    });

    // =====================================================================
    // RESUMEN DETALLADO
    // =====================================================================
    const resY = kpiY + kpiH + 20;

    doc.fontSize(12)
        .font('Helvetica-Bold')
        .fillColor(COLORS.azul)
        .text('Resumen del Período', MARGEN, resY);

    doc.moveTo(MARGEN, resY + 18)
        .lineTo(ANCHO_PAGINA - MARGEN, resY + 18)
        .strokeColor(COLORS.borde)
        .stroke();

    const resItems = [
        { label: 'Total de documentos procesados', value: String(datos.total || 0) },
        { label: 'Facturas exitosas (CFZ)',        value: String(contarPorTipoYEstado(datos.facturas, 'CFZ', 'OK')) },
        { label: 'Notas crédito exitosas (CNZ)',   value: String(contarPorTipoYEstado(datos.facturas, 'CNZ', 'OK')) },
        { label: 'Ajustes de inventario (CPE)',    value: String(contarPorTipo(datos.facturas, 'CPE')) },
        { label: 'Documentos fallidos',            value: String(datos.fail || 0) },
        { label: 'Automatizaciones aplicadas',     value: String(datos.automatizaciones || 0) },
        { label: 'Valor total neto procesado',     value: `$${formatearCOP(datos.totalNeto)}` },
        { label: 'Tasa de éxito',                  value: calcularPct(datos.ok, datos.total) + '%' },
    ];

    let itemY = resY + 26;
    const col1X = MARGEN;
    const col2X = MARGEN + ANCHO_UTIL / 2;

    resItems.forEach((item, i) => {
        const x = i < 4 ? col1X : col2X;
        const y = i < 4 ? itemY + (i % 4) * 18 : itemY + (i % 4) * 18;

        doc.fontSize(9)
            .font('Helvetica')
            .fillColor(COLORS.textoSec)
            .text(item.label, x, y, { width: ANCHO_UTIL / 2 - 20 });

        doc.fontSize(9)
            .font('Helvetica-Bold')
            .fillColor(COLORS.texto)
            .text(item.value, x + ANCHO_UTIL / 2 - 80, y, { width: 80, align: 'right' });
    });

    // =====================================================================
    // TABLA DE FACTURAS (si hay)
    // =====================================================================
    const tablaY = resY + 26 + 4 * 18 + 20;

    if (datos.facturas && datos.facturas.length > 0) {
        doc.fontSize(12)
            .font('Helvetica-Bold')
            .fillColor(COLORS.azul)
            .text('Detalle de Facturas Procesadas', MARGEN, tablaY);

        doc.moveTo(MARGEN, tablaY + 18)
            .lineTo(ANCHO_PAGINA - MARGEN, tablaY + 18)
            .strokeColor(COLORS.borde)
            .stroke();

        // Determinar cuántas facturas mostrar (top 50 para no saturar el PDF)
        const maxFilas = 50;
        const facturasMostrar = datos.facturas.slice(0, maxFilas);
        const encabezados = ['Consec', 'Tipo', 'Fecha', 'Cliente', 'Items', 'Neto', 'Estado'];
        const colWidths = [50, 36, 56, 72, 32, 64, 48];
        const totalW = colWidths.reduce((a, b) => a + b, 0);
        const startX = MARGEN + (ANCHO_UTIL - totalW) / 2;

        let rowY = tablaY + 26;

        // Header de la tabla
        doc.roundedRect(startX - 4, rowY - 4, totalW + 8, 22, 4).fill(COLORS.azul);
        let hX = startX;
        encabezados.forEach((h, i) => {
            doc.fontSize(7)
                .font('Helvetica-Bold')
                .fillColor(COLORS.blanco)
                .text(h, hX + 4, rowY, { width: colWidths[i] - 4, align: i >= 4 ? 'right' : 'left' });
            hX += colWidths[i];
        });
        rowY += 22;

        // Filas
        facturasMostrar.forEach((f, idx) => {
            // Salto de página si es necesario
            if (rowY > 720) {
                doc.addPage();
                rowY = MARGEN + 20;
                // Re-dibujar header en nueva página
                doc.roundedRect(startX - 4, rowY - 4, totalW + 8, 22, 4).fill(COLORS.azul);
                hX = startX;
                encabezados.forEach((h, i) => {
                    doc.fontSize(7)
                        .font('Helvetica-Bold')
                        .fillColor(COLORS.blanco)
                        .text(h, hX + 4, rowY, { width: colWidths[i] - 4, align: i >= 4 ? 'right' : 'left' });
                    hX += colWidths[i];
                });
                rowY += 22;
            }

            const bg = idx % 2 === 0 ? COLORS.blanco : COLORS.grisSoft;
            doc.rect(startX - 4, rowY - 2, totalW + 8, 18).fill(bg);

            const isFallo = f.estado === 'FALLO';
            hX = startX;
            const valores = [
                String(f.consec || ''),
                f.tipo || '',
                f.fecha_factura ? f.fecha_factura.slice(0, 10) : '',
                String(f.cliente_nit || '').slice(0, 12),
                String(f.items ?? ''),
                f.neto ? `$${Math.round(f.neto).toLocaleString('es-CO')}` : '',
                f.estado || '',
            ];

            valores.forEach((v, i) => {
                doc.fontSize(7)
                    .font(i === 6 && isFallo ? 'Helvetica-Bold' : 'Helvetica')
                    .fillColor(i === 6 && isFallo ? COLORS.rojo : i === 6 ? COLORS.verde : COLORS.texto)
                    .text(v, hX + 4, rowY, {
                        width: colWidths[i] - 4,
                        align: i >= 4 ? 'right' : 'left',
                    });
                hX += colWidths[i];
            });
            rowY += 18;
        });

        if (datos.facturas.length > maxFilas) {
            doc.fontSize(8)
                .font('Helvetica')
                .fillColor(COLORS.gris)
                .text(`... y ${datos.facturas.length - maxFilas} facturas más`, MARGEN, rowY + 4);
            rowY += 16;
        }

        // =====================================================================
        // AUTOMATIZACIONES
        // =====================================================================
        let autoY = rowY + 20;
        const facturasConAuto = datos.facturas.filter(f => f.automatizaciones_aplicadas && f.automatizaciones_aplicadas.length > 0);
        if (facturasConAuto.length > 0) {
            // Salto de página si es necesario
            if (autoY > 700) {
                doc.addPage();
                autoY = MARGEN + 20;
            }

            doc.fontSize(12)
                .font('Helvetica-Bold')
                .fillColor(COLORS.azul)
                .text('Automatizaciones Aplicadas', MARGEN, autoY);

            // Contar tipos de automatizaciones
            const conteoAuto = {};
            facturasConAuto.forEach(f => {
                f.automatizaciones_aplicadas.forEach(a => {
                    const tipo = a.startsWith('sync_cliente') ? 'Clientes creados' : 'Ajustes de inventario';
                    conteoAuto[tipo] = (conteoAuto[tipo] || 0) + 1;
                });
            });

            let aY = autoY + 20;
            Object.entries(conteoAuto).forEach(([tipo, count]) => {
                doc.fontSize(9)
                    .font('Helvetica')
                    .fillColor(COLORS.texto)
                    .text(`• ${tipo}: ${count} vez/veces`, MARGEN + 10, aY);
                aY += 16;
            });
        }

        // =====================================================================
        // ERRORES DE MAESTRAS (si hay)
        // =====================================================================
        if (datos.erroresMaestras && datos.erroresMaestras.length > 0) {
            let errY = Math.max(autoY + 60, autoY + 40);

            // Salto de página
            if (errY > 700) {
                doc.addPage();
                errY = MARGEN + 20;
            }

            doc.fontSize(12)
                .font('Helvetica-Bold')
                .fillColor(COLORS.rojo)
                .text('Errores de Maestras — Requieren Acción Manual', MARGEN, errY);

            let eY = errY + 20;
            datos.erroresMaestras.forEach((err) => {
                doc.fontSize(8)
                    .font('Helvetica')
                    .fillColor(COLORS.texto)
                    .text(`• ${err}`, MARGEN + 10, eY, { width: ANCHO_UTIL - 20 });
                eY += 14;
            });
        }
    }

    // =====================================================================
    // FOOTER (todas las páginas)
    // =====================================================================
    const pageRange = doc.bufferedPageRange();
    for (let i = pageRange.start; i < pageRange.start + pageRange.count; i++) {
        doc.switchToPage(i);

        // Línea footer
        const fy = 800;
        doc.moveTo(MARGEN, fy)
            .lineTo(ANCHO_PAGINA - MARGEN, fy)
            .strokeColor(COLORS.borde)
            .stroke();

        doc.fontSize(7)
            .font('Helvetica')
            .fillColor(COLORS.gris)
            .text(
                'Merkahorro — Siesa POS Sync • Reporte generado automáticamente',
                MARGEN,
                fy + 6,
                { align: 'center', width: ANCHO_UTIL }
            );
    }

    doc.end();

    return new Promise((resolve) => {
        doc.on('end', () => resolve(Buffer.concat(buffers)));
    });
}

// =============================================================================
// ENVÍO POR CORREO SMTP
// =============================================================================

/**
 * Envía el reporte PDF por correo SMTP.
 *
 * @param {object} opts
 * @param {Buffer} opts.pdfBuffer       - Buffer del PDF
 * @param {string[]} opts.destinatarios - Lista de correos
 * @param {string} opts.periodo         - "27/05/2026 — 27/05/2026"
 * @param {object} opts.resumen         - { total, ok, fail, pct_exito }
 */
async function enviarCorreo({ pdfBuffer, destinatarios, periodo, resumen }) {
    if (!destinatarios || destinatarios.length === 0) {
        throw new Error('No hay destinatarios configurados');
    }

    const transporter = getTransporter();

    const info = await transporter.sendMail({
        from: `"Merkahorro — Siesa POS Sync" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
        to: destinatarios.join(', '),
        subject: `📊 Reporte Sincronización POS → Siesa — ${periodo}`,
        html: cuerpoHTML(periodo, resumen),
        attachments: [
            {
                filename: `reporte-siesa-${periodo.replace(/[\/—]/g, '-').replace(/\s+/g, '_')}.pdf`,
                content: pdfBuffer,
                contentType: 'application/pdf',
            },
        ],
    });

    return info;
}

function cuerpoHTML(periodo, resumen) {
    const pct = resumen.pct_exito || 0;
    const barColor = pct >= 90 ? '#2ecc71' : pct >= 70 ? '#f5b342' : '#e74c3c';
    return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: 'Segoe UI', Arial, sans-serif; background: #f4f4f6; padding: 30px;">
  <table style="max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 14px rgba(0,0,0,0.1);">
    <tr>
      <td style="background: #210d65; padding: 24px 30px; text-align: center;">
        <h1 style="color: #ffffff; margin: 0; font-size: 22px;">MERKAHORRO</h1>
        <p style="color: #c2c6e0; margin: 6px 0 0; font-size: 14px;">Reporte de Sincronización POS → Siesa QA</p>
      </td>
    </tr>
    <tr>
      <td style="padding: 24px 30px;">
        <p style="color: #7f8c8d; font-size: 13px;">Período: <strong style="color: #2c3e50;">${periodo}</strong></p>

        <table style="width: 100%; border-collapse: collapse; margin: 16px 0;">
          <tr>
            <td style="background: #e8e4f3; padding: 14px; text-align: center; border-radius: 8px 0 0 8px;">
              <div style="color: #210d65; font-size: 11px; font-weight: 600;">PROCESADAS</div>
              <div style="color: #2c3e50; font-size: 24px; font-weight: 700;">${resumen.total || 0}</div>
            </td>
            <td style="background: #d5f5e3; padding: 14px; text-align: center;">
              <div style="color: #2ecc71; font-size: 11px; font-weight: 600;">EXITOSAS</div>
              <div style="color: #2c3e50; font-size: 24px; font-weight: 700;">${resumen.ok || 0}</div>
            </td>
            <td style="background: #fde8e8; padding: 14px; text-align: center;">
              <div style="color: #e74c3c; font-size: 11px; font-weight: 600;">FALLIDAS</div>
              <div style="color: #2c3e50; font-size: 24px; font-weight: 700;">${resumen.fail || 0}</div>
            </td>
            <td style="background: #f0f0f0; padding: 14px; text-align: center; border-radius: 0 8px 8px 0;">
              <div style="color: #7f8c8d; font-size: 11px; font-weight: 600;">EFECTIVIDAD</div>
              <div style="color: ${barColor}; font-size: 24px; font-weight: 700;">${pct}%</div>
            </td>
          </tr>
        </table>

        <div style="background: #f8f9fa; border-radius: 8px; padding: 16px; margin: 16px 0;">
          <p style="margin: 0; color: #2c3e50; font-size: 13px;">
            El reporte PDF adjunto contiene el detalle completo de las <strong>${resumen.total || 0}</strong> 
            facturas procesadas en el período, incluyendo KPIs, tabla de facturas, 
            automatizaciones aplicadas y errores de maestras.
          </p>
        </div>

        <p style="color: #7f8c8d; font-size: 11px; text-align: center; margin-top: 20px;">
          Este correo fue generado automáticamente por el sistema Siesa POS Sync.<br>
          ${new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' })}
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// =============================================================================
// FUNCIÓN PRINCIPAL: GENERAR + ENVIAR
// =============================================================================

/**
 * Genera el reporte y lo envía por correo según la configuración almacenada.
 *
 * @param {object} opciones
 * @param {string} [opciones.periodo='diario'] - 'diario' | 'semanal'
 * @param {string} [opciones.fechaInicio]      - override de fecha inicio
 * @param {string} [opciones.fechaFin]         - override de fecha fin
 * @param {string[]} [opciones.destinatarios]  - override de destinatarios
 * @returns {Promise<object>} resultado
 */
async function generarYEnviar(opciones = {}) {
    const periodo = opciones.periodo || 'diario';

    // Calcular fechas según período
    const hoy = new Date();
    const fechaInicio = opciones.fechaInicio || (() => {
        if (periodo === 'semanal') {
            const d = new Date(hoy);
            d.setDate(d.getDate() - d.getDay() + 1); // Lunes de esta semana
            return d.toISOString().split('T')[0];
        }
        return hoy.toISOString().split('T')[0]; // Hoy
    })();

    const fechaFin = opciones.fechaFin || hoy.toISOString().split('T')[0];

    console.log(`📊 Generando reporte ${periodo}: ${fechaInicio} → ${fechaFin}`);

    // Consultar facturas del período
    const { data: facturas, error } = await logger.supabase
        .from('sps_facturas')
        .select('*')
        .gte('ultima_corrida', `${fechaInicio}T00:00:00-05:00`)
        .lte('ultima_corrida', `${fechaFin}T23:59:59-05:00`)
        .order('ultima_corrida', { ascending: false });

    if (error) {
        throw new Error(`Error consultando facturas: ${error.message}`);
    }

    if (!facturas || facturas.length === 0) {
        console.log('ℹ️ No hay facturas en el período seleccionado.');
        return { enviado: false, total: 0, ok: 0, fail: 0, message: 'Sin facturas en el período' };
    }

    // Calcular KPIs
    const total = facturas.length;
    const ok = facturas.filter(f => f.estado === 'OK').length;
    const fail = total - ok;
    const totalNeto = facturas.reduce((sum, f) => sum + (parseFloat(f.neto) || 0), 0);
    const automatizaciones = facturas.filter(f => f.automatizaciones_aplicadas && f.automatizaciones_aplicadas.length > 0).length;

    // Consultar errores de maestras
    const { data: maestras } = await logger.supabase
        .from('sps_errores_maestras')
        .select('mensaje')
        .order('fecha', { ascending: false });

    const erroresMaestras = (maestras || []).map(m => m.mensaje);

    // Generar PDF
    const pdfBuffer = await generarPDF({
        fechaInicio,
        fechaFin,
        total,
        ok,
        fail,
        totalNeto,
        automatizaciones,
        facturas,
        erroresMaestras,
    });

    console.log(`📄 PDF generado: ${(pdfBuffer.length / 1024).toFixed(1)} KB`);

    // Destinatarios
    let destinatarios = opciones.destinatarios;
    if (!destinatarios || destinatarios.length === 0) {
        const config = await getConfigFromDB();
        destinatarios = config?.destinatarios || [];
    }

    if (!destinatarios || destinatarios.length === 0) {
        console.log('⚠️ No hay destinatarios configurados. PDF generado pero no enviado.');
        return {
            enviado: false,
            total,
            ok,
            fail,
            pct_exito: calcularPct(ok, total),
            total_neto: totalNeto,
            message: 'Sin destinatarios configurados',
        };
    }

    // Enviar por correo
    const periodoStr = `${formatearFecha(fechaInicio)} — ${formatearFecha(fechaFin)}`;
    const resumen = {
        total,
        ok,
        fail,
        pct_exito: calcularPct(ok, total),
        total_neto: totalNeto,
    };

    try {
        const info = await enviarCorreo({
            pdfBuffer,
            destinatarios,
            periodo: periodoStr,
            resumen,
        });

        console.log(`✅ Reporte enviado a ${destinatarios.length} destinatario(s): ${info.messageId}`);

        // Guardar en historial
        await guardarHistorial({
            tipo_periodo: periodo,
            fecha_inicio: fechaInicio,
            fecha_fin: fechaFin,
            destinatarios,
            resumen,
            enviado_ok: true,
        });

        // Actualizar último envío en config
        await logger.supabase
            .from('sps_config_reportes')
            .update({ ultimo_envio: new Date().toISOString() })
            .eq('id', 1);

        return {
            enviado: true,
            total,
            ok,
            fail,
            pct_exito: calcularPct(ok, total),
            total_neto: totalNeto,
            messageId: info.messageId,
            destinatarios,
        };
    } catch (err) {
        console.error(`❌ Error enviando correo:`, err.message);

        // Guardar fallo en historial
        await guardarHistorial({
            tipo_periodo: periodo,
            fecha_inicio: fechaInicio,
            fecha_fin: fechaFin,
            destinatarios,
            resumen,
            enviado_ok: false,
            error: err.message,
        });

        throw err;
    }
}

// =============================================================================
// CONFIGURACIÓN (Supabase)
// =============================================================================

async function getConfigFromDB() {
    try {
        const { data } = await logger.supabase
            .from('sps_config_reportes')
            .select('*')
            .eq('id', 1)
            .single();
        return data;
    } catch {
        return null;
    }
}

/**
 * Obtiene la configuración actual de reportes.
 */
async function getConfig() {
    let config = await getConfigFromDB();

    // Si no existe la tabla o está vacía, devolver valores por defecto
    if (!config) {
        return {
            destinatarios: [],
            programacion: 'diario',
            hora_envio: '08:00',
            dia_semana: 1,
            activo: false,
            ultimo_envio: null,
        };
    }

    return config;
}

/**
 * Guarda la configuración de reportes.
 *
 * @param {object} cfg
 * @param {string[]} cfg.destinatarios
 * @param {string} cfg.programacion   - 'diario' | 'semanal'
 * @param {string} cfg.hora_envio     - 'HH:MM'
 * @param {number} cfg.dia_semana     - 1-7
 * @param {boolean} cfg.activo
 */
async function saveConfig(cfg) {
    // Validar destinatarios
    if (cfg.destinatarios && cfg.destinatarios.length > 0) {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        const invalidos = cfg.destinatarios.filter(e => !emailRegex.test(e));
        if (invalidos.length > 0) {
            throw new Error(`Correos inválidos: ${invalidos.join(', ')}`);
        }
    }

    const payload = {
        destinatarios: cfg.destinatarios || [],
        programacion: cfg.programacion || 'diario',
        hora_envio: cfg.hora_envio || '08:00',
        dia_semana: cfg.dia_semana ?? 1,
        activo: cfg.activo ?? false,
        updated_at: new Date().toISOString(),
    };

    const { data, error } = await logger.supabase
        .from('sps_config_reportes')
        .upsert({ id: 1, ...payload }, { onConflict: 'id' })
        .select()
        .single();

    if (error) {
        throw new Error(`Error guardando configuración: ${error.message}`);
    }

    return data;
}

// =============================================================================
// HISTORIAL
// =============================================================================

async function guardarHistorial(entry) {
    try {
        await logger.supabase.from('sps_historial_reportes').insert({
            tipo_periodo: entry.tipo_periodo,
            fecha_inicio: entry.fecha_inicio,
            fecha_fin: entry.fecha_fin,
            destinatarios: entry.destinatarios,
            resumen: {
                total: entry.resumen.total,
                ok: entry.resumen.ok,
                fail: entry.resumen.fail,
                pct_exito: entry.resumen.pct_exito,
                total_neto: entry.resumen.total_neto,
            },
            enviado_ok: entry.enviado_ok,
            error: entry.error || null,
        });
    } catch (err) {
        console.error('⚠️ Error guardando historial:', err.message);
    }
}

/**
 * Obtiene el historial de reportes enviados.
 *
 * @param {number} limit - Máximo de registros (default 20)
 */
async function getHistorial(limit = 20) {
    try {
        const { data, error } = await logger.supabase
            .from('sps_historial_reportes')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(Math.min(limit, 100));

        if (error) throw error;
        return data || [];
    } catch (err) {
        console.error('⚠️ Error consultando historial:', err.message);
        return [];
    }
}

// =============================================================================
// HELPERS
// =============================================================================

function formatearFecha(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatearCOP(n) {
    if (n == null) return '0';
    return Math.round(n).toLocaleString('es-CO');
}

function calcularPct(parte, total) {
    if (!total || total === 0) return '0';
    return Math.round((parte / total) * 100);
}

function contarPorTipoYEstado(facturas, tipo, estado) {
    if (!facturas) return 0;
    return facturas.filter(f => f.tipo === tipo && f.estado === estado).length;
}

function contarPorTipo(facturas, tipo) {
    if (!facturas) return 0;
    return facturas.filter(f => f.tipo === tipo).length;
}

// =============================================================================
// EXPORTS
// =============================================================================

module.exports = {
    generarPDF,
    enviarCorreo,
    generarYEnviar,
    getConfig,
    saveConfig,
    getHistorial,
};
