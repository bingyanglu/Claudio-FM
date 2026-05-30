const ytDlp = require('./music-yt-dlp');

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';
const DEFAULT_TIMEOUT_MS = 10000;

let cachedToken = null;

function splitQuery(query) {
  const parts = String(query || '').split(/\s+-\s+/);
  return {
    title: parts[0]?.trim() || String(query || '').trim(),
    artist: parts.slice(1).join(' - ').trim(),
  };
}

function withTimeout(timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}

function getCredentials() {
  return {
    clientId: process.env.SPOTIFY_CLIENT_ID || '',
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
  };
}

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60000) {
    return cachedToken.accessToken;
  }

  const { clientId, clientSecret } = getCredentials();
  if (!clientId || !clientSecret) {
    throw new Error('SPOTIFY_CLIENT_ID or SPOTIFY_CLIENT_SECRET not set');
  }

  const timeout = withTimeout();
  try {
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'client_credentials' }),
      signal: timeout.signal,
    });

    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Spotify token error ${res.status}: ${body.error_description || body.error || 'unknown error'}`);
    }

    cachedToken = {
      accessToken: body.access_token,
      expiresAt: now + Number(body.expires_in || 3600) * 1000,
    };
    return cachedToken.accessToken;
  } finally {
    timeout.clear();
  }
}

async function spotifyGet(path, params = {}) {
  const token = await getAccessToken();
  const url = new URL(`${API_BASE}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const timeout = withTimeout();
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: timeout.signal,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`Spotify API error ${res.status}: ${body.error?.message || 'unknown error'}`);
    }
    return body;
  } finally {
    timeout.clear();
  }
}

function normalizeTrack(raw, query) {
  if (!raw) return null;
  const image = raw.album?.images?.[0]?.url || '';
  const artists = Array.isArray(raw.artists) ? raw.artists.map(a => a.name).filter(Boolean) : [];
  return {
    id: raw.id,
    spotifyId: raw.id,
    spotifyUri: raw.uri,
    spotifyUrl: raw.external_urls?.spotify || '',
    title: raw.name || query,
    artist: artists.join(', '),
    album: raw.album?.name || '',
    imageUrl: image,
    durationMs: raw.duration_ms || 0,
    previewUrl: raw.preview_url || '',
    query,
    source: 'spotify',
  };
}

async function searchSpotify(query) {
  const { title, artist } = splitQuery(query);
  const market = process.env.SPOTIFY_MARKET || 'US';
  const searches = [];

  if (title && artist) searches.push(`track:${title} artist:${artist}`);
  searches.push(query);

  for (const q of searches) {
    const data = await spotifyGet('/search', {
      q,
      type: 'track',
      limit: 1,
      market,
      include_external: 'audio',
    });
    const track = normalizeTrack(data?.tracks?.items?.[0], query);
    if (track) return track;
  }

  return null;
}

async function resolveStreamUrl(track) {
  const fallbackProvider = process.env.MUSIC_FALLBACK_PROVIDER || 'yt-dlp';

  if (fallbackProvider === 'yt-dlp') {
    const lookup = `${track.title}${track.artist ? ' - ' + track.artist : ''}`;
    const streamUrl = await ytDlp.getStreamUrl(lookup);
    if (streamUrl) return streamUrl;
  }

  if (process.env.SPOTIFY_ALLOW_PREVIEW === '1' && track.previewUrl) {
    return track.previewUrl;
  }

  return null;
}

async function getTrack(query) {
  try {
    const track = await searchSpotify(query);
    if (!track) return null;

    const streamUrl = await resolveStreamUrl(track);
    if (!streamUrl) {
      console.warn(`[spotify] no fallback stream; using Spotify Web Playback URI: ${track.title} - ${track.artist || 'unknown'}`);
    }

    return {
      ...track,
      streamUrl: streamUrl || '',
      lyrics: null,
    };
  } catch (err) {
    console.warn('[spotify] search failed:', err.message);
    return null;
  }
}

module.exports = {
  getAccessToken,
  getTrack,
  searchSpotify,
};
