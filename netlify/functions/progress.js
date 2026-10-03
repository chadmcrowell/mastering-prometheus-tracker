const { createClient } = require('@supabase/supabase-js');

const TOTAL_CHAPTERS = 15;
const MAX_DISPLAY_NAME_LENGTH = 40;

// Bidi overrides/isolates (U+202A–202E, U+2066–2069) can visually reverse text,
// e.g. to impersonate another reader's name.
const UNSAFE_NAME_CHARS = /[\p{Cc}‪-‮⁦-⁩]/gu;

// Shown on the leaderboard (never the email). Comes from the JWT, not the
// request body, so users can't set someone else's name through this endpoint.
// full_name is user-editable via the Identity API, so it's sanitized here
// rather than trusted. Returns null when unset, which the leaderboard shows
// as an anonymous "Reader #xxxx".
function displayNameFromIdentity(user) {
  const fullName = user.user_metadata && user.user_metadata.full_name;
  if (typeof fullName !== 'string') return null;
  // Whitespace first, so newlines/tabs (also \p{Cc}) become spaces, not nothing.
  const cleaned = fullName.replace(/\s+/g, ' ').replace(UNSAFE_NAME_CHARS, '').trim();
  // Array.from splits by code point, so truncation never cuts an emoji in half.
  return Array.from(cleaned).slice(0, MAX_DISPLAY_NAME_LENGTH).join('').trim() || null;
}

exports.handler = async (event, context) => {
  const user = context.clientContext && context.clientContext.user;
  if (!user) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated' }) };
  }
  const userId = user.sub;

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Supabase is not configured' }) };
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  if (event.httpMethod === 'GET') {
    const { data, error } = await supabase
      .from('reading_progress')
      .select('chapters, updated_at')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }

    return {
      statusCode: 200,
      body: JSON.stringify(
        data
          ? { chapters: data.chapters, updatedAt: Number(data.updated_at) }
          : { chapters: null, updatedAt: 0 }
      ),
    };
  }

  if (event.httpMethod === 'POST') {
    let payload;
    try {
      payload = JSON.parse(event.body || '{}');
    } catch (e) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
    }

    const { chapters, updatedAt } = payload;
    const isValid =
      Array.isArray(chapters) &&
      chapters.length === TOTAL_CHAPTERS &&
      chapters.every((c) => typeof c === 'boolean') &&
      typeof updatedAt === 'number';

    if (!isValid) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid payload' }) };
    }

    const { error } = await supabase.from('reading_progress').upsert(
      {
        user_id: userId,
        chapters,
        updated_at: updatedAt,
        display_name: displayNameFromIdentity(user),
      },
      { onConflict: 'user_id' }
    );

    if (error) {
      return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  // Re-syncs display_name from the caller's (freshly refreshed) JWT after they
  // edit their name, without touching chapters — re-POSTing progress here could
  // overwrite newer progress saved from another device. A user with no row yet
  // isn't on the leaderboard; their first POST will set the name.
  if (event.httpMethod === 'PATCH') {
    const displayName = displayNameFromIdentity(user);
    const { error } = await supabase
      .from('reading_progress')
      .update({ display_name: displayName })
      .eq('user_id', userId);

    if (error) {
      return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }

    return { statusCode: 200, body: JSON.stringify({ displayName }) };
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
};
