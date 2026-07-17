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
// Notificación de ALERTA DE SILENCIO (sin facturas registradas)
// ──────────────────────────────────────────────────────────
async function sendSilentMiddayNotification({ co, totalFacturasHoy, reales, genericas, checkTime, ultimaFactura }) {
    const emails = getNotifyErrorEmails();
    if (emails.length === 0) {
        console.log('📧 NOTIFY_ERROR_EMAILS no configurado — se omite alerta de mediodía.');
        return;
    }

    const hora = checkTime || '12:00 M';
    const fechaHoy = new Date().toLocaleDateString('es-CO', { timeZone: 'America/Bogota', year: 'numeric', month: 'long', day: 'numeric' });

    // Determinar el mensaje según qué está en 0
    let tituloAlerta, descripcionAlerta;
    if (reales === 0 && genericas === 0) {
        tituloAlerta = 'No hay facturas registradas';
        descripcionAlerta = `A las ${hora} no se ha registrado ninguna factura en el sistema (reales = 0 y genéricas = 0).`;
    } else if (reales === 0) {
        tituloAlerta = 'No hay facturas con cliente real';
        descripcionAlerta = `A las ${hora} solo hay facturas genéricas (NIT 222222222222), ninguna con cliente real.`;
    } else {
        tituloAlerta = 'No hay facturas genéricas';
        descripcionAlerta = `A las ${hora} solo hay facturas con cliente real, ninguna genérica (NIT 222222222222).`;
    }

    const realesIcono = reales === 0 ? '❌' : '✅';
    const genericasIcono = genericas === 0 ? '❌' : '✅';

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; background: #f5f5f5; padding: 20px;">
  <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
    <div style="background: #e67e22; color: white; padding: 20px; text-align: center;">
      <h2 style="margin: 0;">⚠️ ${tituloAlerta}</h2>
      <p style="margin: 5px 0 0; opacity: 0.9;">${descripcionAlerta}</p>
    </div>
    <div style="padding: 20px;">
      <hr style="border: none; border-top: 1px solid #eee; margin: 0 0 16px;">
      <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
        <tr>
          <td style="padding: 8px; font-weight: bold; color: #555; width: 160px;">CO(s) activos</td>
          <td style="padding: 8px;">${co || '(todos)'}</td>
        </tr>
        <tr style="background: #f9f9f9;">
          <td style="padding: 8px; font-weight: bold; color: #555;">Facturas reales</td>
          <td style="padding: 8px; font-weight: bold;">${realesIcono} ${reales}</td>
        </tr>
        <tr>
          <td style="padding: 8px; font-weight: bold; color: #555;">Facturas genéricas</td>
          <td style="padding: 8px; font-weight: bold;">${genericasIcono} ${genericas}</td>
        </tr>
        <tr style="background: #f9f9f9;">
          <td style="padding: 8px; font-weight: bold; color: #555;">Total hoy</td>
          <td style="padding: 8px; font-weight: bold; color: ${totalFacturasHoy === 0 ? '#e74c3c' : '#27ae60'};">${totalFacturasHoy}</td>
        </tr>
      </table>
      <p style="margin-top: 16px; font-size: 14px; color: #555; line-height: 1.6;">
        <strong>Posibles causas:</strong><br>
        ${reales === 0 ? '• El POS puede no estar enviando datos de clientes reales (solo genéricas).<br>' : ''}
        ${genericas === 0 ? '• Puede que no se estén facturando clientes sin identificación (solo reales).<br>' : ''}
        ${totalFacturasHoy === 0 ? '• El POS podría estar caído o el sync automático fallando.<br>• Problemas de conexión con Connekta.<br>• El local pudo haber estado cerrado.' : ''}
      </p>
      <p style="margin-top: 20px; font-size: 13px; color: #999; text-align: center;">
        Revisar en el dashboard de SiesaPOS Sync o directamente en Connekta/Siesa.
      </p>
    </div>
  </div>
</body>
</html>`;

    // Asunto según qué falta
    let asunto;
    if (reales === 0 && genericas === 0) {
        asunto = `⚠️ [SiesaPOS] Sin facturas a las ${hora} — ${fechaHoy}`;
    } else if (reales === 0) {
        asunto = `⚠️ [SiesaPOS] Sin reales a las ${hora} (solo genéricas) — ${fechaHoy}`;
    } else {
        asunto = `⚠️ [SiesaPOS] Sin genéricas a las ${hora} (solo reales) — ${fechaHoy}`;
    }

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
