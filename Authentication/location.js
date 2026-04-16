/**
 * ================================================================
 * METUPS — LOCATION UTILITY
 * Authentication/location.js
 *
 * getUserCoordinates()          — browser GPS → {lat, lng}
 * reverseGeocode(lat, lng)      — coordinates → {city, country, ...}
 * geocodeCity(name)             → coordinates (cached)
 * detectAndSaveLocation(userId) — full pipeline: detect + save to profile
 * getStoredLocation()           — read sessionStorage cache
 * getDistanceKm(...)            — Haversine formula
 * sortProductsByProximity(...)  — tier-sort: same city → country → rest
 * loadUserLocationFromProfile() — read profile row, fall back to cache
 *
 * Uses OpenStreetMap Nominatim (free, no API key).
 * Policy: max 1 request/second — don't call in tight loops.
 * ================================================================
 */

import { supabaseClient } from './supabase.js';

const NOMINATIM  = 'https://nominatim.openstreetmap.org';
const UA         = 'Metups/1.0 (marketplace)';
const SESS_KEY   = 'metups_location';
const cityCache  = new Map();   // in-memory: city string → {lat, lng}

// ── 1. BROWSER GEOLOCATION ──────────────────────────────────────

/**
 * Ask the browser for the user's coordinates.
 * @returns {Promise<{lat: number, lng: number}>}
 */
export function getUserCoordinates(opts = {}) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Geolocation is not supported by this browser.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      (err) => {
        const msgs = {
          1: 'Location access denied. Please allow location in browser settings.',
          2: 'Location unavailable. Try again or type your city manually.',
          3: 'Location request timed out.',
        };
        reject(new Error(msgs[err.code] || 'Unknown geolocation error.'));
      },
      { timeout: 10_000, maximumAge: 300_000, enableHighAccuracy: false, ...opts }
    );
  });
}

// ── 2. REVERSE GEOCODING ────────────────────────────────────────

/**
 * Convert {lat, lng} to human-readable location.
 * @returns {Promise<{city, country, countryCode, displayName, lat, lng}>}
 */
export async function reverseGeocode(lat, lng) {
  const res  = await fetch(
    `${NOMINATIM}/reverse?format=json&lat=${lat}&lon=${lng}&zoom=10&addressdetails=1`,
    { headers: { 'Accept-Language': 'en', 'User-Agent': UA } }
  );
  if (!res.ok) throw new Error(`Geocoding failed (${res.status})`);

  const { address: a = {} } = await res.json();

  const city        = a.city || a.town || a.village || a.suburb || a.county || '';
  const country     = a.country || '';
  const countryCode = (a.country_code || '').toUpperCase();
  const displayName = [city, country].filter(Boolean).join(', ');

  return { city, country, countryCode, displayName, lat, lng };
}

// ── 3. FORWARD GEOCODING ────────────────────────────────────────

/**
 * Convert a city name to {lat, lng}. Results are cached per page session.
 * @returns {Promise<{lat: number, lng: number} | null>}
 */
export async function geocodeCity(cityName) {
  if (!cityName) return null;
  const key = cityName.toLowerCase().trim();
  if (cityCache.has(key)) return cityCache.get(key);

  try {
    const res = await fetch(
      `${NOMINATIM}/search?format=json&q=${encodeURIComponent(cityName)}&limit=1`,
      { headers: { 'Accept-Language': 'en', 'User-Agent': UA } }
    );
    const data = await res.json();
    const coords = data[0]
      ? { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) }
      : null;
    cityCache.set(key, coords);
    return coords;
  } catch {
    return null;
  }
}

// ── 4. DETECT + SAVE (one-shot) ─────────────────────────────────

/**
 * Full pipeline: GPS → geocode → cache → save to Supabase profile.
 * @param {string} userId — Supabase auth UUID (optional; pass null for guests)
 * @returns {Promise<{city, country, countryCode, displayName, lat, lng}>}
 */
export async function detectAndSaveLocation(userId) {
  const coords   = await getUserCoordinates();
  const location = await reverseGeocode(coords.lat, coords.lng);

  sessionStorage.setItem(SESS_KEY, JSON.stringify(location));

  if (userId) {
    // Note: if your profiles table does not yet have city/country/lat/lng columns,
    // run the SQL in supabase/add_location_columns.sql first.
    await supabaseClient.from('profiles').update({
      location:     location.displayName,
      city:         location.city,
      country:      location.country,
      country_code: location.countryCode,
      lat:          location.lat,
      lng:          location.lng,
    }).eq('id', userId);
  }

  return location;
}

// ── 5. CACHE HELPERS ────────────────────────────────────────────

/** Read cached location from this browser session. */
export function getStoredLocation() {
  try { return JSON.parse(sessionStorage.getItem(SESS_KEY) || 'null'); }
  catch { return null; }
}

/** Remove cached location. */
export function clearStoredLocation() { sessionStorage.removeItem(SESS_KEY); }

// ── 6. HAVERSINE DISTANCE ───────────────────────────────────────

/**
 * Distance in km between two lat/lng pairs.
 */
export function getDistanceKm(lat1, lng1, lat2, lng2) {
  const R    = 6371;
  const rad  = (d) => d * Math.PI / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lng2 - lng1);
  const a    = Math.sin(dLat / 2) ** 2
             + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── 7. SORT PRODUCTS BY PROXIMITY ──────────────────────────────

/**
 * Sort products so nearest appear first.
 * Tier 0: same city  →  Tier 1: same country  →  Tier 2: everywhere else
 *
 * Uses string matching (no extra API calls). Within each tier,
 * original DB order (newest-first) is preserved.
 *
 * @param {Array}  products
 * @param {string} userCity
 * @param {string} userCountry
 * @returns {Array}  new sorted array (does not mutate input)
 */
export function sortProductsByProximity(products, userCity, userCountry) {
  if (!products?.length) return products ?? [];

  const city    = (userCity    || '').toLowerCase().trim();
  const country = (userCountry || '').toLowerCase().trim();

  const tier = (p) => {
    const loc = (p.location || '').toLowerCase();
    if (city    && loc.includes(city))    return 0;
    if (country && loc.includes(country)) return 1;
    return 2;
  };

  return [...products].sort((a, b) => tier(a) - tier(b));
}

// ── 8. LOAD FROM PROFILE ────────────────────────────────────────

/**
 * Get user's stored location from Supabase profile.
 * Falls back to sessionStorage cache if already loaded this session.
 *
 * @param {string} userId
 * @returns {Promise<{city, country, countryCode, displayName, lat, lng} | null>}
 */
export async function loadUserLocationFromProfile(userId) {
  const cached = getStoredLocation();
  if (cached) return cached;
  if (!userId) return null;

  const { data } = await supabaseClient
    .from('profiles')
    .select('location, city, country, country_code, lat, lng')
    .eq('id', userId)
    .maybeSingle();

  if (!data?.city) return null;

  const loc = {
    city:        data.city         || '',
    country:     data.country      || '',
    countryCode: data.country_code || '',
    displayName: data.location     || [data.city, data.country].filter(Boolean).join(', '),
    lat:         data.lat          ?? null,
    lng:         data.lng          ?? null,
  };

  sessionStorage.setItem(SESS_KEY, JSON.stringify(loc));
  return loc;
}