/**
 * ================================================================
 * METUPS MARKETPLACE — WISHLIST MODULE
 * Dashboard/wishlist.js
 *
 * Two distinct concepts live in the wishlists table:
 *
 *   1. SAVED ITEMS   — product_id is set, user bookmarked a listing
 *   2. WANT ALERTS   — product_id is null, user described what they want
 *
 * Exports:
 *   toggleSaveProduct()     — save or unsave a product (heart button)
 *   isProductSaved()        — boolean check
 *   getSavedProductIds()    — Set<string> for fast heart rendering
 *   getSavedProducts()      — full product rows for saved items list
 *   createWantAlert()       — insert a want-alert row
 *   updateWantAlert()       — patch an existing want-alert
 *   deactivateWantAlert()   — set active = false (stop notifications)
 *   getWantAlerts()         — list all active want-alerts for current user
 *   checkWishlistMatches()  — (re-export from messaging module)
 * ================================================================
 */

import { supabaseClient } from '../Authentication/supabase.js';
import { checkAuth, handleError } from '../Authentication/utils.js';

// ================================================================
// SAVED ITEMS (product_id is set)
// ================================================================

/**
 * toggleSaveProduct()
 * Adds or removes a product from the user's saved list.
 * Redirects to login if the user is not authenticated.
 *
 * @param {string} productId
 * @returns {Promise<{ saved: boolean }>}  true = just saved, false = just unsaved
 */
export async function toggleSaveProduct(productId) {
  const user = await checkAuth();
  if (!user) {
    // Caller should show guest modal instead of hard redirect where possible
    throw new Error('NOT_AUTHENTICATED');
  }

  // Check existing
  const { data: existing } = await supabaseClient
    .from('wishlists')
    .select('id')
    .eq('user_id', user.id)
    .eq('product_id', productId)
    .maybeSingle();

  if (existing) {
    // ── Unsave ──
    const { error } = await supabaseClient
      .from('wishlists')
      .delete()
      .eq('id', existing.id);

    if (error) throw error;
    return { saved: false };
  }

  // ── Save ──
  const { error } = await supabaseClient
    .from('wishlists')
    .insert({
      user_id:    user.id,
      product_id: productId,
      active:     true,
    });

  if (error) throw error;
  return { saved: true };
}

/**
 * isProductSaved()
 * Returns true if the current user has saved this product.
 *
 * @param {string} productId
 * @returns {Promise<boolean>}
 */
export async function isProductSaved(productId) {
  const user = await checkAuth();
  if (!user) return false;

  const { data } = await supabaseClient
    .from('wishlists')
    .select('id')
    .eq('user_id', user.id)
    .eq('product_id', productId)
    .maybeSingle();

  return !!data;
}

/**
 * getSavedProductIds()
 * Returns a Set of product IDs saved by the current user.
 * Used for efficient heart-button rendering across a product grid.
 *
 * @returns {Promise<Set<string>>}
 */
export async function getSavedProductIds() {
  const user = await checkAuth();
  if (!user) return new Set();

  const { data } = await supabaseClient
    .from('wishlists')
    .select('product_id')
    .eq('user_id', user.id)
    .eq('active', true)
    .not('product_id', 'is', null);

  return new Set((data ?? []).map(r => r.product_id));
}

/**
 * getSavedProducts()
 * Returns full product rows for the current user's saved items.
 * Sorted newest-saved first.
 *
 * @returns {Promise<Array>}
 */
export async function getSavedProducts() {
  const user = await checkAuth();
  if (!user) return [];

  const { data, error } = await supabaseClient
    .from('wishlists')
    .select(`
      id,
      created_at,
      product:products(
        id, title, price, condition, location, category, sold,
        product_images(image_url, image_order)
      )
    `)
    .eq('user_id', user.id)
    .eq('active', true)
    .not('product_id', 'is', null)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[getSavedProducts]', error);
    return [];
  }

  // Flatten — skip rows where the product was deleted
  return (data ?? []).filter(r => r.product).map(r => ({
    wishlistId: r.id,
    savedAt:    r.created_at,
    ...r.product,
  }));
}

// ================================================================
// WANT ALERTS (product_id is null)
// ================================================================

/**
 * createWantAlert()
 * Inserts a new want-alert (a wish for an item not yet listed).
 *
 * @param {{ title, description?, max_price?, category?, condition?, location?, shipping_ok? }} alertData
 * @returns {Promise<{ id: string }>}  the new row
 */
export async function createWantAlert(alertData) {
  const user = await checkAuth();
  if (!user) throw new Error('Not authenticated.');

  const { data, error } = await supabaseClient
    .from('wishlists')
    .insert({
      ...alertData,
      user_id:    user.id,
      product_id: null,    // mark as want-alert, not a saved product
      active:     true,
    })
    .select('id')
    .single();

  if (error) throw error;
  return data;
}

/**
 * updateWantAlert()
 * Updates an existing want-alert the user owns.
 *
 * @param {string} alertId
 * @param {Object} updates  — partial fields to update
 * @returns {Promise<void>}
 */
export async function updateWantAlert(alertId, updates) {
  const user = await checkAuth();
  if (!user) throw new Error('Not authenticated.');

  const { error } = await supabaseClient
    .from('wishlists')
    .update(updates)
    .eq('id', alertId)
    .eq('user_id', user.id);

  if (error) throw error;
}

/**
 * deactivateWantAlert()
 * Stops notifications for a want-alert (soft-disables it).
 *
 * @param {string} alertId
 * @returns {Promise<void>}
 */
export async function deactivateWantAlert(alertId) {
  const user = await checkAuth();
  if (!user) throw new Error('Not authenticated.');

  const { error } = await supabaseClient
    .from('wishlists')
    .update({ active: false })
    .eq('id', alertId)
    .eq('user_id', user.id);

  if (error) throw error;
}

/**
 * getWantAlerts()
 * Returns all active want-alerts for the current user.
 *
 * @returns {Promise<Array>}
 */
export async function getWantAlerts() {
  const user = await checkAuth();
  if (!user) return [];

  const { data, error } = await supabaseClient
    .from('wishlists')
    .select('*')
    .eq('user_id', user.id)
    .is('product_id', null)
    .eq('active', true)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('[getWantAlerts]', error);
    return [];
  }
  return data ?? [];
}

// ================================================================
// MATCH CHECKING
// ================================================================

/**
 * checkWishlistMatches()
 * Re-exported from the messaging module for convenience.
 * Called inside add_product.html after a new listing is created.
 *
 * @param {Object} newProduct  — product row just inserted
 */
export async function checkWishlistMatches(newProduct) {
  // Lazy import to avoid a circular dependency
  const { checkWishlistMatches: check } = await import('../Messaging/messaging.js');
  return check(newProduct);
}

// ================================================================
// WINDOW GLOBALS
// ================================================================
window.toggleSaveProduct   = toggleSaveProduct;
window.deactivateWantAlert = deactivateWantAlert;