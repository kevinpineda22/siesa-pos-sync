const nodemailer = require('nodemailer');
require('dotenv').config();

// ──────────────────────────────────────────────────────────
// Configuración del transportador SMTP
// ──────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
});

const SMTP_FROM = process.env.SMTP_FROM || 'notificacion@merkahorro.com';

// ──────────────────────────────────────────────────────────
// Las variables de entorno se leen EN CADA LLAMADA, no al cargar el módulo,
// para evitar que Vercel las quede cacheadas con valores viejos.
// ──────────────────────────────────────────────────────────
function getNotifyErrorEmails() {
    return (process.env.NOTIFY_ERROR_EMAILS || process.env.NOTIFY_EMAILS || '')
        .split(',')
        .map(e => e.trim())
        .filter(Boolean);
}

function getNotifyCpeEmails() {
    return (process.env.NOTIFY_CPE_EMAILS || process.env.NOTIFY_EMAILS || '')
        .split(',')
        .map(e => e.trim())
        .filter(Boolean);
}

function getNotifyTransfEmails() {
    return (process.env.NOTIFY_TRANSF_EMAILS || process.env.NOTIFY_EMAILS || '')
        .split(',')
        .map(e => e.trim())
        .filter(Boolean);
}

function escapeHtml(valor) {
    return String(valor ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ──────────────────────────────────────────────────────────
// Notificación de ERROR en factura del flujo
// ──────────────────────────────────────────────────────────
async function sendErrorNotification({ tipo, consecutivo, mensaje, co, caja, fecha, cliente_nit, neto }) {
    const emails = getNotifyErrorEmails();
    if (emails.length === 0) {
        console.log('📧 NOTIFY_ERROR_EMAILS no configurado — se omite notificación de error.');
        return;
    }

    const fechaStr = fecha || '(sin fecha)';
    const resumenError = typeof mensaje === 'string' ? mensaje.slice(0, 500) : JSON.stringify(mensaje).slice(0, 500);

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; background: #f5f5f5; padding: 20px;">
  <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
    <div style="background: #e74c3c; color: white; padding: 20px; text-align: center;">
      <h2 style="margin: 0;">❌ Error en sincronización</h2>
      <p style="margin: 5px 0 0; opacity: 0.9;">Factura rechazada por Siesa</p>
    </div>
    <div style="padding: 20px;">
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 8px; font-weight: bold; color: #555; width: 120px;">Documento</td>
          <td style="padding: 8px;">${tipo || 'CNZ'} <strong>${consecutivo}</strong></td>
        </tr>
        <tr style="background: #f9f9f9;">
          <td style="padding: 8px; font-weight: bold; color: #555;">Caja / CO</td>
          <td style="padding: 8px;">${caja || '—'} · ${co || '—'}</td>
        </tr>
        <tr>
          <td style="padding: 8px; font-weight: bold; color: #555;">Fecha</td>
          <td style="padding: 8px;">${fechaStr}</td>
        </tr>
        ${cliente_nit ? `<tr style="background: #f9f9f9;"><td style="padding: 8px; font-weight: bold; color: #555;">Cliente NIT</td><td style="padding: 8px;">${cliente_nit}</td></tr>` : ''}
        ${neto ? `<tr><td style="padding: 8px; font-weight: bold; color: #555;">Neto</td><td style="padding: 8px;">$${Number(neto).toLocaleString('es-CO')}</td></tr>` : ''}
      </table>
      <div style="margin-top: 16px; padding: 12px; background: #fff5f5; border-left: 4px solid #e74c3c; border-radius: 4px;">
        <p style="margin: 0 0 4px; font-weight: bold; color: #c0392b;">Detalle del error:</p>
        <pre style="margin: 0; font-size: 13px; color: #666; white-space: pre-wrap; word-break: break-word;">${resumenError}</pre>
      </div>
      <p style="margin-top: 20px; font-size: 13px; color: #999; text-align: center;">
        Revisar en el dashboard de SiesaPOS Sync para más detalles.
      </p>
    </div>
  </div>
</body>
</html>`;

    try {
        const info = await transporter.sendMail({
            from: SMTP_FROM,
            to: emails.join(', '),
            subject: `❌ [SiesaPOS] Error en ${tipo || 'factura'} ${consecutivo}`,
            html,
        });
        console.log(`📧 Notificación de error enviada a ${emails.join(', ')}: ${info.messageId}`);
    } catch (err) {
        console.error(`⚠️ Error enviando notificación de error: ${err.message}`);
    }
}

// ──────────────────────────────────────────────────────────
// Notificación de AJUSTE DE INVENTARIO (CPE)
// ──────────────────────────────────────────────────────────
async function sendCpeNotification({ tipo, consecutivo, items, co, caja, fecha }) {
    const emails = getNotifyCpeEmails();
    if (emails.length === 0) {
        console.log('📧 NOTIFY_CPE_EMAILS no configurado — se omite notificación de CPE.');
        return;
    }
    if (!items || items.length === 0) {
        console.log('📧 Sin items CPE que notificar.');
        return;
    }

    const fechaStr = fecha || '(sin fecha)';
    const totalValor = items.reduce((s, i) => s + ((i.cantidad || 0) * (i.costo || 0)), 0);

    const filasItems = items.map(i => `
        <tr${items.indexOf(i) % 2 === 0 ? '' : ' style="background: #f9f9f9;"'}>
            <td style="padding: 6px 8px;">${i.item || '—'}</td>
            <td style="padding: 6px 8px; text-align: center;">${i.bodega || '—'}</td>
            <td style="padding: 6px 8px; text-align: right;">${Number(i.cantidad || 0).toLocaleString('es-CO')}</td>
            <td style="padding: 6px 8px; text-align: center;">${i.un || '—'}</td>
            <td style="padding: 6px 8px; text-align: right;">$${Number(i.costo || 0).toLocaleString('es-CO')}</td>
            <td style="padding: 6px 8px; text-align: right;">$${Number((i.cantidad || 0) * (i.costo || 0)).toLocaleString('es-CO')}</td>
        </tr>
    `).join('');

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; background: #f5f5f5; padding: 20px;">
  <div style="max-width: 650px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
    <div style="background: #2980b9; color: white; padding: 20px; text-align: center;">
      <h2 style="margin: 0;">📦 Ajuste de inventario automático</h2>
      <p style="margin: 5px 0 0; opacity: 0.9;">Inyección de stock por factura con inventario insuficiente</p>
    </div>
    <div style="padding: 20px;">
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 8px; font-weight: bold; color: #555; width: 120px;">Factura</td>
          <td style="padding: 8px;">${tipo || 'CNZ'} <strong>${consecutivo}</strong></td>
        </tr>
        <tr style="background: #f9f9f9;">
          <td style="padding: 8px; font-weight: bold; color: #555;">Caja / CO</td>
          <td style="padding: 8px;">${caja || '—'} · ${co || '—'}</td>
        </tr>
        <tr>
          <td style="padding: 8px; font-weight: bold; color: #555;">Fecha</td>
          <td style="padding: 8px;">${fechaStr}</td>
        </tr>
        <tr style="background: #f9f9f9;">
          <td style="padding: 8px; font-weight: bold; color: #555;">Items ajustados</td>
          <td style="padding: 8px;">${items.length}</td>
        </tr>
        <tr>
          <td style="padding: 8px; font-weight: bold; color: #555;">Valor total</td>
          <td style="padding: 8px;">$${Number(totalValor).toLocaleString('es-CO')}</td>
        </tr>
      </table>

      <h3 style="margin: 20px 0 10px; color: #333;">Detalle de items inyectados</h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <thead>
          <tr style="background: #ecf0f1;">
            <th style="padding: 8px; text-align: left;">Item</th>
            <th style="padding: 8px; text-align: center;">Bodega</th>
            <th style="padding: 8px; text-align: right;">Cantidad</th>
            <th style="padding: 8px; text-align: center;">UN</th>
            <th style="padding: 8px; text-align: right;">Costo</th>
            <th style="padding: 8px; text-align: right;">Total</th>
          </tr>
        </thead>
        <tbody>
          ${filasItems}
        </tbody>
        <tfoot>
          <tr style="font-weight: bold; border-top: 2px solid #2980b9;">
            <td style="padding: 8px;" colspan="3">${items.length} item(s)</td>
            <td style="padding: 8px;" colspan="3" style="text-align: right;">$${Number(totalValor).toLocaleString('es-CO')}</td>
          </tr>
        </tfoot>
      </table>

      <p style="margin-top: 20px; font-size: 13px; color: #999; text-align: center;">
        Ajuste generado automáticamente por SiesaPOS Sync.
      </p>
    </div>
  </div>
</body>
</html>`;

    try {
        const info = await transporter.sendMail({
            from: SMTP_FROM,
            to: emails.join(', '),
            subject: `📦 [SiesaPOS] Ajuste inventario en ${tipo || 'factura'} ${consecutivo} (${items.length} item(s))`,
            html,
        });
        console.log(`📧 Notificación de CPE enviada a ${emails.join(', ')}: ${info.messageId}`);
    } catch (err) {
        console.error(`⚠️ Error enviando notificación de CPE: ${err.message}`);
    }
}

// ──────────────────────────────────────────────────────────
// Notificación de CONVERSIÓN de medio de pago (DOM→EFE)
// ──────────────────────────────────────────────────────────
async function sendConversionNotification({ tipo, consecutivo, conversiones, co, caja, fecha, neto }) {
    const emails = getNotifyErrorEmails();
    if (emails.length === 0) {
        console.log('📧 NOTIFY_ERROR_EMAILS no configurado — se omite notificación de conversión.');
        return;
    }
    if (!conversiones || conversiones.length === 0) {
        console.log('📧 Sin conversiones que notificar.');
        return;
    }

    const fechaStr = fecha || '(sin fecha)';
    const filasConv = conversiones.map(cv => `
        <tr>
            <td style="padding: 6px 8px;">• ${cv.replace(/</g, '&lt;')}</td>
        </tr>
    `).join('');

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; background: #f5f5f5; padding: 20px;">
  <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
    <div style="background: #f39c12; color: white; padding: 20px; text-align: center;">
      <h2 style="margin: 0;">🔄 Conversión de medio de pago</h2>
      <p style="margin: 5px 0 0; opacity: 0.9;">Factura con pago DOM convertido automáticamente a EFE</p>
    </div>
    <div style="padding: 20px;">
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 8px; font-weight: bold; color: #555; width: 120px;">Documento</td>
          <td style="padding: 8px;">${tipo || 'CNZ'} <strong>${consecutivo}</strong></td>
        </tr>
        <tr style="background: #f9f9f9;">
          <td style="padding: 8px; font-weight: bold; color: #555;">Caja / CO</td>
          <td style="padding: 8px;">${caja || '—'} · ${co || '—'}</td>
        </tr>
        <tr>
          <td style="padding: 8px; font-weight: bold; color: #555;">Fecha</td>
          <td style="padding: 8px;">${fechaStr}</td>
        </tr>
        ${neto ? `<tr style="background: #f9f9f9;"><td style="padding: 8px; font-weight: bold; color: #555;">Valor</td><td style="padding: 8px;">$${Number(neto).toLocaleString('es-CO')}</td></tr>` : ''}
      </table>

      <h3 style="margin: 20px 0 10px; color: #333;">Conversiones aplicadas</h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <tbody>
          ${filasConv}
        </tbody>
      </table>

      <p style="margin-top: 20px; font-size: 13px; color: #999; text-align: center;">
        Conversión automática realizada por SiesaPOS Sync — ${conversiones.length} conversión(es).
      </p>
    </div>
  </div>
</body>
</html>`;

    try {
        const info = await transporter.sendMail({
            from: SMTP_FROM,
            to: emails.join(', '),
            subject: `🔄 [SiesaPOS] Conversión pago en ${tipo || 'factura'} ${consecutivo} (${conversiones.length})`,
            html,
        });
        console.log(`📧 Notificación de conversión enviada a ${emails.join(', ')}: ${info.messageId}`);
    } catch (err) {
        console.error(`⚠️ Error enviando notificación de conversión: ${err.message}`);
    }
}

// ──────────────────────────────────────────────────────────
// Notificación de CLIENTE con código y NIT distintos en el POS
// ──────────────────────────────────────────────────────────
async function sendClienteInconsistenteNotification({ tipo, consecutivo, co, caja, fecha, neto, idTercero, nitTercero, razonSocial }) {
    const emails = getNotifyErrorEmails();
    if (emails.length === 0) {
        console.log('📧 NOTIFY_ERROR_EMAILS no configurado — se omite notificación de cliente inconsistente.');
        return;
    }

    const fechaStr = fecha || '(sin fecha)';

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; background: #f5f5f5; padding: 20px;">
  <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
    <div style="background: #f39c12; color: white; padding: 20px; text-align: center;">
      <h2 style="margin: 0;">⚠️ Cliente con código y NIT distintos en el POS</h2>
      <p style="margin: 5px 0 0; opacity: 0.9;">Requiere confirmar el documento real del cliente</p>
    </div>
    <div style="padding: 20px;">
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 8px; font-weight: bold; color: #555; width: 120px;">Documento</td>
          <td style="padding: 8px;">${escapeHtml(tipo || 'CFZ')} <strong>${escapeHtml(consecutivo)}</strong></td>
        </tr>
        <tr style="background: #f9f9f9;">
          <td style="padding: 8px; font-weight: bold; color: #555;">Caja / CO</td>
          <td style="padding: 8px;">${escapeHtml(caja || '—')} · ${escapeHtml(co || '—')}</td>
        </tr>
        <tr>
          <td style="padding: 8px; font-weight: bold; color: #555;">Fecha</td>
          <td style="padding: 8px;">${escapeHtml(fechaStr)}</td>
        </tr>
        ${neto ? `<tr style="background: #f9f9f9;"><td style="padding: 8px; font-weight: bold; color: #555;">Valor</td><td style="padding: 8px;">$${Number(neto).toLocaleString('es-CO')}</td></tr>` : ''}
        <tr>
          <td style="padding: 8px; font-weight: bold; color: #555;">Cliente</td>
          <td style="padding: 8px;">${escapeHtml(razonSocial || '(sin razón social)')}</td>
        </tr>
        <tr style="background: #f9f9f9;">
          <td style="padding: 8px; font-weight: bold; color: #555;">Código POS</td>
          <td style="padding: 8px;">${escapeHtml(idTercero)}</td>
        </tr>
        <tr>
          <td style="padding: 8px; font-weight: bold; color: #555;">NIT enviado</td>
          <td style="padding: 8px;"><strong>${escapeHtml(nitTercero)}</strong></td>
        </tr>
      </table>

      <p style="margin-top: 20px; font-size: 14px; color: #333;">
        La factura se envió a Siesa con el NIT <strong>${escapeHtml(nitTercero)}</strong>, pero el registro del cliente
        en el POS tiene un código distinto (<strong>${escapeHtml(idTercero)}</strong>). Alguien debe confirmar cuál es el
        documento real del cliente y corregir el cliente en el POS.
      </p>

      <p style="margin-top: 20px; font-size: 13px; color: #999; text-align: center;">
        Alerta generada por SiesaPOS Sync.
      </p>
    </div>
  </div>
</body>
</html>`;

    try {
        const info = await transporter.sendMail({
            from: SMTP_FROM,
            to: emails.join(', '),
            subject: `⚠️ [SiesaPOS] Cliente con código y NIT distintos en ${tipo || 'factura'} ${consecutivo}`,
            html,
        });
        console.log(`📧 Notificación de cliente inconsistente enviada a ${emails.join(', ')}: ${info.messageId}`);
    } catch (err) {
        console.error(`⚠️ Error enviando notificación de cliente inconsistente: ${err.message}`);
    }
}

// ──────────────────────────────────────────────────────────
// Notificación de ALERTA DE SILENCIO (por CO)
// ──────────────────────────────────────────────────────────
async function sendSilentMiddayNotification({ resultados, checkTime }) {
    const emails = getNotifyErrorEmails();
    if (emails.length === 0) {
        console.log('📧 NOTIFY_ERROR_EMAILS no configurado — se omite alerta.');
        return;
    }
    if (!resultados || resultados.length === 0) {
        console.log('📧 Sin resultados que notificar.');
        return;
    }

    const hora = checkTime || '12:00 M';
    const fechaHoy = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota', year: 'numeric', month: 'long', day: 'numeric' });

    // COs con novedades para el asunto
    const conNovedad = resultados.filter(r => !r.ok);
    const coNovedadStr = conNovedad.map(r => `CO ${r.co}`).join(', ');
    const asunto = `⚠️ [SiesaPOS] Novedad en ${coNovedadStr} a las ${hora} — ${fechaHoy}`;

    // Filas de la tabla por CO
    const filasCO = resultados.map(r => {
        const rIcono = r.reales === 0 ? '❌' : '✅';
        const gIcono = r.genericas === 0 ? '❌' : '✅';
        const estadoColor = r.ok ? '#27ae60' : '#e74c3c';
        const estadoLabel = r.ok ? 'Bien' : '⚠️';
        return `
        <tr${resultados.indexOf(r) > 0 ? ' style="border-top: 1px solid #eee;"' : ''}>
          <td style="padding: 10px 8px; font-weight: bold; color: #555;">CO ${r.co}</td>
          <td style="padding: 10px 8px; text-align: center; font-weight: bold; color: ${estadoColor};">${estadoLabel}</td>
          <td style="padding: 10px 8px; text-align: center;">${rIcono} ${r.reales}</td>
          <td style="padding: 10px 8px; text-align: center;">${gIcono} ${r.genericas}</td>
          <td style="padding: 10px 8px; text-align: center; font-weight: bold;">${r.total}</td>
        </tr>`;
    }).join('');

    // Detalle de cada novedad
    const novedadesHTML = conNovedad.map(r => {
        if (r.reales === 0 && r.genericas === 0) return `<li><strong>CO ${r.co}</strong>: no hay ninguna factura registrada</li>`;
        if (r.reales === 0) return `<li><strong>CO ${r.co}</strong>: no hay facturas con cliente real (solo genéricas 222222222222)</li>`;
        return `<li><strong>CO ${r.co}</strong>: no hay facturas genéricas 222222222222 (solo reales)</li>`;
    }).join('');

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; background: #f5f5f5; padding: 20px;">
  <div style="max-width: 650px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
    <div style="background: #e67e22; color: white; padding: 20px; text-align: center;">
      <h2 style="margin: 0;">⚠️ Novedades en sincronización</h2>
      <p style="margin: 5px 0 0; opacity: 0.9;">${coNovedadStr} — ${hora}</p>
    </div>
    <div style="padding: 20px;">
      <p style="color: #555; font-size: 14px;">Resumen por CO a las <strong>${hora}</strong> del <strong>${fechaHoy}</strong>:</p>
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <thead>
          <tr style="background: #ecf0f1;">
            <th style="padding: 8px; text-align: left;">CO</th>
            <th style="padding: 8px; text-align: center;">Estado</th>
            <th style="padding: 8px; text-align: center;">Reales</th>
            <th style="padding: 8px; text-align: center;">Genéricas</th>
            <th style="padding: 8px; text-align: center;">Total</th>
          </tr>
        </thead>
        <tbody>
          ${filasCO}
        </tbody>
      </table>

      <div style="margin-top: 20px; padding: 12px; background: #fff8e1; border-left: 4px solid #e67e22; border-radius: 4px;">
        <p style="margin: 0 0 8px; font-weight: bold; color: #e67e22;">Novedades:</p>
        <ul style="margin: 0; padding-left: 20px; color: #555; font-size: 14px; line-height: 1.6;">
          ${novedadesHTML}
        </ul>
      </div>

      <p style="margin-top: 20px; font-size: 13px; color: #999; text-align: center;">
        Revisar en el dashboard o directamente en Connekta/Siesa.
      </p>
    </div>
  </div>
</body>
</html>`;

    try {
        const info = await transporter.sendMail({
            from: SMTP_FROM,
            to: emails.join(', '),
            subject: asunto,
            html,
        });
        console.log(`📧 Alerta enviada a ${emails.join(', ')}: ${info.messageId}`);
    } catch (err) {
        console.error(`⚠️ Error enviando alerta: ${err.message}`);
    }
}

// ──────────────────────────────────────────────────────────
// Notificación de TRANSFORMACIÓN TOCINO → CHICHARRÓN (resumen diario + alertas)
// ──────────────────────────────────────────────────────────
async function sendTransformacionNotification({ fecha, entorno, grupos, totalUnidades, totalKilos, detalle, alertas }) {
    const emails = getNotifyTransfEmails();
    if (emails.length === 0) {
        console.log('📧 NOTIFY_TRANSF_EMAILS no configurado — se omite notificación de transformación.');
        return;
    }

    const a = alertas || {};
    const nAlertas = (a.sinFilas ? 1 : 0) + (a.noClasificadas || []).length + (a.sinConfig || []).length
        + (a.advertenciasUM || []).length + (a.netoNoPositivo || []).length
        + (a.erroresSiesa || []).length + (a.erroresGuardado || []).length;

    const filas = (detalle || []).map((d, i) => `
        <tr${i % 2 === 0 ? '' : ' style="background: #f9f9f9;"'}>
            <td style="padding: 6px 8px;">${escapeHtml(d.co)}</td>
            <td style="padding: 6px 8px; text-align: center;">${escapeHtml(d.bodega)}</td>
            <td style="padding: 6px 8px; text-align: right;">${Number(d.unidades).toLocaleString('es-CO')}</td>
            <td style="padding: 6px 8px; text-align: right;">${Number(d.kilos).toLocaleString('es-CO')}</td>
            <td style="padding: 6px 8px; text-align: center;">${escapeHtml(d.entrada)}</td>
            <td style="padding: 6px 8px; text-align: center;">${escapeHtml(d.salida)}</td>
        </tr>`).join('');

    const items = [];
    if (a.sinFilas) items.push('<li><strong>0 filas</strong> devueltas por Connekta. Probable causa: el POS ya cerró el día y vació las tablas vivas, y la query de acumulados aún no lo trae.</li>');
    (a.erroresSiesa || []).forEach(e => items.push(`<li><strong>Siesa rechazó ${escapeHtml(e.tipo)}</strong> (CO ${escapeHtml(e.co)}, ${escapeHtml(e.bodega)}): ${escapeHtml(String(e.error).slice(0, 400))}</li>`));
    (a.erroresGuardado || []).forEach(e => items.push(`<li><strong>No se pudo registrar ${escapeHtml(e.tipo)}</strong> (CO ${escapeHtml(e.co)}, ${escapeHtml(e.bodega)})${e.ok ? ' — Siesa SÍ lo aceptó: no reenviar manualmente' : ''}: ${escapeHtml(e.error)}</li>`));
    (a.netoNoPositivo || []).forEach(d => items.push(`<li><strong>Neto ≤ 0</strong> (CO ${escapeHtml(d.co)}, ${escapeHtml(d.bodega)}): ventas ${d.ventas}, devoluciones ${d.devoluciones}. No se envió nada.</li>`));
    (a.noClasificadas || []).forEach(f => items.push(`<li><strong>Fila NO contada</strong>: ${escapeHtml(f.ID_TIPO_DOCTO)} ${escapeHtml(f.CONSEC_DOCTO)} item ${escapeHtml(f.id_item)} naturaleza=${escapeHtml(f.ind_naturaleza)} clase=${escapeHtml(f.ID_CLASE_DOCTO)} cantidad=${escapeHtml(f.CANTIDAD)}</li>`));
    (a.sinConfig || []).forEach(f => items.push(`<li><strong>Ítem sin configuración</strong> ${escapeHtml(f.id_item)} (${escapeHtml(f.DescItem)}): ${escapeHtml(f.ID_TIPO_DOCTO)} ${escapeHtml(f.CONSEC_DOCTO)}</li>`));
    (a.advertenciasUM || []).forEach(f => items.push(`<li><strong>Unidad de medida distinta</strong> a la configurada: ${escapeHtml(f.ID_TIPO_DOCTO)} ${escapeHtml(f.CONSEC_DOCTO)} UM=${escapeHtml(String(f.UNIDAD_MEDIDA).trim())} (se contó igual)</li>`));

    const color = nAlertas > 0 ? '#e67e22' : '#27ae60';
    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; background: #f5f5f5; padding: 20px;">
  <div style="max-width: 650px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
    <div style="background: ${color}; color: white; padding: 20px; text-align: center;">
      <h2 style="margin: 0;">🥓 Transformación tocino → chicharrón</h2>
      <p style="margin: 5px 0 0; opacity: 0.9;">${escapeHtml(fecha)} · Entorno ${escapeHtml(entorno)}</p>
    </div>
    <div style="padding: 20px;">
      <p style="color: #555; font-size: 14px;">Grupos: <strong>${grupos}</strong> · Unidades netas: <strong>${Number(totalUnidades).toLocaleString('es-CO')}</strong> · Tocino: <strong>${Number(totalKilos).toLocaleString('es-CO')} kg</strong></p>
      ${filas ? `
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <thead>
          <tr style="background: #ecf0f1;">
            <th style="padding: 8px; text-align: left;">CO</th>
            <th style="padding: 8px; text-align: center;">Bodega</th>
            <th style="padding: 8px; text-align: right;">Unidades</th>
            <th style="padding: 8px; text-align: right;">Kg</th>
            <th style="padding: 8px; text-align: center;">CEI</th>
            <th style="padding: 8px; text-align: center;">CSA</th>
          </tr>
        </thead>
        <tbody>${filas}</tbody>
      </table>` : '<p style="color: #999;">Sin grupos para procesar.</p>'}
      ${items.length > 0 ? `
      <div style="margin-top: 20px; padding: 12px; background: #fff8e1; border-left: 4px solid #e67e22; border-radius: 4px;">
        <p style="margin: 0 0 8px; font-weight: bold; color: #e67e22;">Alertas (${items.length}):</p>
        <ul style="margin: 0; padding-left: 20px; color: #555; font-size: 13px; line-height: 1.6;">${items.join('')}</ul>
      </div>` : ''}
      <p style="margin-top: 20px; font-size: 13px; color: #999; text-align: center;">
        Generado automáticamente por SiesaPOS Sync.
      </p>
    </div>
  </div>
</body>
</html>`;

    const prefijo = nAlertas > 0 ? '⚠️' : '🥓';
    try {
        const info = await transporter.sendMail({
            from: SMTP_FROM,
            to: emails.join(', '),
            subject: `${prefijo} [SiesaPOS] Transformación chicharrón ${fecha} (${totalUnidades} und${nAlertas > 0 ? `, ${nAlertas} alerta(s)` : ''})`,
            html,
        });
        console.log(`📧 Notificación de transformación enviada a ${emails.join(', ')}: ${info.messageId}`);
    } catch (err) {
        console.error(`⚠️ Error enviando notificación de transformación: ${err.message}`);
    }
}

// ──────────────────────────────────────────────────────────
// Notificación de TRANSFORMACIÓN NEGATIVOS (CEI + CSA por destino con inventario negativo)
// ──────────────────────────────────────────────────────────
// Destinatarios: NOTIFY_TRANSF_NEG_EMAILS -> NOTIFY_TRANSF_EMAILS -> NOTIFY_EMAILS
// (la lista propia aún no está confirmada por negocio).
function getNotifyTransfNegEmails() {
    return (process.env.NOTIFY_TRANSF_NEG_EMAILS || process.env.NOTIFY_TRANSF_EMAILS || process.env.NOTIFY_EMAILS || '')
        .split(',')
        .map(e => e.trim())
        .filter(Boolean);
}

// Construcción pura del correo (sin red): facilita las pruebas con transporte inyectado.
function buildTransformacionNegativosEmail(resultado) {
    const r = resultado || {};
    const a = r.alertas || {};
    const ref = (f) => `${escapeHtml(f.fecha)} CO ${escapeHtml(f.co)} ${escapeHtml(f.bodega)} item ${escapeHtml(f.item_destino)} ${escapeHtml(f.tipo_dto || '')}${f.item_origen ? ` origen ${escapeHtml(f.item_origen)}` : ''}`;
    const items = [];

    (a.ambiguos || []).forEach(f => items.push(`<li><strong>AMBIGUO${f.previo ? ' (SENDING -> AMBIGUO al inicio)' : ''}</strong> ${ref(f)}: ${f.tipo_dto === 'CEI' ? 'CEI possibly sent, CSAs blocked, manual review. ' : 'CSA possibly sent, manual review. '}${escapeHtml(String(f.error || '').slice(0, 300))}</li>`));
    (a.bloqueados || []).forEach(f => items.push(`<li><strong>CSA bloqueada</strong> ${ref(f)} cantidad ${escapeHtml(f.cantidad)}: ${escapeHtml(f.motivo)}</li>`));
    (a.erroresSiesa || []).forEach(f => items.push(`<li><strong>Siesa rechazó</strong> ${ref(f)}: ${escapeHtml(String(f.error).slice(0, 400))}</li>`));
    (a.erroresGuardado || []).forEach(f => items.push(`<li><strong>No se pudo registrar</strong> (${escapeHtml(f.fase)}) ${ref(f)}${f.ok ? ' — Siesa SÍ lo aceptó: no reenviar manualmente' : ''}: ${escapeHtml(f.error)}</li>`));
    (a.anomalias || []).forEach(f => items.push(`<li><strong>${escapeHtml(f.tipoAnomalia || 'ANOMALIA')}</strong> ${ref(f)}: ${escapeHtml(f.motivo)}</li>`));
    (a.errores || []).forEach(f => items.push(`<li><strong>Error de planeación</strong> ${ref(f)} cantidad ${escapeHtml(f.cantidad)}: ${escapeHtml(f.error)}</li>`));
    (a.omitidos || []).forEach(f => items.push(`<li><strong>Omitido ${escapeHtml(f.motivo)}</strong> ${ref(f)}${f.cantidad ? ` cantidad ${escapeHtml(f.cantidad)}` : ''}: ${escapeHtml(f.detalle || '')}</li>`));
    (a.reintentosDiasPrevios || []).forEach(f => items.push(`<li><strong>Reintento de día previo</strong> ${ref(f)} cantidad ${escapeHtml(f.cantidad)} (intentos previos ${escapeHtml(f.intentosPrevios)}): ${escapeHtml(f.resultado)}</li>`));
    (a.cancelados || []).forEach(f => items.push(`<li><strong>Cancelado</strong> (estado previo ${escapeHtml(f.estadoPrevio)}) ${ref(f)}</li>`));
    if (r.abortada) items.push('<li><strong>Corrida abortada</strong>: quedaron destinos sin procesar.</li>');

    const nAlertas = items.length;
    const inv = r.inventario;
    const invTexto = inv ? `${Number(inv.filas).toLocaleString('es-CO')} filas en ${inv.paginas} page(s)` : 'sin consulta (solo reanudación)';
    const filas = (r.detalle || []).map((d, i) => `
        <tr${i % 2 === 0 ? '' : ' style="background: #f9f9f9;"'}>
            <td style="padding: 6px 8px;">${escapeHtml(d.co)}</td>
            <td style="padding: 6px 8px; text-align: center;">${escapeHtml(d.bodega)}</td>
            <td style="padding: 6px 8px; text-align: center;">${escapeHtml(d.item_destino)}</td>
            <td style="padding: 6px 8px; text-align: center;">${escapeHtml(d.tipo_dto)}${d.item_origen ? ` (${escapeHtml(d.item_origen)})` : ''}</td>
            <td style="padding: 6px 8px; text-align: right;">${escapeHtml(d.cantidad)}</td>
            <td style="padding: 6px 8px; text-align: center;">${escapeHtml(d.resultado)}</td>
        </tr>`).join('');

    const color = nAlertas > 0 ? '#e67e22' : '#27ae60';
    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; background: #f5f5f5; padding: 20px;">
  <div style="max-width: 700px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
    <div style="background: ${color}; color: white; padding: 20px; text-align: center;">
      <h2 style="margin: 0;">Transformación de inventario negativo</h2>
      <p style="margin: 5px 0 0; opacity: 0.9;">${escapeHtml(r.fecha)} · Entorno ${escapeHtml(r.entorno)} · Modo ${escapeHtml(r.modo)}</p>
    </div>
    <div style="padding: 20px;">
      <p style="color: #555; font-size: 14px;">Destinos: <strong>${escapeHtml(r.destinos)}</strong> · Documentos enviados OK: <strong>${escapeHtml(r.documentos)}</strong> · Fallos: <strong>${escapeHtml(r.fallos)}</strong></p>
      <p style="color: #555; font-size: 14px;">Consulta de inventario: ${invTexto}</p>
      ${filas ? `
      <table style="width: 100%; border-collapse: collapse; font-size: 13px;">
        <thead>
          <tr style="background: #ecf0f1;">
            <th style="padding: 8px; text-align: left;">CO</th>
            <th style="padding: 8px; text-align: center;">Bodega</th>
            <th style="padding: 8px; text-align: center;">Destino</th>
            <th style="padding: 8px; text-align: center;">Doc</th>
            <th style="padding: 8px; text-align: right;">Cantidad</th>
            <th style="padding: 8px; text-align: center;">Resultado</th>
          </tr>
        </thead>
        <tbody>${filas}</tbody>
      </table>` : '<p style="color: #999;">Sin documentos enviados.</p>'}
      ${items.length > 0 ? `
      <div style="margin-top: 20px; padding: 12px; background: #fff8e1; border-left: 4px solid #e67e22; border-radius: 4px;">
        <p style="margin: 0 0 8px; font-weight: bold; color: #e67e22;">Alertas (${items.length}):</p>
        <ul style="margin: 0; padding-left: 20px; color: #555; font-size: 13px; line-height: 1.6;">${items.join('')}</ul>
      </div>` : ''}
      <p style="margin-top: 20px; font-size: 13px; color: #999; text-align: center;">
        Generado automáticamente por SiesaPOS Sync.
      </p>
    </div>
  </div>
</body>
</html>`;

    const subject = `${nAlertas > 0 ? '[ALERTA]' : '[OK]'} [SiesaPOS] Transformación negativos ${r.fecha} (${r.documentos} doc${nAlertas > 0 ? `, ${nAlertas} alerta(s)` : ''})`;
    return { subject, html, nAlertas };
}

// `deps.transport` permite inyectar un transporte en pruebas (nunca enviar correo real).
async function sendTransformacionNegativosNotification(resultado, deps = {}) {
    const emails = getNotifyTransfNegEmails();
    if (emails.length === 0) {
        console.log('NOTIFY_TRANSF_NEG_EMAILS/NOTIFY_TRANSF_EMAILS/NOTIFY_EMAILS no configurado — se omite notificación de negativos.');
        return;
    }
    const { subject, html } = buildTransformacionNegativosEmail(resultado);
    try {
        const info = await (deps.transport || transporter).sendMail({
            from: SMTP_FROM,
            to: emails.join(', '),
            subject,
            html,
        });
        console.log(`Notificación de negativos enviada a ${emails.join(', ')}: ${info && info.messageId}`);
    } catch (err) {
        console.error(`Error enviando notificación de negativos: ${err.message}`);
    }
}

module.exports = {
    sendErrorNotification,
    sendCpeNotification,
    sendConversionNotification,
    sendClienteInconsistenteNotification,
    sendSilentMiddayNotification,
    sendTransformacionNotification,
    sendTransformacionNegativosNotification,
    buildTransformacionNegativosEmail,
};
