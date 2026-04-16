/**
 * ================================================================
 * METUPS MARKETPLACE — SHARED UTILITIES
 * Authentication/utils.js
 *
 * Pure helper functions used by every page.
 * No DOM interaction here — just data manipulation, formatting
 * and auth checks so every module stays lean.
 * ================================================================
 */

import { supabaseClient } from './supabase.js';

// ================================================================
// AUTH
// ================================================================

/**
 * checkAuth()
 * Returns the currently signed-in Supabase user, or null.
 * Uses getUser() (hits the server) so the session is always fresh.
 *
 * @returns {Promise<User|null>}
 *
 * @example
 *   const user = await checkAuth();
 *   if (!user) window.location.href = '/login.html';
 */
export async function checkAuth() {
  try {
    const { data: { user }, error } = await supabaseClient.auth.getUser();
    if (error) {
      // PGRST / auth errors are normal when logged out — don't clutter console
      if (!error.message?.includes('Auth session missing')) {
        console.warn('[checkAuth]', error.message);
      }
      return null;
    }
    return user ?? null;
  } catch (err) {
    console.warn('[checkAuth] unexpected error:', err);
    return null;
  }
}

//Avoid calling the same auth check multiple times in parallel (e.g. on multiple page components) by caching the promise and result.
let currentUser = null;
let authPromise = null;

export async function getCurrentUser() {
  if (currentUser) return currentUser;

  // Prevent parallel calls
  if (!authPromise) {
    authPromise = supabase.auth.getUser().then(({ data, error }) => {
      if (error) throw error;
      currentUser = data.user;
      return currentUser;
    });
  }

  return authPromise;
}


/**
 * isCurrentUserSeller()
 * Returns true if the signed-in user owns a given seller ID.
 *
 * @param {string} sellerId  — UUID from the products table
 * @returns {Promise<boolean>}
 */
export async function isCurrentUserSeller(sellerId) {
  const user = await checkAuth();
  return !!(user && user.id === sellerId);
}

// ================================================================
// FORMATTING
// ================================================================

/**
 * formatCurrency()
 * Formats a number as a localised USD string.
 * Falls back to "$0.00" for invalid input.
 *
 * @param {number} amount
 * @returns {string}  e.g. "$25.99"
 */
export function formatCurrency(amount) {
  const n = parseFloat(amount);
  if (isNaN(n)) return '$0.00';
  return new Intl.NumberFormat('en-US', {
    style:                 'currency',
    currency:              'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n);
}

/**
 * formatDate()
 * Converts an ISO date string or Date object to a human-readable date.
 *
 * @param {string|Date} date
 * @returns {string}  e.g. "Jan 15, 2025"
 */
export function formatDate(date) {
  if (!date) return '';
  const d = typeof date === 'string' ? new Date(date) : date;
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * timeAgo()
 * Returns a compact "time ago" string for a timestamp.
 *
 * @param {string|Date} dateStr
 * @returns {string}  e.g. "3m ago", "2h ago", "5d ago"
 */
export function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1)   return 'Just now';
  if (mins < 60)  return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs  < 24)  return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30)  return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/**
 * truncateText()
 * Shortens a string to maxLength chars, appending "…" if cut.
 *
 * @param {string} text
 * @param {number} [maxLength=100]
 * @returns {string}
 */
export function truncateText(text, maxLength = 100) {
  if (!text || typeof text !== 'string') return '';
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength).trimEnd() + '…';
}

// ================================================================
// USER INTERFACE HELPERS
// ================================================================

/**
 * getAvatarInitials()
 * Returns up to 2 uppercase initials from a full name.
 * Falls back to the first 2 chars of an email if name is empty.
 *
 * @param {string} fullName
 * @returns {string}  e.g. "JD"
 */
export function getAvatarInitials(fullName) {
  if (!fullName || typeof fullName !== 'string') return '??';
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '??';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * getCategoryIcon()
 * Maps a product category string to a Font Awesome icon name.
 *
 * @param {string} category
 * @returns {string}  FA icon name without the "fa-" prefix
 */
export function getCategoryIcon(category) {
  const map = {
    Electronics: 'laptop',
    Fashion:     'tshirt',
    Furniture:   'couch',
    Appliances:  'blender',
    Vehicles:    'car',
    Books:       'book',
    Other:       'box',
  };
  return map[category] || 'shopping-bag';
}

/**
 * getConditionClass()
 * Maps a product condition string to a CSS class name.
 *
 * @param {string} condition
 * @returns {string}  CSS class
 */
export function getConditionClass(condition) {
  const map = {
    'New':          'condition-new',
    'Like-New':     'condition-like-new',
    'Fair':         'condition-fair',
    'Needs Repair': 'condition-needs-repair',
  };
  return map[condition] || 'condition-fair';
}

// ================================================================
// VALIDATION
// ================================================================

/**
 * isValidEmail()
 * @param {string} email
 * @returns {boolean}
 */
export function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

/**
 * isValidPassword()
 * Minimum 8 characters.
 *
 * @param {string} password
 * @returns {boolean}
 */
export function isValidPassword(password) {
  return typeof password === 'string' && password.length >= 8;
}

// ================================================================
// ERROR HANDLING
// ================================================================

/**
 * handleError()
 * Extracts a user-friendly message from a Supabase error or generic Error.
 * Also logs to console with optional context label.
 *
 * @param {Error|Object} error
 * @param {string}       [context='']  — label printed in console
 * @returns {string}  Human-readable message
 */
export function handleError(error, context = '') {
  if (!error) return 'An unknown error occurred.';

  const prefix = context ? `[${context}] ` : '';
  console.error(prefix, error);

  // ── Supabase / PostgREST error shapes ────────────────────────────
  if (typeof error === 'object' && error !== null) {
    if (error.message)           return error.message;
    if (error.error_description) return error.error_description;
    if (error.msg)               return error.msg;
    if (error.details)           return error.details;
    // Stringify non-empty objects so they aren't shown as [object Object]
    try {
      const str = JSON.stringify(error);
      if (str && str !== '{}' && str !== 'null') return `Error: ${str}`;
    } catch { /* ignore circular refs */ }
  }

  if (typeof error === 'string' && error.trim()) return error;

  return 'An unexpected error occurred. Please try again.';
}

// ================================================================
// PERFORMANCE
// ================================================================

/**
 * debounce()
 * Returns a debounced version of fn that fires after `wait` ms of silence.
 * Useful for search inputs.
 *
 * @param {Function} fn
 * @param {number}   wait  — milliseconds
 * @returns {Function}
 *
 * @example
 *   const onSearch = debounce(loadProducts, 350);
 *   input.addEventListener('input', e => onSearch(e.target.value));
 */
export function debounce(fn, wait = 300) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), wait);
  };
}

/**
 * sleep()
 * Promise-based delay. Handy for rate-limiting retries.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ================================================================
// DOM HELPERS
// ================================================================

/**
 * escHtml()
 * Escapes a string for safe insertion into innerHTML.
 *
 * @param {string} str
 * @returns {string}
 */
export function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * showAlert()
 * Injects an alert div into a container element.
 * Auto-clears success messages after 3 seconds.
 *
 * @param {HTMLElement} container
 * @param {string}      message
 * @param {'error'|'success'|'info'|'warning'} type
 */
export function showAlert(container, message, type = 'info') {
  if (!container) return;
  container.innerHTML = `<div class="alert alert-${type}">${escHtml(message)}</div>`;
  if (type === 'success') {
    setTimeout(() => { if (container) container.innerHTML = ''; }, 3500);
  }
}

// ================================================================
// DEFAULT EXPORT (convenience — named imports are preferred)
// ================================================================
export default {
  checkAuth,
  isCurrentUserSeller,
  formatCurrency,
  formatDate,
  timeAgo,
  truncateText,
  getAvatarInitials,
  getCategoryIcon,
  getConditionClass,
  isValidEmail,
  isValidPassword,
  handleError,
  debounce,
  sleep,
  escHtml,
  showAlert,
  getCurrentUser,
};