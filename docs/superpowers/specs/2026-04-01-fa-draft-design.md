# Free Agent Draft — Design Spec
Date: 2026-04-01

## Overview

A live, joinable Free Agent draft that runs after the team draft for a season. Players draft individual MLB The Show Live Series players from the teams already claimed in the team draft, filtered to a configurable overall rating range. Draft order is reversed from the team draft (last pick goes first), with snake ordering across multiple rounds. Results export as a CSV and a printable trade checklist that guides manual in-game trade execution.

---

## Architecture

### New Files
| File | Purpose |
|------|---------|
| `fa-draft.html` | Standalone FA draft room page (mirrors `draft.html` pattern) |
| `js/fa-draft-room.js` | FA draft engine — config, player pool, snake order, picks, export |
| `css/fa-draft.css` | FA draft room styles |

### Entry Point
- Seasons page gets a **"FA Draft"** button on each season that has teams assigned
- Button is commissioner/admin only
- Links to `fa-draft.html?season=<id>`
- Button shows "View FA Draft" (not "Launch") if a draft already exists for that season

### Supabase Tables (no schema changes needed)
| Table | Usage |
|-------|-------|
| `drafts` | One row per FA draft, `type = 'player'`, stores `timer_seconds`, `status`, rating range in `settings` (jsonb) |
| `draft_slots` | One row per pick slot — member_id + pick_number (derived from reversed team draft order) |
| `draft_picks` | One row per pick — `player_name`, `player_rating`, `member_id`, `picked_at`. `mlb_team_id` = original team the player came from |
| `league_members` | Read for draft order derivation |

`drafts.settings` jsonb stores FA draft config:
```json
{
  "ratingMin": 70,
  "ratingMax": 79,
  "rounds": 1
}
```

### Realtime
- Subscribe to `draft_picks` inserts on the active draft (same pattern as team draft)
- On reconnect, reconstruct full draft state from DB — picks, current slot, timer state
- Paused state stored in `drafts.paused` column (already exists)

---

## Configuration Screen (Commissioner Only)

Shown when the commissioner first opens `fa-draft.html` for a season with no existing FA draft.

### Rating Range
- **Tier buttons**: Common (65–69), Bronze (70–74), Silver (75–79), Gold (80–84), Diamond (85–99)
  - Clicking a tier pre-fills Min/Max inputs
  - Multiple tiers can be combined by manually adjusting the inputs after selecting a tier
- **Min Overall** / **Max Overall**: number inputs, manually editable at any time
- Tier button highlights when the current min/max exactly matches its range

### Rounds
- Number input, default **1**
- Snake order applies when rounds > 1: odd rounds go in reversed-team-draft order, even rounds flip

### Pick Timer
- Dropdown: No timer / 2 min / 3 min / 5 min

### Draft Order Preview
- Shows the pick order derived from reversing the team draft slots for that season
- Displays member display names in order

### Launch
- "Launch FA Draft" button creates `drafts` row + all `draft_slots` rows in Supabase
- After creation, page transitions to the live draft room (same URL, no redirect)
- Any member who opens the link after launch goes directly to the live room

---

## Draft Room UI (All Members)

Tabbed layout — 3 tabs:

### Tab 1: Available Players
- Fetched from new Worker `/fa-roster?team=X&min=Y&max=Z` endpoint for each team in the season's `teamAssignments`
- Rating range filtering happens server-side in the Worker
- Sorted by overall descending by default; filterable by position group
- Already-picked players are hidden

**Collapsed player row:**
- OVR badge (color-coded by tier: gold border for Gold, silver for Silver, etc.)
- Name, position, team abbreviation, series, rarity
- "▼ Details" button to expand

**Expanded player card (hitters):**
- Contact L/R, Power L/R, Vision, Discipline, Clutch
- Speed, Steal, Fielding, Arm Strength, Arm Accuracy
- Quirks (color-coded tags)
- "Select This Player" button (only enabled when it's your turn)

**Expanded player card (pitchers):**
- K/9, BB/9, HR/9, Velocity, Break, Control, Stamina
- **Pitch Repertoire**: list of pitch types with speed and break rating (e.g., 4-Seam FB 94 / Break 42)
- Quirks
- "Select This Player" button

### Tab 2: Draft Board
- Full pick-by-pick grid showing all rounds and slots
- Current on-clock slot highlighted
- Completed picks show player name + OVR
- Empty future slots show member name + pick number

### Tab 3: My Picks
- List of players the signed-in member has drafted so far
- Collapsed by default, expandable (same card format as Tab 1)

### On-Clock Header (persistent across all tabs)
- Member name currently on the clock
- Countdown timer (if configured)
- "Your turn!" highlight when it's the signed-in member's pick
- Commissioner controls: Pause / Resume / Skip Current Pick / End Draft Early

---

## Player Pool Data

### Worker Extension Required
The existing Worker `/roster` endpoint returns only the top 5 players per team by overall. For the FA draft we need:

**New Worker route: `GET /fa-roster?team=LAD&min=70&max=84`**
- Returns all Live Series players for the team within the overall range
- Each player includes all attribute fields from the MLB The Show API item object:
  - Hitters: contact_left, contact_right, power_left, power_right, plate_vision, plate_discipline, clutch, speed, stealing, fielding, arm_strength, arm_accuracy
  - Pitchers: pitching_clutch, hits_per_bf, k_per_bf, bb_per_bf, hr_per_bf, velocity, control, stamina, pitch_arsenal (array of `{name, speed, break}`)
  - All players: quirks array
- Cache: 1 hour (same as `/roster`)
- Uses existing `TEAM_MAP` for WSH→WAS conversion

---

## Snake Order Logic

Given N members and R rounds, pick order is:

- Base order = team draft slots reversed (pick N, N-1, … 1)
- Round 1 (odd): base order forward
- Round 2 (even): base order reversed
- Round 3 (odd): base order forward
- …

`draft_slots` rows are pre-written at launch with pick_number 1 through (N × R), encoding the snake pattern. No runtime logic needed — the slot sequence is the source of truth.

---

## Export

Generated client-side after the draft completes (or by commissioner at any time from a "Generate Export" button).

### CSV Download
Columns: `Round`, `Pick`, `Player Name`, `OVR`, `Position`, `Original Team`, `Drafted By`, `Drafted By Team`, `Trade Return Player`, `Trade Return OVR`, `Trade Return Position`

### Printable HTML Checklist
- "Print Checklist" opens a new browser tab with print-optimized HTML
- Instructions banner at top explaining the rejoin-and-trade flow
- Grouped by **original team** (the team the FA player came from)
- Each trade row:
  - Checkbox
  - Player name + OVR badge + position + round/pick
  - Drafted by (member name + their team abbreviation)
  - Trade return player (name + OVR + position) — see selection logic below
  - Step hint: "Rejoin as [original team] → trade [player] to [new owner team]"
- Progress counter: X / N trades completed
- Checkboxes persist in localStorage for the session

### Trade Return Player Selection Logic
The trade return is the worst player on the new owner's team (from Worker roster data), selected by position group matching:

1. **Pitcher drafted (SP/RP)** → lowest overall pitcher (SP or RP) on receiving team
2. **Catcher drafted (C)** → lowest overall catcher; fallback: lowest overall infielder
3. **Infielder drafted (1B/2B/3B/SS)** → lowest overall infielder on receiving team; fallback: lowest overall position player
4. **Outfielder drafted (LF/CF/RF/DH)** → lowest overall outfielder on receiving team; fallback: lowest overall position player
5. If the best match is rated within 5 OVR of the drafted player (too valuable to trade), fall back to the absolute lowest rated player on the team regardless of position

---

## Permissions
- **Commissioner / Admin only**: create FA draft, configure settings, pause/resume/skip/end
- **All signed-in members**: view draft room, see all picks, expand player cards
- **On-clock member only**: "Select This Player" button is active

---

## State Persistence
- Draft config + all picks live in Supabase — no localStorage dependency
- Members can close the tab and rejoin at any time; full state reconstructed from DB on load
- `dna_live_draft` localStorage key is NOT used for FA drafts (team draft only)

---

## Supabase RLS
FA draft uses the same `drafts`, `draft_slots`, `draft_picks` RLS policies already in place from the team draft. No new policies needed.

---

## Out of Scope
- Automated in-game trade execution (not possible via API)
- Multiple FA drafts per season (one FA draft per season; commissioner must end before creating another)
- FA draft history on member profile cards (future enhancement)
