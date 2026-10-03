const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const LEADERBOARD_LIMIT = 50;

// Stable, non-reversible fallback for users with no display name, so the
// leaderboard never shows emails or raw Identity ids.
function fallbackName(userId) {
  const hash = crypto.createHash('sha256').update(userId).digest('hex');
  return `Reader #${hash.slice(0, 4)}`;
}

function toEntry(row, currentUserId) {
  return {
    rank: row.rank,
    displayName: row.display_name || fallbackName(row.user_id),
    chaptersCompleted: row.chapters_completed,
    reachedAt: row.reached_at,
    isCurrentUser: row.user_id === currentUserId,
  };
}

exports.handler = async (event, context) => {
  const user = context.clientContext && context.clientContext.user;
  if (!user) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated' }) };
  }
  const userId = user.sub;

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Supabase is not configured' }) };
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const columns = 'rank, user_id, display_name, chapters_completed, reached_at';

  const [top, me] = await Promise.all([
    supabase
      .from('leaderboard')
      .select(columns)
      .order('rank', { ascending: true })
      .order('user_id', { ascending: true })
      .limit(LEADERBOARD_LIMIT),
    supabase.from('leaderboard').select(columns).eq('user_id', userId).maybeSingle(),
  ]);

  const error = top.error || me.error;
  if (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      entries: top.data.map((row) => toEntry(row, userId)),
      // The caller's own row, even if they're outside the top N; null if they
      // haven't completed any chapters yet.
      me: me.data ? toEntry(me.data, userId) : null,
    }),
  };
};
