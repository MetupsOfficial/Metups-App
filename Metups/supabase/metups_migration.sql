-- ============================================================
-- METUPS MARKETPLACE — COMPLETE DATABASE MIGRATION
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor)
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. ENABLE EXTENSIONS
-- ────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";   -- for fuzzy text search


-- ────────────────────────────────────────────────────────────
-- 2. PROFILES — add missing columns
-- ────────────────────────────────────────────────────────────

-- phone number for SMS auth / notifications
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS phone         TEXT,
  ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS date_of_birth  DATE,
  ADD COLUMN IF NOT EXISTS country        TEXT    DEFAULT 'Zimbabwe',
  ADD COLUMN IF NOT EXISTS city           TEXT,
  -- JSON object: { email: true, sms: false, push: true }
  ADD COLUMN IF NOT EXISTS notification_preferences JSONB DEFAULT '{"email":true,"sms":false,"push":true}'::jsonb,
  ADD COLUMN IF NOT EXISTS rating_avg     NUMERIC(3,2) DEFAULT 0,  -- cached average rating
  ADD COLUMN IF NOT EXISTS rating_count   INTEGER      DEFAULT 0,  -- total ratings received
  ADD COLUMN IF NOT EXISTS is_active      BOOLEAN      NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS last_seen_at   TIMESTAMP WITH TIME ZONE;

-- unique constraint: one phone per account
ALTER TABLE profiles
  DROP CONSTRAINT IF EXISTS profiles_phone_key;
ALTER TABLE profiles
  ADD CONSTRAINT profiles_phone_key UNIQUE (phone);

-- index for phone lookups
CREATE INDEX IF NOT EXISTS idx_profiles_phone ON profiles(phone);


-- ────────────────────────────────────────────────────────────
-- 3. PRODUCTS — add missing columns
-- ────────────────────────────────────────────────────────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS views_count    INTEGER   NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sold_price     NUMERIC,            -- actual price agreed in chat
  ADD COLUMN IF NOT EXISTS sold_to_id     UUID REFERENCES profiles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sold_at        TIMESTAMP WITH TIME ZONE,
  ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMP WITH TIME ZONE DEFAULT now(),
  ADD COLUMN IF NOT EXISTS is_active      BOOLEAN   NOT NULL DEFAULT true; -- soft delete

-- make title/description/price NOT NULL (data quality)
ALTER TABLE products
  ALTER COLUMN title       SET NOT NULL,
  ALTER COLUMN description SET NOT NULL,
  ALTER COLUMN price       SET NOT NULL;

-- add price range constraint
ALTER TABLE products
  DROP CONSTRAINT IF EXISTS products_price_positive;
ALTER TABLE products
  ADD CONSTRAINT products_price_positive CHECK (price >= 0);

-- indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_products_seller     ON products(seller_id);
CREATE INDEX IF NOT EXISTS idx_products_category   ON products(category);
CREATE INDEX IF NOT EXISTS idx_products_location   ON products(location);
CREATE INDEX IF NOT EXISTS idx_products_created    ON products(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_products_sold       ON products(sold);
CREATE INDEX IF NOT EXISTS idx_products_search     ON products USING GIN(search_vector);

-- trigger: auto-update search_vector on insert/update
CREATE OR REPLACE FUNCTION update_products_search_vector()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_vector :=
    setweight(to_tsvector('english', coalesce(NEW.title, '')),       'A') ||
    setweight(to_tsvector('english', coalesce(NEW.description, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW.category, '')),    'C') ||
    setweight(to_tsvector('english', coalesce(NEW.location, '')),    'C');
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_products_search ON products;
CREATE TRIGGER trg_products_search
  BEFORE INSERT OR UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION update_products_search_vector();


-- ────────────────────────────────────────────────────────────
-- 4. PRODUCT_IMAGES — constraints
-- ────────────────────────────────────────────────────────────
-- max 10 images per product (enforced via trigger)
CREATE OR REPLACE FUNCTION check_product_image_limit()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT COUNT(*) FROM product_images WHERE product_id = NEW.product_id) >= 10 THEN
    RAISE EXCEPTION 'Maximum 10 images allowed per product';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_product_image_limit ON product_images;
CREATE TRIGGER trg_product_image_limit
  BEFORE INSERT ON product_images
  FOR EACH ROW EXECUTE FUNCTION check_product_image_limit();


-- ────────────────────────────────────────────────────────────
-- 5. CONVERSATIONS — add missing columns
-- ────────────────────────────────────────────────────────────
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived', 'blocked'));

-- unique constraint: one conversation per (buyer, seller, product)
ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_unique_participants;
ALTER TABLE conversations
  ADD CONSTRAINT conversations_unique_participants
    UNIQUE (product_id, buyer_id, seller_id);

CREATE INDEX IF NOT EXISTS idx_conversations_buyer  ON conversations(buyer_id);
CREATE INDEX IF NOT EXISTS idx_conversations_seller ON conversations(seller_id);
CREATE INDEX IF NOT EXISTS idx_conversations_last   ON conversations(last_message_at DESC);


-- ────────────────────────────────────────────────────────────
-- 6. MESSAGES — add media support
-- ────────────────────────────────────────────────────────────
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS message_type TEXT NOT NULL DEFAULT 'text'
    CHECK (message_type IN ('text', 'image', 'voice', 'system')),
  ADD COLUMN IF NOT EXISTS media_url    TEXT;    -- for image / voice messages

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_messages_sender       ON messages(sender_id);


-- ────────────────────────────────────────────────────────────
-- 7. WISHLISTS — repurpose as SAVED ITEMS (favorites)
--    The want-ads feature gets its own table below.
-- ────────────────────────────────────────────────────────────

-- Remove product_id NOT NULL so it can serve both purposes,
-- then add a unique constraint to prevent duplicates
ALTER TABLE wishlists
  ADD COLUMN IF NOT EXISTS title        TEXT,  -- for want-ad style requests
  ADD COLUMN IF NOT EXISTS description  TEXT,
  ADD COLUMN IF NOT EXISTS max_price    NUMERIC,
  ADD COLUMN IF NOT EXISTS condition    TEXT,
  ADD COLUMN IF NOT EXISTS category     TEXT,
  ADD COLUMN IF NOT EXISTS location     TEXT DEFAULT 'Anywhere',
  ADD COLUMN IF NOT EXISTS shipping_ok  BOOLEAN DEFAULT false;

-- Make product_id nullable so table handles both saved-items AND want-ads
ALTER TABLE wishlists
  ALTER COLUMN product_id DROP NOT NULL;

-- Prevent duplicate saves of the same product
ALTER TABLE wishlists
  DROP CONSTRAINT IF EXISTS wishlists_unique_save;
ALTER TABLE wishlists
  ADD CONSTRAINT wishlists_unique_save
    UNIQUE NULLS NOT DISTINCT (user_id, product_id);

CREATE INDEX IF NOT EXISTS idx_wishlists_user ON wishlists(user_id);


-- ────────────────────────────────────────────────────────────
-- 8. REVIEWS — add constraints
-- ────────────────────────────────────────────────────────────
ALTER TABLE reviews
  ADD CONSTRAINT reviews_rating_range CHECK (rating BETWEEN 1 AND 5);

-- prevent double reviews for same transaction
ALTER TABLE reviews
  DROP CONSTRAINT IF EXISTS reviews_unique_per_product;
ALTER TABLE reviews
  ADD CONSTRAINT reviews_unique_per_product
    UNIQUE (reviewer_id, reviewee_id, product_id);

CREATE INDEX IF NOT EXISTS idx_reviews_reviewee ON reviews(reviewee_id);

-- trigger: update seller's cached rating after review insert/update
CREATE OR REPLACE FUNCTION update_seller_rating()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE profiles
  SET
    rating_avg   = (SELECT ROUND(AVG(rating)::numeric, 2) FROM reviews WHERE reviewee_id = NEW.reviewee_id),
    rating_count = (SELECT COUNT(*)                       FROM reviews WHERE reviewee_id = NEW.reviewee_id)
  WHERE id = NEW.reviewee_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_update_seller_rating ON reviews;
CREATE TRIGGER trg_update_seller_rating
  AFTER INSERT OR UPDATE ON reviews
  FOR EACH ROW EXECUTE FUNCTION update_seller_rating();


-- ────────────────────────────────────────────────────────────
-- 9. NOTIFICATIONS — NEW TABLE
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN (
                'new_message',
                'product_viewed',
                'wishlist_match',
                'product_sold',
                'product_uploaded',
                'new_review'
              )),
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  data        JSONB,             -- arbitrary extra context (product_id, conversation_id, etc.)
  read_at     TIMESTAMP WITH TIME ZONE,
  created_at  TIMESTAMP WITH TIME ZONE DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user    ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread  ON notifications(user_id) WHERE read_at IS NULL;

-- helper: create a notification row
CREATE OR REPLACE FUNCTION create_notification(
  p_user_id UUID,
  p_type    TEXT,
  p_title   TEXT,
  p_body    TEXT,
  p_data    JSONB DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO notifications(user_id, type, title, body, data)
  VALUES (p_user_id, p_type, p_title, p_body, p_data);
END;
$$;

-- auto-notify seller when a new message is sent in their conversation
CREATE OR REPLACE FUNCTION notify_on_message()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_conv  conversations%ROWTYPE;
  v_product products%ROWTYPE;
  v_notify_user UUID;
BEGIN
  SELECT * INTO v_conv FROM conversations WHERE id = NEW.conversation_id;
  SELECT * INTO v_product FROM products WHERE id = v_conv.product_id;

  -- Notify the OTHER participant
  IF NEW.sender_id = v_conv.buyer_id THEN
    v_notify_user := v_conv.seller_id;
  ELSE
    v_notify_user := v_conv.buyer_id;
  END IF;

  PERFORM create_notification(
    v_notify_user,
    'new_message',
    'New Message',
    'New message about ' || v_product.title,
    jsonb_build_object('conversation_id', NEW.conversation_id, 'product_id', v_conv.product_id)
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_on_message ON messages;
CREATE TRIGGER trg_notify_on_message
  AFTER INSERT ON messages
  FOR EACH ROW
  WHEN (NEW.message_type = 'text' OR NEW.message_type = 'image' OR NEW.message_type = 'voice')
  EXECUTE FUNCTION notify_on_message();


-- ────────────────────────────────────────────────────────────
-- 10. CART — add quantity constraint
-- ────────────────────────────────────────────────────────────
ALTER TABLE cart
  DROP CONSTRAINT IF EXISTS cart_quantity_positive;
ALTER TABLE cart
  ADD CONSTRAINT cart_quantity_positive CHECK (quantity > 0);

ALTER TABLE cart
  DROP CONSTRAINT IF EXISTS cart_unique_item;
ALTER TABLE cart
  ADD CONSTRAINT cart_unique_item UNIQUE (user_id, product_id);

CREATE INDEX IF NOT EXISTS idx_cart_user ON cart(user_id);


-- ────────────────────────────────────────────────────────────
-- 11. ROW LEVEL SECURITY (RLS)
-- ────────────────────────────────────────────────────────────

-- Enable RLS on all tables
ALTER TABLE profiles         ENABLE ROW LEVEL SECURITY;
ALTER TABLE products         ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_images   ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations    ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages         ENABLE ROW LEVEL SECURITY;
ALTER TABLE wishlists        ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews          ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications    ENABLE ROW LEVEL SECURITY;
ALTER TABLE cart             ENABLE ROW LEVEL SECURITY;

-- ── PROFILES ──
-- Anyone can read public profiles (needed for seller info)
DROP POLICY IF EXISTS "profiles_public_read"   ON profiles;
DROP POLICY IF EXISTS "profiles_own_all"        ON profiles;

CREATE POLICY "profiles_public_read"
  ON profiles FOR SELECT
  USING (true);

CREATE POLICY "profiles_own_all"
  ON profiles FOR ALL
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- ── PRODUCTS ──
DROP POLICY IF EXISTS "products_public_read"   ON products;
DROP POLICY IF EXISTS "products_seller_manage" ON products;

CREATE POLICY "products_public_read"
  ON products FOR SELECT
  USING (is_active = true);

CREATE POLICY "products_seller_manage"
  ON products FOR ALL
  USING (auth.uid() = seller_id)
  WITH CHECK (auth.uid() = seller_id);

-- ── PRODUCT IMAGES ──
DROP POLICY IF EXISTS "images_public_read"   ON product_images;
DROP POLICY IF EXISTS "images_seller_manage" ON product_images;

CREATE POLICY "images_public_read"
  ON product_images FOR SELECT
  USING (true);

CREATE POLICY "images_seller_manage"
  ON product_images FOR ALL
  USING (
    auth.uid() = (
      SELECT seller_id FROM products WHERE id = product_id
    )
  )
  WITH CHECK (
    auth.uid() = (
      SELECT seller_id FROM products WHERE id = product_id
    )
  );

-- ── CONVERSATIONS ──
DROP POLICY IF EXISTS "conversations_participant_read"   ON conversations;
DROP POLICY IF EXISTS "conversations_buyer_create"       ON conversations;
DROP POLICY IF EXISTS "conversations_participant_update" ON conversations;

CREATE POLICY "conversations_participant_read"
  ON conversations FOR SELECT
  USING (auth.uid() IN (buyer_id, seller_id));

CREATE POLICY "conversations_buyer_create"
  ON conversations FOR INSERT
  WITH CHECK (auth.uid() = buyer_id);

CREATE POLICY "conversations_participant_update"
  ON conversations FOR UPDATE
  USING (auth.uid() IN (buyer_id, seller_id));

-- ── MESSAGES ──
DROP POLICY IF EXISTS "messages_participant_read"   ON messages;
DROP POLICY IF EXISTS "messages_sender_create"      ON messages;
DROP POLICY IF EXISTS "messages_participant_update" ON messages;

CREATE POLICY "messages_participant_read"
  ON messages FOR SELECT
  USING (
    auth.uid() IN (
      SELECT buyer_id FROM conversations WHERE id = conversation_id
      UNION
      SELECT seller_id FROM conversations WHERE id = conversation_id
    )
  );

CREATE POLICY "messages_sender_create"
  ON messages FOR INSERT
  WITH CHECK (
    auth.uid() = sender_id AND
    auth.uid() IN (
      SELECT buyer_id FROM conversations WHERE id = conversation_id
      UNION
      SELECT seller_id FROM conversations WHERE id = conversation_id
    )
  );

CREATE POLICY "messages_participant_update"
  ON messages FOR UPDATE
  USING (
    auth.uid() IN (
      SELECT buyer_id FROM conversations WHERE id = conversation_id
      UNION
      SELECT seller_id FROM conversations WHERE id = conversation_id
    )
  );

-- ── WISHLISTS ──
DROP POLICY IF EXISTS "wishlists_own_all" ON wishlists;

CREATE POLICY "wishlists_own_all"
  ON wishlists FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── REVIEWS ──
DROP POLICY IF EXISTS "reviews_public_read"    ON reviews;
DROP POLICY IF EXISTS "reviews_author_manage"  ON reviews;

CREATE POLICY "reviews_public_read"
  ON reviews FOR SELECT
  USING (true);

CREATE POLICY "reviews_author_manage"
  ON reviews FOR ALL
  USING (auth.uid() = reviewer_id)
  WITH CHECK (auth.uid() = reviewer_id);

-- ── NOTIFICATIONS ──
DROP POLICY IF EXISTS "notifications_own_all" ON notifications;

CREATE POLICY "notifications_own_all"
  ON notifications FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── CART ──
DROP POLICY IF EXISTS "cart_own_all" ON cart;

CREATE POLICY "cart_own_all"
  ON cart FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);


-- ────────────────────────────────────────────────────────────
-- 12. STORAGE BUCKETS (run via Dashboard or CLI)
-- ────────────────────────────────────────────────────────────
-- Create in Supabase Dashboard → Storage:
--   bucket: product_images   (public: true,  max size: 5MB)
--   bucket: avatars          (public: true,  max size: 2MB)
--   bucket: messages         (public: false, max size: 10MB)

-- Storage RLS for product_images bucket (set in Dashboard):
-- SELECT: true (public)
-- INSERT: auth.uid() IS NOT NULL
-- UPDATE: auth.uid()::text = (storage.foldername(name))[2]  -- users/{uid}/...
-- DELETE: auth.uid()::text = (storage.foldername(name))[2]

-- ────────────────────────────────────────────────────────────
-- 13. HELPER VIEWS
-- ────────────────────────────────────────────────────────────

-- Products with first image (used in listings grid)
CREATE OR REPLACE VIEW products_with_image AS
SELECT
  p.*,
  pi.image_url AS primary_image,
  pr.full_name  AS seller_name,
  pr.rating_avg AS seller_rating
FROM products p
LEFT JOIN LATERAL (
  SELECT image_url FROM product_images
  WHERE product_id = p.id
  ORDER BY image_order, created_at
  LIMIT 1
) pi ON true
LEFT JOIN profiles pr ON pr.id = p.seller_id
WHERE p.is_active = true;

-- Conversations with unread counts and latest message
CREATE OR REPLACE VIEW conversations_summary AS
SELECT
  c.*,
  p.title            AS product_title,
  pi.image_url       AS product_image,
  buyer.full_name    AS buyer_name,
  buyer.avatar_url   AS buyer_avatar,
  seller.full_name   AS seller_name,
  seller.avatar_url  AS seller_avatar,
  m.content          AS last_message,
  m.sent_at          AS last_message_at_ts,
  m.sender_id        AS last_sender_id
FROM conversations c
JOIN products p        ON p.id  = c.product_id
LEFT JOIN LATERAL (
  SELECT image_url FROM product_images WHERE product_id = p.id ORDER BY image_order LIMIT 1
) pi ON true
JOIN profiles buyer    ON buyer.id  = c.buyer_id
JOIN profiles seller   ON seller.id = c.seller_id
LEFT JOIN LATERAL (
  SELECT content, sent_at, sender_id
  FROM messages
  WHERE conversation_id = c.id
  ORDER BY sent_at DESC
  LIMIT 1
) m ON true;

-- ────────────────────────────────────────────────────────────
-- 14. PROFILE AUTO-CREATE ON SIGNUP
-- ────────────────────────────────────────────────────────────
-- Supabase fires auth.users insert → create a matching profile row
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1))
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();