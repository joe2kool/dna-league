# Batched Team Ratings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 31-request two-phase team ratings load with 15 parallel chunk requests to a new `/teams-full` endpoint that returns overall + all 6 breakdown stats in one shot.

**Architecture:** New Cloudflare Worker route `/teams-full?chunk=N` processes 2 teams per chunk (staying under CF's 50 subrequest limit), returning overall + SP/RP/Power/Contact/Speed/Defense for both. Client fires all 15 chunks in parallel via `getTeamRatingsFull()` in `ratings.js`, then renders cards fully populated with no loading placeholder.

**Tech Stack:** Cloudflare Worker ES module, vanilla JS, existing CSS badge classes

---

## File Map

| File | Change |
|------|--------|
| `worker.js` | Add `/teams-full?chunk=N` route before 404 fallback |
| `js/ratings.js` | Add `_cache.full`/`_cache.fullFetchedAt`, add `getTeamRatingsFull()`, expose in return |
| `js/draft-board.js` | Replace `loading...` placeholder in `renderAvailableTeams()` with inline badge render from ratings map |
| `draft.html` | Replace `getTeamRatings()` + `loadTeamBreakdowns()` with `getTeamRatingsFull()` at all 3 call sites |
| `js/draft-room.js` | Remove `loadTeamBreakdowns()` from all 7 `renderAvailableTeams` pairs |

---

## Task 1: Add `/teams-full` Worker endpoint

**Files:**
- Modify: `worker.js` — insert route before the 404 fallback line
- Modify: `worker.js:11` — update route comment block

- [ ] **Step 1: Update the route comment at the top of worker.js**

Find this line in the Routes comment block (around line 10):
```js
//   GET /team-breakdown?team=LAD        — SP/RP/Power/Contact/Speed/Defense averages for a team
```

Add after it:
```js
//   GET /teams-full?chunk=N             — Overall + breakdown for 2 teams per chunk (0–14)
```

- [ ] **Step 2: Insert the `/teams-full` handler**

Find this line near the bottom of `worker.js` (currently the last route before 404):
```js
    return json({ error: 'Unknown endpoint. Use /roster?team=LAD, /fa-roster?team=LAD&min=70&max=84, /teams, /team-breakdown?team=LAD, /history?username=X&platform=Y, or /gamelog?id=X' }, 404);
```

Insert the following block immediately before it:

```js
    // ── GET /teams-full?chunk=N ───────────────────────────────
    // Returns overall + SP/RP/Power/Contact/Speed/Defense for 2 teams per chunk.
    // 30 teams ÷ 2 = 15 chunks (0–14). Budget: ~46 subrequests per chunk (CF limit: 50).
    if (path === '/teams-full') {
      const chunk = parseInt(url.searchParams.get('chunk') || '', 10);
      const abbrs = Object.keys(TEAM_MAP);
      const CHUNK_SIZE = 2;
      const totalChunks = Math.ceil(abbrs.length / CHUNK_SIZE);

      if (isNaN(chunk) || chunk < 0 || chunk >= totalChunks) {
        return json({ error: `chunk must be 0–${totalChunks - 1}` }, 400);
      }

      const teamAbbrs = abbrs.slice(chunk * CHUNK_SIZE, (chunk + 1) * CHUNK_SIZE);

      function avg(vals) {
        const v = vals.filter(x => x != null);
        return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : null;
      }

      async function processTeam(teamAbbr) {
        const apiTeam = TEAM_MAP[teamAbbr] || teamAbbr;
        const PITCHER_POS  = ['SP', 'RP', 'CP'];
        const HITTER_SLOTS = ['C', '1B', '2B', '3B', 'SS', 'LF', 'CF', 'RF'];

        // Fetch 2 pages of listings
        const [page1, page2] = await Promise.all([1, 2].map(p =>
          fetch(
            `${MLB_API}/listings.json?type=mlb_card&series_id=${LIVE_SERIES}&team=${apiTeam}&sort=rank&order=desc&page=${p}`,
            { headers: { 'Accept': 'application/json', 'User-Agent': 'DNA-League-App/1.0' },
              cf: { cacheTtl: 3600, cacheEverything: true } }
          ).then(r => r.ok ? r.json() : { listings: [] }).catch(() => ({ listings: [] }))
        ));

        const page1Listings = page1.listings || [];
        const allListings   = [...page1Listings, ...(page2.listings || [])];

        // overall = avg OVR of top 5 from page 1
        const top5 = page1Listings
          .filter(l => l.item?.ovr)
          .slice(0, 5)
          .map(l => l.item.ovr);
        const overall = top5.length ? Math.round(top5.reduce((s, v) => s + v, 0) / top5.length) : null;

        const allPlayers = allListings
          .filter(l => l.item && l.item.uuid && l.item.ovr && l.item.name)
          .map(l => ({ uuid: l.item.uuid, ovr: l.item.ovr, pos: l.item.display_position || '' }));

        const pitchers = allPlayers.filter(p => PITCHER_POS.includes(p.pos));
        const hitters  = allPlayers.filter(p => !PITCHER_POS.includes(p.pos));

        const topSPs = pitchers.filter(p => p.pos === 'SP').slice(0, 5);
        const topRPs = pitchers.filter(p => p.pos === 'RP' || p.pos === 'CP').slice(0, 7);

        const selectedHitters = [];
        const selectedUuids   = new Set();
        for (const slot of HITTER_SLOTS) {
          const best = hitters.find(p => p.pos === slot && !selectedUuids.has(p.uuid));
          if (best) { selectedHitters.push(best); selectedUuids.add(best.uuid); }
        }
        const ninthHitter = hitters.find(p => p.pos === 'DH' && !selectedUuids.has(p.uuid))
                         || hitters.find(p => !selectedUuids.has(p.uuid));
        if (ninthHitter) selectedHitters.push(ninthHitter);

        const targets = [...topSPs, ...topRPs, ...selectedHitters];

        const items = await Promise.all(targets.map(p =>
          fetch(
            `${MLB_API}/item.json?uuid=${p.uuid}`,
            { headers: { 'Accept': 'application/json', 'User-Agent': 'DNA-League-App/1.0' },
              cf: { cacheTtl: 3600, cacheEverything: true } }
          ).then(r => r.ok ? r.json() : null).catch(() => null)
        ));

        const spItems     = items.slice(0, topSPs.length).filter(Boolean);
        const rpItems     = items.slice(topSPs.length, topSPs.length + topRPs.length).filter(Boolean);
        const hitterItems = items.slice(topSPs.length + topRPs.length).filter(Boolean);

        return {
          overall,
          sp:      avg(spItems.map(i => i.ovr)),
          rp:      avg(rpItems.map(i => i.ovr)),
          power:   avg(hitterItems.map(i => i.power_left != null && i.power_right != null
                        ? Math.round((i.power_left + i.power_right) / 2) : null)),
          contact: avg(hitterItems.map(i => i.contact_left != null && i.contact_right != null
                        ? Math.round((i.contact_left + i.contact_right) / 2) : null)),
          speed:   avg(hitterItems.map(i => i.speed != null ? i.speed : null)),
          defense: avg(hitterItems.map(i => i.fielding_ability != null ? i.fielding_ability : null)),
        };
      }

      try {
        const results = await Promise.all(teamAbbrs.map(async abbr => {
          try {
            const stats = await processTeam(abbr);
            return [abbr, stats];
          } catch(e) {
            console.warn(`/teams-full: failed processing ${abbr}:`, e.message);
            return null; // omit from response on individual failure
          }
        }));

        const teams = Object.fromEntries(results.filter(Boolean));
        return json({ chunk, teams });

      } catch(e) {
        return json({ error: e.message }, 500);
      }
    }

```

Also update the 404 error message to include the new route:
```js
    return json({ error: 'Unknown endpoint. Use /roster?team=LAD, /fa-roster?team=LAD&min=70&max=84, /teams, /team-breakdown?team=LAD, /teams-full?chunk=N, /history?username=X&platform=Y, or /gamelog?id=X' }, 404);
```

- [ ] **Step 3: Verify logic by code review**

Read through the inserted handler and confirm:
- `chunk=0` → `abbrs.slice(0, 2)` = `['ARI', 'ATL']`
- `chunk=14` → `abbrs.slice(28, 30)` = `['TOR', 'WSH']`
- `chunk=15` → returns 400
- `overall` uses `page1Listings` top 5 (not page 2)
- `targets` array order: SPs first, then RPs, then hitters — matches `items.slice()` indices

- [ ] **Step 4: Commit**

```bash
git add worker.js
git commit -m "feat: add /teams-full?chunk=N Worker endpoint returning overall + breakdown per team

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 2: Add `getTeamRatingsFull()` to ratings.js

**Files:**
- Modify: `js/ratings.js:11-17` — add `full` and `fullFetchedAt` cache keys
- Modify: `js/ratings.js` — add method after `getTeamBreakdown`, expose in return

- [ ] **Step 1: Add full-ratings cache fields**

Find the `_cache` object (lines 11–17):
```js
  const _cache = {
    teams:               null,    // { abbr: { overall, topPlayers } }
    players:             {},      // { teamAbbr: [...players] }
    fetchedAt:           null,
    breakdowns:          {},      // { teamAbbr: breakdown | null }
    breakdownFetchedAt:  {},      // { teamAbbr: timestamp }
  };
```

Replace with:
```js
  const _cache = {
    teams:               null,    // { abbr: { overall, topPlayers } }
    players:             {},      // { teamAbbr: [...players] }
    fetchedAt:           null,
    breakdowns:          {},      // { teamAbbr: breakdown | null }
    breakdownFetchedAt:  {},      // { teamAbbr: timestamp }
    full:                null,    // { abbr: { overall, sp, rp, power, contact, speed, defense } }
    fullFetchedAt:       null,
  };
```

- [ ] **Step 2: Add `getTeamRatingsFull()` method**

Find `clearCache()` (line 398) and insert the new function immediately before it:

```js
  async function getTeamRatingsFull() {
    if (_cache.full && _cache.fullFetchedAt && (Date.now() - _cache.fullFetchedAt) < CACHE_TTL_MS) {
      return _cache.full;
    }
    const adapter = adapters[DNA_CONFIG.ratings.game] || adapters.mlbtheshow;
    if (!adapter.workerUrl) {
      // No Worker configured — fall back to static overalls with null breakdowns
      const base = await getTeamRatings();
      return Object.fromEntries(
        Object.entries(base).map(([abbr, t]) => [abbr, {
          overall: t.overall, sp: null, rp: null,
          power: null, contact: null, speed: null, defense: null,
        }])
      );
    }
    try {
      const TOTAL_CHUNKS = 15;
      const chunkResults = await Promise.all(
        Array.from({ length: TOTAL_CHUNKS }, (_, i) =>
          fetch(
            `${adapter.workerUrl}/teams-full?chunk=${i}`,
            { signal: AbortSignal.timeout(20000) }
          )
          .then(r => r.ok ? r.json() : { teams: {} })
          .catch(() => ({ teams: {} }))
        )
      );

      // Merge all chunk results into one flat map
      const merged = {};
      for (const result of chunkResults) {
        for (const [abbr, stats] of Object.entries(result.teams || {})) {
          merged[abbr] = stats;
        }
      }

      // Fill in any missing teams with static overall + null breakdowns
      const base = _getStaticMLBRatings();
      for (const abbr of Object.keys(base)) {
        if (!merged[abbr]) {
          merged[abbr] = {
            overall: base[abbr].overall, sp: null, rp: null,
            power: null, contact: null, speed: null, defense: null,
          };
        }
        // Preserve name/league/division from static base for card rendering
        merged[abbr].name     = base[abbr].name;
        merged[abbr].league   = base[abbr].league;
        merged[abbr].division = base[abbr].division;
      }

      _cache.full          = merged;
      _cache.fullFetchedAt = Date.now();
      return merged;
    } catch(e) {
      console.warn('getTeamRatingsFull failed, falling back to getTeamRatings:', e.message);
      const base = await getTeamRatings();
      return Object.fromEntries(
        Object.entries(base).map(([abbr, t]) => [abbr, {
          ...t, sp: null, rp: null, power: null, contact: null, speed: null, defense: null,
        }])
      );
    }
  }
```

- [ ] **Step 3: Add `full` and `fullFetchedAt` to `clearCache()`**

Find `clearCache()`:
```js
  function clearCache() {
    _cache.teams = null;
    _cache.players = {};
    _cache.fetchedAt = null;
    _cache.breakdowns = {};
    _cache.breakdownFetchedAt = {};
  }
```

Replace with:
```js
  function clearCache() {
    _cache.teams = null;
    _cache.players = {};
    _cache.fetchedAt = null;
    _cache.breakdowns = {};
    _cache.breakdownFetchedAt = {};
    _cache.full = null;
    _cache.fullFetchedAt = null;
  }
```

- [ ] **Step 4: Expose `getTeamRatingsFull` in the return object**

Find:
```js
  return { getTeamRatings, getTeamRoster, getTeamBreakdown, clearCache };
```

Replace with:
```js
  return { getTeamRatings, getTeamRoster, getTeamBreakdown, getTeamRatingsFull, clearCache };
```

- [ ] **Step 5: Verify in browser console (after Worker is deployed)**

Open `draft.html`, open console, run:
```js
DnaRatings.getTeamRatingsFull().then(r => console.log(Object.keys(r).length, r['LAD']))
```
Expected: `30 { overall: 93, sp: 94, rp: 89, power: 91, contact: 90, speed: 86, defense: 88, name: 'Los Angeles Dodgers', league: 'NL', division: 'West' }`

A second call should return instantly (no network requests in the Network tab).

- [ ] **Step 6: Commit**

```bash
git add js/ratings.js
git commit -m "feat: add getTeamRatingsFull() — 15 parallel chunk requests for all team stats

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 3: Update `renderAvailableTeams` to render badges inline

**Files:**
- Modify: `js/draft-board.js:92-112` — replace `loading...` placeholder with inline badge render

- [ ] **Step 1: Replace placeholder with inline breakdown render**

In `js/draft-board.js`, find the template literal inside `renderAvailableTeams()` (lines 98–111):

```js
      return `
        <div class="team-card" onclick="DraftRoom.makePick('${abbr}')" id="tc-${abbr}" title="${info.name}">
          <div class="team-card-abbr">${abbr}</div>
          <div class="team-card-name">${escHtml(info.name)}</div>
          <div class="team-card-ovr" style="color:${ovrColor}">${ovr}</div>
          <div class="team-card-league">${info.league || ''} ${info.division || ''}</div>
          <div class="team-card-breakdown" id="tcb-${abbr}">
            <span class="team-card-breakdown-loading">loading...</span>
          </div>
          <button type="button" class="team-card-btn" onclick="event.stopPropagation();DraftUI.showTeamDetail('${abbr}')">
            Top 5 ▸
          </button>
        </div>`;
```

Replace with:

```js
      function fmt(val) { return val != null ? val : '—'; }
      const bd = rating; // breakdown stats are on the same rating object
      return `
        <div class="team-card" onclick="DraftRoom.makePick('${abbr}')" id="tc-${abbr}" title="${info.name}">
          <div class="team-card-abbr">${abbr}</div>
          <div class="team-card-name">${escHtml(info.name)}</div>
          <div class="team-card-ovr" style="color:${ovrColor}">${ovr}</div>
          <div class="team-card-league">${info.league || ''} ${info.division || ''}</div>
          <div class="team-card-breakdown" id="tcb-${abbr}">
            <div class="tcb-group">
              <span class="tcb-label">Pitching</span>
              <span class="tcb-badge tcb-green">SP ${fmt(bd?.sp)}</span>
              <span class="tcb-badge tcb-green">RP ${fmt(bd?.rp)}</span>
            </div>
            <div class="tcb-group">
              <span class="tcb-label">Hitting</span>
              <span class="tcb-badge tcb-gold">PWR ${fmt(bd?.power)}</span>
              <span class="tcb-badge tcb-gold">CON ${fmt(bd?.contact)}</span>
            </div>
            <div class="tcb-group">
              <span class="tcb-label">Athletic</span>
              <span class="tcb-badge tcb-blue">SPD ${fmt(bd?.speed)}</span>
              <span class="tcb-badge tcb-blue">DEF ${fmt(bd?.defense)}</span>
            </div>
          </div>
          <button type="button" class="team-card-btn" onclick="event.stopPropagation();DraftUI.showTeamDetail('${abbr}')">
            Top 5 ▸
          </button>
        </div>`;
```

Note: `fmt` is now defined inside the `sorted.map()` callback. Move it above the `sorted.map()` call to avoid re-declaring on every iteration. The full updated block for clarity — find the `const sorted = ...` setup:

```js
    const sorted = [...available].sort((a, b) => {
      const ra = teamRatings?.[a]?.overall || 0;
      const rb = teamRatings?.[b]?.overall || 0;
      return rb - ra;
    });

    function fmt(val) { return val != null ? val : '—'; }

    el.innerHTML = sorted.map(abbr => {
      const info   = DNA_CONFIG.mlbTeams.find(t => t.abbr === abbr) || { name: abbr, abbr };
      const rating = teamRatings?.[abbr] || {};
      const ovr    = rating.overall || '—';
      const ovrColor = ovr >= 88 ? 'var(--green)' : ovr >= 82 ? 'var(--gold)' : 'var(--text2)';

      return `
        <div class="team-card" onclick="DraftRoom.makePick('${abbr}')" id="tc-${abbr}" title="${info.name}">
          <div class="team-card-abbr">${abbr}</div>
          <div class="team-card-name">${escHtml(info.name)}</div>
          <div class="team-card-ovr" style="color:${ovrColor}">${ovr}</div>
          <div class="team-card-league">${info.league || ''} ${info.division || ''}</div>
          <div class="team-card-breakdown" id="tcb-${abbr}">
            <div class="tcb-group">
              <span class="tcb-label">Pitching</span>
              <span class="tcb-badge tcb-green">SP ${fmt(rating?.sp)}</span>
              <span class="tcb-badge tcb-green">RP ${fmt(rating?.rp)}</span>
            </div>
            <div class="tcb-group">
              <span class="tcb-label">Hitting</span>
              <span class="tcb-badge tcb-gold">PWR ${fmt(rating?.power)}</span>
              <span class="tcb-badge tcb-gold">CON ${fmt(rating?.contact)}</span>
            </div>
            <div class="tcb-group">
              <span class="tcb-label">Athletic</span>
              <span class="tcb-badge tcb-blue">SPD ${fmt(rating?.speed)}</span>
              <span class="tcb-badge tcb-blue">DEF ${fmt(rating?.defense)}</span>
            </div>
          </div>
          <button type="button" class="team-card-btn" onclick="event.stopPropagation();DraftUI.showTeamDetail('${abbr}')">
            Top 5 ▸
          </button>
        </div>`;
    }).join('');
```

- [ ] **Step 2: Verify cards render badges immediately**

Load `draft.html` in browser, start a draft, confirm:
- No `loading...` text appears at any point
- All 6 badge groups (Pitching / Hitting / Athletic) show on first render
- Cards with no Worker data (fallback path) show `SP —` etc.

- [ ] **Step 3: Commit**

```bash
git add js/draft-board.js
git commit -m "feat: render breakdown badges inline in renderAvailableTeams, remove loading placeholder

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

## Task 4: Wire up `getTeamRatingsFull()` in draft.html and draft-room.js

**Files:**
- Modify: `draft.html:319` — background ratings callback
- Modify: `draft.html:585-586` — `enterDraftRoom()` initial render
- Modify: `draft.html:677-678` — `applyTeamFilter()`
- Modify: `js/draft-room.js` — remove all 7 `loadTeamBreakdowns` calls

- [ ] **Step 1: Update background ratings callback in draft.html**

Find (lines 318–327):
```js
  // Load team ratings in background (non-blocking)
  DnaRatings.getTeamRatings().then(ratings => {
    _teamRatings = ratings;
    const draft = DraftRoom.getDraft();
    if (draft && draft.status === 'active') {
      DraftUI.renderAvailableTeams(draft.availableTeams, _teamRatings);
      DraftUI.loadTeamBreakdowns(draft.availableTeams);
    }
    renderSetupTeamPool();
  });
```

Replace with:
```js
  // Load team ratings in background (non-blocking)
  DnaRatings.getTeamRatingsFull().then(ratings => {
    _teamRatings = ratings;
    const draft = DraftRoom.getDraft();
    if (draft && draft.status === 'active') {
      DraftUI.renderAvailableTeams(draft.availableTeams, _teamRatings);
    }
    renderSetupTeamPool();
  });
```

- [ ] **Step 2: Update `enterDraftRoom()` in draft.html**

Find (lines 584–587):
```js
  DraftBoard.render(draft);
  _allAvailable = draft.availableTeams.slice();
  DraftUI.renderAvailableTeams(draft.availableTeams, draft.teamRatings || _teamRatings);
  DraftUI.loadTeamBreakdowns(draft.availableTeams);
  updateOnClock();
```

Replace with:
```js
  DraftBoard.render(draft);
  _allAvailable = draft.availableTeams.slice();
  DraftUI.renderAvailableTeams(draft.availableTeams, draft.teamRatings || _teamRatings);
  updateOnClock();
```

- [ ] **Step 3: Update `applyTeamFilter()` in draft.html**

Find (lines 677–679):
```js
  DraftUI.renderAvailableTeams(available, draft.teamRatings || _teamRatings);
  DraftUI.loadTeamBreakdowns(available);
}
```

Replace with:
```js
  DraftUI.renderAvailableTeams(available, draft.teamRatings || _teamRatings);
}
```

- [ ] **Step 4: Remove all 7 `loadTeamBreakdowns` calls from draft-room.js**

In `js/draft-room.js`, find and remove every line that reads `DraftUI.loadTeamBreakdowns(...)`. There are exactly 7 occurrences. After removal, every `renderAvailableTeams` call should stand alone without a paired `loadTeamBreakdowns`.

Verify with:
```bash
grep -n "loadTeamBreakdowns" js/draft-room.js
```
Expected: no output (zero matches).

- [ ] **Step 5: Verify full end-to-end**

Open `draft.html`, start or resume a draft. Confirm:
1. Team grid renders with all badges populated immediately — no `loading...` at any point
2. Network tab shows exactly 15 `/teams-full?chunk=N` requests firing in parallel
3. Making a pick re-renders the grid — remaining teams still show all badges immediately
4. Filter/search re-renders — badges still present

- [ ] **Step 6: Commit**

```bash
git add draft.html js/draft-room.js
git commit -m "feat: use getTeamRatingsFull() for single-phase team card render, remove loadTeamBreakdowns wiring

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```
