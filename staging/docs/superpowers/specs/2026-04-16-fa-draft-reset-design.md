# FA Draft Reset Design Spec

**Date:** 2026-04-16
**Feature:** Commissioner can reset (delete) an existing FA draft from the season card to start fresh

---

## Problem

When a commissioner runs a test FA draft or needs to restart, there is no way to wipe the existing `player` draft for a season short of the nuclear "Reset All Test Data" button in the League page, which deletes everything. The season card needs a targeted reset for the FA draft only.

---

## Solution Overview

Add a "Reset FA Draft" button to the Teams tab of the season card in `index.html`, next to the existing "Open FA Draft" button. The button only appears when an FA draft already exists for the season (lazy async check after render). Clicking shows an inline confirmation. Confirming deletes `draft_picks` → `draft_slots` → `drafts` for that draft only, then re-renders the season card.

---

## Architecture

### Modified files
- `index.html` only — all changes live here

### No new DB schema, no Worker changes

---

## Detailed Design

### Season card — Teams tab

The existing FA Draft button row (lines ~2285–2290 in `renderSeasonCard`):

```js
if (canManageSchedule() && Object.keys(teams).length > 0) {
  teamsContent +=
    '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">' +
      '<button ... onclick="openFADraft(\'' + s.id + '\')">🏋 FA Draft</button>' +
      '<button ... onclick="downloadFaPoolCsv(\'' + s.id + '\')">⬇ Export FA Pool CSV</button>' +
    '</div>'
```

**New markup** — add a reset container div in the same row:

```js
if (canManageSchedule() && Object.keys(teams).length > 0) {
  teamsContent +=
    '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;">' +
      '<button ... onclick="openFADraft(\'' + s.id + '\')">🏋 FA Draft</button>' +
      '<button ... onclick="downloadFaPoolCsv(\'' + s.id + '\')">⬇ Export FA Pool CSV</button>' +
      '<div id="fa-reset-wrap-' + s.id + '"></div>' +
    '</div>'
```

After `renderSeasonCard` injects the card HTML, call `initFAResetButton(s.id)` to asynchronously check for an existing draft and populate the container if found. This avoids an extra DB round-trip on every render — only fires when Teams tab is active.

**Where to call `initFAResetButton`:** In `switchSeasonTab()` when the `teams` tab is selected, after the card re-renders:

```js
// Inside switchSeasonTab, after renderSeasonCard call, when tab === 'teams':
if (tab === 'teams' && canManageSchedule()) {
  initFAResetButton(season.id);
}
```

---

### `initFAResetButton(seasonId)` — new async function

Checks whether a `player` draft exists for the season. If found, injects the Reset button into `#fa-reset-wrap-{seasonId}`. If not found, leaves the container empty.

```js
async function initFAResetButton(seasonId) {
  const wrap = document.getElementById('fa-reset-wrap-' + seasonId);
  if (!wrap) return;
  const { data } = await db.from('drafts')
    .select('id')
    .eq('season_id', seasonId)
    .eq('type', 'player')
    .maybeSingle();
  if (!data) return;  // no FA draft — nothing to reset
  wrap.innerHTML =
    '<button type="button" class="btn btn-outline btn-sm" ' +
    'style="color:var(--red);border-color:rgba(217,64,64,0.4);" ' +
    'onclick="startFADraftReset(\'' + seasonId + '\',\'' + data.id + '\')">' +
    '&#x21BA; Reset FA Draft</button>';
}
```

---

### `startFADraftReset(seasonId, draftId)` — new function

Replaces the reset button with an inline confirmation row.

```js
function startFADraftReset(seasonId, draftId) {
  const wrap = document.getElementById('fa-reset-wrap-' + seasonId);
  if (!wrap) return;
  wrap.innerHTML =
    '<span style="font-size:12px;color:var(--text2);margin-right:4px;">Reset FA draft? All picks will be lost.</span>' +
    '<button type="button" class="btn btn-outline btn-sm" ' +
    'onclick="cancelFADraftReset(\'' + seasonId + '\',\'' + draftId + '\')" ' +
    'style="color:var(--text2);">Cancel</button>' +
    '<button type="button" class="btn btn-sm" ' +
    'style="background:var(--red);color:#fff;border:none;" ' +
    'onclick="confirmFADraftReset(\'' + seasonId + '\',\'' + draftId + '\')">Confirm Reset</button>';
}
```

---

### `cancelFADraftReset(seasonId, draftId)` — new function

Restores the original Reset button.

```js
function cancelFADraftReset(seasonId, draftId) {
  const wrap = document.getElementById('fa-reset-wrap-' + seasonId);
  if (!wrap) return;
  wrap.innerHTML =
    '<button type="button" class="btn btn-outline btn-sm" ' +
    'style="color:var(--red);border-color:rgba(217,64,64,0.4);" ' +
    'onclick="startFADraftReset(\'' + seasonId + '\',\'' + draftId + '\')">' +
    '&#x21BA; Reset FA Draft</button>';
}
```

---

### `confirmFADraftReset(seasonId, draftId)` — new async function

Executes the delete cascade, then re-renders the season card.

```js
async function confirmFADraftReset(seasonId, draftId) {
  const wrap = document.getElementById('fa-reset-wrap-' + seasonId);
  if (wrap) wrap.innerHTML = '<span style="font-size:12px;color:var(--text2);">Resetting…</span>';

  // Delete in FK order: picks → slots → draft
  const picksRes = await db.from('draft_picks').delete().eq('draft_id', draftId);
  if (picksRes.error) { showToast('Reset failed: ' + picksRes.error.message); initFAResetButton(seasonId); return; }

  const slotsRes = await db.from('draft_slots').delete().eq('draft_id', draftId);
  if (slotsRes.error) { showToast('Reset failed: ' + slotsRes.error.message); initFAResetButton(seasonId); return; }

  const draftRes = await db.from('drafts').delete().eq('id', draftId);
  if (draftRes.error) { showToast('Reset failed: ' + draftRes.error.message); initFAResetButton(seasonId); return; }

  showToast('FA Draft reset — ready for a new draft');
  // Re-render the season card so the reset button disappears
  const season = getSeasonById(seasonId);
  if (season) renderAndReplaceSeasonCard(season);
}
```

**Note on `getSeasonById` and `renderAndReplaceSeasonCard`:** These must refer to whatever the existing pattern is in `index.html` for re-rendering a season card. The explorer found `switchSeasonTab()` calls `renderSeasonCard(season)` and replaces the DOM. The implementation plan should verify the exact re-render mechanism and use it.

---

## Error Handling

- DB delete error at any step: show toast with error message, call `initFAResetButton(seasonId)` to restore the button
- `#fa-reset-wrap-{seasonId}` not in DOM (e.g., tab switched away): early return, no action

## Permissions

- `initFAResetButton` is only called inside `if (canManageSchedule())` — commissioner+ only
- No member can trigger the reset flow

## Not In Scope

- Resetting the team draft
- Resetting individual picks within an active FA draft
- Undo after reset
