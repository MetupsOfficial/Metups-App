/**
 * ================================================================
 * METUPS MARKETPLACE — PRODUCTS MODULE
 * Dashboard/products.js
 *
 * Exports:
 *   getProductImage()     — first image URL for a product
 *   getProductImages()    — all image URLs for a product
 *   uploadProduct()       — insert product + upload images atomically
 *   getFilteredProducts() — fetch with optional search / filter / sort
 *   getProductById()      — single product with seller profile
 *   getUserProducts()     — all products belonging to current user
 *   updateProduct()       — patch a product row (owner only)
 *   deleteProduct()       — soft-delete (sets is_active = false)
 *   markProductSold()     — stamp sold + sold_price + sold_to_id
 *   displayProducts()     — render a product grid into a DOM container
 *   getIconForCategory()  — FA icon name for a category string
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
  getAvatarInitials,
  escHtml,
} from '../Authentication/utils.js';

// ================================================================
// IMAGE HELPERS
// ================================================================

/**
 * getProductImage()
 * Returns the URL of the first (cover) image for a product.
 * image_url stores the STORAGE PATH (e.g. users/uid/pid/file.jpg).
 * Call getPublicUrl(image_url) at display time to get the full https:// URL.
 *
 * @param {string} productId
 * @returns {Promise<string|null>}
 */
export async function getProductImage(productId) {
  const { data } = await supabaseClient
    .from('product_images')
    .select('image_url')
    .eq('product_id', productId)
    .order('image_order', { ascending: true })
    .limit(1)
    .maybeSingle();

  return data?.image_url ?? null;
}

/**
 * getProductImages()
 * Returns all image URLs for a product, in display order.
 *
 * @param {string} productId
 * @returns {Promise<string[]>}
 */
export async function getProductImages(productId) {
  const { data } = await supabaseClient
    .from('product_images')
    .select('image_url, image_order')
    .eq('product_id', productId)
    .order('image_order', { ascending: true });

  return (data ?? []).map(r => r.image_url);
}

// ================================================================
// UPLOAD
// ================================================================

/**
 * uploadProduct()
 * 1. Inserts a new product row.
 * 2. Uploads each image file to the product_images storage bucket.
 * 3. Records each public URL in the product_images table.
 *
 * @param {Object}   productData  — { title, description, price, condition, category, location, shipping_available }
 * @param {FileList|File[]} [imageFiles=[]]  — up to 10 images
 * @returns {Promise<{ id: string }>}  the new product row
 */
export async function uploadProduct(productData, imageFiles = []) {
  const user = await checkAuth();
  if (!user) throw new Error('You must be logged in to list a product.');

  // ── 1. Insert product row ──
  const { data: product, error: productError } = await supabaseClient
    .from('products')
    .insert({ ...productData, seller_id: user.id })
    .select('id')
    .single();

  if (productError) throw productError;

  const productId = product.id;
  const files     = Array.from(imageFiles).slice(0, 10);

  // ── 2 & 3. Upload images ──
  for (let i = 0; i < files.length; i++) {
    const file     = files[i];
    const filePath = `users/${user.id}/${productId}/${Date.now()}_${file.name.replace(/\s+/g, '_')}`;

    const { error: uploadError } = await supabaseClient.storage
      .from(IMAGES_BUCKET)
      .upload(filePath, file, { cacheControl: '3600', upsert: false });

    if (uploadError) throw new Error(`Image upload failed: ${uploadError.message}`);

    // Store the storage PATH only — never the full URL.
    // getPublicUrl() is called at display time so the bucket name can be changed
    // in one place (IMAGES_BUCKET constant) without touching stored data.
    const { error: dbError } = await supabaseClient
      .from('product_images')
      .insert({
        product_id:  productId,
        image_url:   filePath,
        image_order: i,
      });

    if (dbError) throw new Error(`Failed to save image record: ${dbError.message}`);
  }

  return product;
}

// ================================================================
// READ
// ================================================================

/**
 * getFilteredProducts()
 * Fetches products matching optional filters.
 * Includes the seller profile and first image in each row.
 *
 * @param {Object} [filters={}]
 * @param {string}  [filters.search]          — full-text search query
 * @param {string}  [filters.category]        — exact category match
 * @param {string}  [filters.condition]       — exact condition match
 * @param {number}  [filters.minPrice]        — price >= minPrice
 * @param {number}  [filters.maxPrice]        — price <= maxPrice
 * @param {string}  [filters.location]        — partial match on location
 * @param {boolean} [filters.shippingAvailable]
 * @param {string}  [filters.sortBy]          — "price,asc" | "price,desc" | "created_at,desc"
 * @param {number}  [filters.limit=40]
 * @returns {Promise<Array>}
 */
export async function getFilteredProducts(filters = {}) {
  let query = supabaseClient
    .from('products')
    .select(`
      *,
      seller:profiles!seller_id(full_name, avatar_url, rating_avg),
      product_images(image_url, image_order)
    `)
    .eq('is_active', true);

  if (filters.search?.trim()) {
    query = query.textSearch('search_vector', filters.search.trim(), {
      type:   'websearch',
      config: 'english',
    });
  }

  if (filters.category)   query = query.eq('category', filters.category);
  if (filters.condition)  query = query.eq('condition', filters.condition);
  if (filters.location)   query = query.ilike('location', `%${filters.location}%`);

  if (filters.minPrice !== undefined && filters.minPrice !== '') {
    query = query.gte('price', parseFloat(filters.minPrice));
  }
  if (filters.maxPrice !== undefined && filters.maxPrice !== '') {
    query = query.lte('price', parseFloat(filters.maxPrice));
  }
  if (filters.shippingAvailable !== undefined) {
    query = query.eq('shipping_available', filters.shippingAvailable);
  }

  if (filters.sortBy) {
    const [col, dir = 'desc'] = filters.sortBy.split(',');
    query = query.order(col, { ascending: dir === 'asc' });
  } else {
    query = query.order('created_at', { ascending: false });
  }

  query = query.limit(filters.limit ?? 40);

  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}

/**
 * getProductById()
 * Returns a single product with its seller profile and all images.
 *
 * @param {string} id
 * @returns {Promise<Object>}
 */
export async function getProductById(id) {
  const { data, error } = await supabaseClient
    .from('products')
    .select(`
      *,
      seller:profiles!seller_id(id, email, full_name, avatar_url, rating_avg, rating_count, created_at),
      product_images(image_url, image_order)
    `)
    .eq('id', id)
    .single();

  if (error) throw error;
  return data;
}

/**
 * getUserProducts()
 * Returns all active products belonging to the signed-in user.
 *
 * @returns {Promise<Array>}
 */
export async function getUserProducts() {
  const user = await checkAuth();
  if (!user) return [];

  const { data, error } = await supabaseClient
    .from('products')
    .select('*, product_images(image_url, image_order)')
    .eq('seller_id', user.id)
    .eq('is_active', true)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return data ?? [];
}

// ================================================================
// WRITE
// ================================================================

/**
 * updateProduct()
 * Patches a product row. Only the owner can update their listing.
 *
 * @param {string} productId
 * @param {Object} updates  — partial product fields
 * @returns {Promise<void>}
 */
export async function updateProduct(productId, updates) {
  const user = await checkAuth();
  if (!user) throw new Error('Not authenticated.');

  const { error } = await supabaseClient
    .from('products')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', productId)
    .eq('seller_id', user.id);   // RLS + explicit guard

  if (error) throw error;
}

/**
 * deleteProduct()
 * Soft-deletes a product by setting is_active = false.
 * The row remains in DB for analytics / message history.
 *
 * @param {string} productId
 * @returns {Promise<void>}
 */
export async function deleteProduct(productId) {
  const user = await checkAuth();
  if (!user) throw new Error('Not authenticated.');

  const { error } = await supabaseClient
    .from('products')
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq('id', productId)
    .eq('seller_id', user.id);

  if (error) throw error;
}

/**
 * markProductSold()
 * Marks a product as sold, recording who bought it and at what price.
 *
 * @param {string}      productId
 * @param {string|null} [buyerId]    — UUID of buyer (optional)
 * @param {number|null} [soldPrice]  — agreed price (optional)
 * @returns {Promise<void>}
 */
export async function markProductSold(productId, buyerId = null, soldPrice = null) {
  const user = await checkAuth();
  if (!user) throw new Error('Not authenticated.');

  const { error } = await supabaseClient
    .from('products')
    .update({
      sold:        true,
      sold_at:     new Date().toISOString(),
      sold_to_id:  buyerId   ?? null,
      sold_price:  soldPrice ?? null,
      updated_at:  new Date().toISOString(),
    })
    .eq('id', productId)
    .eq('seller_id', user.id);

  if (error) throw error;
}

// ================================================================
// DISPLAY RENDERING
// ================================================================

/**
 * getIconForCategory()
 * Convenience re-export matching the old products.js API.
 * Use getCategoryIcon() from utils.js going forward.
 *
 * @param {string} category
 * @returns {string}
 */
export function getIconForCategory(category) {
  return getCategoryIcon(category);
}

// Expose for legacy inline onclick handlers in rendered HTML
window.getIconForCategory = getIconForCategory;

/**
 * displayProducts()
 * Renders a 2-column product grid into a container element.
 *
 * @param {string} containerId      — ID of the target DOM element
 * @param {Object} [filters={}]     — same filters as getFilteredProducts()
 * @param {Object} [options={}]
 * @param {Set}    [options.savedIds] — Set of product IDs in user's wishlist
 * @param {string} [options.currentUserId] — to hide heart on own products
 */
export async function displayProducts(containerId, filters = {}, options = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;

  // ── Loading state ──
  container.innerHTML = `
    <div style="grid-column:1/-1;text-align:center;padding:32px;color:var(--text-muted)">
      <i class="fas fa-spinner fa-spin" style="font-size:1.8rem;color:var(--teal)"></i>
      <p style="margin-top:10px;font-size:.85rem">Loading…</p>
    </div>
  `;

  try {
    const products = await getFilteredProducts(filters);

    if (!products.length) {
      container.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1">
          <i class="fas fa-search"></i>
          <h3>No listings found</h3>
          <p>Try adjusting your search or filters.</p>
        </div>
      `;
      return;
    }

    const { savedIds = new Set(), currentUserId = null } = options;

    container.innerHTML = products.map(p => {
      // Pick first image sorted by image_order
      const imgs = (p.product_images ?? []).sort((a, b) => (a.image_order ?? 0) - (b.image_order ?? 0));
      // image_url is a storage path — reconstruct full URL via getPublicUrl
      const _rawImg = imgs[0]?.image_url ?? null;
      const img = _rawImg
        ? supabaseClient.storage.from(IMAGES_BUCKET).getPublicUrl(_rawImg).data.publicUrl
        : null;
      const icon = getCategoryIcon(p.category);
      const isSaved = savedIds.has(p.id);
      const isOwn   = currentUserId && currentUserId === p.seller_id;

      return `
        <div class="product-card" onclick="window.location.href='./product.html?id=${p.id}'">
          <div class="product-card-img">
            ${img
              ? `<img src="${escHtml(img)}" alt="${escHtml(p.title)}" loading="lazy"
                     onerror="this.parentElement.innerHTML='<i class=\\'fas fa-${icon} img-placeholder\\'></i>'">`
              : `<i class="fas fa-${icon} img-placeholder"></i>`
            }
          </div>
          ${p.sold ? '<div class="sold-overlay">SOLD</div>' : ''}
          ${!isOwn ? `
            <button class="card-heart ${isSaved ? 'saved' : ''}"
                    onclick="handleToggleSave(event,'${p.id}')"
                    title="${isSaved ? 'Remove from saved' : 'Save item'}">
              <i class="${isSaved ? 'fas' : 'far'} fa-heart"></i>
            </button>
          ` : ''}
          <div class="product-card-body">
            <div class="card-price">${formatCurrency(p.price)}</div>
            <div class="card-title">${escHtml(p.title)}</div>
            <div class="card-meta">${escHtml(p.location ?? '')} &nbsp;·&nbsp; ${escHtml(p.condition ?? '')}</div>
          </div>
        </div>
      `;
    }).join('');

  } catch (err) {
    console.error('[displayProducts]', err);
    container.innerHTML = `
      <div class="empty-state" style="grid-column:1/-1">
        <i class="fas fa-exclamation-triangle" style="color:var(--red)"></i>
        <h3>Error loading products</h3>
        <p>${escHtml(handleError(err))}</p>
      </div>
    `;
  }
}