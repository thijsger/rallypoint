// Email verzenden via Resend (https://resend.com).
//
// Vereist env-vars:
//   RESEND_API_KEY — Resend API key (re_xxx)
//   EMAIL_FROM     — afzender, bv. 'RallyPoint <noreply@rallypoint.pro>'
//   SITE_URL       — basis voor links in mails (default https://rallypoint.pro)
//
// Zonder API key worden mails niet verzonden — handig in dev.

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const EMAIL_FROM = process.env.EMAIL_FROM || 'RallyPoint <noreply@rallypoint.pro>';
const SITE_URL = process.env.SITE_URL || 'https://rallypoint.pro';

console.log('[email] RESEND_API_KEY present =', !!RESEND_API_KEY, '| FROM =', EMAIL_FROM);

async function sendEmail(to, subject, html) {
  if (!RESEND_API_KEY) {
    console.warn('[email] not sending — RESEND_API_KEY missing:', to, subject);
    return { ok: false, error: 'not_configured' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: EMAIL_FROM, to: [to], subject, html }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error('[email] resend', res.status, body.slice(0, 200));
      return { ok: false, error: 'send_failed' };
    }
    return { ok: true };
  } catch (e) {
    console.error('[email] threw:', e && e.message);
    return { ok: false, error: 'send_threw' };
  }
}

function wrap(title, intro, ctaLabel, ctaUrl, footer) {
  return `
<div style="font-family:'Outfit',Arial,sans-serif;background:#062821;color:#f4fff9;padding:40px 20px;">
  <div style="max-width:480px;margin:0 auto;background:#073b2e;border:1px solid #2a8c6f;border-radius:16px;padding:32px;">
    <h1 style="font-family:'Barlow Condensed',Arial,sans-serif;font-weight:700;color:#d4ff00;text-transform:uppercase;letter-spacing:.04em;margin:0 0 8px;font-size:28px;">RallyPoint</h1>
    <h2 style="font-weight:600;margin:0 0 14px;color:#f4fff9;font-size:20px;">${title}</h2>
    <p style="line-height:1.6;color:#cfe9dd;margin:0 0 22px;">${intro}</p>
    <p style="margin:0 0 22px;">
      <a href="${ctaUrl}" style="display:inline-block;background:#d4ff00;color:#052017;padding:14px 28px;border-radius:100px;text-decoration:none;font-weight:700;font-family:'Barlow Condensed',Arial,sans-serif;text-transform:uppercase;letter-spacing:.08em;">${ctaLabel}</a>
    </p>
    <p style="font-size:13px;color:#7fae9f;margin:0;">Of plak deze link in je browser:<br><span style="color:#d4ff00;word-break:break-all;">${ctaUrl}</span></p>
    <hr style="border:none;border-top:1px solid #2a8c6f;margin:24px 0;">
    <p style="font-size:12px;color:#7fae9f;margin:0;">${footer}</p>
  </div>
</div>`;
}

function sendVerifyEmail(toEmail, verifyToken) {
  const link = `${SITE_URL}/account/verify/${verifyToken}`;
  const html = wrap(
    'Bevestig je e-mailadres',
    'Welkom bij RallyPoint! Klik op de knop hieronder om je account te activeren.',
    'E-mail bevestigen',
    link,
    'Je hebt deze mail gekregen omdat iemand zich met dit adres heeft aangemeld bij rallypoint.pro. Was jij dat niet? Negeer dit bericht.'
  );
  return sendEmail(toEmail, 'Bevestig je RallyPoint-account', html);
}

function sendPasswordResetEmail(toEmail, resetToken) {
  const link = `${SITE_URL}/account/reset/${resetToken}`;
  const html = wrap(
    'Reset je wachtwoord',
    'Klik op de knop hieronder om een nieuw wachtwoord in te stellen. Deze link is 1 uur geldig.',
    'Wachtwoord resetten',
    link,
    'Heb je geen wachtwoord-reset aangevraagd? Negeer dit bericht. Je wachtwoord blijft ongewijzigd.'
  );
  return sendEmail(toEmail, 'Reset je RallyPoint-wachtwoord', html);
}

module.exports = { sendVerifyEmail, sendPasswordResetEmail };
