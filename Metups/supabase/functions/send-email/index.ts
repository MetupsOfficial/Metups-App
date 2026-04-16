/**
 * ================================================================
 * METUPS — EDGE FUNCTION: send-email
 * supabase/functions/send-email/index.ts
 *
 * Sends a transactional email via the Resend API.
 * Called from the frontend when a notification needs to go out
 * (new message, product view alert, etc.)
 *
 * ENVIRONMENT VARIABLES (set in Supabase Dashboard → Edge Functions):
 *   RESEND_API_KEY  — your Resend API key (re_...)
 *   FROM_EMAIL      — verified sender address (e.g. no-reply@metups.com)
 *
 * DEPLOY:
 *   supabase functions deploy send-email
 * ================================================================
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

// ── CORS headers ─────────────────────────────────────────────────
// Required for browser clients (fetch from your frontend domain).
// Adjust the origin to your production domain in production.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ── Environment ───────────────────────────────────────────────────
const RESEND_API_KEY = Deno.env.get('re_BHKgN32f_KGXKxXo5Qh5iCG5Du3YFcGrf') ?? '';
const FROM_EMAIL     = Deno.env.get('onboarding@resend.dev')     ?? 'no-reply@metups.com';
const APP_URL        = Deno.env.get('http://metups.com')        ?? 'https://metups.com';

// ── Email template ────────────────────────────────────────────────
function buildEmailHtml(subject: string, message: string, actionUrl: string): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#F2F5F9;font-family:'Helvetica Neue',Arial,sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#F2F5F9;padding:32px 16px">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#4DD9C0,#1B44C8);padding:28px 24px;border-radius:12px 12px 0 0;text-align:center">
              <h1 style="margin:0;color:#ffffff;font-size:28px;font-weight:900;letter-spacing:-0.5px">Metups</h1>
              <p style="margin:4px 0 0;color:rgba(255,255,255,.8);font-size:13px">Buy &amp; Sell Pre-owned Goods</p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background:#ffffff;padding:32px 28px;border-radius:0 0 12px 12px;box-shadow:0 4px 12px rgba(0,0,0,.08)">
              <h2 style="margin:0 0 16px;color:#0F172A;font-size:20px;font-weight:800">${subject}</h2>
              <p style="margin:0 0 24px;color:#334155;font-size:15px;line-height:1.65">${message}</p>

              ${actionUrl ? `
              <div style="text-align:center;margin:24px 0">
                <a href="${actionUrl}"
                   style="display:inline-block;background:#22C55E;color:#ffffff;font-size:15px;
                          font-weight:700;padding:13px 28px;border-radius:999px;text-decoration:none">
                  View Details
                </a>
              </div>` : ''}

              <hr style="border:none;border-top:1px solid #E2E8F0;margin:28px 0">

              <p style="margin:0;color:#94A3B8;font-size:12px;line-height:1.6">
                You're receiving this because you have a Metups account.
                <a href="${APP_URL}/settings" style="color:#1B44C8;text-decoration:none">Manage notifications</a>
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="text-align:center;padding:20px 0">
              <p style="margin:0;color:#94A3B8;font-size:11px">
                © ${new Date().getFullYear()} Metups · Give products a second life
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ── Request handler ───────────────────────────────────────────────
serve(async (req: Request): Promise<Response> => {

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Only allow POST
  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  // Guard: API key must be configured
  if (!RESEND_API_KEY) {
    console.error('[send-email] RESEND_API_KEY is not set');
    return new Response(
      JSON.stringify({ error: 'Email service not configured' }),
      { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  // Parse body
  let to: string, subject: string, message: string, actionUrl: string;
  try {
    const body = await req.json();
    to        = String(body.to        ?? '').trim();
    subject   = String(body.subject   ?? '').trim();
    message   = String(body.message   ?? '').trim();
    actionUrl = String(body.actionUrl ?? '').trim();
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON body' }),
      { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  // Input validation
  if (!to || !to.includes('@')) {
    return new Response(
      JSON.stringify({ error: 'Invalid recipient email address' }),
      { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
  if (!subject || !message) {
    return new Response(
      JSON.stringify({ error: 'subject and message are required' }),
      { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  // Send via Resend
  const resendRes = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from:    FROM_EMAIL,
      to:      [to],
      subject: `Metups — ${subject}`,
      html:    buildEmailHtml(subject, message, actionUrl),
    }),
  });

  if (!resendRes.ok) {
    const err = await resendRes.json().catch(() => ({ message: resendRes.statusText }));
    console.error('[send-email] Resend API error:', err);
    return new Response(
      JSON.stringify({ error: 'Failed to send email', detail: err }),
      { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  const result = await resendRes.json();
  console.log(`[send-email] ✅ Sent to ${to} — id: ${result.id}`);

  return new Response(
    JSON.stringify({ success: true, id: result.id }),
    { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
  );
});