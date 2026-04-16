/**
 * ================================================================
 * METUPS MARKETPLACE — SUPABASE CLIENT
 * Authentication/supabase.js
 *
 * Single source-of-truth for the Supabase client instance.
 * Import { supabaseClient } wherever you need DB / Auth / Storage.
 *
 * HOW TO FIND YOUR CREDENTIALS
 * ─────────────────────────────
 * 1. Go to https://app.supabase.com
 * 2. Open your project → Settings → API
 * 3. Copy "Project URL"  →  paste as SUPABASE_URL below
 * 4. Copy "anon public"  →  paste as SUPABASE_ANON_KEY below
 * ================================================================
 */

// ── Credentials ──────────────────────────────────────────────────
const SUPABASE_URL      = 'https://cnmmdxmbdlrvvtvqqjpa.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNubW1keG1iZGxydnZ0dnFxanBhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTg5NjkzMDQsImV4cCI6MjA3NDU0NTMwNH0.iHPsWJQvPlZEO4gvxqijP0T-4zsJADlp4XZx_ADw1Cs';

// ── Guard: the Supabase CDN script must be loaded before this module ──
if (typeof supabase === 'undefined') {
  throw new Error(
    '[Metups] Supabase JS library not found.\n' +
    'Make sure you have this <script> tag BEFORE your module script:\n' +
    '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>'
  );
}

// ── Create the singleton client ───────────────────────────────────
export const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    /**
     * persistSession: true  → stores the JWT in localStorage so the user
     * stays logged in across page reloads and browser restarts.
     */
    persistSession:    true,
    autoRefreshToken:  true,
    detectSessionInUrl: true,
  },
});

// ── Named exports for convenience ────────────────────────────────
export { SUPABASE_URL, SUPABASE_ANON_KEY };

/**
 * testConnection()
 * Quick sanity-check you can run from the browser console:
 *
 *   import { testConnection } from './supabase.js';
 *   testConnection().then(console.log);
 */
export async function testConnection() {
  try {
    const { count, error } = await supabaseClient
      .from('products')
      .select('*', { count: 'exact', head: true });

    if (error) {
      console.error('❌ DB connection failed:', error.message);
      return { ok: false, error: error.message };
    }

    //console.log(`✅ Connected — ${count} products in DB`);
    return { ok: true, count };
  } catch (err) {
    console.error('❌ Unexpected error:', err);
    return { ok: false, error: err.message };
  }
}