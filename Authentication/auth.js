/**
 * ================================================================
 * METUPS MARKETPLACE — AUTH MODULE
 * Authentication/auth.js
 *
 * Handles:
 *   • Email/password signup with automatic profile creation
 *   • Email/password login
 *   • Email OTP confirmation (verify token)
 *   • OAuth (Google, Facebook)
 *   • Logout
 *   • updateAuthUI()  — refreshes navbar based on session state
 *   • sendNotification() — proxied email / SMS via Edge Functions
 * ================================================================
 */

import { supabaseClient, SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase.js';
import {
  checkAuth,
  handleError,
  isValidEmail,
  isValidPassword,
  getAvatarInitials,
  showAlert,
} from './utils.js';

// ── Edge Function base URL ──────────────────────────────────────────
// Functions are hosted on Supabase, not your app domain.
// Using the full URL means this works whether your app is on
// Netlify, Vercel, or any other host.
const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;

// ================================================================
// SIGNUP
// ================================================================

/**
 * handleSignup()
 * Called by the signup form's submit event.
 * Creates the auth user then upserts a matching profile row.
 *
 * @param {SubmitEvent} e
 */
export async function handleSignup(e) {
  e.preventDefault();

  const fullName = document.getElementById('fullName')?.value.trim() || '';
  const email    = document.getElementById('email').value.trim().toLowerCase();
  const password = document.getElementById('password').value;
  const location = document.getElementById('location')?.value.trim() || null;
  const msgDiv   = document.getElementById('authMessage');
  const btn      = e.target.querySelector('button[type="submit"]');

  // ── Validate ──
  if (fullName && fullName.length < 2) {
    showAlert(msgDiv, 'Please enter your full name.', 'error'); return;
  }
  if (!isValidEmail(email)) {
    showAlert(msgDiv, 'Please enter a valid email address.', 'error'); return;
  }
  if (!isValidPassword(password)) {
    showAlert(msgDiv, 'Password must be at least 8 characters long.', 'error'); return;
  }

  // ── Loading state ──
  setButtonLoading(btn, 'Creating account…');

  // ── Create auth user ──
  const { data, error } = await supabaseClient.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: fullName || email.split('@')[0] },
    },
  });

  if (error) {
    resetButton(btn, '<i class="fas fa-user-plus"></i> Create Account');
    const msg = error.message.includes('already registered')
      ? 'An account with this email already exists. Try logging in.'
      : handleError(error, 'Signup');
    showAlert(msgDiv, msg, 'error');
    return;
  }

  // ── Upsert profile (trigger also creates one, this adds extra fields) ──
  if (data?.user) {
    await supabaseClient.from('profiles').upsert({
      id:        data.user.id,
      email,
      full_name: fullName || email.split('@')[0],
      location:  location || null,
    }, { onConflict: 'id' });
  }

  // ── Store email for confirm page ──
  localStorage.setItem('signupEmail', email);

  showAlert(msgDiv, '✅ Account created! Check your email for a confirmation code.', 'success');
  resetButton(btn, '✅ Account Created');

  // Redirect to confirmation page after short delay
  setTimeout(() => {
    window.location.href = `./confirm.html?email=${encodeURIComponent(email)}`;
  }, 1800);
}

// ================================================================
// LOGIN
// ================================================================

/**
 * handleLogin()
 * Called by the login form's submit event.
 *
 * @param {SubmitEvent} e
 */
export async function handleLogin(e) {
  e.preventDefault();

  const email    = document.getElementById('email').value.trim().toLowerCase();
  const password = document.getElementById('password').value;
  const msgDiv   = document.getElementById('authMessage');
  const btn      = e.target.querySelector('button[type="submit"]');

  // ── Validate ──
  if (!isValidEmail(email)) {
    showAlert(msgDiv, 'Please enter a valid email address.', 'error'); return;
  }
  if (!isValidPassword(password)) {
    showAlert(msgDiv, 'Password must be at least 8 characters.', 'error'); return;
  }

  setButtonLoading(btn, 'Signing in…');

  const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password });

  if (error) {
    resetButton(btn, '<i class="fas fa-sign-in-alt"></i> Log In');
    const msg = error.message.includes('Invalid login credentials')
      ? 'Incorrect email or password. Please try again.'
      : error.message.includes('Email not confirmed')
        ? 'Please confirm your email first. Check your inbox.'
        : handleError(error, 'Login');
    showAlert(msgDiv, msg, 'error');
    return;
  }

  // Update last_seen_at (fire-and-forget)
  supabaseClient
    .from('profiles')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', data.user.id)
    .then(() => {});

  showAlert(msgDiv, '✅ Welcome back! Redirecting…', 'success');
  resetButton(btn, '✅ Logged In');

  setTimeout(() => { window.location.href = '../index.html'; }, 1200);
}

// ================================================================
// EMAIL OTP CONFIRMATION
// ================================================================

/**
 * handleConfirmation()
 * Verifies the 6-digit OTP entered on confirm.html.
 *
 * @param {SubmitEvent} e
 */
export async function handleConfirmation(e) {
  e?.preventDefault();

  const email   = document.getElementById('email')?.value.trim();
  const codeEl  = document.getElementById('confirmationCode');
  const code    = codeEl?.value.trim();
  const msgDiv  = document.getElementById('authMessage');
  const btn     = document.getElementById('confirmBtn');

  if (!email || !isValidEmail(email)) {
    showAlert(msgDiv, 'Invalid email.', 'error'); return;
  }
  if (!code || code.length !== 6) {
    showAlert(msgDiv, 'Enter the full 6-digit code.', 'error'); return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Verifying…'; }

  const { error } = await supabaseClient.auth.verifyOtp({
    email,
    token: code,
    type:  'signup',
  });

  if (error) {
    if (btn) { btn.disabled = false; btn.textContent = 'Confirm Account'; }
    const msg = error.message.includes('expired')
      ? 'Code expired — request a new one.'
      : 'Invalid code. Please try again.';
    showAlert(msgDiv, msg, 'error');
    return;
  }

  localStorage.removeItem('signupEmail');
  showAlert(msgDiv, '✅ Account confirmed! Redirecting…', 'success');
  setTimeout(() => { window.location.href = '../index.html'; }, 1500);
}

/**
 * handleResendCode()
 * Re-sends the signup OTP email.
 */
export async function handleResendCode() {
  const email  = document.getElementById('email')?.value.trim();
  const msgDiv = document.getElementById('authMessage');

  if (!email || !isValidEmail(email)) {
    showAlert(msgDiv, 'No valid email found.', 'error'); return;
  }

  const { error } = await supabaseClient.auth.resend({ type: 'signup', email });

  if (error) {
    showAlert(msgDiv, handleError(error, 'Resend'), 'error');
  } else {
    showAlert(msgDiv, 'New code sent! Check your inbox.', 'success');
  }
}

// ================================================================
// OAUTH — SOCIAL LOGIN
// ================================================================

/**
 * signInWithProvider()
 * Opens the OAuth flow for Google, Facebook, etc.
 * Exposed to window so it can be called from inline onclick attributes.
 *
 * @param {'google'|'facebook'|'twitter'|'linkedin'} provider
 */
export async function signInWithProvider(provider) {
  const { error } = await supabaseClient.auth.signInWithOAuth({
    provider,
    options: {
      redirectTo: `${window.location.origin}/index.html`,
    },
  });
  if (error) {
    const msgDiv = document.getElementById('authMessage');
    if (msgDiv) showAlert(msgDiv, handleError(error, 'OAuth'), 'error');
  }
}

window.signInWithProvider = signInWithProvider;

// ================================================================
// LOGOUT
// ================================================================

/**
 * handleLogout()
 * Signs out and clears local storage.
 * Exported AND attached to window for inline onclick use.
 */
export async function handleLogout() {
  try {
    await supabaseClient.auth.signOut();
  } catch { /* ignore */ }
  localStorage.clear();
  window.location.href = '../index.html';
}

window.handleLogout         = handleLogout;
window.handleLogoutFromNavbar = handleLogout;   // legacy alias used in older nav HTML

// ================================================================
// NAVBAR UI
// ================================================================

/**
 * updateAuthUI()
 * Reads the current session and injects auth-aware nav buttons.
 * Call once on DOMContentLoaded for pages that share a nav.
 *
 * Looks for:
 *   <div id="authButtons"></div>  in the navbar
 */
export async function updateAuthUI() {
  const user       = await checkAuth();
  const authButtons = document.getElementById('authButtons');
  if (!authButtons) return;

  if (user) {
    // Load profile for name + avatar
    const { data: profile } = await supabaseClient
      .from('profiles')
      .select('full_name, avatar_url')
      .eq('id', user.id)
      .maybeSingle();

    const name     = profile?.full_name || user.email;
    const initials = getAvatarInitials(name);
    const avatarHtml = profile?.avatar_url
      ? `<img src="${profile.avatar_url}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
      : initials;

    // Unread counts (best-effort — don't block UI)
    let msgCount   = 0;
    let notifCount = 0;
    try {
      const [{ count: m }, { count: n }] = await Promise.all([
        supabaseClient
          .from('conversations')
          .select('*', { count: 'exact', head: true })
          .or(`buyer_id.eq.${user.id},seller_id.eq.${user.id}`)
          .gt('unread_count', 0),
        supabaseClient
          .from('notifications')
          .select('*', { count: 'exact', head: true })
          .eq('user_id', user.id)
          .is('read_at', null),
      ]);
      msgCount   = m || 0;
      notifCount = n || 0;
    } catch { /* non-critical */ }

    authButtons.innerHTML = `
      <div class="user-info" style="display:flex;align-items:center;gap:8px">
        <a href="../Dashboard/dashboard.html"    class="btn btn-outline btn-sm">
          <i class="fas fa-store"></i> Listings
        </a>
        <a href="../Messaging/messaging.html"    class="btn btn-outline btn-sm" style="position:relative">
          <i class="fas fa-comment-dots"></i> Messages
          ${msgCount ? `<span class="nav-badge" style="position:static;margin-left:2px">${msgCount > 9 ? '9+' : msgCount}</span>` : ''}
        </a>
        <a href="../Dashboard/notifications.html" class="btn btn-outline btn-sm" style="position:relative">
          <i class="fas fa-bell"></i>
          ${notifCount ? `<span class="nav-badge" style="position:static;margin-left:2px">${notifCount > 9 ? '9+' : notifCount}</span>` : ''}
        </a>
        <a href="../Dashboard/menu.html" class="nav-avatar" style="cursor:pointer">${avatarHtml}</a>
      </div>
    `;
  } else {
    authButtons.innerHTML = `
      <div style="display:flex;gap:6px">
        <a href="./login.html"  class="btn btn-outline btn-sm">Log in</a>
        <a href="./signup.html" class="btn btn-blue   btn-sm">Sign up</a>
      </div>
    `;
  }
}

// ================================================================
// NOTIFICATIONS — proxy via Edge Functions
// ================================================================

/**
 * sendNotification()
 * Sends an email and/or SMS notification to a user via Supabase Edge Functions.
 * Respects the user's notification_preferences from their profile.
 *
 * @param {string} userId
 * @param {{ subject: string, message: string, actionUrl: string }} notifData
 * @param {{ email?: boolean, sms?: boolean }} options
 */
export async function sendNotification(userId, notifData, options = {}) {
  if (!userId) return;

  const { subject, message, actionUrl } = notifData;
  const { email: wantEmail = true, sms: wantSms = false } = options;

  try {
    const { data: profile } = await supabaseClient
      .from('profiles')
      .select('email, phone, notification_preferences')
      .eq('id', userId)
      .maybeSingle();

    if (!profile) return;

    const prefs = profile.notification_preferences || { email: true, sms: false };
    const tasks = [];

    // ── Email ──
    if (wantEmail && prefs.email !== false && profile.email) {
      tasks.push(
        fetch(`${FUNCTIONS_URL}/send-email`, {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          },
          body: JSON.stringify({ to: profile.email, subject, message, actionUrl }),
        })
      );
    }

    // ── SMS ──
    if (wantSms && prefs.sms === true && profile.phone) {
      tasks.push(
        fetch(`${FUNCTIONS_URL}/send-sms`, {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          },
          body: JSON.stringify({ to: profile.phone, message: `${message}\n${actionUrl}` }),
        })
      );
    }

    await Promise.allSettled(tasks);
  } catch (err) {
    console.error('[sendNotification]', err);
  }
}

// ================================================================
// FORM INITIALISER
// ================================================================

/**
 * initAuthForms()
 * Attaches submit handlers to whichever auth forms exist on the page.
 * Called automatically on DOMContentLoaded.
 */
function initAuthForms() {
  document.getElementById('loginForm')  ?.addEventListener('submit', handleLogin);
  document.getElementById('signupForm') ?.addEventListener('submit', handleSignup);
  document.getElementById('confirmForm')?.addEventListener('submit', handleConfirmation);
  document.getElementById('resendCode') ?.addEventListener('click',  handleResendCode);
}

document.addEventListener('DOMContentLoaded', () => {
  initAuthForms();

  // Only run updateAuthUI on non-auth pages (avoids flash on login/signup)
  const path = window.location.pathname;
  const isAuthPage = /\/(login|signup|confirm)\.html/.test(path);
  if (!isAuthPage) updateAuthUI();
});

// Named exports for tree-shaking / explicit imports
export { handleLogin, handleSignup };