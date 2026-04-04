# Draft Room Enhancements — Design Spec

**Date:** 2026-04-03
**Branch:** feature/fa-draft (or new branch from staging)
**Affects:** `draft.html`, `fa-draft.html`, `js/draft-room.js`, `js/fa-draft-room.js`, `css/draft.css`, `css/fa-draft.css`

---

## Goal

Four enhancements to both the team draft room (`draft.html`) and FA draft room (`fa-draft.html`):
1. Rename "End Draft Early" → "Close Draft"
2. 2-minute pre-draft countdown before picks begin
3. Left sidebar with live online presence list + ephemeral chat
4. Shortened pick clock for offline members (configurable, default 30s)

---

## Feature 1 — Close Draft Button

### What changes
The "End Draft Early" button in both draft rooms is renamed to **"Close Draft"**. Behavior is identical: mark draft `completed`, stop timer, show recap screen. No logic changes — label only.

**Files:**
- `draft.html` — button label in `#dr-controls`
- `fa-draft.html` — button label in `#fa-controls`

---

## Feature 2 — Pre-Draft Countdown

### Overview
When the commissioner clicks **Launch Draft**, all connected clients enter a 2-minute countdown before the first pick clock starts. Full draft board is visible and scrollable during this phase but team selection is disabled.

### Draft status lifecycle
```
setup → countdown → active → (paused) → (skipped_picks) → completed
```
A new `countdown` status is inserted between setup and active.

### How it works

**Launch:**
1. Commissioner clicks Launch Draft (existing flow).
2. Draft is inserted into Supabase with `status: 'countdown'` and `settings.countdownEndAt = now + 120s`.
3. All clients entering the room see `status === 'countdown'` and start a local countdown synced to `countdownEndAt` (same absolute deadline pattern as the pick timer).

**Countdown UI:**
- Full pick board rendered as normal.
- Available teams grid is rendered but all team cards have `pointer-events: none` and reduced opacity (`0.4`) — a CSS class `teams-locked` applied to the grid container.
- A gold countdown banner replaces the "On the clock" timer area: large text "Draft starts in 1:47", timer ring in gold.
- Commissioner sees an additional **"Start Now"** button that skips the remaining countdown.

**Skipping countdown:**
- Commissioner clicks "Start Now".
- Client broadcasts `{ type: 'countdown_skip' }` and updates draft `status` to `active` in Supabase.
- All clients (including commissioner's) handle `countdown_skip` by transitioning to active state and calling `_advancePick()`.
- Commissioner's client does NOT call `_advancePick()` directly before broadcasting — it only broadcasts `countdown_skip`. The transition on all clients (including commissioner) is triggered by the incoming broadcast, preventing double-advance.

**Countdown expiry (no skip):**
- When local countdown hits zero, the client that detects expiry broadcasts `countdown_skip` and updates Supabase status to `active`.
- Guard: `_countdownExpired` flag (same dedup pattern as `_timedOutForPick`) prevents multiple clients from firing simultaneously.

**Late joiners:**
- On page load, if `draft.status === 'countdown'`, read `settings.countdownEndAt`, start countdown timer locally. Do not broadcast.
- If `countdownEndAt` is in the past (draft should have started but DB hasn't updated yet), transition straight to `active`.

### State additions
Both `draft-room.js` and `fa-draft-room.js`:
```js
let _isCountdown = false;
let _countdownEndTime = 0;
let _countdownTimer = null;
let _countdownExpired = false; // dedup guard
```

### Setup screen addition
No changes to the setup screen for this feature — countdown duration is fixed at 120 seconds (not configurable).

---

## Feature 3 — Left Sidebar (Chat + Online Presence)

### Layout
A `~160px` fixed-width left sidebar is added to both draft room screens, sitting to the left of the existing pick board column. The existing two-column layout (`draft-left` + `draft-right`) becomes three columns with the sidebar added at the far left.

```
[Online/Chat Sidebar] | [Pick Board] | [Available Teams/Players]
       ~160px                ~auto               ~auto
```

### Online Presence (top half of sidebar)

**Technology:** Supabase Realtime Presence on the existing draft channel.

Each client tracks itself on page load:
```js
channel.track({ memberId: _member.id, memberName: _member.name, color: _member.color })
```

Presence state is unregistered automatically on page unload / connection drop.

**Display:**
- Section header: "👥 Online (N/M)"
- Each draft slot member listed with a colored dot:
  - **Green dot** — member has active Presence entry
  - **Gold dot** — member is in draft slot list but has no Presence entry (offline)
  - No "auto-skip" mode (replaced by shortened clock — see Feature 4)
- Members not in the draft slot list (spectators / late page loads) are not shown

**Updates:** Re-render the online list on every `presence_sync`, `presence_join`, and `presence_leave` event.

### Chat (bottom half of sidebar)

**Technology:** Broadcast on the existing Supabase Realtime channel, event name `chat_message`.

**Message format:**
```js
{ type: 'chat_message', memberId, memberName, memberColor, text, ts }
```

**Display:**
- Sender name in their avatar color, message text below/beside it
- Timestamps not shown (ephemeral, no need)
- Messages capped at last 50 in a local array — oldest trimmed when limit exceeded
- No DB persistence — messages exist only for connected clients

**System messages** are posted to the local chat list (not broadcast) automatically:
- `"● JosephII joined"` — on `presence_join`
- `"● MikeD disconnected"` — on `presence_leave`
- `"Draft starting in 2:00"` — when countdown phase begins
- `"JosephII picked NYY"` — when `pick` event received
- `"FA Draft starting — pick 1 is live"` — when countdown ends / draft goes active

**Input:** Single text input + send button. Enter key submits. Max 200 characters. Empty messages rejected.

**Mobile:** Sidebar collapses entirely. Online dots appear inline next to member names on the pick board rows. Chat becomes a new tab in the existing mobile tab bar: "💬 Chat".

### New broadcast event type
Both `draft-room.js` and `fa-draft-room.js` handle:
```js
case 'chat_message':
  _addChatMessage(payload);
  break;
```

### Public API additions
```js
sendChatMessage(text)  // validates, broadcasts chat_message event
getOnlineMembers()     // returns Set of memberIds currently in Presence
```

### CSS
New styles in `css/draft.css` and `css/fa-draft.css`:
- `.draft-sidebar` — left sidebar container, fixed width, flex column
- `.sidebar-online` — top section, scrollable member list
- `.sidebar-chat` — bottom section, flex-grow, message list + input
- `.sidebar-online-item` — row with dot + name
- `.online-dot`, `.online-dot.offline` — colored dot variants
- `.chat-msg` — message row
- `.chat-input-row` — input + send button strip

---

## Feature 4 — Offline Shortened Clock

### Overview
When it's a member's turn and they are **not present** in the Supabase Presence set, the pick timer uses `offlineTimerSeconds` instead of the full `timerTotal`. Default: 30 seconds.

### Setup screen addition
Both `draft.html` and `fa-draft.html` setup screens get a new **"Offline timer (s)"** number input alongside the existing timer input. Default value: `30`. Stored in `drafts.settings.offlineTimerSeconds`.

**Team draft setup** (`draft.html`): add input next to the existing `#setup-timer`.
**FA draft setup** (`fa-draft.html`): add input next to the existing `#setup-timer`.

### How it works

`_advancePick()` in both engines checks Presence before starting the timer:
```js
function _advancePick() {
  resetTimer();
  const cur = _getCurrentPick();
  const isOffline = cur && !_onlineMembers.has(cur.memberId);
  const duration = isOffline ? (_offlineTimerSecs || 30) : _timerTotal;
  startTimer(undefined, duration); // startTimer accepts optional duration override
  if (_timerTotal) {
    _broadcast({ type: 'timer_start', endTime: _timerEndTime });
    _saveTimerEndToDB();
  }
  ...
}
```

`startTimer(endTime, duration)` — the `duration` parameter overrides `_timerTotal` for the ring fill calculation only; `_timerTotal` is not mutated so the full clock remains for online members.

**Authority:** Only the commissioner's client determines whether to apply the short clock — it is the one calling `_advancePick()` locally and broadcasting `timer_start`. Remote clients simply sync to whatever `endTime` they receive, so the short clock propagates automatically.

### State additions
Both engines:
```js
let _offlineTimerSecs = 30;  // loaded from draft.settings.offlineTimerSeconds
let _onlineMembers = new Set(); // memberIds — updated by Presence events
```

---

## Data Changes

### `drafts` table — `settings` jsonb
New fields added to the `settings` jsonb column (no schema migration needed):
```json
{
  "countdownEndAt": "ISO timestamp",
  "offlineTimerSeconds": 30
}
```

### No new Supabase tables
Chat is ephemeral (broadcast only). Presence uses Supabase's built-in Presence API on the existing channel. No new tables or columns required beyond the `settings` jsonb additions above.

---

## Applies To Both Draft Rooms

All four features apply identically to:
- `draft.html` + `js/draft-room.js` (team draft)
- `fa-draft.html` + `js/fa-draft-room.js` (FA draft)

Where behavior differs (e.g. "On the clock" UI structure), each file handles its own rendering — no shared module is introduced.

---

## Out of Scope

- Persistent chat history
- Message reactions / threading
- Push notifications for offline members
- Countdown duration configurable in setup screen (fixed at 120s)
