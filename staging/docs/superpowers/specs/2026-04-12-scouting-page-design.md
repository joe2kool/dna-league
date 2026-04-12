# Scouting Page Design Spec

**Date:** 2026-04-12
**Feature:** Scouting page — cross-team player search, sortable table, team browsing

---

## Overview

A new "Scouting" tab in `index.html` visible to all members. Lets users search and sort all Live Series players across all 30 MLB teams, or browse a specific team's roster with rating badges. Primary use case: pre-draft research and trade target identification.

---

## Architecture

### New files
- `js/scouting.js` — `ScoutingManager` IIFE module. Owns all state and rendering.

### Modified files
- `index.html` — Add `page-scouting` div, "Scouting" nav tab (desktop + mobile drawer), call `ScoutingManager.init()` on first tab open.
- `css/draft.css` — Add scouting page styles (reuse existing badge/card CSS classes where possible).

### No new Worker endpoints
Uses existing `/fa-roster?team=X&min=0&max=99` (30 calls, one per team) and `DnaRatings.getTeamRatingsFull()` for team badges.

---

## Data Flow

1. User opens Scouting tab for the first time → `ScoutingManager.init()` called once
2. Fire all 30 `/fa-roster?team=X&min=0&max=99` requests in parallel via `Promise.all`
3. Each resolved team's players are merged into `_players[]` immediately; table re-renders after each batch resolves
4. Progress indicator: `Loading teams… X / 30` updates as each resolves
5. Once all 30 resolve, full dataset (~600 players) is cached in `_players[]` for the session
6. Tab revisits use cache — no re-fetch
7. `DnaRatings.getTeamRatingsFull()` is called once for team badges (already cached if user visited draft room)

---

## ScoutingManager State

```js
_players        // flat array of all loaded players (accumulated as teams resolve)
_teamsLoaded    // count of resolved team fetches (0–30)
_filters        // { search, pos, team, bat, throw }
_sort           // { col, dir }  col = 'ovr'|'name'|'pos'|'team'|'con'|'pwr'|'spd'|'fld'|'vel'|'pitchCon'
_page           // current page number (1-indexed)
_view           // 'all' | 'team'
_selectedTeam   // abbr string when _view === 'team'
_expandedRow    // player index with open detail card, or null
_initialized    // bool — prevents double-init on tab revisit
```

---

## Views

### All-Players View (default)

**Filter bar** (above table):
- Text input: player name search (case-insensitive substring)
- Dropdown: Position — All / SP / RP / CP / C / 1B / 2B / 3B / SS / LF / CF / RF / DH
- Dropdown: Team — All / [30 teams alphabetical] — selecting a team switches to Team View
- Dropdown: Bat — All / L / R / S
- Dropdown: Throw — All / L / R

Filters apply immediately on change; any filter change resets to page 1.

**Table columns** (all sortable, click header to toggle asc/desc):

| Column | Field | Notes |
|--------|-------|-------|
| Name | `name` | |
| Pos | `pos` | |
| Team | `team` | abbreviation |
| OVR | `overall` | default sort desc |
| CON | avg(contact_left, contact_right) | `—` for pitchers |
| PWR | avg(power_left, power_right) | `—` for pitchers |
| SPD | `speed` | `—` for pitchers |
| FLD | `fielding` | `—` for pitchers |
| VEL | `velocity` | `—` for hitters |
| CTL | `control` | `—` for hitters (pitch control) |

Active sort column highlighted. Arrow indicator (↑/↓) on sorted column.

**Row expand:** Clicking a row toggles an inline detail panel below that row — identical to the FA draft room attribute card (`renderPlayerDetail` pattern). Clicking the same row again collapses it. Only one row expanded at a time.

**Pagination:** 40 records per page. Controls: `← Prev | Page N of M | Next →`. Sort or filter change resets to page 1.

**Loading state:** While `_teamsLoaded < 30`, show `Loading teams… X / 30` above the table. Table renders with whatever players have loaded so far. Once complete, indicator disappears.

---

### Team View

Entered by: selecting a team from the Team dropdown, or clicking a team card in the team grid.

**Header:**
- `← All Players` button (restores previous all-players filter state)
- Team name + league + division

**Team summary card:**
- 6 rating badges reusing existing `.tcb-group` / `.tcb-badge` CSS:
  - Pitching: SP / RP (green)
  - Hitting: PWR / CON (gold)
  - Athletic: SPD / DEF (blue)
- Data from `DnaRatings.getTeamRatingsFull()` — renders instantly from cache

**Roster table:**
- Same sortable table as all-players view, pre-filtered to selected team
- No pagination (max 20 players per team)
- Same row-expand detail card behavior

---

## Team Grid (entry point to Team View)

A scrollable grid of 30 team cards shown at the top of the Scouting page, above the filter bar. Each card shows team abbreviation and overall rating (from `getTeamRatingsFull()`). Clicking a card enters Team View for that team. Cards use existing `.team-card` CSS pattern.

---

## Player Object Shape (as stored in `_players[]`)

Each player entry from `/fa-roster` response, with `teamAbbr` field added by the client:

```js
{
  teamAbbr,   // added by client — e.g. 'LAD'
  name, pos, overall, series, rarity, bats, throws, quirks,
  // hitters:
  contact_left, contact_right, power_left, power_right,
  plate_vision, plate_discipline, clutch, speed, stealing, fielding, arm_strength, arm_accuracy,
  // pitchers:
  stamina, pitching_clutch, velocity, control, break_rating,
  hits_per_bf_l, hits_per_bf_r, k_per_bf_l, k_per_bf_r, bb_per_bf, hr_per_bf,
  pitch_arsenal,
}
```

---

## Error Handling

- Individual team fetch failures are silently skipped (team omitted from results, counter still increments)
- If all 30 fail (0 players loaded), show "Could not load player data. Check connection." message with a "Retry" button that resets `_initialized` and calls `init()` again
- Partial load (some teams failed) shows the available players with no error message — the count badge indicates data may be incomplete

---

## Styling

- Reuse existing CSS variables (`--green`, `--gold`, `--blue`, `--chrome1`, `--text1`, `--text2`)
- Reuse `.tcb-group`, `.tcb-badge`, `.tcb-green`, `.tcb-gold`, `.tcb-blue` for team badges
- New classes scoped to `.scouting-*` prefix to avoid collisions
- Table: compact rows, alternating row shading, sticky header on scroll
- Responsive: on mobile, hide FLD/VEL/CTL columns; show condensed card

---

## Not In Scope

- Saving/bookmarking players
- Comparing players side-by-side
- Filtering by specific attribute thresholds (e.g., "speed > 85")
- Integration with season rosters (showing which member owns each team)
