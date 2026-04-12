// js/scouting.js
// ScoutingManager — player scouting page for DNA League
// Loads all 30 MLB team rosters in parallel, renders sortable/filterable player table.

const ScoutingManager = (() => {

  // ── State ────────────────────────────────────────────────────────
  let _players      = [];   // all loaded players (flat, augmented with teamAbbr)
  let _teamsLoaded  = 0;    // count of resolved team fetches (0–30)
  let _initialized  = false;
  let _filters      = { search: '', pos: 'all', bat: 'all', thr: 'all' };
  let _sort         = { col: 'ovr', dir: 'desc' };
  let _page         = 1;
  let _view         = 'all';        // 'all' | 'team'
  let _selectedTeam = null;         // abbr string in team view
  let _expandedIdx  = null;         // index into _filteredPlayers of expanded row
  let _teamRatings  = null;         // from DnaRatings.getTeamRatingsFull()
  let _filteredPlayers = [];        // result of current filter+sort (recalculated on change)

  const PAGE_SIZE   = 40;
  const WORKER_URL  = DNA_CONFIG.ratings.workerUrl;
  const PITCHER_POS = new Set(['SP','RP','CP']);

  // ── Helpers ──────────────────────────────────────────────────────
  function _escHtml(s) {
    return String(s ?? '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;')
      .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function _attrColor(val) {
    if (!val || val <= 0) return '';
    if (val >= 85) return 'high';
    if (val >= 70) return 'mid';
    if (val >= 55) return 'low';
    return 'vlow';
  }

  function _attrVal(val) {
    return (val != null && val > 0) ? val : '—';
  }

  function _conVal(p) {
    if (PITCHER_POS.has(p.pos)) return null;
    const l = p.contact_left, r = p.contact_right;
    return (l != null && r != null) ? Math.round((l + r) / 2) : null;
  }

  function _pwrVal(p) {
    if (PITCHER_POS.has(p.pos)) return null;
    const l = p.power_left, r = p.power_right;
    return (l != null && r != null) ? Math.round((l + r) / 2) : null;
  }

  function _sortVal(p, col) {
    switch(col) {
      case 'ovr':  return p.overall || 0;
      case 'name': return (p.name || '').toLowerCase();
      case 'pos':  return p.pos || '';
      case 'team': return p.teamAbbr || '';
      case 'con':  return _conVal(p) ?? -1;
      case 'pwr':  return _pwrVal(p) ?? -1;
      case 'spd':  return (PITCHER_POS.has(p.pos) ? -1 : (p.speed    ?? -1));
      case 'fld':  return (PITCHER_POS.has(p.pos) ? -1 : (p.fielding ?? -1));
      case 'vel':  return (PITCHER_POS.has(p.pos) ? (p.velocity ?? -1) : -1);
      case 'ctl':  return (PITCHER_POS.has(p.pos) ? (p.control  ?? -1) : -1);
      default:     console.warn(`ScoutingManager: unknown sort column "${col}"`); return 0;
    }
  }

  // ── Root element ─────────────────────────────────────────────────
  function _root() { return document.getElementById('scouting-root'); }

  // ── Filter + Sort ────────────────────────────────────────────────
  function _recompute() {
    let list = _players.slice();

    if (_filters.search) {
      const q = _filters.search.toLowerCase();
      list = list.filter(p => p.name && p.name.toLowerCase().includes(q));
    }
    if (_filters.pos !== 'all') {
      list = list.filter(p => p.pos === _filters.pos);
    }
    if (_filters.bat !== 'all') {
      list = list.filter(p => p.bats === _filters.bat);
    }
    if (_filters.thr !== 'all') {
      list = list.filter(p => p.throws === _filters.thr);
    }

    const { col, dir } = _sort;
    list.sort((a, b) => {
      const av = _sortVal(a, col), bv = _sortVal(b, col);
      if (typeof av === 'string') {
        return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return dir === 'asc' ? av - bv : bv - av;
    });

    _filteredPlayers = list;
  }

  // ── Init + Data Loading ──────────────────────────────────────────
  function init() {
    if (_initialized) { _render(); return; }
    _initialized = true;
    _render();
    _loadAll();
  }

  async function _loadAll() {
    const abbrs = DNA_CONFIG.mlbTeams.map(t => t.abbr);
    _teamsLoaded = 0;
    _players     = [];

    // Load team ratings for badges (non-blocking)
    DnaRatings.getTeamRatingsFull().then(r => { _teamRatings = r; _render(); });

    // Fetch all 30 teams in parallel
    await Promise.all(abbrs.map(abbr =>
      fetch(`${WORKER_URL}/fa-roster?team=${abbr}&min=0&max=99`, {
        signal: AbortSignal.timeout(20000)
      })
      .then(r => r.ok ? r.json() : { players: [] })
      .catch(() => ({ players: [] }))
      .then(data => {
        const tagged = (data.players || []).map(p => ({ ...p, teamAbbr: abbr }));
        _players.push(...tagged);
        _teamsLoaded++;
        _recompute();
        _render();
      })
    ));

    _recompute();
    _render();
  }

  // ── Render (stub — replaced in Task 3) ──────────────────────────
  function _render() {
    const el = _root();
    if (!el) return;
    el.innerHTML = `<p style="padding:20px;color:var(--text2)">Loading teams… ${_teamsLoaded} / 30</p>`;
  }

  // ── Placeholder team view functions (replaced in Task 5) ─────────
  function _renderTeamGrid() { return ''; }
  function _renderTeamView(el) { el.innerHTML = '<p style="padding:20px">Team view coming in next update.</p>'; }
  function _enterTeamView(abbr) { _view = 'team'; _selectedTeam = abbr; _expandedIdx = null; _render(); }
  function _exitTeamView() { _view = 'all'; _selectedTeam = null; _render(); }

  // ── Public API ───────────────────────────────────────────────────
  return {
    init,
    exitTeamView: _exitTeamView,
  };

})();
