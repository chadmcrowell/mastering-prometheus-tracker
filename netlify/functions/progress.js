const { createClient } = require('@supabase/supabase-js');

const TOTAL_CHAPTERS = 15;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

exports.handler = async (event, context) => {
  const user = context.clientContext && context.clientContext.user;
  if (!user) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated' }) };
  }
  const userId = user.sub;

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

    const { error } = await supabase
      .from('reading_progress')
      .upsert({ user_id: userId, chapters, updated_at: updatedAt }, { onConflict: 'user_id' });

    if (error) {
      return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true }) };
  }

  return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
};
