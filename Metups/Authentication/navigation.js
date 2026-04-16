/**
 * ================================================================
 * METUPS — DESKTOP NAVIGATION SIDEBAR
 * Authentication/navigation.js
 *
 * Dynamically injects a persistent left sidebar on every page
 * at the ≥768px breakpoint (WhatsApp Web / Facebook style).
 * On mobile the sidebar is hidden and the existing top-nav shows.
 *
 * HOW TO ADD TO EVERY PAGE:
 *   Add this before </body> in every HTML file:
 *   <script type="module" src="../Authentication/navigation.js"></script>
 *   (Auth pages: src="./navigation.js")
 *
 * The sidebar:
 *   • Logo + wordmark
 *   • Search bar (redirects to index with query)
 *   • Nav links: Browse · Messages · Sell · Notifications · Profile
 *   • User avatar + name at bottom
 *   • Logout button
 * ================================================================
 */

import { supabaseClient } from './supabase.js';
import { checkAuth, getAvatarInitials } from './utils.js';

// Don't inject sidebar on pure auth pages (login / signup / confirm)
const AUTH_PAGES = ['/login.html', '/signup.html', '/confirm.html'];
const isAuthPage = AUTH_PAGES.some(p => window.location.pathname.endsWith(p));
if (isAuthPage) {
  // Still export a no-op so importing pages don't break
  console.debug('[nav] Auth page — sidebar not injected');
} else {
  injectSidebar();
}

// ── Resolve paths relative to current page location ──────────────
// All paths use ../ navigation which works correctly from:
//   Authentication/  →  ../index.html, ../Dashboard/..., ../Messaging/...
//   Dashboard/       →  ../index.html, ./dashboard.html, ../Messaging/...
//   Messaging/       →  ../index.html, ../Dashboard/..., ./messaging.html
function resolvePaths() {
  const p    = window.location.pathname;
  const inAuth = p.includes('') || p.endsWith('/index.html') && !p.includes('/Dashboard/') && !p.includes('/Messaging/');
  const here = inAuth ? './' : '../Authentication/';

  return {
    home:          here + 'index.html',
    login:         here + 'login.html',
    signup:        here + 'signup.html',
    // These use ../ which resolves correctly from any subfolder
    messages:      '../Messaging/messaging.html',
    sell:          '../Dashboard/add_product.html',
    listings:      '../Dashboard/dashboard.html',
    notifications: '../Dashboard/notifications.html',
    profile:       '../Dashboard/profile.html',
    settings:      '../Dashboard/settings.html',
    wishlist:      '../Dashboard/wishlist.html',
  };
}

// ── Which link is "active" based on current path ─────────────────
function isActive(href) {
  return window.location.pathname.endsWith(href) ? 'active' : '';
}

// ── Inject sidebar into DOM ──────────────────────────────────────
async function injectSidebar() {
  const user  = await checkAuth();
  const paths = resolvePaths();

  // User info
  let userName   = '';
  let avatarHtml = '';
  let msgCount   = 0;
  let notifCount = 0;

  if (user) {
    const { data: profile } = await supabaseClient
      .from('profiles')
      .select('full_name, avatar_url')
      .eq('id', user.id)
      .maybeSingle();

    userName = profile?.full_name || user.email || '';
    const initials = getAvatarInitials(userName);

    avatarHtml = profile?.avatar_url
      ? `<img src="${profile.avatar_url}" alt="${initials}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
      : `<span>${initials}</span>`;

    // Unread counts (best-effort)
    try {
      const [{ count: m }, { count: n }] = await Promise.all([
        supabaseClient.from('conversations')
          .select('*', { count: 'exact', head: true })
          .or(`buyer_id.eq.${user.id},seller_id.eq.${user.id}`)
          .gt('unread_count', 0),
        supabaseClient.from('notifications')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .is('read_at', null),
      ]);
      msgCount   = m || 0;
      notifCount = n || 0;
    } catch { /* non-critical */ }
  }

  // ── Build sidebar HTML ─────────────────────────────────────────
  const sidebar = document.createElement('aside');
  sidebar.className = 'sidebar-nav';
  sidebar.id        = 'sidebarNav';
  sidebar.innerHTML = `

    <!-- Logo -->
    <a href="${paths.home}" class="sidebar-logo">
      <div class="logo-icon" style="width:38px;height:38px;flex-shrink:0"></div>
      <span class="sidebar-logo-text">Metups</span>
    </a>

    <!-- Search -->
    <div class="sidebar-search">
      <i class="fas fa-search sidebar-search-icon"></i>
      <input class="sidebar-search-input" type="text"
             placeholder="Search Metups…"
             id="sidebarSearchInput"
             autocomplete="off">
    </div>

    <!-- Nav links -->
    <nav class="sidebar-links">
      <a href="${paths.home}" class="sidebar-link ${isActive('index.html')}">
        <i class="fas fa-home"></i>
        <span>Browse</span>
      </a>

      <a href="${paths.messages}" class="sidebar-link ${isActive('messaging.html')}">
        <i class="fas fa-comment-dots"></i>
        <span>Messages</span>
        ${msgCount ? `<span class="sidebar-badge">${msgCount > 9 ? '9+' : msgCount}</span>` : ''}
      </a>

      ${user ? `
      <a href="${paths.sell}" class="sidebar-link sidebar-link-sell ${isActive('add_product.html')}">
        <i class="fas fa-plus-circle"></i>
        <span>Sell</span>
      </a>

      <a href="${paths.listings}" class="sidebar-link ${isActive('dashboard.html')}">
        <i class="fas fa-store"></i>
        <span>My Listings</span>
      </a>

      <a href="${paths.wishlist}" class="sidebar-link ${isActive('wishlist.html')}">
        <i class="fas fa-heart"></i>
        <span>Saved</span>
      </a>

      <a href="${paths.notifications}" class="sidebar-link ${isActive('notifications.html')}">
        <i class="fas fa-bell"></i>
        <span>Notifications</span>
        ${notifCount ? `<span class="sidebar-badge">${notifCount > 9 ? '9+' : notifCount}</span>` : ''}
      </a>
      ` : ''}
    </nav>

    <!-- Spacer -->
    <div style="flex:1"></div>

    <!-- Bottom: user info or login prompt -->
    ${user ? `
    <div class="sidebar-footer">
      <a href="${paths.profile}" class="sidebar-user">
        <div class="sidebar-user-avatar">${avatarHtml}</div>
        <div class="sidebar-user-info">
          <div class="sidebar-user-name">${escHtml(userName)}</div>
          <div class="sidebar-user-sub">View profile</div>
        </div>
      </a>
      <div style="display:flex;gap:6px;margin-top:10px">
        <a href="${paths.settings}" class="sidebar-icon-btn" title="Settings">
          <i class="fas fa-cog"></i>
        </a>
        <button class="sidebar-icon-btn" title="Log out" onclick="sidebarLogout()">
          <i class="fas fa-sign-out-alt"></i>
        </button>
      </div>
    </div>
    ` : `
    <div class="sidebar-footer">
      <a href="${paths.login}"  class="sidebar-link" style="margin-bottom:6px">
        <i class="fas fa-sign-in-alt"></i><span>Log In</span>
      </a>
      <a href="${paths.signup}" class="sidebar-link sidebar-link-sell">
        <i class="fas fa-user-plus"></i><span>Sign Up</span>
      </a>
    </div>
    `}
  `;

  // Insert at the very start of <body>
  document.body.insertBefore(sidebar, document.body.firstChild);

  // ── Search handler ──────────────────────────────────────────────
  document.getElementById('sidebarSearchInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const q = e.target.value.trim();
      if (q) window.location.href = `${paths.home}?q=${encodeURIComponent(q)}`;
    }
  });

  // ── Logout ─────────────────────────────────────────────────────
  window.sidebarLogout = async () => {
    if (!confirm('Log out?')) return;
    await supabaseClient.auth.signOut();
    localStorage.clear();
    window.location.href = paths.login;
  };
}

// ── Tiny HTML escaper ────────────────────────────────────────────
function escHtml(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}