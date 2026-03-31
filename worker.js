// ============================================================
// THE DNA LEAGUE — Cloudflare Worker v3
// CORS proxy for MLB The Show 26 APIs.
//
// Routes:
//   GET /teams                          — Live Series team OVR ratings
//   GET /roster?team=LAD                — Top 5 Live Series players per team
//   GET /history?username=X&platform=Y  — Player's Diamond Dynasty game history
//   GET /gamelog?id=X                   — Full box score for a specific game
//
// Deploy at: https://dash.cloudflare.com/workers
// ============================================================

const MLB_API      = 'https://mlb26.theshow.com/apis';
const LIVE_SERIES  = '1337'; // confirmed series_id for Live Series cards

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

// Map our abbreviations to the exact team values the API expects
const TEAM_MAP = {
  ARI:'ARI', ATL:'ATL', BAL:'BAL', BOS:'BOS',
  CHC:'CHC', CWS:'CWS', CIN:'CIN', CLE:'CLE',
  COL:'COL', DET:'DET', HOU:'HOU', KC:'KC',
  LAA:'LAA', LAD:'LAD', MIA:'MIA', MIL:'MIL',
  MIN:'MIN', NYM:'NYM', NYY:'NYY', OAK:'OAK',
  PHI:'PHI', PIT:'PIT', SD:'SD',  SF:'SF',
  SEA:'SEA', STL:'STL', TB:'TB',  TEX:'TEX',
  TOR:'TOR', WSH:'WAS', // WSH in our app = WAS in the API
};

export default {
  async fetch(request) {

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url  = new URL(request.url);
    const path = url.pathname;

    // ── GET /roster?team=LAD ──────────────────────────────────
    if (path === '/roster') {
      const teamAbbr = (url.searchParams.get('team') || '').toUpperCase();
      if (!teamAbbr) return json({ error: 'team parameter required' }, 400);

      const apiTeam = TEAM_MAP[teamAbbr] || teamAbbr;

      try {
        const apiUrl = `${MLB_API}/listings.json?type=mlb_card&series_id=${LIVE_SERIES}&team=${apiTeam}&sort=rank&order=desc&page=1`;

        const res = await fetch(apiUrl, {
          headers: { 'Accept': 'application/json', 'User-Agent': 'DNA-League-App/1.0' },
          cf: { cacheTtl: 3600, cacheEverything: true },
        });

        if (!res.ok) throw new Error(`MLB API returned ${res.status}`);

        const data     = await res.json();
        const listings = data.listings || [];

        const players = listings
          .filter(l => l.item && l.item.ovr && l.item.name)
          .slice(0, 5)
          .map(l => ({
            name:    l.item.name,
            pos:     l.item.display_position || '—',
            overall: l.item.ovr,
            series:  l.item.series || 'Live Series',
            rarity:  l.item.rarity || '',
          }));

        return json({ team: teamAbbr, players, source: 'mlb26-listings' });

      } catch(e) {
        return json({ error: e.message }, 500);
      }
    }

    // ── GET /teams ────────────────────────────────────────────
    if (path === '/teams') {
      try {
        const teams = {};
        const abbrs = Object.keys(TEAM_MAP);
        const BATCH = 6;

        for (let i = 0; i < abbrs.length; i += BATCH) {
          const batch   = abbrs.slice(i, i + BATCH);
          const results = await Promise.all(batch.map(abbr => {
            const apiTeam = TEAM_MAP[abbr] || abbr;
            return fetch(
              `${MLB_API}/listings.json?type=mlb_card&series_id=${LIVE_SERIES}&team=${apiTeam}&sort=rank&order=desc&page=1`,
              {
                headers: { 'Accept': 'application/json', 'User-Agent': 'DNA-League-App/1.0' },
                cf: { cacheTtl: 3600, cacheEverything: true },
              }
            )
            .then(r => r.ok ? r.json() : { listings: [] })
            .catch(() => ({ listings: [] }));
          }));

          batch.forEach((abbr, idx) => {
            const listings = results[idx].listings || [];
            const top5 = listings
              .filter(l => l.item?.ovr)
              .slice(0, 5)
              .map(l => l.item.ovr);
            if (top5.length) {
              teams[abbr] = {
                overall: Math.round(top5.reduce((s, v) => s + v, 0) / top5.length),
              };
            }
          });
        }

        return json({ teams, source: 'mlb26-listings' });

      } catch(e) {
        return json({ error: e.message }, 500);
      }
    }

    // ── GET /history?username=X&platform=psn&page=1 ───────────
    // Proxies game_history.json filtered to Diamond Dynasty (arena) mode.
    // Short cache (5 min) since results update throughout the week.
    if (path === '/history') {
      const username = url.searchParams.get('username') || '';
      const platform = url.searchParams.get('platform') || 'psn';
      const page     = url.searchParams.get('page') || '1';
      if (!username) return json({ error: 'username required' }, 400);

      try {
        const apiUrl = `${MLB_API}/game_history.json?username=${encodeURIComponent(username)}&platform=${encodeURIComponent(platform)}&mode=arena&page=${page}`;
        const res = await fetch(apiUrl, {
          headers: { 'Accept': 'application/json', 'User-Agent': 'DNA-League-App/1.0' },
          cf: { cacheTtl: 300, cacheEverything: true },
        });
        if (!res.ok) throw new Error(`MLB API returned ${res.status}`);
        const data = await res.json();
        return json(data);
      } catch(e) {
        return json({ error: e.message }, 500);
      }
    }

    // ── GET /gamelog?id=X ────────────────────────────────────
    // Proxies game_log.json for a specific completed game.
    // Long cache (24h) since completed game data never changes.
    if (path === '/gamelog') {
      const id = url.searchParams.get('id') || '';
      if (!id) return json({ error: 'id required' }, 400);

      try {
        const apiUrl = `${MLB_API}/game_log.json?id=${encodeURIComponent(id)}`;
        const res = await fetch(apiUrl, {
          headers: { 'Accept': 'application/json', 'User-Agent': 'DNA-League-App/1.0' },
          cf: { cacheTtl: 86400, cacheEverything: true },
        });
        if (!res.ok) throw new Error(`MLB API returned ${res.status}`);
        const data = await res.json();
        return json(data);
      } catch(e) {
        return json({ error: e.message }, 500);
      }
    }

    return json({ error: 'Unknown endpoint. Use /roster?team=LAD, /teams, /history?username=X&platform=Y, or /gamelog?id=X' }, 404);
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS,
  });
}
