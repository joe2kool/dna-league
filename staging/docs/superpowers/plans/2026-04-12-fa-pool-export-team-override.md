# FA Pool Export & Team Assignment Override Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an FA player pool CSV export button and an inline team assignment override control to the season card Teams tab in `index.html`.

**Architecture:** All changes are additive to `index.html`. `saveTeamAssignment` is updated to support upsert and clearing. Three new fetch/CSV functions handle the export. The Teams tab row template gains a pencil icon that uses existing `seasonState.teamAssignEditing` state. No new files created.

**Tech Stack:** Vanilla JS, Supabase JS client (`db`), Cloudflare Worker (`DNA_CONFIG.app.workerUrl`), browser Blob/URL APIs for CSV download.

---

## File Map

| File | Change |
|------|--------|
| `index.html` | Fix `saveTeamAssignment`; add `startTeamOverride`, `cancelTeamOverride`, `confirmTeamOverride`; update Teams tab row template; add `fetchFaPool`, `buildFaPoolCsv`, `downloadFaPoolCsv`, `submitFaPoolForm`; add export button + form to Teams tab template |

---

## Task 1: Fix `saveTeamAssignment` — upsert and clearing support

**Files:**
- Modify: `index.html` ~line 2778

The existing function uses `.update()` (fails if no row exists) and rejects empty `teamName` (blocks clearing). Fix both.

- [ ] **Step 1: Locate the function**

Open `index.html` and find `saveTeamAssignment` (~line 2778). Confirm it currently reads:

```javascript
async function saveTeamAssignment(seasonId, memberId, teamName) {
  var s = seasonState.seasons.find(function(x) { return x.id === seasonId; });
  if (!s) return;

  var mlbTeamId = getMlbTeamId(teamName);
  if (!mlbTeamId) { toast('Unknown team: ' + teamName); return; }

  var res = await db.from('league_teams')
    .update({ mlb_team_id: mlbTeamId })
    .eq('season_id', seasonId)
    .eq('member_id', memberId);

  if (res.error) { toast('Error saving team assignment'); console.error(res.error.message); return; }

  s.teamAssignments[memberId] = teamName;
  renderSeasonsList();
}
```

- [ ] **Step 2: Replace with upsert + clear version**

```javascript
async function saveTeamAssignment(seasonId, memberId, teamName) {
  var s = seasonState.seasons.find(function(x) { return x.id === seasonId; });
  if (!s) return;

  var mlbTeamId = teamName ? getMlbTeamId(teamName) : null;
  if (teamName && !mlbTeamId) { toast('Unknown team: ' + teamName); return; }

  var res = await db.from('league_teams')
    .upsert(
      { season_id: seasonId, member_id: memberId, mlb_team_id: mlbTeamId },
      { onConflict: 'season_id,member_id' }
    );

  if (res.error) { toast('Error saving team assignment'); console.error(res.error.message); return; }

  if (teamName) {
    s.teamAssignments[memberId] = teamName;
  } else {
    delete s.teamAssignments[memberId];
  }
  renderSeasonsList();
}
```

- [ ] **Step 3: Manual verify — existing assignment change**

In the app, open a season with at least one team assigned. Change that member's team via the existing dropdown. Confirm the new team saves (no toast error, tag updates).

- [ ] **Step 4: Manual verify — clearing**

Open browser console. Run:
```javascript
saveTeamAssignment('<seasonId>', '<memberId>', '');
```
Confirm: no error toast, the member's team tag disappears from the Teams tab, `seasonState.seasons[i].teamAssignments[memberId]` is undefined.

- [ ] **Step 5: Commit**

```bash
git add index.html
git commit -m "fix: saveTeamAssignment uses upsert and supports clearing"
```

---

## Task 2: Add team override helper functions

**Files:**
- Modify: `index.html` — add three functions near `saveTeamAssignment`

These functions control which row is in "override edit mode" via `seasonState.teamAssignEditing`.

- [ ] **Step 1: Locate insertion point**

Find the line just after `saveTeamAssignment` closes (the `}` on ~line 2794). Add the three functions immediately after.

- [ ] **Step 2: Add the functions**

```javascript
function startTeamOverride(seasonId, memberId) {
  seasonState.teamAssignEditing = { seasonId: seasonId, memberId: memberId };
  renderSeasonsList();
}

function cancelTeamOverride() {
  seasonState.teamAssignEditing = null;
  renderSeasonsList();
}

async function confirmTeamOverride(seasonId, memberId) {
  var sel = document.getElementById('override-ta-' + seasonId + '-' + memberId);
  if (!sel) return;
  var teamName = sel.value; // empty string = clear
  seasonState.teamAssignEditing = null;
  await saveTeamAssignment(seasonId, memberId, teamName);
  // saveTeamAssignment calls renderSeasonsList() internally
}
```

- [ ] **Step 3: Manual verify — functions exist**

In browser console:
```javascript
typeof startTeamOverride   // "function"
typeof cancelTeamOverride  // "function"
typeof confirmTeamOverride // "function"
```

- [ ] **Step 4: Commit**

```bash
git add index.html
git commit -m "feat: add team override helper functions"
```

---

## Task 3: Update Teams tab row template — pencil icon and override UI

**Files:**
- Modify: `index.html` ~lines 2226–2240 (the `team-assignment-row` template inside `renderSeasonCard`)

Add a pencil icon (✏) per row (commissioner+ only). When `seasonState.teamAssignEditing` matches the row, render an override select (all 30 teams, including taken ones) with confirm/cancel buttons instead of the pencil.

- [ ] **Step 1: Locate the row template**

Find this block (~line 2226):

```javascript
return '<div class="team-assignment-row">' +
  '<div class="ta-player">' +
    ...
  '</div>' +
  '<div class="ta-team">' +
    '<select id="ta-' + s.id + '-' + r.memberId + '" ' +
      (canManageSchedule() ? 'onchange="saveTeamAssignment(..."' : 'disabled') + '>' +
      options +
    '</select>' +
  '</div>' +
  (assigned ? '<span class="tag tag-gold" style="flex-shrink:0;font-size:10px;">' + escHtml(assigned.split(' ').pop()) + '</span>' : '') +
  '</div>';
```

- [ ] **Step 2: Replace with the updated template**

Insert the `isEditing` check and override UI. The `options` variable and everything before the `return` statement stays unchanged — only the `return` string changes.

```javascript
var isEditing = !!(seasonState.teamAssignEditing &&
  seasonState.teamAssignEditing.seasonId === s.id &&
  seasonState.teamAssignEditing.memberId === r.memberId);

var overrideOptions = '<option value="">— No Team —</option>' +
  MLB_TEAMS.map(function(t) {
    return '<option value="' + escHtml(t) + '"' + (assigned === t ? ' selected' : '') + '>' + escHtml(t) + '</option>';
  }).join('');

var overrideRow = isEditing
  ? '<div style="width:100%;display:flex;align-items:center;gap:6px;margin-top:4px;flex-wrap:wrap;">' +
      '<select id="override-ta-' + s.id + '-' + r.memberId + '" style="flex:1;min-width:120px;font-size:12px;">' +
        overrideOptions +
      '</select>' +
      '<button type="button" onclick="confirmTeamOverride(\'' + s.id + '\',\'' + r.memberId + '\')" ' +
        'style="padding:2px 8px;font-size:13px;cursor:pointer;" title="Confirm">&#x2713;</button>' +
      '<button type="button" onclick="cancelTeamOverride()" ' +
        'style="padding:2px 8px;font-size:13px;cursor:pointer;" title="Cancel">&#x2717;</button>' +
    '</div>'
  : '';

var pencilBtn = (canManageSchedule() && !isEditing)
  ? '<button type="button" onclick="startTeamOverride(\'' + s.id + '\',\'' + r.memberId + '\')" ' +
      'title="Override team assignment" ' +
      'style="background:none;border:none;cursor:pointer;color:var(--text2);font-size:13px;padding:0 3px;flex-shrink:0;">&#x270F;</button>'
  : '';

return '<div class="team-assignment-row" style="flex-wrap:wrap;">' +
  '<div class="ta-player">' +
    '<div class="avatar-sm" style="background:' + (player.color||'#6a9ec7') + ';font-size:11px;">' +
      player.name.split(' ').map(function(w){return w[0]||'';}).join('').slice(0,2).toUpperCase() +
    '</div>' +
    escHtml(player.name) +
  '</div>' +
  '<div class="ta-team">' +
    '<select id="ta-' + s.id + '-' + r.memberId + '" ' +
      (canManageSchedule() ? 'onchange="saveTeamAssignment(\'' + s.id + '\',\'' + r.memberId + '\',this.value)"' : 'disabled') + '>' +
      options +
    '</select>' +
  '</div>' +
  (assigned ? '<span class="tag tag-gold" style="flex-shrink:0;font-size:10px;">' + escHtml(assigned.split(' ').pop()) + '</span>' : '') +
  pencilBtn +
  overrideRow +
  '</div>';
```

- [ ] **Step 3: Manual verify — pencil icon appears**

Open any season's Teams tab as a commissioner. Confirm a ✏ icon appears to the right of each assigned team tag.

- [ ] **Step 4: Manual verify — edit mode opens**

Click the ✏ icon on any row. Confirm:
- The pencil disappears on that row
- A dropdown appears with all 30 teams (including any taken by others) plus "— No Team —" at top
- ✓ and ✗ buttons appear

- [ ] **Step 5: Manual verify — confirm saves**

In edit mode, select a different team and click ✓. Confirm the assignment updates and the row exits edit mode.

- [ ] **Step 6: Manual verify — cancel discards**

Click ✏, change the team selection, click ✗. Confirm the original assignment is unchanged.

- [ ] **Step 7: Manual verify — one row at a time**

Click ✏ on row A (enters edit mode). Click ✏ on row B. Confirm row A exits edit mode and row B enters it.

- [ ] **Step 8: Manual verify — only one edit open at a time**

`seasonState.teamAssignEditing` should only hold one `{ seasonId, memberId }` at a time. Confirm in console.

- [ ] **Step 9: Commit**

```bash
git add index.html
git commit -m "feat: add inline team assignment override to Teams tab"
```

---

## Task 4: Add `fetchFaPool` and `buildFaPoolCsv` functions

**Files:**
- Modify: `index.html` — add two functions in the schedule/season helper section

- [ ] **Step 1: Find insertion point**

Locate `function openFADraft(seasonId)` (~line 2683). Add the two new functions immediately before it.

- [ ] **Step 2: Add `fetchFaPool`**

```javascript
async function fetchFaPool(teamAbbrs, min, max) {
  var workerUrl = DNA_CONFIG.app.workerUrl;
  var results = await Promise.all(teamAbbrs.map(function(abbr) {
    return fetch(workerUrl + '/fa-roster?team=' + encodeURIComponent(abbr) + '&min=' + min + '&max=' + max)
      .then(function(r) { return r.ok ? r.json() : { players: [], team: abbr }; })
      .catch(function() { return { players: [], team: abbr }; });
  }));
  var all = [];
  results.forEach(function(r) {
    (r.players || []).forEach(function(p) {
      all.push(Object.assign({}, p, { fromTeam: r.team || '' }));
    });
  });
  all.sort(function(a, b) { return b.overall - a.overall; });
  return all;
}
```

- [ ] **Step 3: Add `buildFaPoolCsv`**

```javascript
function buildFaPoolCsv(players) {
  var HEADERS = [
    'Name','OVR','Pos','Team','Bats','Throws',
    'Contact L','Contact R','Power L','Power R','Plate Vision','Plate Discipline','Clutch',
    'Speed','Stealing','Fielding','Arm Strength','Arm Accuracy',
    'Stamina','Pitching Clutch','Velocity','Control','Break',
    'H/BF L','H/BF R','K/BF L','K/BF R','BB/BF','HR/BF',
    'Pitch Arsenal','Quirks'
  ];
  var PITCHER_POS = ['SP','RP','CP'];

  function csvEsc(v) {
    if (v == null || v === '') return '';
    var s = String(v);
    if (s.indexOf(',') > -1 || s.indexOf('"') > -1 || s.indexOf('\n') > -1) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  var rows = [HEADERS.join(',')];
  players.forEach(function(p) {
    var isPitcher = PITCHER_POS.indexOf(p.pos) > -1;
    var quirks = (p.quirks || []).join('; ');
    var arsenal = isPitcher
      ? (p.pitch_arsenal || [])
          .map(function(a) { return a.name + ':' + a.speed + ':' + a.break; })
          .join('; ')
      : '';

    rows.push([
      csvEsc(p.name),
      csvEsc(p.overall),
      csvEsc(p.pos),
      csvEsc(p.fromTeam),
      csvEsc(p.bats),
      csvEsc(p.throws),
      // Hitter attributes (blank for pitchers)
      csvEsc(isPitcher ? '' : p.contact_left),
      csvEsc(isPitcher ? '' : p.contact_right),
      csvEsc(isPitcher ? '' : p.power_left),
      csvEsc(isPitcher ? '' : p.power_right),
      csvEsc(isPitcher ? '' : p.plate_vision),
      csvEsc(isPitcher ? '' : p.plate_discipline),
      csvEsc(isPitcher ? '' : p.clutch),
      csvEsc(isPitcher ? '' : p.speed),
      csvEsc(isPitcher ? '' : p.stealing),
      csvEsc(isPitcher ? '' : p.fielding),
      csvEsc(isPitcher ? '' : p.arm_strength),
      csvEsc(isPitcher ? '' : p.arm_accuracy),
      // Pitcher attributes (blank for hitters)
      csvEsc(isPitcher ? p.stamina : ''),
      csvEsc(isPitcher ? p.pitching_clutch : ''),
      csvEsc(isPitcher ? p.velocity : ''),
      csvEsc(isPitcher ? p.control : ''),
      csvEsc(isPitcher ? p.break_rating : ''),
      csvEsc(isPitcher ? p.hits_per_bf_l : ''),
      csvEsc(isPitcher ? p.hits_per_bf_r : ''),
      csvEsc(isPitcher ? p.k_per_bf_l : ''),
      csvEsc(isPitcher ? p.k_per_bf_r : ''),
      csvEsc(isPitcher ? p.bb_per_bf : ''),
      csvEsc(isPitcher ? p.hr_per_bf : ''),
      csvEsc(arsenal),
      csvEsc(quirks),
    ].join(','));
  });
  return rows.join('\n');
}
```

- [ ] **Step 4: Manual verify — functions load without error**

Reload the app. In console:
```javascript
typeof fetchFaPool    // "function"
typeof buildFaPoolCsv // "function"
```

- [ ] **Step 5: Manual verify — fetchFaPool returns players**

```javascript
fetchFaPool(['LAD'], 70, 84).then(function(p) { console.log(p.length, p[0]); });
// Expected: array of player objects, first one has name/overall/pos/fromTeam etc.
```

- [ ] **Step 6: Manual verify — buildFaPoolCsv output**

```javascript
fetchFaPool(['LAD'], 75, 84).then(function(players) {
  var csv = buildFaPoolCsv(players);
  console.log(csv.split('\n').slice(0, 3).join('\n'));
});
// Expected: header row + 2 player rows with correct columns,
// pitcher rows have blank hitter columns and vice versa
```

- [ ] **Step 7: Commit**

```bash
git add index.html
git commit -m "feat: add fetchFaPool and buildFaPoolCsv functions"
```

---

## Task 5: Add export button + `downloadFaPoolCsv` to Teams tab

**Files:**
- Modify: `index.html` — add `downloadFaPoolCsv` and `submitFaPoolForm` functions; update Teams tab template

- [ ] **Step 1: Add `downloadFaPoolCsv` and `submitFaPoolForm`**

Add these two functions immediately after `buildFaPoolCsv`:

```javascript
async function downloadFaPoolCsv(seasonId) {
  var s = seasonState.seasons.find(function(x) { return x.id === seasonId; });
  if (!s) return;

  var teamAbbrs = Object.values(s.teamAssignments)
    .map(function(fullName) {
      var t = DNA_CONFIG.mlbTeams.find(function(t) { return t.name === fullName; });
      return t ? t.abbr : null;
    })
    .filter(Boolean);

  if (!teamAbbrs.length) { toast('No teams assigned to this season.'); return; }

  var btn = document.getElementById('fa-pool-export-btn-' + seasonId);
  if (btn) { btn.textContent = 'Checking…'; btn.disabled = true; }

  try {
    var draftRes = await db.from('drafts')
      .select('settings')
      .eq('season_id', seasonId)
      .eq('type', 'player')
      .maybeSingle();

    if (draftRes.data && draftRes.data.settings) {
      var min = draftRes.data.settings.ratingMin || 70;
      var max = draftRes.data.settings.ratingMax || 84;
      if (btn) { btn.textContent = 'Export FA Pool CSV'; btn.disabled = false; }
      await _runFaPoolDownload(s, teamAbbrs, min, max);
    } else {
      // No FA draft config — reveal inline form
      if (btn) { btn.textContent = 'Export FA Pool CSV'; btn.disabled = false; }
      var form = document.getElementById('fa-pool-form-' + seasonId);
      if (form) form.style.display = 'flex';
    }
  } catch(e) {
    toast('Error: ' + e.message);
    if (btn) { btn.textContent = 'Export FA Pool CSV'; btn.disabled = false; }
  }
}

async function submitFaPoolForm(seasonId) {
  var s = seasonState.seasons.find(function(x) { return x.id === seasonId; });
  if (!s) return;
  var min = parseInt(document.getElementById('fa-pool-min-' + seasonId).value, 10);
  var max = parseInt(document.getElementById('fa-pool-max-' + seasonId).value, 10);
  if (isNaN(min) || isNaN(max) || min > max) { toast('Invalid OVR range.'); return; }

  var teamAbbrs = Object.values(s.teamAssignments)
    .map(function(fullName) {
      var t = DNA_CONFIG.mlbTeams.find(function(t) { return t.name === fullName; });
      return t ? t.abbr : null;
    })
    .filter(Boolean);

  await _runFaPoolDownload(s, teamAbbrs, min, max);
}

async function _runFaPoolDownload(season, teamAbbrs, min, max) {
  var btn = document.getElementById('fa-pool-export-btn-' + season.id);
  var dlBtn = document.getElementById('fa-pool-dl-btn-' + season.id);
  if (btn)   { btn.textContent = 'Fetching…'; btn.disabled = true; }
  if (dlBtn) { dlBtn.textContent = 'Fetching…'; dlBtn.disabled = true; }

  try {
    var players = await fetchFaPool(teamAbbrs, min, max);
    if (!players.length) { toast('No players found in that OVR range.'); return; }

    var csv  = buildFaPoolCsv(players);
    var blob = new Blob([csv], { type: 'text/csv' });
    var url  = URL.createObjectURL(blob);
    var a    = document.createElement('a');
    a.href     = url;
    a.download = 'fa-pool-' + season.name.replace(/\s+/g, '_') + '-' + min + '-' + max + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch(e) {
    toast('Error fetching FA pool: ' + e.message);
  } finally {
    if (btn)   { btn.textContent = 'Export FA Pool CSV'; btn.disabled = false; }
    if (dlBtn) { dlBtn.textContent = 'Download'; dlBtn.disabled = false; }
  }
}
```

- [ ] **Step 2: Add export button to Teams tab template**

Find the block that renders the FA Draft button (inside `if (Object.keys(teams).length > 0)`, ~line 2256). Currently:

```javascript
if (Object.keys(teams).length > 0) {
  teamsContent += '<div style="margin-top:8px;">' +
    '<button type="button" class="btn btn-outline btn-sm" style="color:var(--blue);border-color:rgba(106,158,199,0.4);" onclick="openFADraft(\'' + s.id + '\')">&#x1F3CB; FA Draft</button>' +
    '</div>';
}
```

Replace with:

```javascript
if (Object.keys(teams).length > 0) {
  teamsContent +=
    '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">' +
      '<button type="button" class="btn btn-outline btn-sm" style="color:var(--blue);border-color:rgba(106,158,199,0.4);" onclick="openFADraft(\'' + s.id + '\')">&#x1F3CB; FA Draft</button>' +
      '<button type="button" id="fa-pool-export-btn-' + s.id + '" class="btn btn-outline btn-sm" style="color:var(--green);border-color:rgba(80,200,120,0.4);" onclick="downloadFaPoolCsv(\'' + s.id + '\')">&#x2B07; Export FA Pool CSV</button>' +
    '</div>' +
    '<div id="fa-pool-form-' + s.id + '" style="display:none;margin-top:8px;align-items:center;gap:6px;flex-wrap:wrap;">' +
      '<span style="font-size:12px;color:var(--text2);">OVR range:</span>' +
      '<input type="number" id="fa-pool-min-' + s.id + '" value="70" min="1" max="99" style="width:52px;padding:2px 4px;font-size:12px;background:var(--bg2);border:1px solid var(--border);border-radius:4px;color:var(--text);">' +
      '<span style="font-size:12px;color:var(--text2);">–</span>' +
      '<input type="number" id="fa-pool-max-' + s.id + '" value="84" min="1" max="99" style="width:52px;padding:2px 4px;font-size:12px;background:var(--bg2);border:1px solid var(--border);border-radius:4px;color:var(--text);">' +
      '<button type="button" id="fa-pool-dl-btn-' + s.id + '" class="btn btn-sm" onclick="submitFaPoolForm(\'' + s.id + '\')">Download</button>' +
    '</div>';
}
```

- [ ] **Step 3: Manual verify — button appears**

Open a season with at least one team assigned. On the Teams tab, confirm the "⬇ Export FA Pool CSV" green-tinted button appears next to the FA Draft button.

- [ ] **Step 4: Manual verify — with existing FA draft (configured range used)**

For a season that already has an FA draft record in Supabase: click "Export FA Pool CSV". Confirm:
- Button shows "Checking…" briefly
- No OVR form appears
- A CSV file downloads named `fa-pool-<seasonName>-<min>-<max>.csv`
- The file opens in a spreadsheet and has the correct 31-column header row

- [ ] **Step 5: Manual verify — without existing FA draft (form appears)**

For a season with no FA draft record: click "Export FA Pool CSV". Confirm:
- The inline OVR range form appears (Min=70, Max=84 pre-filled)
- Form is hidden initially, visible after click
- Entering a range and clicking Download triggers the CSV download
- Button shows "Fetching…" while the worker request is in flight

- [ ] **Step 6: Manual verify — CSV content correctness**

Open the downloaded CSV in a spreadsheet. Verify:
- Row 1: 31 header columns match the spec
- Position player rows have Contact L/R, Power L/R, etc. populated; Stamina, Velocity, Pitch Arsenal are blank
- Pitcher rows have Stamina, Velocity, K/BF L, etc. populated; Contact L/R, Speed, etc. are blank
- Quirks column lists quirk names separated by "; "
- Pitch Arsenal column for SP rows lists pitches as `PitchName:speed:break; ...`
- Team column shows the team abbreviation (e.g., "LAD")

- [ ] **Step 7: Manual verify — error state**

Temporarily set `DNA_CONFIG.app.workerUrl` to a bad URL in console and click Export. Confirm an error toast appears and the button resets to its default label.

- [ ] **Step 8: Commit**

```bash
git add index.html
git commit -m "feat: add FA pool CSV export to season card Teams tab"
```

---

## Spec Coverage Check

| Spec requirement | Task |
|-----------------|------|
| Export button in Teams tab, commissioner+ only | Task 5 step 2 (inside `canManageSchedule()` block via `Object.keys(teams).length > 0` which is already inside commissioner gate) |
| Use FA draft ratingMin/ratingMax if draft exists | Task 5 step 1 (`downloadFaPoolCsv` queries drafts table) |
| Show inline OVR form if no FA draft | Task 5 steps 1–2 (`fa-pool-form` div shown on demand) |
| Loading state + error handling | Task 5 step 1 (`_runFaPoolDownload` with finally block) |
| CSV filename `fa-pool-{seasonName}-{min}-{max}.csv` | Task 5 step 1 |
| All 31 CSV columns (hitter + pitcher split) | Task 4 step 3 |
| Pitch arsenal as `Name:speed:break; ...` | Task 4 step 3 |
| Quirks as semicolon-separated | Task 4 step 3 |
| Pencil icon per row, commissioner+ only | Task 3 step 2 |
| Only one row in edit mode at a time | Task 2 + Task 3 (state via `seasonState.teamAssignEditing`) |
| Override select shows all 30 teams + No Team | Task 3 step 2 |
| Confirm saves via upsert | Task 1 + Task 2 (`confirmTeamOverride` calls `saveTeamAssignment`) |
| Cancel discards without saving | Task 2 (`cancelTeamOverride`) |
| Clearing team sets mlb_team_id null + removes from teamAssignments | Task 1 |
| Upsert creates row for members with no existing row | Task 1 |
