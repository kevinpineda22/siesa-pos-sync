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

module.exports = {
    sendErrorNotification,
    sendCpeNotification,
    sendConversionNotification,
    sendSilentMiddayNotification,
};
