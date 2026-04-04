# Draft Room Enhancements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four enhancements to both draft rooms: rename End Draft button, 2-minute pre-draft countdown, left sidebar with online presence + ephemeral chat, and a shortened pick clock for offline members.

**Architecture:** The two draft engines (`draft-room.js` / `fa-draft-room.js`) each gain new state and functions; the HTML pages wire them to the DOM. Both rooms share the same four features but are fully separate files with no shared module. Supabase Realtime Presence handles online tracking on the existing channel; chat messages are ephemeral broadcasts on the same channel.

**Tech Stack:** Vanilla JS, Supabase Realtime (broadcast + presence), CSS Grid, no build step.

---

## File Map

| File | Changes |
|------|---------|
| `draft.html` | Button rename; countdown banner + Start Now; sidebar HTML; offline timer setup input; wiring |
| `fa-draft.html` | Same as above for FA room |
| `js/draft-room.js` | Countdown state/functions; presence + chat engine; offline timer logic |
| `js/fa-draft-room.js` | Same as above for FA engine |
| `css/draft.css` | `.teams-locked`, countdown banner styles, sidebar styles, mobile chat tab |
| `css/fa-draft.css` | Same sidebar/countdown styles for FA room |

---

## Task 1: Rename "End Draft" → "Close Draft"

**Files:**
- Modify: `draft.html:179-180`
- Modify: `fa-draft.html:163`

- [ ] **Step 1: Update button label in `draft.html`**

Find (line ~179):
```html
            <button type="button" class="btn btn-outline btn-sm"
              onclick="endDraftEarly()">
              ⏹ End Draft
            </button>
```
Replace the label:
```html
            <button type="button" class="btn btn-outline btn-sm"
              onclick="endDraftEarly()">
              ⏹ Close Draft
            </button>
```

- [ ] **Step 2: Update button label in `fa-draft.html`**

Find (line ~163):
```html
        <button type="button" class="btn btn-sm" onclick="FADraftRoom.endDraftEarly()" style="color:var(--red);border-color:rgba(217,64,64,0.3);">End Draft</button>
```
Replace:
```html
        <button type="button" class="btn btn-sm" onclick="FADraftRoom.endDraftEarly()" style="color:var(--red);border-color:rgba(217,64,64,0.3);">Close Draft</button>
```

- [ ] **Step 3: Verify**

Open `draft.html` and `fa-draft.html` in a browser. The commissioner controls row should read "Close Draft" on the button.

- [ ] **Step 4: Commit**

```bash
git add draft.html fa-draft.html
git commit -m "feat: rename End Draft button to Close Draft"
```

---

## Task 2: Pre-Draft Countdown Engine — `draft-room.js`

**Files:**
- Modify: `js/draft-room.js`

### Context

`draft-room.js` is a self-contained IIFE exporting `DraftRoom`. The state block starts at line ~10. `loadDraft()` is at ~44, `loadDraftFromDB()` at ~52, `_handleRemoteEvent()` at ~543, the public `return {}` at ~614.

- [ ] **Step 1: Add countdown state variables**

After the existing state block (after line ~24, `let _timedOutForPick = null;`), add:

```js
  let _isCountdown      = false;
  let _countdownEndTime = 0;
  let _countdownTimer   = null;
  let _countdownExpired = false; // dedup: prevents multiple clients from double-firing expiry
```

- [ ] **Step 2: Update `loadDraft()` to read countdown status**

Find:
```js
  function loadDraft(draft) {
    _draft        = draft;
    _timerTotal   = draft.timerSeconds || DNA_CONFIG.draft.defaultTimerSeconds;
    _timerSeconds = _timerTotal;
    _isPaused     = draft.status === 'paused';
    _isComplete   = draft.status === 'completed';
  }
```
Replace:
```js
  function loadDraft(draft) {
    _draft        = draft;
    _timerTotal   = draft.timerSeconds || DNA_CONFIG.draft.defaultTimerSeconds;
    _timerSeconds = _timerTotal;
    _isPaused     = draft.status === 'paused';
    _isComplete   = draft.status === 'completed';
    _isCountdown  = draft.status === 'countdown';
  }
```

- [ ] **Step 3: Expose `countdownEndAt` from `loadDraftFromDB()`**

Find the return object inside `loadDraftFromDB` (line ~91):
```js
    return {
      id:           d.id,
      name:         d.name,
      seasonId:     d.season_id,
      status:       d.status,
      timerSeconds: d.timer_seconds || DNA_CONFIG.draft.defaultTimerSeconds,
      timerEndAt:   d.settings?.timerEndAt || null,
      settings:     d.settings || {},
```
Replace:
```js
    return {
      id:             d.id,
      name:           d.name,
      seasonId:       d.season_id,
      status:         d.status,
      timerSeconds:   d.timer_seconds || DNA_CONFIG.draft.defaultTimerSeconds,
      timerEndAt:     d.settings?.timerEndAt || null,
      countdownEndAt: d.settings?.countdownEndAt || null,
      settings:       d.settings || {},
```

- [ ] **Step 4: Add `startCountdown()` and `skipCountdown()` functions**

Add these new functions after `resetTimer()` (after line ~135):

```js
  // ── COUNTDOWN (pre-draft 2-minute wait) ───────────────────
  function startCountdown(endTime) {
    _isCountdown = true;
    _countdownEndTime = endTime;
    if (typeof renderCountdown === 'function') renderCountdown(_countdownEndTime);
    const tick = () => {
      const remaining = Math.max(0, Math.round((_countdownEndTime - Date.now()) / 1000));
      if (typeof updateCountdownDisplay === 'function') updateCountdownDisplay(remaining);
      if (remaining <= 0) {
        clearInterval(_countdownTimer);
        _countdownTimer = null;
        _onCountdownExpired();
      }
    };
    tick();
    _countdownTimer = setInterval(tick, 1000);
  }

  function _onCountdownExpired() {
    if (_countdownExpired) return; // dedup guard
    _countdownExpired = true;
    _isCountdown = false;
    if (_countdownTimer) { clearInterval(_countdownTimer); _countdownTimer = null; }
    _draft.status = 'active';
    _saveStatusToDB('active');
    // Do NOT call _advancePick() here — all clients (including this one) react to the broadcast
    _broadcast({ type: 'countdown_skip' });
  }

  function skipCountdown() {
    if (!DnaAuth.isAdmin(_member)) return;
    if (!_isCountdown) return;
    if (_countdownTimer) { clearInterval(_countdownTimer); _countdownTimer = null; }
    _onCountdownExpired();
  }
```

- [ ] **Step 5: Handle `countdown_skip` in `_handleRemoteEvent()`**

Find the `switch (payload.type)` block in `_handleRemoteEvent`. Add a new case before the final closing brace of the switch (before `case 'complete':`):

```js
      case 'countdown_skip':
        _isCountdown = false;
        if (_countdownTimer) { clearInterval(_countdownTimer); _countdownTimer = null; }
        _draft.status = 'active';
        if (typeof hideCountdown === 'function') hideCountdown();
        _advancePick();
        break;
```

- [ ] **Step 6: Export new functions in public API**

Find the `return {` block and add `startCountdown` and `skipCountdown`:

```js
    startTimer, stopTimer, resetTimer,
    startCountdown, skipCountdown,
```

- [ ] **Step 7: Verify (no UI yet — just check no console errors)**

Open `draft.html` and the browser console. Confirm `DraftRoom.startCountdown` and `DraftRoom.skipCountdown` are accessible without errors.

- [ ] **Step 8: Commit**

```bash
git add js/draft-room.js
git commit -m "feat: add countdown engine state and functions to DraftRoom"
```

---

## Task 3: Pre-Draft Countdown UI — `draft.html` + `css/draft.css`

**Files:**
- Modify: `draft.html`
- Modify: `css/draft.css`

- [ ] **Step 1: Add countdown CSS to `draft.css`**

Append to `css/draft.css` before the `@media (max-width: 768px)` block:

```css
/* ── COUNTDOWN BANNER ──────────────────────────────────── */
#dr-countdown-wrap {
  display: none;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
  gap: 0.75rem;
  border-bottom: 1px solid var(--border);
  background: var(--surface2);
  text-align: center;
}
#dr-countdown-wrap.visible { display: flex; }
.dr-countdown-label {
  font-family: 'Barlow Condensed'; font-size: 11px;
  letter-spacing: 3px; text-transform: uppercase; color: var(--gold);
}
.dr-countdown-val {
  font-family: 'Bebas Neue'; font-size: 48px;
  color: var(--gold); letter-spacing: 4px; line-height: 1;
}
.dr-countdown-sub {
  font-size: 12px; color: var(--text2);
}

/* ── TEAMS LOCKED (during countdown) ─────────────────── */
.teams-locked {
  pointer-events: none;
  opacity: 0.4;
}
```

- [ ] **Step 2: Add countdown banner HTML inside `screen-draft`**

In `draft.html`, find `#dr-timer-wrap` (line ~125). Add the countdown banner directly BEFORE it (inside `.draft-left`):

```html
        <!-- Countdown Banner (shown before draft starts) -->
        <div id="dr-countdown-wrap">
          <div class="dr-countdown-label">Draft Starts In</div>
          <div class="dr-countdown-val" id="dr-countdown-val">2:00</div>
          <div class="dr-countdown-sub">Teams are visible — picks are locked until the draft begins</div>
          <button type="button" class="btn btn-gold btn-sm" id="dr-start-now-btn"
            onclick="DraftRoom.skipCountdown()" style="display:none;">
            ⚡ Start Now
          </button>
        </div>
```

- [ ] **Step 3: Add `renderCountdown()`, `updateCountdownDisplay()`, `hideCountdown()` to `draft.html` script**

In `draft.html` script section, add these three functions before the `boot()` call at the bottom:

```js
// ── COUNTDOWN UI ──────────────────────────────────────────
function renderCountdown(endTime) {
  document.getElementById('dr-countdown-wrap').classList.add('visible');
  document.getElementById('dr-timer-wrap').style.display = 'none';
  document.getElementById('dr-teams-grid').classList.add('teams-locked');
  if (DnaAuth.canManage(_member)) {
    document.getElementById('dr-start-now-btn').style.display = '';
  }
  const remaining = Math.max(0, Math.round((endTime - Date.now()) / 1000));
  updateCountdownDisplay(remaining);
}

function updateCountdownDisplay(seconds) {
  const el = document.getElementById('dr-countdown-val');
  if (!el) return;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  el.textContent = `${m}:${s.toString().padStart(2, '0')}`;
}

function hideCountdown() {
  document.getElementById('dr-countdown-wrap').classList.remove('visible');
  document.getElementById('dr-timer-wrap').style.display = '';
  document.getElementById('dr-teams-grid').classList.remove('teams-locked');
}
```

- [ ] **Step 4: Update `launchDraft()` to set `status: 'countdown'`**

In `draft.html`, find the `db.from('drafts').insert({` call inside `launchDraft()`. It currently inserts with `status: 'active'`. Change it to insert with `status: 'countdown'` and include `countdownEndAt` in settings:

Find:
```js
  const draftRes = await db.from('drafts').insert({
    league_id:     DNA_CONFIG.league.id,
    season_id:     seasonId || null,
    type:          'team',
    status:        'active',
    order_mode:    'manual',
    timer_seconds: timerSeconds,
    name,
  }).select().single();
```
Replace:
```js
  const draftRes = await db.from('drafts').insert({
    league_id:     DNA_CONFIG.league.id,
    season_id:     seasonId || null,
    type:          'team',
    status:        'countdown',
    order_mode:    'manual',
    timer_seconds: timerSeconds,
    name,
    settings:      { countdownEndAt: new Date(Date.now() + 120000).toISOString() },
  }).select().single();
```

- [ ] **Step 5: Update `enterDraftRoom()` to handle `countdown` status**

In `draft.html`, find the existing block inside `enterDraftRoom()`:

```js
  // Start timer if active — pass stored endTime so late joiners sync to remaining time
  if (draft.status === 'active') {
    const endTime = draft.timerEndAt ? new Date(draft.timerEndAt).getTime() : null;
    DraftRoom.startTimer(endTime || undefined);
    // First client to open the draft (no stored deadline yet) saves + broadcasts so all others sync.
    if (!endTime && draft.timerSeconds) DraftRoom.saveAndBroadcastTimer();
    checkYourTurn();
  }
```

Replace with:

```js
  // Start timer if active; start countdown if in pre-draft phase
  if (draft.status === 'active') {
    const endTime = draft.timerEndAt ? new Date(draft.timerEndAt).getTime() : null;
    DraftRoom.startTimer(endTime || undefined);
    if (!endTime && draft.timerSeconds) DraftRoom.saveAndBroadcastTimer();
    checkYourTurn();
  } else if (draft.status === 'countdown') {
    const endTime = draft.countdownEndAt ? new Date(draft.countdownEndAt).getTime() : (Date.now() + 120000);
    if (Date.now() >= endTime) {
      // Countdown already expired — wait for countdown_skip broadcast to arrive
      renderCountdown(Date.now());
    } else {
      DraftRoom.startCountdown(endTime);
    }
  }
```

- [ ] **Step 6: Verify**

1. Open `draft.html` and launch a new draft.
2. You should see the countdown banner "Draft Starts In 2:00" counting down. The teams grid should be visible but dimmed and unclickable.
3. If you're the commissioner, a "⚡ Start Now" button appears.
4. Click "Start Now" — countdown should disappear, pick clock should start, first player should be on the clock.
5. Open a second browser tab and navigate to the draft. Both tabs should show the same countdown.

- [ ] **Step 7: Commit**

```bash
git add draft.html css/draft.css
git commit -m "feat: pre-draft countdown UI for team draft room"
```

---

## Task 4: Pre-Draft Countdown Engine — `fa-draft-room.js`

**Files:**
- Modify: `js/fa-draft-room.js`

Same as Task 2 but for the FA draft engine (`FADraftRoom`). The broadcast event name is `fa_draft_event` (already handled by `_broadcast`).

- [ ] **Step 1: Add countdown state variables**

After line ~35 (`let _timedOutForPick = null;`):

```js
  let _isCountdown      = false;
  let _countdownEndTime = 0;
  let _countdownTimer   = null;
  let _countdownExpired = false;
```

- [ ] **Step 2: Update `loadDraft()` to read countdown status**

Find:
```js
  function loadDraft(draft) {
    _draft         = draft;
    _timerTotal    = draft.timerSeconds || 0;
    _timerSeconds  = _timerTotal;
    _isPaused      = draft.status === 'paused';
    _isComplete    = draft.status === 'completed';
  }
```
Replace:
```js
  function loadDraft(draft) {
    _draft         = draft;
    _timerTotal    = draft.timerSeconds || 0;
    _timerSeconds  = _timerTotal;
    _isPaused      = draft.status === 'paused';
    _isComplete    = draft.status === 'completed';
    _isCountdown   = draft.status === 'countdown';
  }
```

- [ ] **Step 3: Expose `countdownEndAt` from `loadDraftFromDB()`**

In the return object of `loadDraftFromDB()`, find:
```js
      settings: {
        ratingMin:  settings.ratingMin  ?? 70,
        ratingMax:  settings.ratingMax  ?? 79,
        rounds:     settings.rounds     ?? 1,
        timerEndAt: settings.timerEndAt ?? null,
      },
```
Replace:
```js
      settings: {
        ratingMin:       settings.ratingMin       ?? 70,
        ratingMax:       settings.ratingMax       ?? 79,
        rounds:          settings.rounds          ?? 1,
        timerEndAt:      settings.timerEndAt      ?? null,
        countdownEndAt:  settings.countdownEndAt  ?? null,
      },
```

- [ ] **Step 4: Add `startCountdown()`, `_onCountdownExpired()`, `skipCountdown()`**

Add after `resetTimer()` (after the `function resetTimer()` block):

```js
  // ── COUNTDOWN ─────────────────────────────────────────────
  function startCountdown(endTime) {
    _isCountdown = true;
    _countdownEndTime = endTime;
    if (typeof renderCountdown === 'function') renderCountdown(_countdownEndTime);
    const tick = () => {
      const remaining = Math.max(0, Math.round((_countdownEndTime - Date.now()) / 1000));
      if (typeof updateCountdownDisplay === 'function') updateCountdownDisplay(remaining);
      if (remaining <= 0) {
        clearInterval(_countdownTimer);
        _countdownTimer = null;
        _onCountdownExpired();
      }
    };
    tick();
    _countdownTimer = setInterval(tick, 1000);
  }

  function _onCountdownExpired() {
    if (_countdownExpired) return;
    _countdownExpired = true;
    _isCountdown = false;
    if (_countdownTimer) { clearInterval(_countdownTimer); _countdownTimer = null; }
    _draft.status = 'active';
    _saveStatusToDB('active');
    _broadcast({ type: 'countdown_skip' });
  }

  function skipCountdown() {
    if (!_isAdminMember()) return;
    if (!_isCountdown) return;
    if (_countdownTimer) { clearInterval(_countdownTimer); _countdownTimer = null; }
    _onCountdownExpired();
  }
```

- [ ] **Step 5: Handle `countdown_skip` in `_handleRemoteEvent()`**

In `_handleRemoteEvent()`, find the block that checks `payload.type === 'complete'`:
```js
    } else if (payload.type === 'complete') {
```
Add a new block BEFORE it:
```js
    } else if (payload.type === 'countdown_skip') {
      _isCountdown = false;
      if (_countdownTimer) { clearInterval(_countdownTimer); _countdownTimer = null; }
      _draft.status = 'active';
      if (typeof hideCountdown === 'function') hideCountdown();
      _advancePick();
```

- [ ] **Step 6: Export in public API**

Find in the `return {` block:
```js
    startTimer, stopTimer, resetTimer,
```
Replace:
```js
    startTimer, stopTimer, resetTimer,
    startCountdown, skipCountdown,
```

- [ ] **Step 7: Commit**

```bash
git add js/fa-draft-room.js
git commit -m "feat: add countdown engine state and functions to FADraftRoom"
```

---

## Task 5: Pre-Draft Countdown UI — `fa-draft.html` + `css/fa-draft.css`

**Files:**
- Modify: `fa-draft.html`
- Modify: `css/fa-draft.css`

The FA draft room has a different layout — a top bar (`#fa-on-clock-bar`) and tabs below. The countdown replaces the on-clock content in the top bar and locks the available players tab.

- [ ] **Step 1: Add countdown styles to `css/fa-draft.css`**

Append before the `@media` block at the bottom:

```css
/* ── COUNTDOWN ────────────────────────────────────────── */
.fa-countdown-bar {
  display: none;
  align-items: center;
  gap: 1rem;
  padding: 0.75rem 1.25rem;
  background: var(--surface2);
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.fa-countdown-bar.visible { display: flex; }
.fa-countdown-label {
  font-family: 'Barlow Condensed'; font-size: 11px;
  letter-spacing: 3px; text-transform: uppercase; color: var(--gold);
}
.fa-countdown-val {
  font-family: 'Bebas Neue'; font-size: 32px;
  color: var(--gold); letter-spacing: 3px;
}
.fa-countdown-sub {
  font-size: 12px; color: var(--text2); flex: 1;
}

/* ── PLAYERS LOCKED ───────────────────────────────────── */
.fa-players-locked .fa-player-card { pointer-events: none; opacity: 0.4; }
.fa-players-locked .fa-select-btn  { pointer-events: none; opacity: 0.4; }
```

- [ ] **Step 2: Add countdown bar HTML in `fa-draft.html`**

Find `#screen-draft` (line ~150). Add the countdown bar immediately BEFORE `#fa-on-clock-bar`:

```html
    <!-- Countdown Bar (shown before draft starts) -->
    <div class="fa-countdown-bar" id="fa-countdown-bar">
      <div>
        <div class="fa-countdown-label">Draft Starts In</div>
        <div class="fa-countdown-val" id="fa-countdown-val">2:00</div>
      </div>
      <div class="fa-countdown-sub">Browse players now — selection is locked until the draft begins</div>
      <button type="button" class="btn btn-gold btn-sm" id="fa-start-now-btn"
        onclick="FADraftRoom.skipCountdown()" style="display:none;">
        ⚡ Start Now
      </button>
    </div>
```

- [ ] **Step 3: Add `renderCountdown()`, `updateCountdownDisplay()`, `hideCountdown()` to `fa-draft.html` script**

In the `fa-draft.html` script section, add before the final `boot()` call:

```js
// ── COUNTDOWN UI ──────────────────────────────────────────
function renderCountdown(endTime) {
  document.getElementById('fa-countdown-bar').classList.add('visible');
  document.getElementById('fa-on-clock-bar').style.display = 'none';
  document.getElementById('tab-players').classList.add('fa-players-locked');
  if (_isAdmin()) document.getElementById('fa-start-now-btn').style.display = '';
  const remaining = Math.max(0, Math.round((endTime - Date.now()) / 1000));
  updateCountdownDisplay(remaining);
}

function updateCountdownDisplay(seconds) {
  const el = document.getElementById('fa-countdown-val');
  if (!el) return;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  el.textContent = `${m}:${s.toString().padStart(2, '0')}`;
}

function hideCountdown() {
  document.getElementById('fa-countdown-bar').classList.remove('visible');
  document.getElementById('fa-on-clock-bar').style.display = '';
  document.getElementById('tab-players').classList.remove('fa-players-locked');
}
```

- [ ] **Step 4: Update `launchFADraft()` to insert with `status: 'countdown'`**

Find the `db.from('drafts').insert({` call in `launchFADraft()`:

```js
  const draftRes = await db.from('drafts').insert({
    season_id:     seasonId,
    league_id:     currentLeague.id,
    type:          'player',
    status:        'active',
    order_mode:    'weighted',
    timer_seconds: timerSecs,
    settings:      { ratingMin, ratingMax, rounds },
    name:          'FA Draft — ' + currentSeason.name,
  }).select().single();
```
Replace:
```js
  const draftRes = await db.from('drafts').insert({
    season_id:     seasonId,
    league_id:     currentLeague.id,
    type:          'player',
    status:        'countdown',
    order_mode:    'weighted',
    timer_seconds: timerSecs,
    settings:      { ratingMin, ratingMax, rounds, countdownEndAt: new Date(Date.now() + 120000).toISOString() },
    name:          'FA Draft — ' + currentSeason.name,
  }).select().single();
```

- [ ] **Step 5: Update `enterDraftRoom()` to handle `countdown` status**

Find:
```js
    if (draft.status === 'active') {
      const endTime = draft.settings.timerEndAt ? new Date(draft.settings.timerEndAt).getTime() : null;
      FADraftRoom.startTimer(endTime || undefined);
      // First client to open the draft (no stored deadline yet) saves + broadcasts so all others sync.
      if (!endTime && draft.timerSeconds) FADraftRoom.saveAndBroadcastTimer();
    }
```
Replace:
```js
    if (draft.status === 'active') {
      const endTime = draft.settings.timerEndAt ? new Date(draft.settings.timerEndAt).getTime() : null;
      FADraftRoom.startTimer(endTime || undefined);
      if (!endTime && draft.timerSeconds) FADraftRoom.saveAndBroadcastTimer();
    } else if (draft.status === 'countdown') {
      const endTime = draft.settings.countdownEndAt ? new Date(draft.settings.countdownEndAt).getTime() : (Date.now() + 120000);
      if (Date.now() >= endTime) {
        renderCountdown(Date.now()); // countdown expired; wait for countdown_skip broadcast
      } else {
        FADraftRoom.startCountdown(endTime);
      }
    }
```

- [ ] **Step 6: Verify**

Launch a new FA draft. Confirm the countdown banner shows above the on-clock bar with a 2-minute timer. Players are visible but dimmed/unclickable. Commissioner sees "Start Now". Clicking it transitions to active draft.

- [ ] **Step 7: Commit**

```bash
git add fa-draft.html css/fa-draft.css
git commit -m "feat: pre-draft countdown UI for FA draft room"
```

---

## Task 6: Sidebar CSS

**Files:**
- Modify: `css/draft.css`
- Modify: `css/fa-draft.css`

- [ ] **Step 1: Add sidebar styles to `css/draft.css`**

Append after the countdown styles (before `@media (max-width: 768px)`):

```css
/* ── SIDEBAR (online presence + chat) ─────────────────── */
.draft-sidebar {
  width: 160px;
  flex-shrink: 0;
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  background: var(--surface);
  overflow: hidden;
}
.sidebar-section-header {
  padding: 6px 10px;
  font-family: 'Barlow Condensed';
  font-size: 10px; letter-spacing: 2px; text-transform: uppercase;
  color: var(--text2);
  background: var(--surface2);
  border-bottom: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between;
  flex-shrink: 0;
}
.sidebar-online {
  flex: 0 0 auto;
  overflow-y: auto;
  max-height: 220px;
  border-bottom: 1px solid var(--border);
}
.sidebar-online-item {
  display: flex; align-items: center; gap: 7px;
  padding: 5px 10px;
  font-size: 11px;
  border-bottom: 1px solid rgba(255,255,255,0.03);
}
.online-dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--green); flex-shrink: 0;
}
.online-dot.offline { background: var(--text3); }
.sidebar-chat {
  flex: 1; display: flex; flex-direction: column; min-height: 0;
}
.chat-messages {
  flex: 1; overflow-y: auto; padding: 4px 0;
}
.chat-msg {
  padding: 4px 10px;
  font-size: 11px; line-height: 1.4;
  border-bottom: 1px solid rgba(255,255,255,0.02);
}
.chat-msg-sender {
  font-weight: 700; font-size: 10px; margin-bottom: 1px;
}
.chat-msg-text { color: var(--text2); word-break: break-word; }
.chat-msg-system { color: var(--text3); font-style: italic; font-size: 10px; padding: 3px 10px; }
.chat-input-row {
  display: flex; gap: 4px; padding: 6px 8px;
  border-top: 1px solid var(--border); flex-shrink: 0;
}
.chat-input {
  flex: 1; background: var(--surface3);
  border: 1px solid var(--border); border-radius: 4px;
  padding: 4px 7px; color: var(--text); font-size: 11px;
  font-family: 'Barlow Condensed';
}
.chat-input:focus { outline: none; border-color: var(--gold); }
.chat-send {
  background: var(--gold); border: none; border-radius: 4px;
  padding: 4px 8px; color: #000; font-size: 11px;
  font-weight: 700; cursor: pointer; flex-shrink: 0;
}
.chat-send:hover { background: #e5a830; }
```

- [ ] **Step 2: Update `draft-body` grid to accommodate sidebar**

Find in `css/draft.css`:
```css
.draft-body {
  flex: 1;
  display: grid;
  grid-template-columns: 1fr 340px;
```
Replace:
```css
.draft-body {
  flex: 1;
  display: grid;
  grid-template-columns: 160px 1fr 340px;
```

- [ ] **Step 3: Update mobile media query for sidebar**

Find in `css/draft.css`:
```css
@media (max-width: 768px) {
  .draft-body { grid-template-columns: 1fr; }
```
Replace:
```css
@media (max-width: 768px) {
  .draft-body { grid-template-columns: 1fr; }
  .draft-sidebar { display: none; }
```

- [ ] **Step 4: Add sidebar styles to `css/fa-draft.css`**

Append before the `@media` block at the bottom of `css/fa-draft.css`:

```css
/* ── FA DRAFT BODY (sidebar + main) ───────────────────── */
.fa-draft-body {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.fa-draft-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow-y: auto;
}

/* ── SIDEBAR (shared styles with team draft) ──────────── */
/* Copy same styles — avoids a shared stylesheet for vanilla JS project */
.draft-sidebar {
  width: 160px; flex-shrink: 0;
  border-right: 1px solid var(--border);
  display: flex; flex-direction: column;
  background: var(--surface); overflow: hidden;
}
.sidebar-section-header {
  padding: 6px 10px;
  font-family: 'Barlow Condensed';
  font-size: 10px; letter-spacing: 2px; text-transform: uppercase;
  color: var(--text2); background: var(--surface2);
  border-bottom: 1px solid var(--border);
  display: flex; align-items: center; justify-content: space-between;
  flex-shrink: 0;
}
.sidebar-online {
  flex: 0 0 auto; overflow-y: auto; max-height: 220px;
  border-bottom: 1px solid var(--border);
}
.sidebar-online-item {
  display: flex; align-items: center; gap: 7px;
  padding: 5px 10px; font-size: 11px;
  border-bottom: 1px solid rgba(255,255,255,0.03);
}
.online-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); flex-shrink: 0; }
.online-dot.offline { background: var(--text3); }
.sidebar-chat { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.chat-messages { flex: 1; overflow-y: auto; padding: 4px 0; }
.chat-msg { padding: 4px 10px; font-size: 11px; line-height: 1.4; border-bottom: 1px solid rgba(255,255,255,0.02); }
.chat-msg-sender { font-weight: 700; font-size: 10px; margin-bottom: 1px; }
.chat-msg-text { color: var(--text2); word-break: break-word; }
.chat-msg-system { color: var(--text3); font-style: italic; font-size: 10px; padding: 3px 10px; }
.chat-input-row { display: flex; gap: 4px; padding: 6px 8px; border-top: 1px solid var(--border); flex-shrink: 0; }
.chat-input { flex: 1; background: var(--surface3); border: 1px solid var(--border); border-radius: 4px; padding: 4px 7px; color: var(--text); font-size: 11px; font-family: 'Barlow Condensed'; }
.chat-input:focus { outline: none; border-color: var(--gold); }
.chat-send { background: var(--gold); border: none; border-radius: 4px; padding: 4px 8px; color: #000; font-size: 11px; font-weight: 700; cursor: pointer; flex-shrink: 0; }
.chat-send:hover { background: #e5a830; }
```

- [ ] **Step 5: Update FA draft mobile query to hide sidebar**

In `css/fa-draft.css`, find the `@media` block and add:
```css
  .draft-sidebar { display: none; }
  .fa-draft-body { display: block; }
```

- [ ] **Step 6: Commit**

```bash
git add css/draft.css css/fa-draft.css
git commit -m "feat: sidebar CSS for online presence and chat"
```

---

## Task 7: Presence + Chat Engine — `draft-room.js`

**Files:**
- Modify: `js/draft-room.js`

- [ ] **Step 1: Add presence + chat state variables**

After the countdown state block, add:

```js
  let _onlineMembers = new Set(); // Set of memberIds currently in Presence
  let _chatMessages  = [];        // local ephemeral array, capped at 50
```

- [ ] **Step 2: Update `subscribeRealtime()` to add Presence tracking**

Find:
```js
  function subscribeRealtime(draftId) {
    if (!_db) return;
    _realtimeChannel = _db.channel(`draft:${draftId}`)
      .on('broadcast', { event: 'draft_event' }, ({ payload }) => {
        _handleRemoteEvent(payload);
      })
      .subscribe();
  }
```
Replace:
```js
  function subscribeRealtime(draftId) {
    if (!_db) return;
    _realtimeChannel = _db.channel(`draft:${draftId}`)
      .on('broadcast', { event: 'draft_event' }, ({ payload }) => {
        _handleRemoteEvent(payload);
      })
      .on('presence', { event: 'sync' }, () => {
        const state = _realtimeChannel.presenceState();
        _onlineMembers = new Set(
          Object.values(state).flatMap(presences => presences.map(p => p.memberId))
        );
        if (typeof renderSidebar === 'function') renderSidebar();
      })
      .on('presence', { event: 'join' }, ({ newPresences }) => {
        newPresences.forEach(p => {
          _onlineMembers.add(p.memberId);
          _addChatMessage({ system: true, text: `● ${p.memberName} joined` });
        });
        if (typeof renderSidebar === 'function') renderSidebar();
      })
      .on('presence', { event: 'leave' }, ({ leftPresences }) => {
        leftPresences.forEach(p => {
          _onlineMembers.delete(p.memberId);
          _addChatMessage({ system: true, text: `● ${p.memberName} disconnected` });
        });
        if (typeof renderSidebar === 'function') renderSidebar();
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED' && _member) {
          await _realtimeChannel.track({
            memberId:   _member.id,
            memberName: _member.name,
            color:      _member.color,
          });
        }
      });
  }
```

- [ ] **Step 3: Add `_addChatMessage()` and `sendChatMessage()`**

Add after `_handleRemoteEvent()`:

```js
  // ── CHAT ──────────────────────────────────────────────────
  function _addChatMessage(msg) {
    _chatMessages.push(msg);
    if (_chatMessages.length > 50) _chatMessages.shift();
    if (typeof renderChatMessages === 'function') renderChatMessages(_chatMessages);
  }

  function sendChatMessage(text) {
    if (!text || !text.trim()) return;
    if (text.length > 200) text = text.slice(0, 200);
    const msg = {
      memberId:    _member?.id,
      memberName:  _member?.name || 'Unknown',
      memberColor: _member?.color || '#6a9ec7',
      text:        text.trim(),
      ts:          Date.now(),
    };
    _addChatMessage(msg); // show immediately to sender
    _broadcast({ type: 'chat_message', ...msg });
  }
```

- [ ] **Step 4: Add `chat_message` case to `_handleRemoteEvent()`**

In `_handleRemoteEvent()`, add before the final closing brace of the `switch`:

```js
      case 'chat_message':
        // Don't add if it's from this member (already added in sendChatMessage)
        if (payload.memberId !== _member?.id) {
          _addChatMessage({
            memberId:    payload.memberId,
            memberName:  payload.memberName,
            memberColor: payload.memberColor,
            text:        payload.text,
          });
        }
        break;
```

- [ ] **Step 5: Post system messages on pick events**

In `_handleRemoteEvent()`, in the `case 'pick':` handler, after `_savePickToSeason(...)`, add:

```js
          _addChatMessage({ system: true, text: `⚾ ${slot.memberName} picked ${payload.teamAbbr}` });
```

- [ ] **Step 6: Post countdown start system message**

In `startCountdown()` (added in Task 2), add a system message after setting `_isCountdown = true`:

```js
    _addChatMessage({ system: true, text: '🕐 Draft starting in 2:00 — get ready!' });
```

- [ ] **Step 7: Export new public API methods**

In the `return {` block, add:

```js
    sendChatMessage,
    getOnlineMembers: () => _onlineMembers,
    getChatMessages:  () => _chatMessages,
```

- [ ] **Step 8: Commit**

```bash
git add js/draft-room.js
git commit -m "feat: presence + chat engine in DraftRoom"
```

---

## Task 8: Sidebar HTML + JS — `draft.html`

**Files:**
- Modify: `draft.html`

- [ ] **Step 1: Add sidebar HTML**

In `draft.html`, find the `.draft-body` div:
```html
    <div class="draft-body" style="position:relative;">

      <!-- LEFT: Pick Board -->
      <div class="draft-left">
```
Add the sidebar as the FIRST child of `.draft-body`, before `.draft-left`:

```html
    <div class="draft-body" style="position:relative;">

      <!-- SIDEBAR: Online Presence + Chat -->
      <div class="draft-sidebar" id="draft-sidebar">
        <div class="sidebar-section-header">
          <span>👥 Online</span>
          <span id="sidebar-online-count" style="color:var(--green);font-size:9px;"></span>
        </div>
        <div class="sidebar-online" id="sidebar-online-list"></div>
        <div class="sidebar-section-header" style="margin-top:auto;">💬 Chat</div>
        <div class="sidebar-chat">
          <div class="chat-messages" id="chat-messages"></div>
          <div class="chat-input-row">
            <input class="chat-input" id="chat-input" placeholder="Message..."
              maxlength="200" onkeydown="if(event.key==='Enter')sendChat()">
            <button class="chat-send" onclick="sendChat()">→</button>
          </div>
        </div>
      </div>

      <!-- LEFT: Pick Board -->
      <div class="draft-left">
```

- [ ] **Step 2: Add mobile Chat tab**

Find the mobile tabs HTML:
```html
        <div class="dr-mobile-tabs">
          <button type="button" class="dr-mobile-tab active" onclick="switchMobileTab('teams', this)">⚡ Available Teams</button>
          <button type="button" class="dr-mobile-tab" onclick="switchMobileTab('board', this)">📋 Draft Order</button>
        </div>
```
Replace:
```html
        <div class="dr-mobile-tabs">
          <button type="button" class="dr-mobile-tab active" onclick="switchMobileTab('teams', this)">⚡ Teams</button>
          <button type="button" class="dr-mobile-tab" onclick="switchMobileTab('board', this)">📋 Order</button>
          <button type="button" class="dr-mobile-tab" onclick="switchMobileTab('chat', this)">💬 Chat</button>
        </div>
```

- [ ] **Step 3: Add mobile chat panel HTML**

After `</div><!-- /dr-board-section -->`, add:

```html
        <!-- Mobile Chat Panel (hidden on desktop, toggled on mobile) -->
        <div id="dr-mobile-chat" style="display:none;flex-direction:column;flex:1;">
          <div class="chat-messages" id="chat-messages-mobile"></div>
          <div class="chat-input-row">
            <input class="chat-input" id="chat-input-mobile" placeholder="Message..."
              maxlength="200" onkeydown="if(event.key==='Enter')sendChat()">
            <button class="chat-send" onclick="sendChat()">→</button>
          </div>
        </div>
```

- [ ] **Step 4: Add `switchMobileTab` chat case**

Find the `switchMobileTab` function in `draft.html`:

```js
function switchMobileTab(tab, btn) {
  document.querySelectorAll('.dr-mobile-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const body = document.querySelector('.draft-body');
  body.classList.toggle('show-board', tab === 'board');
}
```
Replace:
```js
function switchMobileTab(tab, btn) {
  document.querySelectorAll('.dr-mobile-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const body = document.querySelector('.draft-body');
  body.classList.toggle('show-board', tab === 'board');
  document.getElementById('dr-mobile-chat').style.display = tab === 'chat' ? 'flex' : 'none';
  if (tab === 'chat') {
    // When switching to chat on mobile, hide teams + board
    body.classList.remove('show-board');
    document.querySelector('.draft-right').style.display = tab === 'chat' ? 'none' : '';
  } else {
    document.querySelector('.draft-right').style.display = '';
  }
}
```

- [ ] **Step 5: Add `renderSidebar()`, `renderChatMessages()`, and `sendChat()` functions**

Add to the script section:

```js
// ── SIDEBAR ───────────────────────────────────────────────
function renderSidebar() {
  const draft = DraftRoom.getDraft();
  if (!draft) return;
  const online = DraftRoom.getOnlineMembers();

  // Online count
  const total = draft.slots.length;
  const onlineCount = draft.slots.filter(s => online.has(s.memberId)).length;
  const countEl = document.getElementById('sidebar-online-count');
  if (countEl) countEl.textContent = `${onlineCount}/${total}`;

  // Online list
  const listEl = document.getElementById('sidebar-online-list');
  if (listEl) {
    listEl.innerHTML = draft.slots
      .filter((s, i, arr) => arr.findIndex(x => x.memberId === s.memberId) === i) // dedupe
      .map(s => {
        const isOnline = online.has(s.memberId);
        return `<div class="sidebar-online-item">
          <div class="online-dot${isOnline ? '' : ' offline'}"></div>
          <span style="color:${isOnline ? 'var(--text)' : 'var(--text3)'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(s.memberName)}</span>
        </div>`;
      }).join('');
  }
}

function renderChatMessages(messages) {
  const containers = ['chat-messages', 'chat-messages-mobile'];
  containers.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = messages.map(m => {
      if (m.system) return `<div class="chat-msg-system">${escHtml(m.text)}</div>`;
      return `<div class="chat-msg">
        <div class="chat-msg-sender" style="color:${m.memberColor || 'var(--text2)'}">${escHtml(m.memberName)}</div>
        <div class="chat-msg-text">${escHtml(m.text)}</div>
      </div>`;
    }).join('');
    el.scrollTop = el.scrollHeight;
  });
}

function sendChat() {
  const input = document.getElementById('chat-input') || document.getElementById('chat-input-mobile');
  const text = input?.value?.trim();
  if (!text) return;
  DraftRoom.sendChatMessage(text);
  if (document.getElementById('chat-input')) document.getElementById('chat-input').value = '';
  if (document.getElementById('chat-input-mobile')) document.getElementById('chat-input-mobile').value = '';
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
```

- [ ] **Step 6: Call `renderSidebar()` in `updateOnClock()`**

Find `updateOnClock()` in `draft.html`. Add at the end of the function body:

```js
  renderSidebar();
```

- [ ] **Step 7: Verify**

Open `draft.html` with two browser windows. Both should show the left sidebar with online presence dots. Send a message in one — it should appear in the other within a second. Pick a team — a system message "⚾ PlayerName picked NYY" should appear in the chat.

- [ ] **Step 8: Commit**

```bash
git add draft.html
git commit -m "feat: left sidebar with online presence and chat for team draft"
```

---

## Task 9: Presence + Chat Engine — `fa-draft-room.js`

**Files:**
- Modify: `js/fa-draft-room.js`

Same as Task 7 but for FA draft engine. The broadcast event name is `fa_draft_event`.

- [ ] **Step 1: Add presence + chat state variables**

After `_countdownExpired = false;` (Task 4 state), add:

```js
  let _onlineMembers = new Set();
  let _chatMessages  = [];
```

- [ ] **Step 2: Update `subscribeRealtime()` to add Presence tracking**

Find:
```js
  function subscribeRealtime(draftId) {
    if (!_db) return;
    _realtimeChannel = _db.channel(`fa_draft:${draftId}`)
      .on('broadcast', { event: 'fa_draft_event' }, ({ payload }) => {
        _handleRemoteEvent(payload);
      })
      .subscribe();
  }
```
Replace:
```js
  function subscribeRealtime(draftId) {
    if (!_db) return;
    _realtimeChannel = _db.channel(`fa_draft:${draftId}`)
      .on('broadcast', { event: 'fa_draft_event' }, ({ payload }) => {
        _handleRemoteEvent(payload);
      })
      .on('presence', { event: 'sync' }, () => {
        const state = _realtimeChannel.presenceState();
        _onlineMembers = new Set(
          Object.values(state).flatMap(presences => presences.map(p => p.memberId))
        );
        if (typeof renderSidebar === 'function') renderSidebar();
      })
      .on('presence', { event: 'join' }, ({ newPresences }) => {
        newPresences.forEach(p => {
          _onlineMembers.add(p.memberId);
          _addChatMessage({ system: true, text: `● ${p.memberName} joined` });
        });
        if (typeof renderSidebar === 'function') renderSidebar();
      })
      .on('presence', { event: 'leave' }, ({ leftPresences }) => {
        leftPresences.forEach(p => {
          _onlineMembers.delete(p.memberId);
          _addChatMessage({ system: true, text: `● ${p.memberName} disconnected` });
        });
        if (typeof renderSidebar === 'function') renderSidebar();
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED' && _member) {
          await _realtimeChannel.track({
            memberId:   _member.id,
            memberName: _member.name || _member.display_name,
            color:      _member.color || _member.avatar_color || '#6a9ec7',
          });
        }
      });
  }
```

- [ ] **Step 3: Add `_addChatMessage()` and `sendChatMessage()`**

Add after `_handleRemoteEvent()`:

```js
  // ── CHAT ──────────────────────────────────────────────────
  function _addChatMessage(msg) {
    _chatMessages.push(msg);
    if (_chatMessages.length > 50) _chatMessages.shift();
    if (typeof renderChatMessages === 'function') renderChatMessages(_chatMessages);
  }

  function sendChatMessage(text) {
    if (!text || !text.trim()) return;
    if (text.length > 200) text = text.slice(0, 200);
    const msg = {
      memberId:    _member?.id,
      memberName:  _member?.display_name || _member?.name || 'Unknown',
      memberColor: _member?.avatar_color || _member?.color || '#6a9ec7',
      text:        text.trim(),
      ts:          Date.now(),
    };
    _addChatMessage(msg);
    _broadcast({ type: 'chat_message', ...msg });
  }
```

- [ ] **Step 4: Handle `chat_message` in `_handleRemoteEvent()`**

In `_handleRemoteEvent()`, find the `payload.type === 'complete'` branch. Add BEFORE it:

```js
    } else if (payload.type === 'chat_message') {
      if (payload.memberId !== _member?.id) {
        _addChatMessage({
          memberId:    payload.memberId,
          memberName:  payload.memberName,
          memberColor: payload.memberColor,
          text:        payload.text,
        });
      }
```

- [ ] **Step 5: Add pick system message**

In `_handleRemoteEvent()`, in the `payload.type === 'pick'` block, after updating the slot, add:

```js
        _addChatMessage({ system: true, text: `⚾ ${slot.memberName} picked ${payload.playerName} (${payload.playerRating} OVR)` });
```

- [ ] **Step 6: Add countdown start system message in `startCountdown()`**

In `startCountdown()` (added in Task 4), after `_isCountdown = true;`:

```js
    _addChatMessage({ system: true, text: '🕐 FA Draft starting in 2:00 — get ready!' });
```

- [ ] **Step 7: Export new public API methods**

In the `return {` block:

```js
    sendChatMessage,
    getOnlineMembers: () => _onlineMembers,
    getChatMessages:  () => _chatMessages,
```

- [ ] **Step 8: Commit**

```bash
git add js/fa-draft-room.js
git commit -m "feat: presence + chat engine in FADraftRoom"
```

---

## Task 10: Sidebar HTML + JS — `fa-draft.html`

**Files:**
- Modify: `fa-draft.html`

The FA draft room uses a tabbed single-column layout. We wrap the tab area in a `.fa-draft-body` flex container so the sidebar sits beside the main content.

- [ ] **Step 1: Wrap existing draft content in `.fa-draft-body`**

Find:
```html
    <!-- Tabs -->
    <div class="fa-tabs">
```
Replace with (wrapping it):
```html
    <div class="fa-draft-body">
      <!-- SIDEBAR: Online Presence + Chat -->
      <div class="draft-sidebar" id="draft-sidebar">
        <div class="sidebar-section-header">
          <span>👥 Online</span>
          <span id="sidebar-online-count" style="color:var(--green);font-size:9px;"></span>
        </div>
        <div class="sidebar-online" id="sidebar-online-list"></div>
        <div class="sidebar-section-header" style="margin-top:auto;">💬 Chat</div>
        <div class="sidebar-chat">
          <div class="chat-messages" id="chat-messages"></div>
          <div class="chat-input-row">
            <input class="chat-input" id="chat-input" placeholder="Message..."
              maxlength="200" onkeydown="if(event.key==='Enter')sendChat()">
            <button class="chat-send" onclick="sendChat()">→</button>
          </div>
        </div>
      </div>

      <!-- MAIN: Tabs + Content -->
      <div class="fa-draft-main">
    <!-- Tabs -->
    <div class="fa-tabs">
```

Then find the closing `</div><!-- end screen-draft -->` and add the two closing divs before it:
```html
      </div><!-- end fa-draft-main -->
    </div><!-- end fa-draft-body -->
  </div><!-- end screen-draft -->
```

- [ ] **Step 2: Add mobile Chat tab to `.fa-tabs`**

Find:
```html
      <button type="button" class="fa-tab"        onclick="switchTab('mypicks',this)">My Picks</button>
```
After it, add:
```html
      <button type="button" class="fa-tab"        onclick="switchTab('chat',this)" id="fa-chat-tab">💬 Chat</button>
```

- [ ] **Step 3: Add mobile chat tab panel**

After the `tab-export` div, add:

```html
    <!-- Tab: Chat (mobile only, hidden on desktop since sidebar is visible) -->
    <div id="tab-chat" class="fa-tab-content">
      <div style="display:flex;flex-direction:column;height:400px;">
        <div class="chat-messages" id="chat-messages-mobile" style="flex:1;overflow-y:auto;padding:4px 0;"></div>
        <div class="chat-input-row">
          <input class="chat-input" id="chat-input-mobile" placeholder="Message..."
            maxlength="200" onkeydown="if(event.key==='Enter')sendChat()">
          <button class="chat-send" onclick="sendChat()">→</button>
        </div>
      </div>
    </div>
```

- [ ] **Step 4: Hide Chat tab on desktop via CSS**

In `css/fa-draft.css`, add:

```css
@media (min-width: 769px) {
  #fa-chat-tab { display: none; }
}
```

- [ ] **Step 5: Add `renderSidebar()`, `renderChatMessages()`, `sendChat()`, `escHtml()` to `fa-draft.html` script**

Add in the script section:

```js
// ── SIDEBAR ───────────────────────────────────────────────
function renderSidebar() {
  const draft = FADraftRoom.getDraft ? FADraftRoom.getDraft() : null;
  if (!draft) return;
  const online = FADraftRoom.getOnlineMembers();
  const slots  = draft.slots || [];

  const members = slots.filter((s, i, arr) => arr.findIndex(x => x.memberId === s.memberId) === i);
  const onlineCount = members.filter(s => online.has(s.memberId)).length;

  const countEl = document.getElementById('sidebar-online-count');
  if (countEl) countEl.textContent = `${onlineCount}/${members.length}`;

  const listEl = document.getElementById('sidebar-online-list');
  if (listEl) {
    listEl.innerHTML = members.map(s => {
      const isOnline = online.has(s.memberId);
      return `<div class="sidebar-online-item">
        <div class="online-dot${isOnline ? '' : ' offline'}"></div>
        <span style="color:${isOnline ? 'var(--text)' : 'var(--text3)'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${_esc(s.memberName)}</span>
      </div>`;
    }).join('');
  }
}

function renderChatMessages(messages) {
  ['chat-messages', 'chat-messages-mobile'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.innerHTML = messages.map(m => {
      if (m.system) return `<div class="chat-msg-system">${_esc(m.text)}</div>`;
      return `<div class="chat-msg">
        <div class="chat-msg-sender" style="color:${m.memberColor || 'var(--text2)'}">${_esc(m.memberName)}</div>
        <div class="chat-msg-text">${_esc(m.text)}</div>
      </div>`;
    }).join('');
    el.scrollTop = el.scrollHeight;
  });
}

function sendChat() {
  const inputs = ['chat-input', 'chat-input-mobile'].map(id => document.getElementById(id)).filter(Boolean);
  const text = inputs.find(el => el.value.trim())?.value?.trim();
  if (!text) return;
  FADraftRoom.sendChatMessage(text);
  inputs.forEach(el => el.value = '');
}

function _esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
```

Note: `fa-draft-room.js` already defines `_esc` internally but the page needs its own copy for rendering.

- [ ] **Step 6: Expose `getDraft` on FADraftRoom public API**

In `js/fa-draft-room.js`, find the `return {` block and add:

```js
    getDraft: () => _draft,
```

- [ ] **Step 7: Call `renderSidebar()` in `updateOnClock()`**

Find `updateOnClock()` in `fa-draft.html`. Add at the end:

```js
  renderSidebar();
```

- [ ] **Step 8: Verify**

Open two browser tabs pointing at the same active FA draft. Sidebar should show online presence. Send a chat message — it appears in both tabs. Pick a player — system message appears.

- [ ] **Step 9: Commit**

```bash
git add fa-draft.html js/fa-draft-room.js
git commit -m "feat: left sidebar with online presence and chat for FA draft"
```

---

## Task 11: Offline Timer Engine + Setup UI — `draft-room.js` + `draft.html`

**Files:**
- Modify: `js/draft-room.js`
- Modify: `draft.html`

- [ ] **Step 1: Add offline timer state variables to `draft-room.js`**

After `let _onlineMembers = new Set();`, add:

```js
  let _offlineTimerSecs    = 30;  // shortened timer for offline members (configurable)
  let _currentTimerDuration = 90; // duration used for ring fill calc on current pick
```

- [ ] **Step 2: Update `loadDraft()` to read `offlineTimerSeconds`**

In `loadDraft()`, add after `_isCountdown = draft.status === 'countdown';`:

```js
    _offlineTimerSecs = draft.settings?.offlineTimerSeconds || 30;
```

- [ ] **Step 3: Update `startTimer()` to accept optional `duration` param**

Find:
```js
  function startTimer(endTime) {
    stopTimer();
    if (_isPaused || _isComplete) return;
    _timerEndTime = endTime || (Date.now() + _timerTotal * 1000);
    _timerSeconds = Math.max(0, Math.round((_timerEndTime - Date.now()) / 1000));
    _renderTimer();
```
Replace:
```js
  function startTimer(endTime, duration) {
    stopTimer();
    if (_isPaused || _isComplete) return;
    const dur = duration || _timerTotal;
    _currentTimerDuration = dur;
    _timerEndTime = endTime || (Date.now() + dur * 1000);
    _timerSeconds = Math.max(0, Math.round((_timerEndTime - Date.now()) / 1000));
    _renderTimer();
```

- [ ] **Step 4: Update `_renderTimer()` to use `_currentTimerDuration` for ring fill**

Find:
```js
    const pct = _timerSeconds / _timerTotal;
```
Replace:
```js
    const pct = _currentTimerDuration > 0 ? _timerSeconds / _currentTimerDuration : 1;
```

- [ ] **Step 5: Update `_advancePick()` to apply short clock for offline members**

Find:
```js
  function _advancePick() {
    resetTimer();
    startTimer();
    // Broadcast absolute deadline + persist so ALL clients show the same countdown.
    // Safe here because remote pick/skip handlers do NOT call _advancePick().
    if (_timerTotal) {
      _broadcast({ type: 'timer_start', endTime: _timerEndTime });
      _saveTimerEndToDB();
    }
```
Replace:
```js
  function _advancePick() {
    resetTimer();
    const cur = _getCurrentPick();
    const isOffline = cur && !_onlineMembers.has(cur.memberId);
    const duration  = (isOffline && _offlineTimerSecs) ? _offlineTimerSecs : undefined;
    startTimer(undefined, duration);
    // Broadcast absolute deadline + persist so ALL clients show the same countdown.
    // Safe here because remote pick/skip handlers do NOT call _advancePick().
    if (_timerTotal || duration) {
      _broadcast({ type: 'timer_start', endTime: _timerEndTime });
      _saveTimerEndToDB();
    }
```

- [ ] **Step 6: Add `offlineTimerSeconds` setup input to `draft.html`**

Find the Draft Settings card in the setup screen:
```html
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;">
          <div class="form-group">
            <label>Season</label>
            <select id="setup-season"></select>
          </div>
          <div class="form-group">
            <label>Timer per pick (seconds)</label>
            <input type="number" id="setup-timer" value="90" min="30" max="300" step="15">
          </div>
        </div>
```
Replace:
```html
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:1rem;">
          <div class="form-group">
            <label>Season</label>
            <select id="setup-season"></select>
          </div>
          <div class="form-group">
            <label>Timer per pick (s)</label>
            <input type="number" id="setup-timer" value="90" min="30" max="300" step="15">
          </div>
          <div class="form-group">
            <label>Offline timer (s)</label>
            <input type="number" id="setup-offline-timer" value="30" min="10" max="120" step="5">
            <span style="font-size:11px;color:var(--text2);">For members not in the room</span>
          </div>
        </div>
```

- [ ] **Step 7: Read offline timer in `launchDraft()` and save to `settings`**

In `launchDraft()`, find:
```js
  const timerSeconds = parseInt(document.getElementById('setup-timer').value) || 90;
```
Add after it:
```js
  const offlineTimerSeconds = parseInt(document.getElementById('setup-offline-timer').value) || 30;
```

Then in the `db.from('drafts').insert({` call, update the settings:
```js
    settings: { countdownEndAt: new Date(Date.now() + 120000).toISOString(), offlineTimerSeconds },
```

- [ ] **Step 8: Read offline timer in `loadDraftFromDB()` for resumed drafts**

The `loadDraft()` already reads `draft.settings?.offlineTimerSeconds` (Step 2). The `loadDraftFromDB()` returns `settings: d.settings || {}` which already includes it. No additional change needed.

- [ ] **Step 9: Verify**

1. Launch a draft with two browser tabs open (both members logged in).
2. Close/disconnect one tab.
3. Advance to that member's pick — the clock should start at 30 seconds instead of the full timer duration.
4. Try changing the offline timer to 15s in setup — the short clock should match.

- [ ] **Step 10: Commit**

```bash
git add js/draft-room.js draft.html
git commit -m "feat: offline shortened pick clock for team draft"
```

---

## Task 12: Offline Timer Engine + Setup UI — `fa-draft-room.js` + `fa-draft.html`

**Files:**
- Modify: `js/fa-draft-room.js`
- Modify: `fa-draft.html`

- [ ] **Step 1: Add offline timer state to `fa-draft-room.js`**

After `let _onlineMembers = new Set();` (added in Task 9), add:

```js
  let _offlineTimerSecs    = 30;
  let _currentTimerDuration = 120;
```

- [ ] **Step 2: Update `loadDraft()` to read `offlineTimerSeconds`**

In `loadDraft()`, add after `_isCountdown = draft.status === 'countdown';`:

```js
    _offlineTimerSecs = draft.settings?.offlineTimerSeconds || 30;
    _currentTimerDuration = _timerTotal;
```

- [ ] **Step 3: Update `startTimer()` to accept optional `duration` param**

Find:
```js
  function startTimer(endTime) {
    if (!_timerTotal || _isPaused || _isComplete) return;
    stopTimer();
    _timerEndTime = endTime || (Date.now() + _timerTotal * 1000);
    _timerSeconds = Math.max(0, Math.round((_timerEndTime - Date.now()) / 1000));
    _renderTimer();
```
Replace:
```js
  function startTimer(endTime, duration) {
    if (!_timerTotal && !duration) return;
    if (_isPaused || _isComplete) return;
    stopTimer();
    const dur = duration || _timerTotal;
    _currentTimerDuration = dur;
    _timerEndTime = endTime || (Date.now() + dur * 1000);
    _timerSeconds = Math.max(0, Math.round((_timerEndTime - Date.now()) / 1000));
    _renderTimer();
```

- [ ] **Step 4: Update `_renderTimer()` in `fa-draft-room.js`**

Find the `_renderTimer()` function. It renders `#fa-timer-val` with classes based on time remaining. Find:
```js
  function _renderTimer() {
    const el = document.getElementById('fa-timer-val');
    if (!el) return;
    const mins = Math.floor(_timerSeconds / 60);
    const secs = _timerSeconds % 60;
    el.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
    const pct = _timerTotal ? _timerSeconds / _timerTotal : 1;
```
Replace:
```js
  function _renderTimer() {
    const el = document.getElementById('fa-timer-val');
    if (!el) return;
    const mins = Math.floor(_timerSeconds / 60);
    const secs = _timerSeconds % 60;
    el.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
    const pct = _currentTimerDuration > 0 ? _timerSeconds / _currentTimerDuration : 1;
```

- [ ] **Step 5: Update `_advancePick()` in `fa-draft-room.js` to apply short clock**

Find:
```js
  function _advancePick() {
    resetTimer();
    startTimer();
    // Broadcast absolute deadline + persist so ALL clients (including late joiners)
    // show the same countdown. This fires only on the local pick-maker because
    // remote handlers do NOT call _advancePick().
    if (_timerTotal) {
      _broadcast({ type: 'timer_start', endTime: _timerEndTime });
      _saveTimerEndToDB();
    }
```
Replace:
```js
  function _advancePick() {
    resetTimer();
    const cur = _getCurrentPick();
    const isOffline = cur && !_onlineMembers.has(cur.memberId);
    const duration  = (isOffline && _offlineTimerSecs) ? _offlineTimerSecs : undefined;
    startTimer(undefined, duration);
    if (_timerTotal || duration) {
      _broadcast({ type: 'timer_start', endTime: _timerEndTime });
      _saveTimerEndToDB();
    }
```

- [ ] **Step 6: Add `offlineTimerSeconds` input to FA draft setup in `fa-draft.html`**

Find the Rounds & Timer setup card:
```html
      <div class="setup-card">
        <div class="setup-card-header">Draft Settings</div>
        <div class="setup-card-body" style="display:grid;grid-template-columns:1fr 1fr;gap:1rem;">
          <div class="form-group">
            <label>Rounds</label>
            <input type="number" id="setup-rounds" class="form-input" style="width:80px;" value="1" min="1" max="20">
            <div style="font-size:11px;color:var(--text2);">Snake order if &gt; 1</div>
          </div>
          <div class="form-group">
            <label>Pick Timer</label>
            <select id="setup-timer" class="form-input" style="width:140px;">
```
Replace the grid with three columns:
```html
      <div class="setup-card">
        <div class="setup-card-header">Draft Settings</div>
        <div class="setup-card-body" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:1rem;">
          <div class="form-group">
            <label>Rounds</label>
            <input type="number" id="setup-rounds" class="form-input" style="width:80px;" value="1" min="1" max="20">
            <div style="font-size:11px;color:var(--text2);">Snake order if &gt; 1</div>
          </div>
          <div class="form-group">
            <label>Pick Timer</label>
            <select id="setup-timer" class="form-input" style="width:140px;">
```

Then after the closing `</div>` of the Pick Timer form-group (after the `</select>` + `</div>`), add:
```html
          <div class="form-group">
            <label>Offline Timer (s)</label>
            <input type="number" id="setup-offline-timer" class="form-input" style="width:80px;" value="30" min="10" max="120" step="5">
            <div style="font-size:11px;color:var(--text2);">For absent members</div>
          </div>
```

- [ ] **Step 7: Read offline timer in `launchFADraft()`**

Find:
```js
  const timerSecs   = parseInt(document.getElementById('setup-timer').value) || 0;
```
Add after:
```js
  const offlineTimerSecs = parseInt(document.getElementById('setup-offline-timer').value) || 30;
```

Then in the `settings` object in the `db.from('drafts').insert(...)` call:
```js
    settings: { ratingMin, ratingMax, rounds, countdownEndAt: new Date(Date.now() + 120000).toISOString(), offlineTimerSeconds: offlineTimerSecs },
```

- [ ] **Step 8: Verify**

1. Launch a new FA draft.
2. Close one member's tab.
3. Wait for their pick — timer should start at 30s (or configured value) instead of the full pick clock.

- [ ] **Step 9: Commit**

```bash
git add js/fa-draft-room.js fa-draft.html
git commit -m "feat: offline shortened pick clock for FA draft"
```

---

## Final Verification Checklist

- [ ] **Close Draft** — Both rooms show "Close Draft" button; clicking it completes the draft and shows recap.
- [ ] **Countdown** — New draft launches with 2-minute countdown. Board visible, teams locked. Commissioner "Start Now" skips it. Two browsers show same countdown. Both transition to active when countdown ends.
- [ ] **Chat** — Messages sent in one tab appear in the other within 1 second. System messages appear on join, leave, and pick.
- [ ] **Online presence** — Sidebar shows green dot for connected members, gray for absent.
- [ ] **Offline timer** — When a member's tab is closed and it's their turn, the pick clock starts at 30s (or custom value from setup).
- [ ] **Mobile** — Sidebar hidden on mobile. Chat tab available in mobile tab bar.

---

## Push to GitHub

```bash
git push origin feature/fa-draft
```
