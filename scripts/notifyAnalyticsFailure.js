// Notifica por correo el fallo del workflow de materialización analítica POS.
// Se ejecuta SOLO cuando el paso principal falla (if: failure() en el workflow).
// Usa las mismas secrets SMTP y destinatarios que los demás flujos.
require('dotenv').config();
const nodemailer = require('nodemailer');

async function main() {
  const host = process.env.SMTP_HOST;
  const to = (process.env.NOTIFY_ERROR_EMAILS || '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);

  if (!host || to.length === 0) {
    console.log('📧 SMTP_HOST o NOTIFY_ERROR_EMAILS no configurado — se omite notificación de fallo.');
    return;
  }

  const runUrl = `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${
    process.env.GITHUB_REPOSITORY || ''
  }/actions/runs/${process.env.GITHUB_RUN_ID || ''}`;
  const fecha = new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' });

  const transporter = nodemailer.createTransport({
    host,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family: Arial, sans-serif; background: #f5f5f5; padding: 20px;">
  <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1);">
    <div style="background: #e74c3c; color: white; padding: 20px; text-align: center;">
      <h2 style="margin: 0;">❌ Fallo en materialización analítica POS</h2>
      <p style="margin: 5px 0 0; opacity: 0.9;">Workflow diario de analítica</p>
    </div>
    <div style="padding: 20px;">
      <p style="color: #555; font-size: 14px;">La ejecución del workflow <strong>materialize-analytics</strong> falló el <strong>${fecha}</strong> (hora Bogotá).</p>
      <div style="margin-top: 16px; padding: 12px; background: #fff5f5; border-left: 4px solid #e74c3c; border-radius: 4px;">
        <p style="margin: 0 0 4px; font-weight: bold; color: #c0392b;">Acción requerida:</p>
        <p style="margin: 0; font-size: 13px; color: #666;">
          Revisar el log de la ejecución y, si fue un fallo de Siesa/Connekta, volver a disparar el workflow manualmente.
        </p>
      </div>
      <p style="margin-top: 16px; font-size: 13px; color: #999; text-align: center;">
        <a href="${runUrl}" style="color: #3498db;">Ver ejecución en GitHub →</a>
      </p>
    </div>
  </div>
</body>
</html>`;

  try {
    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || 'notificacion@merkahorro.com',
      to: to.join(', '),
      subject: '❌ [SiesaPOS] Fallo en la materialización analítica POS',
      html,
    });
    console.log(`📧 Notificación de fallo enviada a ${to.join(', ')}: ${info.messageId}`);
  } catch (err) {
    // El fallo de la notificación no debe enmascarar el fallo real del workflow.
    console.error(`⚠️ Error enviando notificación de fallo: ${err.message}`);
  }
}

main().catch((err) => {
  console.error('Error fatal en notificador de fallo:', err);
});
