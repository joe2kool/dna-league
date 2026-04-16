# FA Draft Manual Order Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the read-only FA draft order preview with an interactive ↑/↓ reorder list, with a fallback to season members when no team draft exists.

**Architecture:** All changes are in `fa-draft.html`. The setup screen's static chip preview becomes a draggable-free, button-driven ordered list. `showSetupScreen()` is updated to always populate the list (team draft first, season members as fallback). `launchFADraft()` reads member order from the DOM instead of re-fetching from the DB.

**Tech Stack:** Vanilla JS, Supabase JS v2, existing CSS variables

---

## File Map

| File | Change |
|------|--------|
| `fa-draft.html:38–41` | Add `.order-move-btn` CSS inside existing `<style>` block |
| `fa-draft.html:143–149` | Replace read-only order preview card with interactive `<ol>` |
| `fa-draft.html:401–436` | Rewrite `showSetupScreen()` — add fallback, call `renderOrderList()` |
| `fa-draft.html:442–444` | After `escHtml`, add `renderOrderList()`, `moveOrderItem()`, `refreshOrderButtons()` |
| `fa-draft.html:463–518` | Rewrite `launchFADraft()` — read order from DOM, remove team-draft re-fetch |

---

## Task 1: Add CSS and update markup

**Files:**
- Modify: `fa-draft.html:38–41` (inside `<style>` block)
- Modify: `fa-draft.html:143–149` (Draft Order setup card)

- [ ] **Step 1: Add `.order-move-btn` CSS**

Find in `fa-draft.html` (lines 38–41):
```css
  /* Auth screen */
  .auth-wrap { max-width:380px; margin:80px auto; padding:1.5rem; background:var(--surface2); border-radius:12px; border:1px solid var(--border); }
  .auth-wrap h2 { font-family:'Bebas Neue'; font-size:32px; letter-spacing:2px; margin-bottom:1rem; }
</style>
```

Replace with:
```css
  /* Auth screen */
  .auth-wrap { max-width:380px; margin:80px auto; padding:1.5rem; background:var(--surface2); border-radius:12px; border:1px solid var(--border); }
  .auth-wrap h2 { font-family:'Bebas Neue'; font-size:32px; letter-spacing:2px; margin-bottom:1rem; }

  /* Draft order list */
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
    padding: 0;
  }
  .order-move-btn:disabled { opacity: 0.25; cursor: default; }
  .order-move-btn:not(:disabled):hover { background: rgba(168,189,212,0.12); }
</style>
```

- [ ] **Step 2: Replace the Draft Order setup card**

Find in `fa-draft.html` (lines 143–149):
```html
      <!-- Draft Order Preview -->
      <div class="setup-card">
        <div class="setup-card-header">Draft Order <span style="font-size:10px;color:var(--text2);letter-spacing:1px;">(reversed from team draft)</span></div>
        <div class="setup-card-body">
          <div id="setup-order-preview" style="display:flex;gap:8px;flex-wrap:wrap;"></div>
        </div>
      </div>
```

Replace with:
```html
      <!-- Draft Order -->
      <div class="setup-card">
        <div class="setup-card-header">Draft Order <span id="setup-order-source" style="font-size:10px;color:var(--text2);letter-spacing:1px;margin-left:6px;"></span></div>
        <div class="setup-card-body">
          <ol id="setup-order-list" style="list-style:none;display:flex;flex-direction:column;gap:6px;padding:0;margin:0;"></ol>
        </div>
      </div>
```

- [ ] **Step 3: Commit**

```bash
git add fa-draft.html
git commit -m "feat: add draft order list markup and CSS"
```

---

## Task 2: Add helper functions

**Files:**
- Modify: `fa-draft.html` — add three functions after `escHtml` (around line 444)

- [ ] **Step 1: Add `renderOrderList`, `moveOrderItem`, `refreshOrderButtons` after `escHtml`**

Find in `fa-draft.html` (around line 442):
```js
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
```

Replace with:
```js
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderOrderList(members) {
  const list = document.getElementById('setup-order-list');
  list.innerHTML = members.map((m, i) => `
    <li data-member-id="${escHtml(m.id)}"
        style="display:flex;align-items:center;gap:8px;">
      <button class="order-move-btn" onclick="moveOrderItem(this,-1)"
              ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="order-move-btn" onclick="moveOrderItem(this,1)"
              ${i === members.length - 1 ? 'disabled' : ''}>↓</button>
      <span style="font-size:13px;color:var(--text);">
        <span style="color:var(--text2);margin-right:4px;">${i + 1}.</span>${escHtml(m.name)}
      </span>
    </li>`).join('');
}

function moveOrderItem(btn, dir) {
  const li    = btn.closest('li');
  const list  = li.parentElement;
  const items = [...list.children];
  const idx   = items.indexOf(li);
  const target = items[idx + dir];
  if (!target) return;
  if (dir === -1) list.insertBefore(li, target);
  else            list.insertBefore(target, li);
  refreshOrderButtons();
}

function refreshOrderButtons() {
  const items = [...document.querySelectorAll('#setup-order-list li')];
  items.forEach((li, i) => {
    const btns = li.querySelectorAll('.order-move-btn');
    btns[0].disabled = (i === 0);
    btns[1].disabled = (i === items.length - 1);
    // Update position number
    li.querySelector('span > span').textContent = `${i + 1}.`;
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add fa-draft.html
git commit -m "feat: add renderOrderList, moveOrderItem, refreshOrderButtons helpers"
```

---

## Task 3: Rewrite `showSetupScreen`

**Files:**
- Modify: `fa-draft.html:401–440` — `showSetupScreen` function

- [ ] **Step 1: Replace `showSetupScreen`**

Find in `fa-draft.html`:
```js
async function showSetupScreen(seasonId) {
  // Build draft order preview from existing team draft slots (reversed)
  const teamDraftRes = await db.from('drafts')
    .select('id')
    .eq('season_id', seasonId)
    .eq('type', 'team')
    .maybeSingle();

  let orderNames = [];
  if (teamDraftRes.data) {
    const slotsRes = await db.from('draft_slots')
      .select('pick_number, member_id, league_members(display_name)')
      .eq('draft_id', teamDraftRes.data.id)
      .order('pick_number', { ascending: true });
    if (slotsRes.data) {
      // Take only unique members (first-round slots), then reverse
      const seen = new Set();
      const unique = [];
      slotsRes.data.forEach(s => {
        if (!seen.has(s.member_id)) { seen.add(s.member_id); unique.push(s); }
      });
      unique.reverse();
      orderNames = unique.map(s => s.league_members?.display_name || 'Unknown');
    }
  }

  const preview = document.getElementById('setup-order-preview');
  if (orderNames.length) {
    preview.innerHTML = orderNames.map((n, i) =>
      `<div style="background:var(--surface3);border-radius:6px;padding:4px 10px;font-size:12px;">
        <span style="color:var(--text2);">${i+1}.</span> ${escHtml(n)}
      </div>`
    ).join('');
  } else {
    preview.innerHTML = '<div style="font-size:13px;color:var(--text2);">No team draft found — order will be set when you launch.</div>';
  }

  document.getElementById('fa-nav-title').textContent = 'FA Draft — ' + escHtml(currentSeason.name);
  showScreen('setup');
}
```

Replace with:
```js
async function showSetupScreen(seasonId) {
  let members = [];  // [{ id, name }]
  let sourceLabel = '';

  // Try team draft first
  const teamDraftRes = await db.from('drafts')
    .select('id')
    .eq('season_id', seasonId)
    .eq('type', 'team')
    .maybeSingle();

  if (teamDraftRes.data) {
    const slotsRes = await db.from('draft_slots')
      .select('pick_number, member_id, league_members(display_name)')
      .eq('draft_id', teamDraftRes.data.id)
      .order('pick_number', { ascending: true });
    if (slotsRes.data && slotsRes.data.length) {
      const seen = new Set();
      const unique = [];
      slotsRes.data.forEach(s => {
        if (!seen.has(s.member_id)) { seen.add(s.member_id); unique.push(s); }
      });
      unique.reverse();
      members = unique.map(s => ({ id: s.member_id, name: s.league_members?.display_name || 'Unknown' }));
      sourceLabel = 'auto-filled from team draft — reorder as needed';
    }
  }

  // Fallback: season members from league_teams
  if (!members.length) {
    const ltRes = await db.from('league_teams')
      .select('member_id, league_members(display_name)')
      .eq('season_id', seasonId);
    members = (ltRes.data || [])
      .map(r => ({ id: r.member_id, name: r.league_members?.display_name || 'Unknown' }))
      .sort((a, b) => a.name.localeCompare(b.name));
    sourceLabel = members.length ? 'no team draft found — set order manually' : '';
  }

  document.getElementById('setup-order-source').textContent = sourceLabel;

  if (members.length) {
    renderOrderList(members);
  } else {
    document.getElementById('setup-order-list').innerHTML =
      '<li style="font-size:13px;color:var(--text2);">No members found for this season.</li>';
  }

  document.getElementById('fa-nav-title').textContent = 'FA Draft — ' + escHtml(currentSeason.name);
  showScreen('setup');
}
```

- [ ] **Step 2: Commit**

```bash
git add fa-draft.html
git commit -m "feat: rewrite showSetupScreen to populate interactive order list with fallback"
```

---

## Task 4: Rewrite `launchFADraft` to read order from DOM

**Files:**
- Modify: `fa-draft.html:463–518` — `launchFADraft` function

- [ ] **Step 1: Replace the team-draft re-fetch block in `launchFADraft`**

Find in `fa-draft.html` (inside `launchFADraft`, lines ~475–489):
```js
  // Get reversed team draft order
  const teamDraftRes = await db.from('drafts').select('id').eq('season_id', seasonId).eq('type','team').maybeSingle();
  let memberOrder = [];
  if (teamDraftRes.data) {
    const slotsRes = await db.from('draft_slots')
      .select('pick_number, member_id')
      .eq('draft_id', teamDraftRes.data.id)
      .order('pick_number', { ascending: true });
    const seen = new Set(); const unique = [];
    (slotsRes.data || []).forEach(s => { if (!seen.has(s.member_id)) { seen.add(s.member_id); unique.push(s.member_id); } });
    unique.reverse();
    memberOrder = unique;
  }

  if (!memberOrder.length) { faToast('No team draft found to derive order'); return; }
```

Replace with:
```js
  // Read member order from the interactive setup list
  const memberOrder = [...document.querySelectorAll('#setup-order-list li[data-member-id]')]
    .map(li => li.dataset.memberId)
    .filter(Boolean);

  if (!memberOrder.length) { faToast('Add at least one member to the draft order'); return; }
```

- [ ] **Step 2: Verify the full `launchFADraft` function looks correct after the edit**

The function should now be:
```js
async function launchFADraft() {
  const ratingMin   = parseInt(document.getElementById('setup-min').value) || 70;
  const ratingMax   = parseInt(document.getElementById('setup-max').value) || 79;
  const rounds      = parseInt(document.getElementById('setup-rounds').value) || 1;
  const timerSecs   = parseInt(document.getElementById('setup-timer').value) || 0;
  const offlineTimerSecs = parseInt(document.getElementById('setup-offline-timer').value) || 30;

  if (ratingMin > ratingMax) { faToast('Min must be ≤ Max'); return; }

  const params   = new URL(location.href).searchParams;
  const seasonId = params.get('season');

  // Read member order from the interactive setup list
  const memberOrder = [...document.querySelectorAll('#setup-order-list li[data-member-id]')]
    .map(li => li.dataset.memberId)
    .filter(Boolean);

  if (!memberOrder.length) { faToast('Add at least one member to the draft order'); return; }

  // Create draft row
  const draftRes = await db.from('drafts').insert({
    season_id:     seasonId,
    league_id:     currentLeague.id,
    type:          'player',
    status:        'countdown',
    order_mode:    'weighted',
    timer_seconds: timerSecs,
    settings:      { ratingMin, ratingMax, rounds, countdownEndAt: new Date(Date.now() + 120000).toISOString(), offlineTimerSeconds: offlineTimerSecs },
    name:          'FA Draft — ' + currentSeason.name,
  }).select().single();

  if (draftRes.error) { faToast('Error creating draft: ' + draftRes.error.message); return; }
  activeDraftId = draftRes.data.id;

  // Create draft_slots for all rounds (snake order encoded)
  const slots = [];
  let pickNum = 1;
  for (let round = 1; round <= rounds; round++) {
    const order = (round % 2 === 1) ? memberOrder : [...memberOrder].reverse();
    order.forEach(memberId => {
      slots.push({ draft_id: activeDraftId, pick_number: pickNum++, member_id: memberId, skipped: false });
    });
  }
  const slotsRes = await db.from('draft_slots').insert(slots);
  if (slotsRes.error) { faToast('Error creating slots: ' + slotsRes.error.message); return; }

  await enterDraftRoom(activeDraftId);
}
```

- [ ] **Step 3: Commit**

```bash
git add fa-draft.html
git commit -m "feat: launchFADraft reads pick order from DOM list, removes team-draft dependency"
```

---

## Task 5: Manual verification

- [ ] **Step 1: Open `fa-draft.html?season=<id>` where a team draft exists**

Expected:
- Draft Order card shows an ordered list with ↑/↓ buttons
- Source label reads `auto-filled from team draft — reorder as needed`
- First item's ↑ is disabled; last item's ↓ is disabled
- Clicking ↑/↓ moves items and updates position numbers
- Launch works with reordered members

- [ ] **Step 2: Test with a season where no team draft exists (or temporarily test by breaking the team draft query)**

Expected:
- Source label reads `no team draft found — set order manually`
- Season members appear alphabetically
- Launch works

- [ ] **Step 3: Push to staging**

```bash
git push origin staging
```
