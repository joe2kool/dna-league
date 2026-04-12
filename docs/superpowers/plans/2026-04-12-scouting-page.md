# Scouting Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Scouting" tab to `index.html` that lets all members search, sort, and browse Live Series player cards across all 30 MLB teams with full attribute detail cards.

**Architecture:** `js/scouting.js` is a self-contained IIFE module (`ScoutingManager`) that fires 30 parallel `/fa-roster` Worker calls on first open, caches ~600 players in memory, and renders a sortable/filterable table with inline attribute detail cards. Team view shows rating badges + per-team roster. All rendering is client-side; no new Worker endpoints needed.

**Tech Stack:** Vanilla JS IIFE, existing Cloudflare Worker `/fa-roster` endpoint, `DnaRatings.getTeamRatingsFull()` from `js/ratings.js`, CSS custom properties

---

## File Map

| File | Change |
|------|--------|
| `index.html` | Add `<script>` tags, nav tabs, `page-scouting` div, `initScoutingPage()` call in `showPage()` |
| `js/scouting.js` | New — `ScoutingManager` IIFE: state, data loading, table render, filters, sort, pagination, team view |
| `css/draft.css` | Add `.scouting-*` CSS classes |

---

## Task 1: Wire `index.html` — nav tabs, page shell, script tags

**Files:**
- Modify: `index.html` — script tags (after line 12), nav tabs (desktop + mobile), page div, `showPage()` hook

- [ ] **Step 1: Add script tags**

Find in `index.html` (around line 12):
```html
<script src="js/config.js"></script>
```

Replace with:
```html
<script src="js/config.js"></script>
<script src="js/ratings.js"></script>
<script src="js/scouting.js"></script>
```

- [ ] **Step 2: Add desktop nav tab**

Find the desktop nav tabs block. It contains buttons like:
```html
<button type="button" class="nav-tab" onclick="showPage('seasons',this)">Seasons</button>
```

Add a new Scouting tab after the Seasons tab (or after Members — place it last before any admin-only tabs):
```html
<button type="button" class="nav-tab" onclick="showPage('scouting',this)">Scouting</button>
```

- [ ] **Step 3: Add mobile drawer item**

Find the mobile drawer nav items. They look like:
```html
<button type="button" class="drawer-nav-item" id="drawer-tab-seasons" onclick="showPageMobile('seasons',this)">
  <span class="drawer-nav-icon">&#x1F3C6;</span><span>Seasons</span>
</button>
```

Add a Scouting drawer item after the Seasons item:
```html
<button type="button" class="drawer-nav-item" id="drawer-tab-scouting" onclick="showPageMobile('scouting',this)">
  <span class="drawer-nav-icon">&#x1F50D;</span><span>Scouting</span>
</button>
```

- [ ] **Step 4: Add page-scouting div**

Find a nearby page div such as `<div id="page-seasons" class="page">`. Add the scouting page div adjacent to it:
```html
<div id="page-scouting" class="page">
  <div id="scouting-root"></div>
</div>
```

- [ ] **Step 5: Hook into showPage()**

Find the `showPage()` function. It contains lines like:
```js
if (id === 'seasons')  initSeasonsPage();
if (id === 'schedule') initSchedulePage();
```

Add after them:
```js
if (id === 'scouting') initScoutingPage();
```

Also find `showPageMobile()` (same structure) and add the same line there.

- [ ] **Step 6: Add initScoutingPage() stub**

Find where other `initXxxPage()` stubs/functions are defined in the inline `<script>` block. Add:
```js
function initScoutingPage() {
  ScoutingManager.init();
}
```

- [ ] **Step 7: Verify wiring**

Open `index.html` in browser, click the "Scouting" tab. Confirm:
- Tab becomes active with no JS errors in console
- `page-scouting` div becomes visible (may be blank — `scouting.js` doesn't exist yet)

- [ ] **Step 8: Commit**

```bash
git add index.html
git commit -m "feat: add Scouting nav tab and page shell to index.html

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 2: Create `js/scouting.js` — state + data loading

**Files:**
- Create: `js/scouting.js`

- [ ] **Step 1: Create the IIFE skeleton with state**

Create `js/scouting.js`:

```js
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
      case 'spd':  return (PITCHER_POS.has(p.pos) ? -1 : (p.speed  ?? -1));
      case 'fld':  return (PITCHER_POS.has(p.pos) ? -1 : (p.fielding ?? -1));
      case 'vel':  return (PITCHER_POS.has(p.pos) ? (p.velocity ?? -1) : -1);
      case 'ctl':  return (PITCHER_POS.has(p.pos) ? (p.control  ?? -1) : -1);
      default:     return 0;
    }
  }

  // ── Root element ─────────────────────────────────────────────────
  function _root() { return document.getElementById('scouting-root'); }

  // ── Init ─────────────────────────────────────────────────────────
  function init() {
    if (_initialized) { _render(); return; }
    _initialized = true;
    _render();    // show loading state immediately
    _loadAll();
  }

  async function _loadAll() {
    const abbrs = DNA_CONFIG.mlbTeams.map(t => t.abbr);
    _teamsLoaded = 0;
    _players     = [];

    // Load team ratings for team badges (non-blocking)
    DnaRatings.getTeamRatingsFull().then(r => { _teamRatings = r; _render(); });

    // Fetch all 30 teams in parallel; merge results as each resolves
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

    // Final render once all complete
    _recompute();
    _render();
  }

  // ── Filter + Sort ────────────────────────────────────────────────
  function _recompute() {
    let list = _players.slice();

    // Filter
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

    // Sort
    const { col, dir } = _sort;
    const mult = dir === 'desc' ? -1 : 1;
    list.sort((a, b) => {
      const av = _sortVal(a, col), bv = _sortVal(b, col);
      if (typeof av === 'string') return mult * av.localeCompare(bv);
      return mult * (bv - av); // numeric: larger values first for desc
    });

    // Fix: for desc numeric, larger = first = correct. For asc, we want smaller first.
    // The mult already handles this: desc → mult=-1 → bv-av (larger b wins → comes first)
    // Wait: for desc, we want large values first. bv - av: if bv > av → positive → b before a → correct for desc.
    // But we multiplied by mult=-1 for desc → -(bv-av) = av-av... that's wrong.
    // Fix the sort:
    list.sort((a, b) => {
      const av = _sortVal(a, col), bv = _sortVal(b, col);
      if (typeof av === 'string') {
        return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return dir === 'asc' ? av - bv : bv - av;
    });

    _filteredPlayers = list;
  }

  // placeholder for render — implemented in Task 3
  function _render() {
    const el = _root();
    if (!el) return;
    el.innerHTML = `<p style="padding:20px;color:var(--text2)">Loading teams… ${_teamsLoaded} / 30</p>`;
  }

  // ── Public API ───────────────────────────────────────────────────
  return { init };

})();
```

Note: the sort function is written twice — the second definition overwrites the first. Remove the first one (the one using `mult`). The final sort in `_recompute()` should be only:

```js
    list.sort((a, b) => {
      const av = _sortVal(a, col), bv = _sortVal(b, col);
      if (typeof av === 'string') {
        return dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return dir === 'asc' ? av - bv : bv - av;
    });
```

- [ ] **Step 2: Verify data loading in browser console**

Open `index.html`, click Scouting tab. In browser console run:
```js
// After ~5s, check player count
ScoutingManager  // should be an object
```

Check Network tab: should see ~30 requests to `fa-roster?team=...`. The page should show "Loading teams… N / 30" updating.

- [ ] **Step 3: Commit**

```bash
git add js/scouting.js
git commit -m "feat: add ScoutingManager skeleton with parallel team data loading

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 3: Implement table render, filters, sort, and pagination

**Files:**
- Modify: `js/scouting.js` — replace stub `_render()`, add `_renderAllView()`, `_renderFilters()`, `_renderTable()`, `_renderPagination()`, event handler functions

- [ ] **Step 1: Replace `_render()` and add all-players view rendering**

In `js/scouting.js`, replace the stub `_render()` function and add the following functions. Insert them before the `return { init };` line:

```js
  // ── Render orchestrator ──────────────────────────────────────────
  function _render() {
    const el = _root();
    if (!el) return;
    if (_view === 'all') {
      _renderAllView(el);
    } else {
      _renderTeamView(el);
    }
  }

  function _renderAllView(el) {
    const totalPages = Math.max(1, Math.ceil(_filteredPlayers.length / PAGE_SIZE));
    const pageSlice  = _filteredPlayers.slice((_page - 1) * PAGE_SIZE, _page * PAGE_SIZE);

    el.innerHTML = `
      ${_renderTeamGrid()}
      <div class="scouting-all">
        ${_renderFilters()}
        ${_teamsLoaded < 30
          ? `<div class="scouting-progress">Loading teams… ${_teamsLoaded} / 30</div>`
          : ''}
        ${_filteredPlayers.length === 0 && _teamsLoaded === 30
          ? (_players.length === 0
              ? `<div class="scouting-empty">Could not load player data. Check connection. <button class="scouting-retry-btn" onclick="ScoutingManager.retry()">Retry</button></div>`
              : `<div class="scouting-empty">No players match the current filters.</div>`)
          : _renderTable(pageSlice)}
        ${_filteredPlayers.length > PAGE_SIZE ? _renderPagination(totalPages) : ''}
      </div>`;
  }

  function _renderFilters() {
    const positions = ['all','SP','RP','CP','C','1B','2B','3B','SS','LF','CF','RF','DH'];
    const teams     = ['all', ...DNA_CONFIG.mlbTeams.map(t => t.abbr).sort()];
    return `
      <div class="scouting-filters">
        <input  class="scouting-search" type="text" placeholder="Search player…"
                value="${_escHtml(_filters.search)}"
                oninput="ScoutingManager.onSearch(this.value)">
        <select class="scouting-select" onchange="ScoutingManager.onFilter('pos',this.value)">
          ${positions.map(p => `<option value="${p}" ${_filters.pos===p?'selected':''}>${p==='all'?'All Positions':p}</option>`).join('')}
        </select>
        <select class="scouting-select" onchange="ScoutingManager.onTeamFilter(this.value)">
          ${teams.map(t => `<option value="${t}" ${(_view==='team'&&_selectedTeam===t)?'selected':''}>${t==='all'?'All Teams':t}</option>`).join('')}
        </select>
        <select class="scouting-select" onchange="ScoutingManager.onFilter('bat',this.value)">
          <option value="all" ${_filters.bat==='all'?'selected':''}>All Bats</option>
          <option value="L" ${_filters.bat==='L'?'selected':''}>L</option>
          <option value="R" ${_filters.bat==='R'?'selected':''}>R</option>
          <option value="S" ${_filters.bat==='S'?'selected':''}>S</option>
        </select>
        <select class="scouting-select" onchange="ScoutingManager.onFilter('thr',this.value)">
          <option value="all" ${_filters.thr==='all'?'selected':''}>All Throws</option>
          <option value="L" ${_filters.thr==='L'?'selected':''}>L</option>
          <option value="R" ${_filters.thr==='R'?'selected':''}>R</option>
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
      const arrow  = active ? (_sort.dir === 'desc' ? ' ↓' : ' ↑') : '';
      const cls    = `scouting-th${active?' scouting-th-active':''}${c.hideMobile?' scouting-hide-mobile':''}`;
      return `<th class="${cls}" onclick="ScoutingManager.onSort('${c.key}')">${c.label}${arrow}</th>`;
    }).join('');

    const bodyRows = rows.map((p, localIdx) => {
      const globalIdx = (_page - 1) * PAGE_SIZE + localIdx;
      const isPitcher = PITCHER_POS.has(p.pos);
      const con  = _conVal(p);
      const pwr  = _pwrVal(p);
      const spd  = isPitcher ? null : p.speed;
      const fld  = isPitcher ? null : p.fielding;
      const vel  = isPitcher ? p.velocity : null;
      const ctl  = isPitcher ? p.control  : null;
      const fmt  = v => (v != null ? v : '—');
      const isExp = _expandedIdx === globalIdx;

      const dataRow = `
        <tr class="scouting-row${isExp?' scouting-row-expanded':''}"
            onclick="ScoutingManager.onRowClick(${globalIdx})">
          <td class="scouting-td scouting-td-name">${_escHtml(p.name)}</td>
          <td class="scouting-td">${_escHtml(p.pos)}</td>
          <td class="scouting-td">${_escHtml(p.teamAbbr)}</td>
          <td class="scouting-td scouting-ovr">${p.overall || '—'}</td>
          <td class="scouting-td">${fmt(con)}</td>
          <td class="scouting-td">${fmt(pwr)}</td>
          <td class="scouting-td">${fmt(spd)}</td>
          <td class="scouting-td scouting-hide-mobile">${fmt(fld)}</td>
          <td class="scouting-td scouting-hide-mobile">${fmt(vel)}</td>
          <td class="scouting-td scouting-hide-mobile">${fmt(ctl)}</td>
        </tr>`;

      const detailRow = isExp ? `
        <tr class="scouting-detail-row">
          <td colspan="${COLS.length}" class="scouting-detail-cell">
            ${_renderPlayerDetail(p)}
          </td>
        </tr>` : '';

      return dataRow + detailRow;
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
        <button class="scouting-page-btn" ${_page<=1?'disabled':''} onclick="ScoutingManager.onPage(${_page-1})">← Prev</button>
        <span class="scouting-page-info">Page ${_page} of ${totalPages}</span>
        <button class="scouting-page-btn" ${_page>=totalPages?'disabled':''} onclick="ScoutingManager.onPage(${_page+1})">Next →</button>
      </div>`;
  }
```

- [ ] **Step 2: Add event handler functions (before `return { init }`)**

```js
  // ── Event handlers ────────────────────────────────────────────────
  function onSearch(val) {
    _filters.search = val;
    _page = 1;
    _expandedIdx = null;
    _recompute();
    _render();
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
    _root().scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function onRowClick(globalIdx) {
    _expandedIdx = (_expandedIdx === globalIdx) ? null : globalIdx;
    _render();
  }

  function retry() {
    _initialized = false;
    init();
  }

  // placeholder team view functions — implemented in Task 5
  function _renderTeamGrid() { return ''; }
  function _renderTeamView(el) { el.innerHTML = '<p>Team view coming soon</p>'; }
  function _enterTeamView(abbr) { _view = 'team'; _selectedTeam = abbr; _render(); }
  function _exitTeamView() { _view = 'all'; _selectedTeam = null; _render(); }
```

- [ ] **Step 3: Update the public API return**

Find:
```js
  return { init };
```

Replace with:
```js
  return { init, onSearch, onFilter, onTeamFilter, onSort, onPage, onRowClick, retry, exitTeamView: _exitTeamView };
```

- [ ] **Step 4: Verify table renders**

Open `index.html`, click Scouting. After teams load:
- Table shows with columns: Name / Pos / Team / OVR / CON / PWR / SPD / FLD / VEL / CTL
- Clicking a column header re-sorts (arrow indicator changes)
- Typing in search box filters results
- Position/Bat/Throw dropdowns filter results
- Pagination controls appear when > 40 players match
- Note: row clicks will cause a JS error until Task 4 adds `_renderPlayerDetail` — that is expected at this stage

- [ ] **Step 5: Commit**

```bash
git add js/scouting.js
git commit -m "feat: implement scouting table with sort, filter, and pagination

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 4: Implement inline player detail card

**Files:**
- Modify: `js/scouting.js` — add `_renderPlayerDetail(p)` function

- [ ] **Step 1: Add `_renderPlayerDetail` function**

Insert before the `return` line in `js/scouting.js`:

```js
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
              <div class="fa-pitch-stats">MPH <span>${pitch.speed||'—'}</span> BRK <span>${pitch.break||'—'}</span></div>
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
```

- [ ] **Step 2: Verify row expansion**

Click any player row in the scouting table. Confirm:
- Detail card expands inline below the row
- Pitchers show Pitching section + Pitch Repertoire
- Hitters show Hitting section + Speed & Fielding section
- Quirks section appears if player has quirks
- Clicking same row again collapses the card
- Clicking a different row collapses the previous and expands the new one

- [ ] **Step 3: Commit**

```bash
git add js/scouting.js
git commit -m "feat: add inline player detail card to scouting table rows

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 5: Implement team grid + team view

**Files:**
- Modify: `js/scouting.js` — replace placeholder `_renderTeamGrid()`, `_renderTeamView()`, `_enterTeamView()`, `_exitTeamView()`

- [ ] **Step 1: Replace `_renderTeamGrid()` placeholder**

Find and replace the placeholder:
```js
  function _renderTeamGrid() { return ''; }
```

Replace with:
```js
  function _renderTeamGrid() {
    const ratings = _teamRatings || {};
    const sorted  = DNA_CONFIG.mlbTeams.slice().sort((a, b) => {
      const ra = ratings[a.abbr]?.overall || 0;
      const rb = ratings[b.abbr]?.overall || 0;
      return rb - ra;
    });
    const cards = sorted.map(t => {
      const r   = ratings[t.abbr] || {};
      const ovr = r.overall || '—';
      const ovrColor = ovr >= 88 ? 'var(--green)' : ovr >= 82 ? 'var(--gold)' : 'var(--text2)';
      return `
        <div class="team-card scouting-team-card" onclick="ScoutingManager.onTeamFilter('${t.abbr}')" title="${_escHtml(t.name)}">
          <div class="team-card-abbr">${t.abbr}</div>
          <div class="team-card-name">${_escHtml(t.name)}</div>
          <div class="team-card-ovr" style="color:${ovrColor}">${ovr}</div>
          <div class="team-card-league">${t.league || ''} ${t.division || ''}</div>
        </div>`;
    }).join('');
    return `<div class="scouting-team-grid">${cards}</div>`;
  }
```

- [ ] **Step 2: Replace `_renderTeamView()` placeholder**

Find and replace:
```js
  function _renderTeamView(el) { el.innerHTML = '<p>Team view coming soon</p>'; }
```

Replace with:
```js
  function _renderTeamView(el) {
    const abbr    = _selectedTeam;
    const info    = DNA_CONFIG.mlbTeams.find(t => t.abbr === abbr) || { name: abbr, league: '', division: '' };
    const ratings = _teamRatings || {};
    const r       = ratings[abbr] || {};
    const fmt     = v => (v != null ? v : '—');

    const teamPlayers = _players
      .filter(p => p.teamAbbr === abbr)
      .sort((a, b) => (b.overall || 0) - (a.overall || 0));

    const bodyRows = teamPlayers.map((p, i) => {
      const isPitcher = PITCHER_POS.has(p.pos);
      const con  = _conVal(p);
      const pwr  = _pwrVal(p);
      const isExp = _expandedIdx === i;

      const dataRow = `
        <tr class="scouting-row${isExp?' scouting-row-expanded':''}"
            onclick="ScoutingManager.onTeamRowClick(${i})">
          <td class="scouting-td scouting-td-name">${_escHtml(p.name)}</td>
          <td class="scouting-td">${_escHtml(p.pos)}</td>
          <td class="scouting-td">${p.overall || '—'}</td>
          <td class="scouting-td">${fmt(con)}</td>
          <td class="scouting-td">${fmt(pwr)}</td>
          <td class="scouting-td">${isPitcher ? '—' : fmt(p.speed)}</td>
          <td class="scouting-td scouting-hide-mobile">${isPitcher ? '—' : fmt(p.fielding)}</td>
          <td class="scouting-td scouting-hide-mobile">${isPitcher ? fmt(p.velocity) : '—'}</td>
          <td class="scouting-td scouting-hide-mobile">${isPitcher ? fmt(p.control) : '—'}</td>
        </tr>`;

      const detailRow = isExp ? `
        <tr class="scouting-detail-row">
          <td colspan="9" class="scouting-detail-cell">${_renderPlayerDetail(p)}</td>
        </tr>` : '';

      return dataRow + detailRow;
    }).join('');

    el.innerHTML = `
      <div class="scouting-team-header">
        <button class="scouting-back-btn" onclick="ScoutingManager.exitTeamView()">← All Players</button>
        <div>
          <span class="scouting-team-name">${_escHtml(info.name)}</span>
          <span class="scouting-team-meta">${info.league} ${info.division}</span>
        </div>
      </div>
      <div class="scouting-team-card-summary">
        <div class="tcb-group">
          <span class="tcb-label">Pitching</span>
          <span class="tcb-badge tcb-green">SP ${fmt(r.sp)}</span>
          <span class="tcb-badge tcb-green">RP ${fmt(r.rp)}</span>
        </div>
        <div class="tcb-group">
          <span class="tcb-label">Hitting</span>
          <span class="tcb-badge tcb-gold">PWR ${fmt(r.power)}</span>
          <span class="tcb-badge tcb-gold">CON ${fmt(r.contact)}</span>
        </div>
        <div class="tcb-group">
          <span class="tcb-label">Athletic</span>
          <span class="tcb-badge tcb-blue">SPD ${fmt(r.speed)}</span>
          <span class="tcb-badge tcb-blue">DEF ${fmt(r.defense)}</span>
        </div>
      </div>
      <div class="scouting-table-wrap">
        <table class="scouting-table">
          <thead><tr>
            <th class="scouting-th">Name</th>
            <th class="scouting-th">Pos</th>
            <th class="scouting-th">OVR</th>
            <th class="scouting-th">CON</th>
            <th class="scouting-th">PWR</th>
            <th class="scouting-th">SPD</th>
            <th class="scouting-th scouting-hide-mobile">FLD</th>
            <th class="scouting-th scouting-hide-mobile">VEL</th>
            <th class="scouting-th scouting-hide-mobile">CTL</th>
          </tr></thead>
          <tbody>${bodyRows}</tbody>
        </table>
      </div>`;
  }
```

- [ ] **Step 3: Add `onTeamRowClick` handler and update `_enterTeamView`**

Replace the placeholder `_enterTeamView`:
```js
  function _enterTeamView(abbr) { _view = 'team'; _selectedTeam = abbr; _render(); }
```

With:
```js
  function _enterTeamView(abbr) {
    _view         = 'team';
    _selectedTeam = abbr;
    _expandedIdx  = null;
    _render();
  }
```

Add new handler after `onRowClick`:
```js
  function onTeamRowClick(i) {
    _expandedIdx = (_expandedIdx === i) ? null : i;
    _render();
  }
```

Update the public API return:
```js
  return { init, onSearch, onFilter, onTeamFilter, onSort, onPage, onRowClick, onTeamRowClick, retry, exitTeamView: _exitTeamView };
```

- [ ] **Step 4: Verify team view**

In the Scouting page:
- Team grid shows at top with 30 team cards sorted by OVR
- Clicking a team card shows team view with: back button, team name, 6 rating badges, sortable roster table
- Clicking a player row in team view expands their detail card
- "← All Players" button returns to all-players view

- [ ] **Step 5: Commit**

```bash
git add js/scouting.js
git commit -m "feat: add team grid and team view with rating badges and roster table

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 6: Add CSS styles

**Files:**
- Modify: `css/draft.css` — append scouting styles at end of file

- [ ] **Step 1: Append styles to `css/draft.css`**

Add at the end of `css/draft.css`:

```css
/* ── Scouting Page ─────────────────────────────────────────────── */

.scouting-team-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(90px, 1fr));
  gap: 2px;
  margin-bottom: 16px;
}

.scouting-team-card {
  min-width: 0;
}

.scouting-all {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.scouting-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.scouting-search {
  flex: 1 1 160px;
  min-width: 120px;
  padding: 6px 10px;
  background: var(--chrome1);
  border: 1px solid rgba(168,189,212,0.15);
  border-radius: 4px;
  color: var(--text1);
  font-size: 13px;
}

.scouting-select {
  padding: 6px 8px;
  background: var(--chrome1);
  border: 1px solid rgba(168,189,212,0.15);
  border-radius: 4px;
  color: var(--text1);
  font-size: 13px;
}

.scouting-progress {
  font-size: 12px;
  color: var(--text2);
  padding: 4px 0;
}

.scouting-empty {
  padding: 24px;
  text-align: center;
  color: var(--text2);
  font-size: 14px;
}

.scouting-retry-btn {
  margin-left: 10px;
  padding: 4px 12px;
  background: var(--gold);
  color: #000;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
}

.scouting-table-wrap {
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
}

.scouting-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.scouting-th {
  padding: 8px 10px;
  text-align: left;
  background: var(--chrome1);
  color: var(--text2);
  font-size: 11px;
  letter-spacing: 0.5px;
  text-transform: uppercase;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  border-bottom: 1px solid rgba(168,189,212,0.1);
  position: sticky;
  top: 0;
}

.scouting-th:hover { color: var(--text1); }
.scouting-th-active { color: var(--gold); }

.scouting-td {
  padding: 7px 10px;
  border-bottom: 1px solid rgba(168,189,212,0.06);
  white-space: nowrap;
}

.scouting-row {
  cursor: pointer;
  transition: background 0.1s;
}

.scouting-row:hover { background: rgba(168,189,212,0.06); }
.scouting-row-expanded { background: rgba(168,189,212,0.08); }

.scouting-td-name {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.scouting-ovr {
  font-family: 'Bebas Neue', sans-serif;
  font-size: 15px;
  color: var(--gold);
}

.scouting-detail-row { background: var(--surface2); }

.scouting-detail-cell {
  padding: 12px 16px;
  border-bottom: 1px solid rgba(168,189,212,0.1);
}

.scouting-detail-card {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.scouting-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 8px 0;
}

.scouting-page-btn {
  padding: 6px 14px;
  background: var(--chrome1);
  border: 1px solid rgba(168,189,212,0.15);
  border-radius: 4px;
  color: var(--text1);
  font-size: 13px;
  cursor: pointer;
}

.scouting-page-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.scouting-page-info {
  font-size: 13px;
  color: var(--text2);
}

/* Team view */
.scouting-team-header {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-bottom: 12px;
}

.scouting-back-btn {
  padding: 6px 12px;
  background: var(--chrome1);
  border: 1px solid rgba(168,189,212,0.15);
  border-radius: 4px;
  color: var(--text1);
  font-size: 13px;
  cursor: pointer;
  white-space: nowrap;
}

.scouting-team-name {
  font-family: 'Bebas Neue', sans-serif;
  font-size: 22px;
  color: var(--text1);
  letter-spacing: 1px;
}

.scouting-team-meta {
  font-size: 11px;
  color: var(--text2);
  margin-left: 8px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.scouting-team-card-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 16px;
  padding: 10px 12px;
  background: var(--surface2);
  border-radius: 4px;
}

/* Mobile: hide less critical columns */
@media (max-width: 600px) {
  .scouting-hide-mobile { display: none; }
  .scouting-filters { flex-direction: column; align-items: stretch; }
  .scouting-search  { flex: 1 1 auto; }
}
```

- [ ] **Step 2: Verify visual appearance**

Open `index.html` on Scouting tab, check:
- Team grid is a compact responsive grid of cards
- Filter bar wraps cleanly on mobile
- Table has alternating hover highlighting, sticky header
- Expanded detail card displays inside the table row
- Team view shows rating badges, back button, roster table

- [ ] **Step 3: Commit**

```bash
git add css/draft.css
git commit -m "feat: add scouting page CSS styles

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```
