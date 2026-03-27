// ============================================================
// THE DNA LEAGUE — ratings.js
// Team and player ratings fetcher.
// Abstracted by sport/game so future games (NHL, NBA) can
// plug in with minimal changes.
// ============================================================

const DnaRatings = (() => {

  // ── CACHE ─────────────────────────────────────────────────
  const _cache = {
    teams:   null,       // { abbr: { overall, topPlayers } }
    players: {},         // { teamAbbr: [...players] }
    fetchedAt: null,
  };

  const CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour

  function _isCacheValid() {
    return _cache.fetchedAt && (Date.now() - _cache.fetchedAt) < CACHE_TTL_MS;
  }

  // ── SPORT ADAPTERS ────────────────────────────────────────
  // Each adapter exposes { fetchTeams(), fetchRoster(teamAbbr) }
  // Add new sports here following the same interface.

  const adapters = {

    mlbtheshow: {
      baseUrl: 'https://mlb26.theshow.com/apis',

      async fetchTeams() {
        return _getStaticMLBRatings();
      },

      // The Items API only supports type + page — no team filter.
      // We fetch multiple pages and filter by team_short_name client-side.
      // We stop early once we have 5+ Live Series cards for the team.
      async fetchRoster(teamAbbr) {
        const MAX_PAGES  = 15; // cap to avoid too many requests
        const PER_PAGE   = 25; // items per page (API default is 25)
        const liveCards  = [];

        try {
          // First check: how many total pages are there?
          const firstUrl = `${this.baseUrl}/items.json?type=mlb_card&page=1`;
          const firstRes = await fetch(firstUrl, {
            signal:  AbortSignal.timeout(8000),
            headers: { 'Accept': 'application/json' },
          });
          if (!firstRes.ok) throw new Error(`HTTP ${firstRes.status}`);
          const firstData = await firstRes.json();
          const totalPages = Math.min(firstData.total_pages || 1, MAX_PAGES);

          // Process first page
          this._filterLiveCards(firstData.items || [], teamAbbr, liveCards);
          if (liveCards.length >= 5) {
            return _parseMLBShowRoster(liveCards);
          }

          // Fetch remaining pages in parallel batches of 5
          const BATCH = 5;
          for (let startPage = 2; startPage <= totalPages; startPage += BATCH) {
            const endPage = Math.min(startPage + BATCH - 1, totalPages);
            const batch = [];
            for (let p = startPage; p <= endPage; p++) {
              batch.push(
                fetch(`${this.baseUrl}/items.json?type=mlb_card&page=${p}`, {
                  signal: AbortSignal.timeout(8000),
                  headers: { 'Accept': 'application/json' },
                })
                .then(r => r.ok ? r.json() : { items: [] })
                .catch(() => ({ items: [] }))
              );
            }
            const results = await Promise.all(batch);
            for (const data of results) {
              this._filterLiveCards(data.items || [], teamAbbr, liveCards);
            }
            if (liveCards.length >= 5) break;
          }

          if (liveCards.length > 0) {
            console.log(`MLB The Show 26 API: ${liveCards.length} Live Series cards for ${teamAbbr}`);
            return _parseMLBShowRoster(liveCards);
          }
        } catch(e) {
          console.warn(`MLB The Show 26 API error for ${teamAbbr}:`, e.message);
        }

        console.warn(`Falling back to static data for ${teamAbbr}`);
        return _getStaticRoster(teamAbbr);
      },

      // Filter items matching this team's Live Series cards into the array
      _filterLiveCards(items, teamAbbr, out) {
        for (const item of items) {
          if (!item.ovr || !item.name) continue;
          // Match team by short name (e.g. "LAD", "NYY")
          const teamMatch = item.team_short_name === teamAbbr ||
                           item.team === teamAbbr;
          if (!teamMatch) continue;
          // Only Live Series cards
          const series = (item.series || '').toLowerCase();
          const isLive = series.includes('live series') ||
                        series.includes('live_series') ||
                        series === 'live';
          if (isLive) out.push(item);
        }
      },
    },

    // ── FUTURE SPORT ADAPTERS ────────────────────────────────
    // nhl_chel: { fetchTeams() {}, fetchRoster(teamAbbr) {} },
    // nba2k:    { fetchTeams() {}, fetchRoster(teamAbbr) {} },
  };

  // ── STATIC SEED DATA (MLB The Show 26 approximate overalls) ─
  // Used as fallback when API is unavailable or rate-limited.
  // Keyed by MLB team abbreviation.
  const STATIC_OVERALLS = {
    LAD: 93, NYY: 91, ATL: 90, PHI: 90, HOU: 89,
    BAL: 88, CLE: 88, KC:  87, SD:  87, MIN: 87,
    BOS: 86, NYM: 86, TOR: 85, MIL: 85, SEA: 84,
    DET: 84, TEX: 83, ARI: 83, STL: 82, CHC: 82,
    TB:  81, CIN: 81, SF:  80, PIT: 80, MIA: 79,
    WSH: 78, COL: 77, OAK: 76, LAA: 75, CWS: 72,
  };

  // Static top-5 players per team (2025 approximate)
  const STATIC_ROSTERS = {
    LAD: [
      { name:'Shohei Ohtani',    pos:'DH', overall:99 },
      { name:'Freddie Freeman',  pos:'1B', overall:92 },
      { name:'Mookie Betts',     pos:'RF', overall:91 },
      { name:'Yoshinobu Yamamoto',pos:'SP',overall:89 },
      { name:'Tyler Glasnow',    pos:'SP', overall:87 },
    ],
    NYY: [
      { name:'Aaron Judge',      pos:'CF', overall:99 },
      { name:'Juan Soto',        pos:'RF', overall:94 },
      { name:'Gerrit Cole',      pos:'SP', overall:89 },
      { name:'Jazz Chisholm',    pos:'3B', overall:84 },
      { name:'Paul Goldschmidt', pos:'1B', overall:82 },
    ],
    ATL: [
      { name:'Ronald Acuña Jr.', pos:'RF', overall:97 },
      { name:'Matt Olson',       pos:'1B', overall:88 },
      { name:'Austin Riley',     pos:'3B', overall:87 },
      { name:'Spencer Strider',  pos:'SP', overall:86 },
      { name:'Ozzie Albies',     pos:'2B', overall:85 },
    ],
    HOU: [
      { name:'José Altuve',      pos:'2B', overall:88 },
      { name:'Yordan Alvarez',   pos:'DH', overall:95 },
      { name:'Kyle Tucker',      pos:'RF', overall:90 },
      { name:'Framber Valdez',   pos:'SP', overall:86 },
      { name:'Alex Bregman',     pos:'3B', overall:85 },
    ],
    PHI: [
      { name:'Bryce Harper',     pos:'1B', overall:96 },
      { name:'Trea Turner',      pos:'SS', overall:89 },
      { name:'Zack Wheeler',     pos:'SP', overall:92 },
      { name:'Aaron Nola',       pos:'SP', overall:87 },
      { name:'Nick Castellanos', pos:'RF', overall:82 },
    ],
    SD: [
      { name:'Fernando Tatis Jr.',pos:'SS',overall:93 },
      { name:'Manny Machado',    pos:'3B', overall:90 },
      { name:'Dylan Cease',      pos:'SP', overall:88 },
      { name:'Xander Bogaerts',  pos:'SS', overall:85 },
      { name:'Jackson Merrill',  pos:'CF', overall:81 },
    ],
    BOS: [
      { name:'Rafael Devers',    pos:'3B', overall:91 },
      { name:'Jarren Duran',     pos:'CF', overall:84 },
      { name:'Triston Casas',    pos:'1B', overall:82 },
      { name:'Brayan Bello',     pos:'SP', overall:80 },
      { name:'Masataka Yoshida', pos:'DH', overall:83 },
    ],
    MIN: [
      { name:'Byron Buxton',     pos:'CF', overall:87 },
      { name:'Carlos Correa',    pos:'SS', overall:86 },
      { name:'Joe Ryan',         pos:'SP', overall:83 },
      { name:'Pablo López',      pos:'SP', overall:85 },
      { name:'Royce Lewis',      pos:'3B', overall:84 },
    ],
    NYM: [
      { name:'Francisco Lindor', pos:'SS', overall:91 },
      { name:'Pete Alonso',      pos:'1B', overall:87 },
      { name:'Sean Manaea',      pos:'SP', overall:82 },
      { name:'Brandon Nimmo',    pos:'CF', overall:83 },
      { name:'David Peterson',   pos:'SP', overall:79 },
    ],
    TB: [
      { name:'Yandy Díaz',       pos:'1B', overall:84 },
      { name:'Shane McClanahan', pos:'SP', overall:88 },
      { name:'Isaac Paredes',    pos:'3B', overall:83 },
      { name:'Zach Eflin',       pos:'SP', overall:82 },
      { name:'Brandon Lowe',     pos:'2B', overall:80 },
    ],
    BAL: [
      { name:'Gunnar Henderson', pos:'SS', overall:91 },
      { name:'Adley Rutschman',  pos:'C',  overall:90 },
      { name:'Corbin Burnes',    pos:'SP', overall:90 },
      { name:'Anthony Santander',pos:'RF', overall:85 },
      { name:'Ryan Mountcastle', pos:'1B', overall:82 },
    ],
    CLE: [
      { name:'José Ramírez',     pos:'3B', overall:95 },
      { name:'Shane Bieber',     pos:'SP', overall:85 },
      { name:'Josh Naylor',      pos:'1B', overall:82 },
      { name:'Emmanuel Clase',   pos:'CL', overall:89 },
      { name:'Steven Kwan',      pos:'LF', overall:83 },
    ],
    TEX: [
      { name:'Corey Seager',     pos:'SS', overall:92 },
      { name:'Marcus Semien',    pos:'2B', overall:87 },
      { name:'Jacob deGrom',     pos:'SP', overall:88 },
      { name:'Nathan Eovaldi',   pos:'SP', overall:84 },
      { name:'Jonah Heim',       pos:'C',  overall:80 },
    ],
    TOR: [
      { name:'Vladimir Guerrero Jr.',pos:'1B',overall:91 },
      { name:'Bo Bichette',      pos:'SS', overall:87 },
      { name:'Kevin Gausman',    pos:'SP', overall:86 },
      { name:'George Springer',  pos:'CF', overall:84 },
      { name:'Alejandro Kirk',   pos:'C',  overall:82 },
    ],
    MIL: [
      { name:'Willy Adames',     pos:'SS', overall:86 },
      { name:'Christian Yelich', pos:'LF', overall:85 },
      { name:'Corbin Burnes',    pos:'SP', overall:90 },
      { name:'Freddy Peralta',   pos:'SP', overall:84 },
      { name:'William Contreras',pos:'C',  overall:84 },
    ],
    SEA: [
      { name:'Julio Rodríguez',  pos:'CF', overall:91 },
      { name:'Logan Gilbert',    pos:'SP', overall:87 },
      { name:'Luis Castillo',    pos:'SP', overall:88 },
      { name:'Eugenio Suárez',   pos:'3B', overall:81 },
      { name:'Cal Raleigh',      pos:'C',  overall:82 },
    ],
    ARI: [
      { name:'Ketel Marte',      pos:'2B', overall:88 },
      { name:'Corbin Carroll',   pos:'CF', overall:87 },
      { name:'Zac Gallen',       pos:'SP', overall:86 },
      { name:'Lourdes Gurriel Jr.',pos:'LF',overall:82},
      { name:'Merrill Kelly',    pos:'SP', overall:82 },
    ],
    STL: [
      { name:'Nolan Arenado',    pos:'3B', overall:89 },
      { name:'Paul Goldschmidt', pos:'1B', overall:87 },
      { name:'Sonny Gray',       pos:'SP', overall:86 },
      { name:'Willson Contreras',pos:'C',  overall:83 },
      { name:'Lars Nootbaar',    pos:'RF', overall:81 },
    ],
    CHC: [
      { name:'Cody Bellinger',   pos:'CF', overall:84 },
      { name:'Dansby Swanson',   pos:'SS', overall:83 },
      { name:'Justin Steele',    pos:'SP', overall:85 },
      { name:'Seiya Suzuki',     pos:'RF', overall:83 },
      { name:'Ian Happ',         pos:'LF', overall:82 },
    ],
    DET: [
      { name:'Riley Greene',     pos:'CF', overall:83 },
      { name:'Tarik Skubal',     pos:'SP', overall:91 },
      { name:'Spencer Torkelson',pos:'1B', overall:81 },
      { name:'Jake Rogers',      pos:'C',  overall:78 },
      { name:'Casey Mize',       pos:'SP', overall:80 },
    ],
    KC: [
      { name:'Bobby Witt Jr.',   pos:'SS', overall:91 },
      { name:'Salvador Perez',   pos:'C',  overall:85 },
      { name:'Seth Lugo',        pos:'SP', overall:83 },
      { name:'MJ Melendez',      pos:'LF', overall:80 },
      { name:'Brady Singer',     pos:'SP', overall:81 },
    ],
    CIN: [
      { name:'Elly De La Cruz',  pos:'SS', overall:88 },
      { name:'Spencer Steer',    pos:'3B', overall:82 },
      { name:'Tyler Stephenson', pos:'C',  overall:81 },
      { name:'Hunter Greene',    pos:'SP', overall:84 },
      { name:'Graham Ashcraft',  pos:'SP', overall:79 },
    ],
    SF: [
      { name:'Matt Chapman',     pos:'3B', overall:84 },
      { name:'Logan Webb',       pos:'SP', overall:88 },
      { name:'Jorge Soler',      pos:'DH', overall:83 },
      { name:'Heliot Ramos',     pos:'RF', overall:80 },
      { name:'Tyler Rogers',     pos:'RP', overall:79 },
    ],
    MIA: [
      { name:'Jazz Chisholm Jr.',pos:'CF', overall:84 },
      { name:'Sandy Alcantara',  pos:'SP', overall:87 },
      { name:'Luis Arraez',      pos:'1B', overall:87 },
      { name:'Bryan De La Cruz', pos:'RF', overall:81 },
      { name:'Jake Burger',      pos:'3B', overall:80 },
    ],
    COL: [
      { name:'Ryan McMahon',     pos:'3B', overall:82 },
      { name:'Ezequiel Tovar',   pos:'SS', overall:81 },
      { name:'Kyle Freeland',    pos:'SP', overall:79 },
      { name:'Charlie Blackmon', pos:'RF', overall:77 },
      { name:'Brenton Doyle',    pos:'CF', overall:78 },
    ],
    OAK: [
      { name:'Brent Rooker',     pos:'DH', overall:82 },
      { name:'Mason Miller',     pos:'CL', overall:85 },
      { name:'Lawrence Butler',  pos:'LF', overall:79 },
      { name:'JJ Bleday',        pos:'RF', overall:78 },
      { name:'Paul Blackburn',   pos:'SP', overall:76 },
    ],
    PIT: [
      { name:'Paul Skenes',      pos:'SP', overall:88 },
      { name:'Oneil Cruz',       pos:'SS', overall:83 },
      { name:'Bryan Reynolds',   pos:'CF', overall:84 },
      { name:'Mitch Keller',     pos:'SP', overall:82 },
      { name:'Joey Bart',        pos:'C',  overall:78 },
    ],
    WSH: [
      { name:'CJ Abrams',        pos:'SS', overall:83 },
      { name:'MacKenzie Gore',   pos:'SP', overall:82 },
      { name:'Joey Gallo',       pos:'LF', overall:78 },
      { name:'Patrick Corbin',   pos:'SP', overall:74 },
      { name:'Alex Call',        pos:'CF', overall:76 },
    ],
    LAA: [
      { name:'Mike Trout',       pos:'CF', overall:87 },
      { name:'Anthony Rendon',   pos:'3B', overall:75 },
      { name:'Tyler Anderson',   pos:'SP', overall:79 },
      { name:'Hunter Renfroe',   pos:'RF', overall:78 },
      { name:'Logan O\'Hoppe',   pos:'C',  overall:80 },
    ],
    CWS: [
      { name:'Luis Robert Jr.',  pos:'CF', overall:88 },
      { name:'Andrew Vaughn',    pos:'1B', overall:80 },
      { name:'Garrett Crochet',  pos:'SP', overall:84 },
      { name:'Dylan Cease',      pos:'SP', overall:84 },
      { name:'Yoán Moncada',     pos:'3B', overall:78 },
    ],
  };

  function _getStaticMLBRatings() {
    const result = {};
    DNA_CONFIG.mlbTeams.forEach(t => {
      result[t.abbr] = {
        name:     t.name,
        abbr:     t.abbr,
        overall:  STATIC_OVERALLS[t.abbr] || 75,
        league:   t.league,
        division: t.division,
      };
    });
    return result;
  }

  function _getStaticRoster(abbr) {
    return STATIC_ROSTERS[abbr] || [];
  }

  function _parseMLBShowRoster(items) {
    // Field names confirmed from MLB The Show 26 Item API docs:
    // ovr, name, display_position, series, team_short_name
    return items
      .filter(i => i.ovr && i.name)
      .sort((a, b) => b.ovr - a.ovr)
      .slice(0, 5)
      .map(i => ({
        name:    i.name,
        pos:     i.display_position || '—',
        overall: i.ovr,
        series:  i.series || '',
        rarity:  i.rarity || '',
      }));
  }

  // ── PUBLIC API ────────────────────────────────────────────

  async function getTeamRatings() {
    if (_isCacheValid() && _cache.teams) return _cache.teams;
    const adapter = adapters[DNA_CONFIG.ratings.game] || adapters.mlbtheshow;
    const teams = await adapter.fetchTeams();
    _cache.teams = teams;
    _cache.fetchedAt = Date.now();
    return teams;
  }

  async function getTeamRoster(teamAbbr) {
    if (_cache.players[teamAbbr]) return _cache.players[teamAbbr];
    const adapter = adapters[DNA_CONFIG.ratings.game] || adapters.mlbtheshow;
    const roster = await adapter.fetchRoster(teamAbbr);
    _cache.players[teamAbbr] = roster;
    return roster;
  }

  function clearCache() {
    _cache.teams = null;
    _cache.players = {};
    _cache.fetchedAt = null;
  }

  return { getTeamRatings, getTeamRoster, clearCache };
})();