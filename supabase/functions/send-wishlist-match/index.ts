/**
 * ================================================================
 * METUPS — EDGE FUNCTION: send-wishlist-match
 * supabase/functions/send-wishlist-match/index.ts
 *
 * Sends an email notification to a user when a product matching
 * their want-alert is listed on the marketplace.
 *
 * Called from wishlist.js → checkWishlistMatches() after a new
 * product is successfully inserted.
 *
 * ENVIRONMENT VARIABLES (set in Supabase Dashboard → Edge Functions):
 *   RESEND_API_KEY  — your Resend API key (re_...)
 *   FROM_EMAIL      — verified sender address (e.g. no-reply@metups.com)
 *   APP_URL         — your app base URL (e.g. https://metups.com)
 *
 * DEPLOY:
 *   supabase functions deploy send-wishlist-match
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
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const FROM_EMAIL     = Deno.env.get('FROM_EMAIL')     ?? 'no-reply@metups.com';
const APP_URL        = Deno.env.get('APP_URL')        ?? 'https://metups.com';

// ── Request body shape ────────────────────────────────────────────
interface WishlistMatchBody {
  to:             string;   // recipient email
  product_title:  string;   // the matched product's title
  product_price:  number;   // the matched product's price (number)
  product_id:     string;   // UUID — used to build the product URL
  wishlist_title: string;   // the user's want-alert title
}

// ── Currency formatter ────────────────────────────────────────────
function formatUSD(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style:                 'currency',
    currency:              'USD',
    minimumFractionDigits: 2,
  }).format(amount);
}

// ── Email template ────────────────────────────────────────────────
function buildMatchEmail(data: WishlistMatchBody): string {
  const productUrl  = `${APP_URL}/Dashboard/product.html?id=${data.product_id}`;
  const wishlistUrl = `${APP_URL}/Dashboard/wishlist.html`;

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your item is available!</title>
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

              <!-- Emoji + headline -->
              <div style="text-align:center;margin-bottom:24px">
                <div style="font-size:36px;margin-bottom:10px">🎉</div>
                <h2 style="margin:0;color:#0F172A;font-size:22px;font-weight:900">Great news!</h2>
                <p style="margin:8px 0 0;color:#334155;font-size:15px;line-height:1.6">
                  An item matching your want-alert for
                  <strong style="color:#1B44C8">"${data.wishlist_title}"</strong>
                  has just been listed.
                </p>
              </div>

              <!-- Product card -->
              <table width="100%" cellpadding="0" cellspacing="0"
                     style="background:#F2F5F9;border-radius:10px;padding:20px;margin-bottom:24px">
                <tr>
                  <td>
                    <p style="margin:0 0 6px;color:#64748B;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;font-weight:700">
                      Matched Listing
                    </p>
                    <p style="margin:0 0 4px;color:#0F172A;font-size:18px;font-weight:800">
                      ${data.product_title}
                    </p>
                    <p style="margin:0 0 18px;color:#22C55E;font-size:22px;font-weight:900">
                      ${formatUSD(data.product_price)}
                    </p>
                    <a href="${productUrl}"
                       style="display:inline-block;background:#22C55E;color:#ffffff;font-size:15px;
                              font-weight:700;padding:12px 26px;border-radius:999px;text-decoration:none">
                      View Listing
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 24px;color:#334155;font-size:14px;line-height:1.65">
                Pre-owned deals like this move fast — tap the button above to view it before someone else grabs it!
              </p>

              <hr style="border:none;border-top:1px solid #E2E8F0;margin:24px 0">

              <p style="margin:0;color:#94A3B8;font-size:12px;line-height:1.6">
                You're receiving this because you have an active want-alert on Metups.
                <a href="${wishlistUrl}" style="color:#1B44C8;text-decoration:none">Manage your alerts</a>
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
    console.error('[send-wishlist-match] RESEND_API_KEY is not set');
    return new Response(
      JSON.stringify({ error: 'Email service not configured' }),
      { status: 503, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  // Parse body
  let body: Partial<WishlistMatchBody>;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON body' }),
      { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  // Input validation — all fields required
  const { to, product_title, product_price, product_id, wishlist_title } = body;

  if (!to || !String(to).includes('@')) {
    return new Response(
      JSON.stringify({ error: 'Invalid or missing recipient email (to)' }),
      { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
  if (!product_title) {
    return new Response(
      JSON.stringify({ error: 'product_title is required' }),
      { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
  if (product_price === undefined || product_price === null || isNaN(Number(product_price))) {
    return new Response(
      JSON.stringify({ error: 'product_price must be a valid number' }),
      { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
  if (!product_id) {
    return new Response(
      JSON.stringify({ error: 'product_id is required' }),
      { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
  if (!wishlist_title) {
    return new Response(
      JSON.stringify({ error: 'wishlist_title is required' }),
      { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  // Build the clean payload to pass to the template
  const matchData: WishlistMatchBody = {
    to:             String(to).trim(),
    product_title:  String(product_title).trim(),
    product_price:  Number(product_price),
    product_id:     String(product_id).trim(),
    wishlist_title: String(wishlist_title).trim(),
  };

  // Send via Resend
  const resendRes = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from:    FROM_EMAIL,
      to:      [matchData.to],
      subject: `🎉 Found: "${matchData.wishlist_title}" is now available on Metups!`,
      html:    buildMatchEmail(matchData),
    }),
  });

  if (!resendRes.ok) {
    const err = await resendRes.json().catch(() => ({ message: resendRes.statusText }));
    console.error('[send-wishlist-match] Resend API error:', err);
    return new Response(
      JSON.stringify({ error: 'Failed to send email', detail: err }),
      { status: 502, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }

  const result = await resendRes.json();
  console.log(`[send-wishlist-match] ✅ Notified ${matchData.to} about "${matchData.product_title}" — id: ${result.id}`);

  return new Response(
    JSON.stringify({ success: true, id: result.id }),
    { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
  );
});