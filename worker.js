// ============================================================
// THE DNA LEAGUE — Cloudflare Worker v3
// CORS proxy for MLB The Show 26 APIs.
//
// Routes:
//   GET /teams                          — Live Series team OVR ratings
//   GET /roster?team=LAD                — Top 5 Live Series players per team
//   GET /fa-roster?team=LAD&min=70&max=84 — All Live Series players per team within OVR range
//   GET /history?username=X&platform=Y  — Player's Diamond Dynasty game history
//   GET /gamelog?id=X                   — Full box score for a specific game
//   GET /team-breakdown?team=LAD        — SP/RP/Power/Contact/Speed/Defense averages for a team
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

    // ── GET /fa-roster?team=LAD&min=70&max=84 ─────────────────
    // Returns all Live Series players for a team within OVR range,
    // with full attribute fields for use in the FA draft room.
    // Two-step: listings.json to filter by OVR, then item.json per player for full attrs.
    if (path === '/fa-roster') {
      const teamAbbr = (url.searchParams.get('team') || '').toUpperCase();
      const min      = parseInt(url.searchParams.get('min') || '0', 10);
      const max      = parseInt(url.searchParams.get('max') || '99', 10);
      if (!teamAbbr) return json({ error: 'team parameter required' }, 400);
      if (isNaN(min) || isNaN(max)) return json({ error: 'min and max must be integers' }, 400);

      const apiTeam = TEAM_MAP[teamAbbr] || teamAbbr;

      try {
        // Step 1: Fetch up to 3 pages of listings to get UUIDs + OVR for filtering
        const pages = [1, 2, 3];
        const listingResults = await Promise.all(pages.map(p =>
          fetch(
            `${MLB_API}/listings.json?type=mlb_card&series_id=${LIVE_SERIES}&team=${apiTeam}&sort=rank&order=desc&page=${p}`,
            { headers: { 'Accept': 'application/json', 'User-Agent': 'DNA-League-App/1.0' },
              cf: { cacheTtl: 3600, cacheEverything: true } }
          ).then(r => r.ok ? r.json() : { listings: [] }).catch(() => ({ listings: [] }))
        ));

        const allListings = listingResults.flatMap(r => r.listings || []);

        // Filter to OVR range; cap at 20 to stay well within CF subrequest limits
        const inRange = allListings
          .filter(l => l.item && l.item.uuid && l.item.ovr >= min && l.item.ovr <= max && l.item.name)
          .slice(0, 20);

        // Step 2: Fetch full item data (attrs, quirks, pitches) for each player in range
        const itemResults = await Promise.all(inRange.map(l =>
          fetch(
            `${MLB_API}/item.json?uuid=${l.item.uuid}`,
            { headers: { 'Accept': 'application/json', 'User-Agent': 'DNA-League-App/1.0' },
              cf: { cacheTtl: 3600, cacheEverything: true } }
          ).then(r => r.ok ? r.json() : null).catch(() => null)
        ));

        const players = itemResults
          .filter(i => i && i.name)
          .map(i => {
            const isPitcher = ['SP','RP','CP'].includes(i.display_position);
            const base = {
              name:     i.name,
              pos:      i.display_position || '—',
              overall:  i.ovr,
              series:   i.series || 'Live Series',
              rarity:   i.rarity || '',
              bats:     i.bat_hand || '',
              throws:   i.throw_hand || '',
              quirks:   (Array.isArray(i.quirks) ? i.quirks : []).map(q => q.name || q).filter(Boolean),
            };
            if (isPitcher) {
              return {
                ...base,
                stamina:         i.stamina        || 0,
                pitching_clutch: i.pitching_clutch || 0,
                hits_per_bf_l:   i.hits_per_bf_left  || 0,
                hits_per_bf_r:   i.hits_per_bf_right || 0,
                k_per_bf_l:      i.k_per_bf_left     || 0,
                k_per_bf_r:      i.k_per_bf_right    || 0,
                bb_per_bf:       i.bb_per_bf       || 0,
                hr_per_bf:       i.hr_per_bf       || 0,
                velocity:        i.pitch_velocity  || 0,
                control:         i.pitch_control   || 0,
                break_rating:    i.pitch_movement  || 0,
                pitch_arsenal: (Array.isArray(i.pitches) ? i.pitches : []).map(p => ({
                  name:  p.name     || '',
                  speed: p.speed    || 0,
                  break: p.movement || 0,
                })).filter(p => p.name),
              };
            } else {
              return {
                ...base,
                contact_left:     i.contact_left        || 0,
                contact_right:    i.contact_right       || 0,
                power_left:       i.power_left          || 0,
                power_right:      i.power_right         || 0,
                plate_vision:     i.plate_vision        || 0,
                plate_discipline: i.plate_discipline    || 0,
                clutch:           i.batting_clutch      || 0,
                speed:            i.speed               || 0,
                stealing:         i.base_stealing       || 0,
                fielding:         i.fielding_ability    || 0,
                arm_strength:     i.arm_strength        || 0,
                arm_accuracy:     i.arm_accuracy        || 0,
              };
            }
          });

        return json({ team: teamAbbr, min, max, players, source: 'mlb26-item' });

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

    // ── GET /team-breakdown?team=LAD ──────────────────────────
    // Returns SP/RP/Power/Contact/Speed/Defense category averages
    // based on representative Live Series players for the team.
    // Two-step: 2 pages of listings → item API for selected players.
    if (path === '/team-breakdown') {
      const teamAbbr = (url.searchParams.get('team') || '').toUpperCase();
      if (!teamAbbr) return json({ error: 'team parameter required' }, 400);

      const apiTeam = TEAM_MAP[teamAbbr] || teamAbbr;

      try {
        // Step 1: Fetch 2 pages of listings (≈40 players sorted by rank)
        const [page1, page2] = await Promise.all([1, 2].map(p =>
          fetch(
            `${MLB_API}/listings.json?type=mlb_card&series_id=${LIVE_SERIES}&team=${apiTeam}&sort=rank&order=desc&page=${p}`,
            { headers: { 'Accept': 'application/json', 'User-Agent': 'DNA-League-App/1.0' },
              cf: { cacheTtl: 3600, cacheEverything: true } }
          ).then(r => r.ok ? r.json() : { listings: [] }).catch(() => ({ listings: [] }))
        ));

        const allPlayers = [...(page1.listings || []), ...(page2.listings || [])]
          .filter(l => l.item && l.item.uuid && l.item.ovr && l.item.name)
          .map(l => ({ uuid: l.item.uuid, ovr: l.item.ovr, pos: l.item.display_position || '' }));

        // Step 2: Select target player set
        const PITCHER_POS  = ['SP', 'RP', 'CP'];
        const HITTER_SLOTS = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'];

        const pitchers = allPlayers.filter(p => PITCHER_POS.includes(p.pos));
        const hitters  = allPlayers.filter(p => !PITCHER_POS.includes(p.pos));

        const topSPs = pitchers.filter(p => p.pos === 'SP').slice(0, 5);
        const topRPs = pitchers.filter(p => p.pos === 'RP' || p.pos === 'CP').slice(0, 7);

        // Best card at each of the 8 primary hitter positions
        const selectedHitters = [];
        const selectedUuids   = new Set();
        for (const slot of HITTER_SLOTS) {
          const best = hitters.find(p => p.pos === slot && !selectedUuids.has(p.uuid));
          if (best) { selectedHitters.push(best); selectedUuids.add(best.uuid); }
        }
        // 9th hitter: best DH, or next highest hitter not already selected
        const ninthHitter = hitters.find(p => p.pos === 'DH' && !selectedUuids.has(p.uuid))
                         || hitters.find(p => !selectedUuids.has(p.uuid));
        if (ninthHitter) selectedHitters.push(ninthHitter);

        const targets = [...topSPs, ...topRPs, ...selectedHitters];

        // Step 3: Fetch item API for each selected player
        const items = await Promise.all(targets.map(p =>
          fetch(
            `${MLB_API}/item.json?uuid=${p.uuid}`,
            { headers: { 'Accept': 'application/json', 'User-Agent': 'DNA-League-App/1.0' },
              cf: { cacheTtl: 3600, cacheEverything: true } }
          ).then(r => r.ok ? r.json() : null).catch(() => null)
        ));

        // Step 4: Calculate category averages
        const spItems     = items.slice(0, topSPs.length).filter(Boolean);
        const rpItems     = items.slice(topSPs.length, topSPs.length + topRPs.length).filter(Boolean);
        const hitterItems = items.slice(topSPs.length + topRPs.length).filter(Boolean);

        function avg(vals) {
          const v = vals.filter(x => x != null);
          return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : null;
        }

        const breakdown = {
          sp:      avg(spItems.map(i => i.ovr)),
          rp:      avg(rpItems.map(i => i.ovr)),
          power:   avg(hitterItems.map(i => i.power_left != null && i.power_right != null
                        ? Math.round((i.power_left + i.power_right) / 2) : null)),
          contact: avg(hitterItems.map(i => i.contact_left != null && i.contact_right != null
                        ? Math.round((i.contact_left + i.contact_right) / 2) : null)),
          speed:   avg(hitterItems.map(i => i.speed   != null ? i.speed           : null)),
          defense: avg(hitterItems.map(i => i.fielding_ability != null ? i.fielding_ability : null)),
        };

        return json({ team: teamAbbr, breakdown, source: 'mlb26-item' });

      } catch(e) {
        return json({ error: e.message }, 500);
      }
    }

    return json({ error: 'Unknown endpoint. Use /roster?team=LAD, /fa-roster?team=LAD&min=70&max=84, /teams, /team-breakdown?team=LAD, /history?username=X&platform=Y, or /gamelog?id=X' }, 404);
  }
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS,
  });
}
