/**
 * ================================================================
 * METUPS MARKETPLACE — SERVICE WORKER
 * sw.js  (must live at the root of your domain)
 *
 * Strategy:
 *   • App shell (HTML/CSS/JS/fonts) → Cache-first, update in background
 *   • Supabase API calls            → Network-first (always fresh data)
 *   • Images (product_images CDN)   → Cache-first with 7-day expiry
 *   • Offline fallback              → Shows index.html with a notice
 *
 * Versioning: bump CACHE_VERSION when you deploy new code.
 * The old cache is deleted automatically during the activate step.
 * ================================================================
 */

const CACHE_VERSION   = 'metups-v1';
const OFFLINE_URL     = '/index.html';

// ── Assets to pre-cache on install ────────────────────────────────
// These are fetched and cached immediately when the SW installs,
// so the app loads instantly even on a slow connection.
const PRECACHE_ASSETS = [
  '/index.html',
  '/Authentication/styles.css',
  '/Authentication/supabase.js',
  '/Authentication/utils.js',
  '/Authentication/auth.js',
  '/Authentication/login.html',
  '/Authentication/signup.html',
  '/Authentication/confirm.html',
  '/Dashboard/dashboard.html',
  '/Dashboard/product.html',
  '/Dashboard/add_product.html',
  '/Dashboard/profile.html',
  '/Dashboard/notifications.html',
  '/Dashboard/menu.html',
  '/Dashboard/settings.html',
  '/Dashboard/wishlist.html',
  '/Dashboard/add_wishlist.html',
  '/Dashboard/products.js',
  '/Dashboard/dashboard.js',
  '/Dashboard/wishlist.js',
  '/Messaging/messaging.html',
  '/Messaging/messaging.js',
  '/manifest.json',
  '/icons/Metups_logo-192.png',
  '/icons/Metups_logo-512.png',
  // Font Awesome and Supabase CDN are NOT pre-cached (too large)
  // They are cached lazily on first use via the fetch handler below
];

// ── Hosts whose requests bypass the cache entirely ─────────────────
// Supabase REST, Storage, Auth and Realtime must always go to the network.
const NETWORK_ONLY_HOSTS = [
  'supabase.co',
  'supabase.com',
];

// ── Image CDN cache config ─────────────────────────────────────────
const IMAGE_CACHE      = 'metups-images-v1';
const IMAGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const IMAGE_MAX_ITEMS  = 200;

// ================================================================
// INSTALL — pre-cache app shell
// ================================================================
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => {
        //console.log('[SW] Pre-caching app shell…');
        // addAll fails silently per-item — use individual add so one
        // missing file doesn't block the entire install
        return Promise.allSettled(
          PRECACHE_ASSETS.map(url =>
            cache.add(url).catch(err =>
              console.warn(`[SW] Failed to pre-cache ${url}:`, err)
            )
          )
        );
      })
      .then(() => {
        //console.log('[SW] Install complete');
        // Skip waiting so the new SW activates immediately
        return self.skipWaiting();
      })
  );
});

// ================================================================
// ACTIVATE — clean up old caches
// ================================================================
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(k => k !== CACHE_VERSION && k !== IMAGE_CACHE)
          .map(k => {
            //console.log('[SW] Deleting old cache:', k);
            return caches.delete(k);
          })
      ))
      .then(() => {
        //console.log('[SW] Activate complete — controlling all clients');
        return self.clients.claim();
      })
  );
});

// ================================================================
// FETCH — routing strategy
// ================================================================
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // ── 1. Skip non-GET requests (POST/PUT/DELETE go straight to network) ──
  if (request.method !== 'GET') return;

  // ── 2. Skip chrome-extension, data:, blob: etc ──
  if (!request.url.startsWith('http')) return;

  // ── 3. Network-only for Supabase API / Auth / Storage ──
  if (NETWORK_ONLY_HOSTS.some(h => url.hostname.includes(h))) {
    // Don't intercept — let the browser handle it natively
    return;
  }

  // ── 4. Cache-first for product images (CDN) ──
  if (url.pathname.includes('/storage/v1/object/public/')) {
    event.respondWith(serveImage(request));
    return;
  }

  // ── 5. Cache-first (update in background) for app shell ──
  event.respondWith(serveAppShell(request));
});

// ================================================================
// STRATEGY: Cache-first with background update (app shell)
// ================================================================
async function serveAppShell(request) {
  const cache    = await caches.open(CACHE_VERSION);
  const cached   = await cache.match(request);

  // Kick off a background network fetch to keep cache fresh
  const networkFetch = fetch(request)
    .then(response => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null); // offline — background fetch silently fails

  if (cached) {
    // Serve from cache immediately; update happens in background
    return cached;
  }

  // Nothing in cache — wait for network
  try {
    const response = await networkFetch;
    if (response) return response;
  } catch { /* fall through to offline fallback */ }

  // Offline fallback: return the cached home page
  const fallback = await cache.match(OFFLINE_URL);
  if (fallback) return fallback;

  // Last resort: generic offline response
  return new Response(
    `<!DOCTYPE html>
    <html lang="en">
    <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width">
    <title>Metups — Offline</title>
    <style>
      body { font-family: sans-serif; display:flex; flex-direction:column;
             align-items:center; justify-content:center; min-height:100vh;
             background:#F2F5F9; color:#0F172A; text-align:center; padding:20px; }
      h1   { font-size:1.5rem; margin-bottom:12px; }
      p    { color:#64748B; font-size:.9rem; }
      a    { color:#1B44C8; font-weight:700; }
    </style>
    </head>
    <body>
      <h1>📵 You're offline</h1>
      <p>No internet connection. Please check your connection and try again.</p>
      <p><a href="/index.html">Try again</a></p>
    </body>
    </html>`,
    {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    }
  );
}

// ================================================================
// STRATEGY: Cache-first with expiry for images
// ================================================================
async function serveImage(request) {
  const cache  = await caches.open(IMAGE_CACHE);
  const cached = await cache.match(request);

  if (cached) {
    // Check if cached image has expired
    const cachedDate = cached.headers.get('sw-cached-date');
    if (cachedDate && (Date.now() - parseInt(cachedDate)) < IMAGE_MAX_AGE_MS) {
      return cached;
    }
  }

  try {
    const response = await fetch(request);
    if (response.ok) {
      // Clone and add a timestamp header before caching
      const headers  = new Headers(response.headers);
      headers.set('sw-cached-date', Date.now().toString());
      const toCache  = new Response(await response.clone().blob(), { headers });

      await cache.put(request, toCache);
      await trimImageCache(cache);
    }
    return response;
  } catch {
    // Offline: return cached version even if expired
    if (cached) return cached;
    // No cache: transparent 1×1 GIF placeholder
    return new Response(
      atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
      { headers: { 'Content-Type': 'image/gif' } }
    );
  }
}

// ── Remove oldest images when cache exceeds IMAGE_MAX_ITEMS ──
async function trimImageCache(cache) {
  const keys = await cache.keys();
  if (keys.length > IMAGE_MAX_ITEMS) {
    // Delete the oldest N entries
    const toDelete = keys.slice(0, keys.length - IMAGE_MAX_ITEMS);
    await Promise.all(toDelete.map(k => cache.delete(k)));
  }
}

// ================================================================
// PUSH NOTIFICATIONS (for future use)
// ================================================================
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data = { title: 'Metups', body: 'You have a new notification.' };
  try { data = event.data.json(); } catch { /* use defaults */ }

  event.waitUntil(
    self.registration.showNotification(data.title || 'Metups', {
      body:    data.body    || '',
      icon:    data.icon    || '/icons/Metups_logo-192.png',
      badge:   data.badge   || '/icons/Metups_logo-96.png',
      tag:     data.tag     || 'metups-notification',
      data:    { url: data.url || '/index.html' },
      vibrate: [100, 50, 100],
      requireInteraction: false,
    })
  );
});

// Open the relevant page when a notification is tapped
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/index.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        // Focus an existing window if one is open
        for (const client of clientList) {
          if (client.url.includes(self.location.origin) && 'focus' in client) {
            client.navigate(targetUrl);
            return client.focus();
          }
        }
        // Otherwise open a new window
        if (clients.openWindow) return clients.openWindow(targetUrl);
      })
  );
});