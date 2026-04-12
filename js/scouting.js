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

  // ── Render ───────────────────────────────────────────────────────
  function _render() {
    const el = _root();
    if (!el) return;
    if (_view === 'team') {
      _renderTeamView(el);
    } else {
      _renderAllView(el);
    }
  }

  function _renderAllView(el) {
    const totalPages = Math.max(1, Math.ceil(_filteredPlayers.length / PAGE_SIZE));
    const pageSlice  = _filteredPlayers.slice((_page - 1) * PAGE_SIZE, _page * PAGE_SIZE);

    let body = '';
    if (_filteredPlayers.length === 0 && _teamsLoaded === 30) {
      if (_players.length === 0) {
        body = `<div class="scouting-empty">Could not load player data. Check connection. <button class="scouting-retry-btn" onclick="ScoutingManager.retry()">Retry</button></div>`;
      } else {
        body = `<div class="scouting-empty">No players match the current filters.</div>`;
      }
    } else {
      body = _renderTable(pageSlice);
    }

    el.innerHTML = `
      ${_renderTeamGrid()}
      <div class="scouting-all">
        ${_renderFilters()}
        ${_teamsLoaded < 30 ? `<div class="scouting-progress">Loading teams\u2026 ${_teamsLoaded} / 30</div>` : ''}
        ${body}
        ${_filteredPlayers.length > PAGE_SIZE ? _renderPagination(totalPages) : ''}
      </div>`;
  }

  function _renderFilters() {
    const positions = ['all','SP','RP','CP','C','1B','2B','3B','SS','LF','CF','RF','DH'];
    const teams     = ['all', ...DNA_CONFIG.mlbTeams.map(t => t.abbr).sort()];
    const teamVal   = (_view === 'team' && _selectedTeam) ? _selectedTeam : 'all';
    return `
      <div class="scouting-filters">
        <input class="scouting-search" type="text" placeholder="Search player\u2026"
               value="${_escHtml(_filters.search)}"
               oninput="ScoutingManager.onSearch(this.value)">
        <select class="scouting-select" onchange="ScoutingManager.onFilter('pos',this.value)">
          ${positions.map(p => `<option value="${p}"${_filters.pos===p?' selected':''}>${p==='all'?'All Positions':p}</option>`).join('')}
        </select>
        <select class="scouting-select" onchange="ScoutingManager.onTeamFilter(this.value)">
          ${teams.map(t => `<option value="${t}"${teamVal===t?' selected':''}>${t==='all'?'All Teams':t}</option>`).join('')}
        </select>
        <select class="scouting-select" onchange="ScoutingManager.onFilter('bat',this.value)">
          <option value="all"${_filters.bat==='all'?' selected':''}>All Bats</option>
          <option value="L"${_filters.bat==='L'?' selected':''}>L</option>
          <option value="R"${_filters.bat==='R'?' selected':''}>R</option>
          <option value="S"${_filters.bat==='S'?' selected':''}>S</option>
        </select>
        <select class="scouting-select" onchange="ScoutingManager.onFilter('thr',this.value)">
          <option value="all"${_filters.thr==='all'?' selected':''}>All Throws</option>
          <option value="L"${_filters.thr==='L'?' selected':''}>L</option>
          <option value="R"${_filters.thr==='R'?' selected':''}>R</option>
        </select>
      </div>`;
  }

  const COLS = [
    { key:'name', label:'Name'  },
    { key:'pos',  label:'Pos'   },
    { key:'team', label:'Team'  },
    { key:'ovr',  label:'OVR'   },
    { key:'con',  label:'CON'   },
    { key:'pwr',  label:'PWR'   },
    { key:'spd',  label:'SPD'   },
    { key:'fld',  label:'FLD',  hideMobile:true },
    { key:'vel',  label:'VEL',  hideMobile:true },
    { key:'ctl',  label:'CTL',  hideMobile:true },
  ];

  function _renderTable(rows) {
    const thCells = COLS.map(c => {
      const active = _sort.col === c.key;
      const arrow  = active ? (_sort.dir === 'desc' ? ' \u2193' : ' \u2191') : '';
      const cls    = `scouting-th${active?' scouting-th-active':''}${c.hideMobile?' scouting-hide-mobile':''}`;
      return `<th class="${cls}" onclick="ScoutingManager.onSort('${c.key}')">${c.label}${arrow}</th>`;
    }).join('');

    const bodyRows = rows.map((p, localIdx) => {
      const globalIdx = (_page - 1) * PAGE_SIZE + localIdx;
      const isPitcher = PITCHER_POS.has(p.pos);
      const con  = _conVal(p);
      const pwr  = _pwrVal(p);
      const spd  = isPitcher ? null : (p.speed    ?? null);
      const fld  = isPitcher ? null : (p.fielding ?? null);
      const vel  = isPitcher ? (p.velocity ?? null) : null;
      const ctl  = isPitcher ? (p.control  ?? null) : null;
      const fmt  = v => (v != null ? v : '\u2014');
      const isExp = _expandedIdx === globalIdx;

      // _renderPlayerDetail is added in Task 4
      const detailHtml = isExp && typeof _renderPlayerDetail === 'function'
        ? `<tr class="scouting-detail-row"><td colspan="${COLS.length}" class="scouting-detail-cell">${_renderPlayerDetail(p)}</td></tr>`
        : (isExp ? `<tr class="scouting-detail-row"><td colspan="${COLS.length}" class="scouting-detail-cell"><em>Detail card loading\u2026</em></td></tr>` : '');

      return `
        <tr class="scouting-row${isExp?' scouting-row-expanded':''}" onclick="ScoutingManager.onRowClick(${globalIdx})">
          <td class="scouting-td scouting-td-name">${_escHtml(p.name)}</td>
          <td class="scouting-td">${_escHtml(p.pos)}</td>
          <td class="scouting-td">${_escHtml(p.teamAbbr)}</td>
          <td class="scouting-td scouting-ovr">${p.overall || '\u2014'}</td>
          <td class="scouting-td">${fmt(con)}</td>
          <td class="scouting-td">${fmt(pwr)}</td>
          <td class="scouting-td">${fmt(spd)}</td>
          <td class="scouting-td scouting-hide-mobile">${fmt(fld)}</td>
          <td class="scouting-td scouting-hide-mobile">${fmt(vel)}</td>
          <td class="scouting-td scouting-hide-mobile">${fmt(ctl)}</td>
        </tr>${detailHtml}`;
    }).join('');

    return `
      <div class="scouting-table-wrap">
        <table class="scouting-table">
          <thead><tr>${thCells}</tr></thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>`;
  }

  function _renderPagination(totalPages) {
    return `
      <div class="scouting-pagination">
        <button class="scouting-page-btn"${_page<=1?' disabled':''} onclick="ScoutingManager.onPage(${_page-1})">&#8592; Prev</button>
        <span class="scouting-page-info">Page ${_page} of ${totalPages}</span>
        <button class="scouting-page-btn"${_page>=totalPages?' disabled':''} onclick="ScoutingManager.onPage(${_page+1})">Next &#8594;</button>
      </div>`;
  }

  // ── Placeholder team view functions (replaced in Task 5) ─────────
  function _renderTeamGrid() { return ''; }
  function _renderTeamView(el) { el.innerHTML = '<p style="padding:20px">Team view coming in next update.</p>'; }
  function _enterTeamView(abbr) { _view = 'team'; _selectedTeam = abbr; _expandedIdx = null; _render(); }
  function _exitTeamView() { _view = 'all'; _selectedTeam = null; _render(); }

  // ── Player detail card ───────────────────────────────────────────
  function _renderPlayerDetail(p) {
    const isPitcher = PITCHER_POS.has(p.pos);
    const row = (name, val) => `
      <div class="fa-attr-row">
        <span class="fa-attr-name">${name}</span>
        <span class="fa-attr-val ${_attrColor(val)}">${_attrVal(val)}</span>
      </div>`;

    let html = `<div class="scouting-detail-card">`;

    if (isPitcher) {
      html += `<div class="fa-attr-section">
        <div class="fa-attr-label">Pitching</div>
        <div class="fa-attr-grid">
          ${row('Velocity',   p.velocity)}
          ${row('Control',    p.control)}
          ${row('Break',      p.break_rating)}
          ${row('Stamina',    p.stamina)}
          ${row('K/BF vs L',  p.k_per_bf_l)}
          ${row('K/BF vs R',  p.k_per_bf_r)}
          ${row('H/BF vs L',  p.hits_per_bf_l)}
          ${row('H/BF vs R',  p.hits_per_bf_r)}
          ${row('BB/BF',      p.bb_per_bf)}
          ${row('HR/BF',      p.hr_per_bf)}
          ${row('Clutch',     p.pitching_clutch)}
        </div>
      </div>`;
      if (Array.isArray(p.pitch_arsenal) && p.pitch_arsenal.length) {
        html += `<div class="fa-attr-section">
          <div class="fa-attr-label">Pitch Repertoire</div>
          ${p.pitch_arsenal.map(pitch => `
            <div class="fa-pitch-row">
              <span class="fa-pitch-name">${_escHtml(pitch.name)}</span>
              <div class="fa-pitch-stats">MPH <span>${_attrVal(pitch.speed)}</span> BRK <span>${_attrVal(pitch.break)}</span></div>
            </div>`).join('')}
        </div>`;
      }
    } else {
      html += `<div class="fa-attr-section">
        <div class="fa-attr-label">Hitting</div>
        <div class="fa-attr-grid">
          ${row('Contact L',   p.contact_left)}
          ${row('Contact R',   p.contact_right)}
          ${row('Power L',     p.power_left)}
          ${row('Power R',     p.power_right)}
          ${row('Vision',      p.plate_vision)}
          ${row('Discipline',  p.plate_discipline)}
          ${row('Clutch',      p.clutch)}
        </div>
      </div>
      <div class="fa-attr-section">
        <div class="fa-attr-label">Speed & Fielding</div>
        <div class="fa-attr-grid">
          ${row('Speed',    p.speed)}
          ${row('Stealing', p.stealing)}
          ${row('Fielding', p.fielding)}
          ${row('Arm Str',  p.arm_strength)}
          ${row('Arm Acc',  p.arm_accuracy)}
        </div>
      </div>`;
    }

    if (Array.isArray(p.quirks) && p.quirks.length) {
      html += `<div class="fa-attr-section">
        <div class="fa-attr-label">Quirks</div>
        <div class="fa-quirks">${p.quirks.map(q => `<span class="fa-quirk">${_escHtml(q)}</span>`).join('')}</div>
      </div>`;
    }

    html += `</div>`; // .scouting-detail-card
    return html;
  }

  // ── Event handlers ────────────────────────────────────────────────
  function onSearch(val) {
    const cursorPos = document.querySelector('.scouting-search')?.selectionStart ?? val.length;
    _filters.search = val;
    _page = 1;
    _expandedIdx = null;
    _recompute();
    _render();
    // Restore cursor position after full DOM re-render
    const input = document.querySelector('.scouting-search');
    if (input) input.setSelectionRange(cursorPos, cursorPos);
  }

  function onFilter(key, val) {
    _filters[key] = val;
    _page = 1;
    _expandedIdx = null;
    _recompute();
    _render();
  }

  function onTeamFilter(val) {
    if (val === 'all') {
      _exitTeamView();
    } else {
      _enterTeamView(val);
    }
  }

  function onSort(col) {
    if (_sort.col === col) {
      _sort.dir = _sort.dir === 'desc' ? 'asc' : 'desc';
    } else {
      _sort = { col, dir: 'desc' };
    }
    _page = 1;
    _expandedIdx = null;
    _recompute();
    _render();
  }

  function onPage(p) {
    _page = p;
    _expandedIdx = null;
    _render();
    const el = _root();
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function onRowClick(globalIdx) {
    _expandedIdx = (_expandedIdx === globalIdx) ? null : globalIdx;
    _render();
  }

  function retry() {
    _initialized = false;
    init();
  }

  // ── Public API ───────────────────────────────────────────────────
  return {
    init,
    onSearch, onFilter, onTeamFilter, onSort, onPage, onRowClick,
    retry,
    exitTeamView: _exitTeamView,
  };

})();
