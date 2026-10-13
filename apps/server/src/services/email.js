// Email service (verification codes, password reset)

const nodemailer = require('nodemailer');

const smtpUser = (process.env.SMTP_USER || '').trim();

const emailTransporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.163.com',
  port: parseInt(process.env.SMTP_PORT) || 465,
  secure: true,
  auth: {
    user: smtpUser,
    pass: process.env.SMTP_PASS
  }
});

async function sendVerificationEmail(toEmail, code, { subject, title, intro, logLabel }) {
  if (smtpUser) {
    await emailTransporter.sendMail({
      from: `AniWorld <${smtpUser}>`,
      to: toEmail,
      subject,
      html: `
        <div style="max-width:600px;margin:40px auto;padding:32px;font-family:-apple-system,sans-serif;background:#fff;color:#333;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,0.1);">
          <h2 style="color:#e85d04;margin:0 0 16px;">AniWorld ${title}</h2>
          <p style="margin:8px 0;">${intro}</p>
          <p style="margin:8px 0;">您的验证码为：</p>
          <div style="background:#f5f5f5;padding:20px;text-align:center;border-radius:8px;margin:20px 0;">
            <span style="font-size:36px;font-weight:bold;color:#e85d04;letter-spacing:10px;">${code}</span>
          </div>
          <p style="margin:8px 0;color:#666;font-size:14px;">验证码 3 分钟内有效，请勿泄露给他人。</p>
          <p style="margin:8px 0;color:#999;font-size:13px;">如果这不是您的操作，请忽略此邮件。</p>
        </div>
      `
    });
    console.log(`[auth] ${logLabel} sent to`, toEmail);
  } else {
    console.log(`\n======== ${logLabel.toUpperCase()} (dev — SMTP未配置) ========`);
    console.log(`  Email: ${toEmail}`);
    console.log(`  Code:  ${code}`);
    console.log(`  Expires: 3 minutes`);
    console.log(`${'='.repeat(50)}\n`);
  }
  return { sent: true };
}

module.exports = { sendVerificationEmail };
