/**
 * ================================================================
 * METUPS — EDGE FUNCTION: send-sms
 * supabase/functions/send-sms/index.ts
 *
 * Sends an SMS notification via the Twilio API.
 * Used for urgent alerts when the user has SMS notifications enabled.
 *
 * ENVIRONMENT VARIABLES (set in Supabase Dashboard → Edge Functions):
 *   TWILIO_ACCOUNT_SID  — your Twilio Account SID (ACxxx...)
 *   TWILIO_AUTH_TOKEN   — your Twilio Auth Token
 *   TWILIO_PHONE_NUMBER — your Twilio sender number (E.164: +1234567890)
 *
 * DEPLOY:
 *   supabase functions deploy send-sms
 * ================================================================
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

// ── CORS headers ─────────────────────────────────────────────────
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// ── Environment ───────────────────────────────────────────────────
const TWILIO_ACCOUNT_SID  = Deno.env.get('TWILIO_ACCOUNT_SID')  ?? '';
const TWILIO_AUTH_TOKEN   = Deno.env.get('TWILIO_AUTH_TOKEN')   ?? '';
const TWILIO_PHONE_NUMBER = Deno.env.get('TWILIO_PHONE_NUMBER') ?? '';

// ── E.164 phone number validator ──────────────────────────────────
// Twilio requires E.164 format: +[country code][number] — e.g. +263771234567
function isValidPhone(phone: string): boolean {
  return /^\+[1-9]\d{6,14}$/.test(phone.trim());
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

  // Guard: all Twilio credentials must be configured
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    console.error('[send-sms] Twilio credentials not configured');
    return new Response(
      JSON.stringify({ error: 'SMS service not configured' }),
      { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  // Parse body
  let to: string, message: string;
  try {
    const body = await req.json();
    to      = String(body.to      ?? '').trim();
    message = String(body.message ?? '').trim();
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON body' }),
      { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  // Input validation
  if (!to || !isValidPhone(to)) {
    return new Response(
      JSON.stringify({ error: 'Invalid phone number. Must be in E.164 format (e.g. +263771234567)' }),
      { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
  if (!message) {
    return new Response(
      JSON.stringify({ error: 'message is required' }),
      { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  // Prepend app name to message for clarity
  const smsBody = `[Metups] ${message}`;

  // Twilio Messages API
  const twilioUrl = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;

  // Basic auth: base64(ACCOUNT_SID:AUTH_TOKEN)
  const credentials = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);

  const twilioRes = await fetch(twilioUrl, {
    method:  'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type':  'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      Body: smsBody,
      From: TWILIO_PHONE_NUMBER,
      To:   to,
    }),
  });

  if (!twilioRes.ok) {
    const errText = await twilioRes.text();
    console.error(`[send-sms] Twilio error (${twilioRes.status}):`, errText);
    return new Response(
      JSON.stringify({ error: 'Failed to send SMS', detail: errText }),
      { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  const result = await twilioRes.json();
  console.log(`[send-sms] ✅ SMS sent to ${to} — SID: ${result.sid}`);

  return new Response(
    JSON.stringify({ success: true, sid: result.sid }),
    { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
  );
});