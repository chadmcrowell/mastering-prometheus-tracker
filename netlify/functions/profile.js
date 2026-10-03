const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// Mirrors the check constraints in supabase/migrations/002_profiles.sql, which
// are the real enforcement; these exist to return friendly per-field errors.
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/;
const RESERVED_USERNAMES = new Set([
  'admin', 'api', 'edit', 'leaderboard', 'me', 'new', 'null',
  'profile', 'profiles', 'settings', 'undefined',
]);
const MAX_DISPLAY_NAME_LENGTH = 40;
const MAX_BIO_LENGTH = 500;
const MAX_URL_LENGTH = 500;

// Allowed social networks and the hosts each one's URL must point at
// (subdomains included, e.g. uk.linkedin.com). null = any https host.
const SOCIAL_HOSTS = {
  linkedin: ['linkedin.com'],
  bluesky: ['bsky.app'],
  twitter: ['x.com', 'twitter.com'],
  github: ['github.com'],
  website: null,
};

// Bidi overrides/isolates (U+202A–202E, U+2066–2069) can visually reverse text,
// e.g. to impersonate another reader's name.
const UNSAFE_CHARS = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu;
const UNSAFE_CHARS_EXCEPT_NEWLINE = /[^\P{Cc}\n]|[\u202A-\u202E\u2066-\u2069]/gu;

const PROFILE_COLUMNS =
  'user_id, username, display_name, bio, avatar_url, social_links, created_at';

function json(statusCode, body) {
  return { statusCode, body: JSON.stringify(body) };
}

function cleanSingleLine(value) {
  // Whitespace first, so newlines/tabs (also \p{Cc}) become spaces, not nothing.
  return value.replace(/\s+/g, ' ').replace(UNSAFE_CHARS, '').trim();
}

// Lengths are counted in code points, matching Postgres char_length().
function codePointLength(value) {
  return Array.from(value).length;
}

function parseHttpsUrl(value, allowedHosts) {
  let url;
  try {
    url = new URL(value);
  } catch (e) {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (allowedHosts && !allowedHosts.some((h) => host === h || host.endsWith(`.${h}`))) {
    return null;
  }
  return url.href.length <= MAX_URL_LENGTH ? url.href : null;
}

// Accepts a full bsky.app URL or a bare handle ("@name.bsky.social",
// "name.example.com") and normalizes handles to their profile URL.
function normalizeBluesky(value) {
  const handle = value.replace(/^@/, '');
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(handle)) {
    return `https://bsky.app/profile/${handle.toLowerCase()}`;
  }
  return value;
}

// Returns { profile } with the cleaned row to save, or { errors } keyed by
// form field name.
function validateProfileInput(input) {
  const errors = {};
  const profile = {};

  const username = typeof input.username === 'string' ? input.username.trim().toLowerCase() : '';
  if (!USERNAME_PATTERN.test(username)) {
    errors.username =
      'Use 3–30 lowercase letters, numbers, or hyphens, starting and ending with a letter or number.';
  } else if (RESERVED_USERNAMES.has(username)) {
    errors.username = 'That username is reserved.';
  }
  profile.username = username;

  const displayName =
    typeof input.displayName === 'string' ? cleanSingleLine(input.displayName) : '';
  if (codePointLength(displayName) > MAX_DISPLAY_NAME_LENGTH) {
    errors.displayName = `Keep it to ${MAX_DISPLAY_NAME_LENGTH} characters or fewer.`;
  }
  profile.display_name = displayName || null;

  const bio =
    typeof input.bio === 'string'
      ? input.bio
          .replace(/\r\n?/g, '\n')
          .replace(/\t/g, ' ')
          .replace(UNSAFE_CHARS_EXCEPT_NEWLINE, '')
          .trim()
      : '';
  if (codePointLength(bio) > MAX_BIO_LENGTH) {
    errors.bio = `Keep it to ${MAX_BIO_LENGTH} characters or fewer.`;
  }
  profile.bio = bio || null;

  const avatarUrl = typeof input.avatarUrl === 'string' ? input.avatarUrl.trim() : '';
  if (avatarUrl) {
    profile.avatar_url = parseHttpsUrl(avatarUrl, null);
    if (!profile.avatar_url) errors.avatarUrl = 'Enter a full https:// image URL.';
  } else {
    profile.avatar_url = null;
  }

  const links = input.socialLinks && typeof input.socialLinks === 'object' ? input.socialLinks : {};
  profile.social_links = {};
  Object.keys(links).forEach((key) => {
    if (!Object.prototype.hasOwnProperty.call(SOCIAL_HOSTS, key)) {
      errors[`social.${key}`] = 'Unsupported link type.';
      return;
    }
    let value = typeof links[key] === 'string' ? links[key].trim() : '';
    if (!value) return;
    if (key === 'bluesky') value = normalizeBluesky(value);
    const url = parseHttpsUrl(value, SOCIAL_HOSTS[key]);
    if (url) {
      profile.social_links[key] = url;
    } else {
      errors[`social.${key}`] = SOCIAL_HOSTS[key]
        ? `Enter an https:// link on ${SOCIAL_HOSTS[key].join(' or ')}.`
        : 'Enter a full https:// URL.';
    }
  });

  return Object.keys(errors).length ? { errors } : { profile };
}

// Public shape: never includes the Identity user id or email.
function toPublicProfile(row, chaptersCompleted) {
  return {
    username: row.username,
    displayName: row.display_name,
    bio: row.bio,
    avatarUrl: row.avatar_url,
    socialLinks: row.social_links || {},
    joinedAt: row.created_at,
    chaptersCompleted,
  };
}

// Pre-fills the form for someone creating their profile for the first time,
// from the Identity signup "Name" when it makes a usable username.
function suggestedProfile(user) {
  const fullName =
    user.user_metadata && typeof user.user_metadata.full_name === 'string'
      ? cleanSingleLine(user.user_metadata.full_name)
      : '';
  const slug = fullName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '');
  const hash = crypto.createHash('sha256').update(user.sub).digest('hex');
  const username =
    USERNAME_PATTERN.test(slug) && !RESERVED_USERNAMES.has(slug) ? slug : `reader-${hash.slice(0, 6)}`;
  return {
    username,
    displayName: Array.from(fullName).slice(0, MAX_DISPLAY_NAME_LENGTH).join('') || null,
  };
}

async function countCompletedChapters(supabase, userId) {
  const { count, error } = await supabase
    .from('chapter_completions')
    .select('chapter_number', { count: 'exact', head: true })
    .eq('user_id', userId);
  if (error) throw error;
  return count || 0;
}

exports.handler = async (event, context) => {
  const user = (context.clientContext && context.clientContext.user) || null;
  const params = event.queryStringParameters || {};

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return json(500, { error: 'Supabase is not configured' });
  }
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  try {
    // GET ?username=x — public, no login needed.
    if (event.httpMethod === 'GET' && params.username) {
      const username = String(params.username).toLowerCase();
      if (!USERNAME_PATTERN.test(username)) {
        return json(404, { error: 'Profile not found' });
      }
      const { data, error } = await supabase
        .from('profiles')
        .select(PROFILE_COLUMNS)
        .eq('username', username)
        .maybeSingle();
      if (error) throw error;
      if (!data) return json(404, { error: 'Profile not found' });
      const chaptersCompleted = await countCompletedChapters(supabase, data.user_id);
      return json(200, toPublicProfile(data, chaptersCompleted));
    }

    if (!user) return json(401, { error: 'Not authenticated' });

    // GET ?me=1 — the caller's own profile (null if they haven't created one),
    // plus suggested values for a first-time profile form.
    if (event.httpMethod === 'GET' && params.me) {
      const { data, error } = await supabase
        .from('profiles')
        .select(PROFILE_COLUMNS)
        .eq('user_id', user.sub)
        .maybeSingle();
      if (error) throw error;
      const profile = data
        ? toPublicProfile(data, await countCompletedChapters(supabase, user.sub))
        : null;
      return json(200, { profile, suggested: profile ? null : suggestedProfile(user) });
    }

    // PUT — create or update the caller's own profile. The row is always keyed
    // by the verified JWT `sub`, never by anything in the request body.
    if (event.httpMethod === 'PUT') {
      let input;
      try {
        input = JSON.parse(event.body || '{}');
      } catch (e) {
        return json(400, { error: 'Invalid JSON' });
      }
      const { profile, errors } = validateProfileInput(input || {});
      if (errors) return json(400, { error: 'Invalid profile', errors });

      const { data, error } = await supabase
        .from('profiles')
        .upsert({ user_id: user.sub, ...profile }, { onConflict: 'user_id' })
        .select(PROFILE_COLUMNS)
        .single();
      if (error && error.code === '23505') {
        return json(409, { error: 'Invalid profile', errors: { username: 'That username is taken.' } });
      }
      if (error) throw error;
      const chaptersCompleted = await countCompletedChapters(supabase, user.sub);
      return json(200, toPublicProfile(data, chaptersCompleted));
    }

    return json(405, { error: 'Method not allowed' });
  } catch (error) {
    return json(500, { error: error.message });
  }
};
