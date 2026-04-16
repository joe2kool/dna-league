# FA Draft Manual Order Design Spec

**Date:** 2026-04-16
**Feature:** Allow commissioner to manually set/override FA draft pick order in the setup screen

---

## Problem

`launchFADraft()` derives the pick order exclusively from the existing team draft (reversed). If no team draft exists in the DB, launch is blocked with a toast error. There is also no way to override the auto-detected order even when a team draft is present.

---

## Solution Overview

Convert the read-only draft order preview in the setup screen into an interactive ordered list with ↑/↓ buttons. Always populate it on load — from the team draft if found, otherwise from the season's `league_teams` roster (alphabetical). `launchFADraft()` reads the final order directly from the DOM instead of re-fetching from the DB.

---

## Architecture

### Modified files
- `fa-draft.html` — all changes live here (setup screen markup + JS functions)

### No new files, no new DB schema, no Worker changes

---

## Detailed Design

### Setup screen — Draft Order section

**Current markup (line ~143):**
```html
<div class="setup-card">
  <div class="setup-card-header">Draft Order
    <span style="...">(reversed from team draft)</span>
  </div>
  <div class="setup-card-body">
    <div id="setup-order-preview" style="display:flex;gap:8px;flex-wrap:wrap;"></div>
  </div>
</div>
```

**New markup:**
```html
<div class="setup-card">
  <div class="setup-card-header">Draft Order
    <span id="setup-order-source" style="font-size:10px;color:var(--text2);letter-spacing:1px;margin-left:6px;"></span>
  </div>
  <div class="setup-card-body">
    <ol id="setup-order-list" style="list-style:none;display:flex;flex-direction:column;gap:6px;padding:0;margin:0;"></ol>
  </div>
</div>
```

Each list item rendered by JS:
```html
<li data-member-id="<uuid>" style="display:flex;align-items:center;gap:8px;">
  <button class="order-move-btn" onclick="moveOrderItem(this,-1)">↑</button>
  <button class="order-move-btn" onclick="moveOrderItem(this,1)">↓</button>
  <span style="font-size:13px;">Display Name</span>
</li>
```

Button disabled states:
- First item: ↑ disabled
- Last item: ↓ disabled
- Updated after every move

### `showSetupScreen(seasonId)` changes

1. Try to load team draft order (existing logic — reversed unique first-round slots)
2. **If team draft found:** populate list, set source label to `"auto-filled from team draft — reorder as needed"`
3. **If team draft NOT found:** query `league_teams` for this season, join `league_members(display_name)`, sort alphabetically, populate list, set source label to `"no team draft found — set order manually"`
4. Both paths call the same `renderOrderList(members)` helper where `members` is `[{id, name}]`
5. Remove the old `setup-order-preview` div and replace with `setup-order-list`

**Fallback query (no team draft):**
```js
const ltRes = await db.from('league_teams')
  .select('member_id, league_members(display_name)')
  .eq('season_id', seasonId);
// Sort client-side — Supabase does not reliably order by joined column
const members = (ltRes.data || [])
  .map(r => ({ id: r.member_id, name: r.league_members?.display_name || 'Unknown' }))
  .sort((a, b) => a.name.localeCompare(b.name));
```

### `renderOrderList(members)` — new helper

```js
function renderOrderList(members) {
  const list = document.getElementById('setup-order-list');
  list.innerHTML = members.map((m, i) => `
    <li data-member-id="${escHtml(m.id)}"
        style="display:flex;align-items:center;gap:8px;">
      <button class="order-move-btn" onclick="moveOrderItem(this,-1)"
              ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="order-move-btn" onclick="moveOrderItem(this,1)"
              ${i === members.length - 1 ? 'disabled' : ''}>↓</button>
      <span style="font-size:13px;">${escHtml(m.name)}</span>
    </li>`).join('');
}
```

### `moveOrderItem(btn, dir)` — new function

Swaps the clicked item's `<li>` with its sibling in the given direction, then refreshes disabled states on all buttons.

```js
function moveOrderItem(btn, dir) {
  const li   = btn.closest('li');
  const list = li.parentElement;
  const items = [...list.children];
  const idx  = items.indexOf(li);
  const target = items[idx + dir];
  if (!target) return;
  if (dir === -1) list.insertBefore(li, target);
  else            list.insertBefore(target, li);
  refreshOrderButtons();
}

function refreshOrderButtons() {
  const items = [...document.querySelectorAll('#setup-order-list li')];
  items.forEach((li, i) => {
    li.querySelectorAll('.order-move-btn')[0].disabled = (i === 0);
    li.querySelectorAll('.order-move-btn')[1].disabled = (i === items.length - 1);
  });
}
```

### `launchFADraft()` changes

**Remove:**
- The entire team draft re-fetch block (lines ~476–487)
- The `if (!memberOrder.length) { faToast('No team draft found...'); return; }` guard

**Replace with:**
```js
// Read order from setup screen list
const memberOrder = [...document.querySelectorAll('#setup-order-list li')]
  .map(li => li.dataset.memberId)
  .filter(Boolean);

if (!memberOrder.length) { faToast('Add at least one member to the draft order'); return; }
```

Everything after this (draft row creation, slot generation, snake order encoding) is unchanged.

---

## CSS additions (inline `<style>` in `fa-draft.html`)

```css
.order-move-btn {
  background: var(--surface3);
  border: 1px solid rgba(168,189,212,0.15);
  border-radius: 4px;
  color: var(--text);
  width: 26px; height: 26px;
  font-size: 12px;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.order-move-btn:disabled { opacity: 0.25; cursor: default; }
.order-move-btn:not(:disabled):hover { background: rgba(168,189,212,0.12); }
```

---

## Error Handling

- If both team draft fetch AND `league_teams` fetch return no members: show `"No members found for this season"` in the list div and disable the Launch button
- `launchFADraft()` guards `memberOrder.length === 0` with a toast (covers edge case where list is somehow empty)

---

## Not In Scope

- Drag-and-drop reordering
- Saving a custom order as a preset
- Resetting to auto-order after manual edits (commissioner can refresh the page)
