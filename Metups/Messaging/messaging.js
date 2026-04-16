/**
 * ================================================================
 * METUPS MARKETPLACE — MESSAGING MODULE
 * Messaging/messaging.js
 *
 * Exports:
 *   createConversation()      — start / retrieve a buyer↔seller chat
 *   getUserConversations()    — all conversations for the current user
 *   getConversationMessages() — paginated message history
 *   sendMessage()             — insert a text / image / voice message
 *   markConversationAsRead()  — zero the unread counter
 *   markMessageAsDelivered()  — stamp delivered_at on received messages
 *   getUnreadCount()          — total unread conversation count
 *   subscribeToMessages()     — real-time Postgres listener
 *   startVoiceRecording()     — MediaRecorder wrapper
 *   stopVoiceRecording()      — stop and upload voice note
 * ================================================================
 */

import { supabaseClient, SUPABASE_URL, SUPABASE_ANON_KEY } from '../Authentication/supabase.js';

const FUNCTIONS_URL = `${SUPABASE_URL}/functions/v1`;
import { checkAuth, handleError, getCurrentUser } from '../Authentication/utils.js';

// ── Voice recording state ─────────────────────────────────────
let mediaRecorder = null;
let audioChunks   = [];
let isRecording   = false;

// ================================================================
// CONVERSATIONS
// ================================================================

/**
 * createConversation()
 * Finds or creates a conversation between the current user (buyer)
 * and a seller for a specific product.
 * Sends an automatic "I'm interested" opening message on first create.
 *
 * @param {string} productId  — UUID of the product being discussed
 * @param {string} sellerId   — UUID of the seller's profile
 * @returns {Promise<string>} conversationId
 */
export async function createConversation(productId, sellerId) {
  const user = await getCurrentUser();
  if (!user) throw new Error('You must be logged in to message a seller.');

  // ── Check for existing conversation ──
  const { data: existing } = await supabaseClient
    .from('conversations')
    .select('id')
    .eq('product_id', productId)
    .or(`buyer_id.eq.${user.id},seller_id.eq.${user.id}`)
    .maybeSingle();

  if (existing) return existing.id;

  // ── Create new conversation ──
  const { data: newConv, error: createError } = await supabaseClient
    .from('conversations')
    .insert({
      product_id: productId,
      buyer_id:   user.id,
      seller_id:  sellerId,
    })
    .select('id')
    .single();

  if (createError) throw createError;

  // ── Fetch product title for opening message ──
  const { data: product } = await supabaseClient
    .from('products')
    .select('title')
    .eq('id', productId)
    .maybeSingle();

  // ── Send automated opening message ──
  await supabaseClient.from('messages').insert({
    conversation_id: newConv.id,
    sender_id:       user.id,
    content:         `Hi! I'm interested in your listing: "${product?.title ?? 'your item'}". Is it still available?`,
    message_type:    'text',
  });

  // ── Update last_message_at on the conversation ──
  await supabaseClient
    .from('conversations')
    .update({ last_message_at: new Date().toISOString(), unread_count: 1 })
    .eq('id', newConv.id);

  return newConv.id;
}

/**
 * getUserConversations()
 * Returns all conversations for the current user, newest first.
 * Each item includes the latest message, product info and other-user info.
 *
 * @returns {Promise<Array>}
 */
export async function getUserConversations() {
  const user = await getCurrentUser();
  if (!user) return [];

  const { data: conversations, error } = await supabaseClient
    .from('conversations')
    .select(`
      *,
      product:products(id, title, price),
      buyer:profiles!buyer_id(id, full_name, avatar_url),
      seller:profiles!seller_id(id, full_name, avatar_url)
    `)
    .or(`buyer_id.eq.${user.id},seller_id.eq.${user.id}`)
    .order('last_message_at', { ascending: false });

  if (error) {
    console.error('[getUserConversations]', error);
    return [];
  }

  // Attach the latest message to each conversation
  const enriched = await Promise.all(
    (conversations ?? []).map(async (conv) => {
      const { data: msg } = await supabaseClient
        .from('messages')
        .select('content, sent_at, sender_id, message_type')
        .eq('conversation_id', conv.id)
        .order('sent_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      return { ...conv, latest_message: msg ?? null };
    })
  );

  return enriched;
}

// ================================================================
// MESSAGES
// ================================================================

/**
 * getConversationMessages()
 * Loads all messages for a conversation in chronological order.
 *
 * @param {string} conversationId
 * @returns {Promise<Array>}
 */
export async function getConversationMessages(conversationId) {
  const { data, error } = await supabaseClient
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('sent_at', { ascending: true });

  if (error) {
    console.error('[getConversationMessages]', error);
    return [];
  }
  return data ?? [];
}

/**
 * sendMessage()
 * Inserts a message row and bumps last_message_at on the conversation.
 *
 * @param {string} conversationId
 * @param {string} content          — the message text
 * @param {'text'|'image'|'voice'|'system'} [messageType='text']
 * @param {string|null} [mediaUrl]  — storage URL for image / voice messages
 * @returns {Promise<Object>}       the inserted message row
 */
export async function sendMessage(conversationId, content, messageType = 'text', mediaUrl = null) {
  const user = await getCurrentUser();
  if (!user)          throw new Error('Not authenticated.');
  if (!conversationId) throw new Error('conversationId is required.');
  if (messageType === 'text' && !content?.trim()) throw new Error('Message cannot be empty.');

  const { data: message, error } = await supabaseClient
    .from('messages')
    .insert({
      conversation_id: conversationId,
      sender_id:       user.id,
      content:         content?.trim() ?? '',
      message_type:    messageType,
      media_url:       mediaUrl ?? null,
    })
    .select()
    .single();

  if (error) throw error;

  // Update conversation timestamp + increment unread for the other party
  await supabaseClient
    .from('conversations')
    .update({
      last_message_at: new Date().toISOString(),
      unread_count:    supabaseClient.rpc('conversations_increment_unread', { conv_id: conversationId }),
    })
    .eq('id', conversationId);

  // Simpler fallback: just set last_message_at (unread is handled by RLS trigger in DB)
  await supabaseClient
    .from('conversations')
    .update({ last_message_at: new Date().toISOString() })
    .eq('id', conversationId);

  return message;
}

// ================================================================
// READ / DELIVERED RECEIPTS
// ================================================================

/**
 * markConversationAsRead()
 * Zeros the unread_count and stamps read_at on received messages.
 *
 * @param {string} conversationId
 */
export async function markConversationAsRead(conversationId) {
  const user = await getCurrentUser();
  if (!user) return;

  await Promise.all([
    supabaseClient
      .from('conversations')
      .update({ unread_count: 0 })
      .eq('id', conversationId),

    supabaseClient
      .from('messages')
      .update({ read_at: new Date().toISOString() })
      .eq('conversation_id', conversationId)
      .neq('sender_id', user.id)
      .is('read_at', null),
  ]);
}

/**
 * markMessageAsDelivered()
 * Stamps delivered_at on a specific received message.
 *
 * @param {string} messageId
 */
export async function markMessageAsDelivered(messageId) {
  const user = await getCurrentUser();
  if (!user) return;

  await supabaseClient
    .from('messages')
    .update({ delivered_at: new Date().toISOString() })
    .eq('id', messageId)
    .neq('sender_id', user.id)
    .is('delivered_at', null);
}

// ================================================================
// UNREAD COUNT
// ================================================================

/**
 * getUnreadCount()
 * Returns the number of conversations with unread_count > 0.
 *
 * @returns {Promise<number>}
 */
export async function getUnreadCount() {
  const user = await getCurrentUser();
  if (!user) return 0;

  const { count, error } = await supabaseClient
    .from('conversations')
    .select('*', { count: 'exact', head: true })
    .or(`buyer_id.eq.${user.id},seller_id.eq.${user.id}`)
    .gt('unread_count', 0);

  if (error) return 0;
  return count ?? 0;
}

// ================================================================
// REAL-TIME SUBSCRIPTION
// ================================================================

/**
 * subscribeToMessages()
 * Opens a Supabase Realtime channel for a conversation.
 * Calls onInsert(newMsg) when a new message arrives.
 * Calls onUpdate(updatedMsg) when a message is updated (read / delivered).
 *
 * Returns the channel so you can call supabaseClient.removeChannel(channel)
 * when the component unmounts.
 *
 * @param {string}   conversationId
 * @param {Function} onInsert  — (message: Object) => void
 * @param {Function} [onUpdate] — (message: Object) => void
 * @returns {RealtimeChannel}
 *
 * @example
 *   const channel = subscribeToMessages(convId, (msg) => appendBubble(msg));
 *   // On teardown:
 *   supabaseClient.removeChannel(channel);
 */
export function subscribeToMessages(conversationId, onInsert, onUpdate = null) {
  const channel = supabaseClient
    .channel(`messages:conv:${conversationId}`)
    .on(
      'postgres_changes',
      {
        event:  'INSERT',
        schema: 'public',
        table:  'messages',
        filter: `conversation_id=eq.${conversationId}`,
      },
      (payload) => onInsert(payload.new)
    );

  if (onUpdate) {
    channel.on(
      'postgres_changes',
      {
        event:  'UPDATE',
        schema: 'public',
        table:  'messages',
        filter: `conversation_id=eq.${conversationId}`,
      },
      (payload) => onUpdate(payload.new)
    );
  }

  channel.subscribe();
  return channel;
}

// ================================================================
// VOICE RECORDING
// ================================================================

/**
 * startVoiceRecording()
 * Requests microphone access and starts recording.
 * The recording is automatically uploaded and sent as a message
 * when stopVoiceRecording() is called.
 *
 * @param {string}   conversationId  — where to send the voice message
 * @param {Function} [onStateChange] — (isRecording: boolean) => void
 */
export async function startVoiceRecording(conversationId, onStateChange = null) {
  if (!navigator.mediaDevices?.getUserMedia) {
    alert('Your browser does not support voice recording.');
    return;
  }
  if (isRecording) return;

  audioChunks = [];

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      try {
        const blob     = new Blob(audioChunks, { type: 'audio/webm' });
        const fileName = `conversations/${conversationId}/voice_${Date.now()}.webm`;

        // Upload to Supabase Storage (messages bucket)
        const { error: uploadError } = await supabaseClient.storage
          .from('messages')
          .upload(fileName, blob, { cacheControl: '3600', upsert: false });

        if (uploadError) throw uploadError;

        const { data: urlData } = supabaseClient.storage.from('messages').getPublicUrl(fileName);

        // Send as a voice message
        await sendMessage(conversationId, '🎤 Voice message', 'voice', urlData.publicUrl);
      } catch (err) {
        console.error('[voiceRecording onstop]', err);
        alert('Failed to send voice message: ' + err.message);
      } finally {
        stream.getTracks().forEach(t => t.stop());
        isRecording = false;
        onStateChange?.(false);
      }
    };

    mediaRecorder.start();
    isRecording = true;
    onStateChange?.(true);

  } catch (err) {
    console.error('[startVoiceRecording]', err);
    isRecording = false;
    onStateChange?.(false);
    if (err.name === 'NotAllowedError') {
      alert('Microphone access denied. Please allow microphone access in your browser settings.');
    } else {
      alert('Could not access microphone: ' + err.message);
    }
  }
}

/**
 * stopVoiceRecording()
 * Stops the active MediaRecorder. The onstop handler in
 * startVoiceRecording() will upload and send the message.
 */
export function stopVoiceRecording() {
  if (mediaRecorder && isRecording) {
    mediaRecorder.stop();
    // isRecording is set to false inside onstop
  }
}

// ================================================================
// WISHLIST MATCH NOTIFICATIONS
// ================================================================

/**
 * checkWishlistMatches()
 * Called after a new product is listed.
 * Finds active want-alerts that match and sends email notifications
 * via the send-wishlist-match Edge Function.
 *
 * @param {{ id, title, price, category, condition, location, shipping_available }} newProduct
 */
export async function checkWishlistMatches(newProduct) {
  try {
    // Fetch active want-alerts that could match
    const { data: requests, error } = await supabaseClient
      .from('wishlists')
      .select('id, user_id, title, description, max_price, category, condition, location, shipping_ok')
      .eq('active', true)
      .is('product_id', null)            // want-ads only (not saved products)
      .gte('max_price', newProduct.price) // within budget (or no budget set)
      .or([
        `category.is.null`,
        `category.eq.${newProduct.category}`,
      ].join(','))
      .or([
        `condition.is.null`,
        `condition.eq.${newProduct.condition}`,
      ].join(','));

    if (error || !requests?.length) return;

    // Second-pass filter: keyword overlap + location + shipping
    const productText = `${newProduct.title} ${newProduct.description ?? ''}`.toLowerCase();

    const matches = requests.filter((req) => {
      // Keyword check — any word > 3 chars from the want-ad appears in the product text
      const wantWords = `${req.title ?? ''} ${req.description ?? ''}`.toLowerCase().split(/\s+/);
      const hasKeyword = wantWords.some(w => w.length > 3 && productText.includes(w));
      if (!hasKeyword) return false;

      // Location check
      const loc = req.location?.toLowerCase() ?? 'anywhere';
      if (loc !== 'anywhere' && !newProduct.location?.toLowerCase().includes(loc)) return false;

      // Shipping check
      if (!req.shipping_ok && newProduct.shipping_available) return false;

      return true;
    });

    if (!matches.length) return;

    // Send notifications
    await Promise.allSettled(
      matches.map(async (req) => {
        const { data: profile } = await supabaseClient
          .from('profiles')
          .select('email')
          .eq('id', req.user_id)
          .maybeSingle();

        if (!profile?.email) return;

        await fetch(`${FUNCTIONS_URL}/send-wishlist-match`, {
          method:  'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
          },
          body: JSON.stringify({
            to:             profile.email,
            product_title:  newProduct.title,
            product_price:  newProduct.price,
            product_id:     newProduct.id,
            wishlist_title: req.title,
          }),
        });

        // Also create an in-app notification
        await supabaseClient.from('notifications').insert({
          user_id: req.user_id,
          type:    'wishlist_match',
          title:   'Item Found!',
          body:    `"${newProduct.title}" matches your want alert for "${req.title}"`,
          data:    { product_id: newProduct.id },
        });
      })
    );

    //console.log(`[checkWishlistMatches] Notified ${matches.length} user(s)`);
  } catch (err) {
    console.error('[checkWishlistMatches]', err);
  }
}

// ================================================================
// WINDOW GLOBALS (for HTML inline onclick handlers)
// ================================================================
window.createConversation     = createConversation;
window.sendMessage            = sendMessage;
window.markConversationAsRead = markConversationAsRead;
window.markMessageAsDelivered = markMessageAsDelivered;
window.startVoiceRecording    = startVoiceRecording;
window.stopVoiceRecording     = stopVoiceRecording;