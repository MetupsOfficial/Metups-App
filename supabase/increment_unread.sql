-- ================================================================
-- METUPS — ADD TO YOUR SUPABASE SQL EDITOR
-- Run this after the main migration if not already present.
-- ================================================================

-- increment_unread()
-- Called by messaging.html after a message is sent.
-- Increments unread_count AND updates last_message_at atomically.
-- Safer than a plain UPDATE because it can't race-condition to 0.
CREATE OR REPLACE FUNCTION increment_unread(conv_id UUID)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  UPDATE conversations
  SET
    unread_count    = unread_count + 1,
    last_message_at = now()
  WHERE id = conv_id;
$$;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION increment_unread(UUID) TO authenticated;