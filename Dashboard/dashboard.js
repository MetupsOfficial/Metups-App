/**
 * ================================================================
 * METUPS MARKETPLACE — DASHBOARD MODULE
 * Dashboard/dashboard.js
 *
 * Drives the "My Listings" dashboard page.
 * All functions are also exposed on window so the HTML
 * can call them from inline onclick attributes.
 *
 * Exports:
 *   loadMyListings()   — fetch + render seller's products
 *   editProduct()      — redirect to add_product.html in edit mode
 *   deleteProduct()    — soft-delete with confirmation
 *   markAsSold()       — mark a listing sold with confirmation
 * ================================================================
 */

import { supabaseClient } from '../Authentication/supabase.js';

// Change this one constant if you rename the storage bucket.
const IMAGES_BUCKET = 'product_images';
import {
  checkAuth,
  handleError,
  formatCurrency,
  getCategoryIcon,
  getConditionClass,
  escHtml,
} from '../Authentication/utils.js';

// ================================================================
// LOAD LISTINGS
// ================================================================

/**
 * loadMyListings()
 * Fetches all active products for the signed-in seller and renders
 * them as listing cards inside #myProducts.
 * Also computes summary stats (active / sold / revenue).
 */
export async function loadMyListings() {
  const user = await checkAuth();
  if (!user) {
    window.location.href = '../Authentication/login.html';
    return;
  }

  const container = document.getElementById('myProducts');
  const statsBar  = document.getElementById('statsBar');

  if (!container) return;

  // ── Loading skeleton ──
  container.innerHTML = [1, 2, 3].map(() => `
    <div class="listing-item">
      <div class="skeleton listing-thumb"></div>
      <div class="listing-info">
        <div class="skeleton" style="height:13px;width:68%;margin-bottom:6px"></div>
        <div class="skeleton" style="height:11px;width:45%;margin-bottom:6px"></div>
        <div class="skeleton" style="height:11px;width:28%"></div>
      </div>
    </div>
  `).join('');

  try {
    const { data: products, error } = await supabaseClient
      .from('products')
      .select('*, product_images(image_url, image_order)')
      .eq('seller_id', user.id)
      .eq('is_active', true)
      .order('created_at', { ascending: false });

    if (error) throw error;

    // ── Stats ──
    if (statsBar) {
      const total   = products?.length ?? 0;
      const sold    = products?.filter(p => p.sold).length ?? 0;
      const active  = total - sold;
      const revenue = products
        ?.filter(p => p.sold)
        .reduce((s, p) => s + parseFloat(p.sold_price ?? p.price ?? 0), 0) ?? 0;

      statsBar.innerHTML = [
        { label: 'Active',  value: active,                  color: 'var(--green)' },
        { label: 'Sold',    value: sold,                    color: 'var(--blue)'  },
        { label: 'Revenue', value: formatCurrency(revenue), color: 'var(--orange)'},
      ].map(s => `
        <div class="stat-cell">
          <div class="stat-value" style="color:${s.color}">${s.value}</div>
          <div class="stat-label">${s.label}</div>
        </div>
      `).join('');
    }

    // ── Empty state ──
    if (!products?.length) {
      container.innerHTML = `
        <div class="empty-state">
          <i class="fas fa-store-alt-slash"></i>
          <h3>No listings yet</h3>
          <p>List your first item and start selling!</p>
          <a href="./add_product.html" class="btn btn-primary" style="margin-top:16px">
            <i class="fas fa-plus"></i> Add Listing
          </a>
        </div>
      `;
      return;
    }

    // ── Render listing items ──
    container.innerHTML = products.map(p => {
      const imgs = (p.product_images ?? [])
        .sort((a, b) => (a.image_order ?? 0) - (b.image_order ?? 0));
      // image_url stores a storage path — reconstruct the full public URL
      const _rawImg = imgs[0]?.image_url ?? null;
      const img = _rawImg
        ? supabaseClient.storage.from(IMAGES_BUCKET).getPublicUrl(_rawImg).data.publicUrl
        : null;
      const icon = getCategoryIcon(p.category);

      return `
        <div class="listing-item" onclick="window.location.href='./product.html?id=${p.id}'">

          <!-- Thumbnail -->
          <div class="listing-thumb">
            ${img
              ? `<img src="${escHtml(img)}" alt="${escHtml(p.title)}"
                     onerror="this.parentElement.innerHTML='<i class=\\'fas fa-${icon} listing-icon\\'></i>'">`
              : `<i class="fas fa-${icon} listing-icon"></i>`
            }
          </div>

          <!-- Info -->
          <div class="listing-info">
            <div class="listing-title">${escHtml(p.title)}</div>
            <div class="listing-meta">
              ${escHtml(p.location ?? '')} &nbsp;·&nbsp; ${escHtml(p.condition ?? '')}
            </div>
            <div class="listing-price">${formatCurrency(p.price)}</div>
            <div class="listing-actions" onclick="event.stopPropagation()">
              ${p.sold
                ? '<span class="badge-sold">SOLD</span>'
                : `<button class="badge-edit" onclick="markAsSold('${p.id}')">Mark Sold</button>`
              }
              <button class="btn btn-sm btn-outline"
                      style="padding:3px 10px;font-size:.7rem"
                      onclick="editProduct('${p.id}')">
                <i class="fas fa-pen"></i> Edit
              </button>
              <button class="btn btn-sm btn-danger"
                      style="padding:3px 10px;font-size:.7rem"
                      onclick="deleteProduct('${p.id}')">
                <i class="fas fa-trash"></i>
              </button>
            </div>
          </div>

          <!-- Views -->
          <div style="text-align:right;flex-shrink:0;font-size:.68rem;color:var(--text-muted)">
            <i class="fas fa-eye" style="color:var(--teal-dark)"></i>
            <div>${p.views_count ?? 0}</div>
            <div style="margin-top:4px;font-size:.6rem;color:${p.sold ? 'var(--green)' : 'var(--text-muted)'}">
              ${p.sold ? 'SOLD' : 'Active'}
            </div>
          </div>

        </div>
      `;
    }).join('');

  } catch (err) {
    console.error('[loadMyListings]', err);
    container.innerHTML = `
      <div class="empty-state">
        <i class="fas fa-exclamation-triangle" style="color:var(--red)"></i>
        <h3>Couldn't load listings</h3>
        <p>${escHtml(handleError(err))}</p>
      </div>
    `;
  }
}

// ================================================================
// ACTIONS
// ================================================================

/**
 * editProduct()
 * Redirects to add_product.html in edit mode with ?edit=<id>
 *
 * @param {string} productId
 */
export async function editProduct(productId) {
  window.location.href = `./add_product.html?edit=${productId}`;
}

/**
 * deleteProduct()
 * Soft-deletes a product after confirmation.
 * Sets is_active = false so the row stays for audit history.
 *
 * @param {string} productId
 */
export async function deleteProduct(productId) {
  if (!confirm('Delete this listing? It will no longer appear in search results.')) return;

  try {
    const user = await checkAuth();
    if (!user) return;

    const { error } = await supabaseClient
      .from('products')
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq('id', productId)
      .eq('seller_id', user.id);

    if (error) throw error;

    showToast('Listing deleted.');
    await loadMyListings();

  } catch (err) {
    alert('Error deleting listing: ' + handleError(err));
  }
}

/**
 * markAsSold()
 * Marks a product as sold after confirmation.
 *
 * @param {string} productId
 */
export async function markAsSold(productId) {
  if (!confirm('Mark this item as SOLD?')) return;

  try {
    const user = await checkAuth();
    if (!user) return;

    const { error } = await supabaseClient
      .from('products')
      .update({
        sold:        true,
        sold_at:     new Date().toISOString(),
        updated_at:  new Date().toISOString(),
      })
      .eq('id', productId)
      .eq('seller_id', user.id);

    if (error) throw error;

    showToast('✅ Listing marked as sold!');
    await loadMyListings();

  } catch (err) {
    alert('Error marking as sold: ' + handleError(err));
  }
}

// ================================================================
// TOAST
// ================================================================

let toastTimer;

/**
 * showToast()
 * Shows a brief toast notification at the bottom of the screen.
 *
 * @param {string} message
 * @param {number} [duration=2800]
 */
function showToast(message, duration = 2800) {
  let toast = document.getElementById('dashToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'dashToast';
    toast.style.cssText = `
      position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
      background:var(--text);color:#fff;padding:10px 18px;
      border-radius:var(--radius-pill);font-size:.84rem;
      box-shadow:var(--shadow-lg);z-index:500;
      white-space:nowrap;max-width:90vw;text-align:center;
      animation:toastFadeIn .2s ease;
    `;
    document.body.appendChild(toast);

    const style = document.createElement('style');
    style.textContent = `
      @keyframes toastFadeIn { from { opacity:0; transform:translateX(-50%) translateY(8px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }
    `;
    document.head.appendChild(style);
  }

  toast.textContent    = message;
  toast.style.display  = 'block';
  toast.style.opacity  = '1';

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity .3s';
    setTimeout(() => { toast.style.display = 'none'; }, 300);
  }, duration);
}

// ================================================================
// WINDOW GLOBALS
// ================================================================
window.loadMyListings = loadMyListings;
window.editProduct    = editProduct;
window.deleteProduct  = deleteProduct;
window.markAsSold     = markAsSold;

// ================================================================
// AUTO-INIT
// ================================================================
document.addEventListener('DOMContentLoaded', () => {
  // Only auto-run on the dashboard page
  if (document.getElementById('myProducts')) {
    loadMyListings();
  }
});