# Design Spec: FA Pool Export & Team Assignment Override

**Date:** 2026-04-12  
**Status:** Approved

---

## Overview

Two additive features to the season card Teams tab in `index.html`:

1. **FA Pool Export** — commissioner can download a CSV of all Live Series players available for the FA draft, for a given OVR range, before the FA draft room opens.
2. **Team Assignment Override** — commissioner can manually set or change any member's assigned MLB team inline, including members who missed the draft or were assigned incorrectly.

---

## Feature 1: FA Pool Export

### Trigger & Placement

- An "Export FA Pool CSV" button is added to the commissioner-only controls in the season card's Teams tab, alongside the existing FA Draft and Auto-load buttons.
- Visibility: commissioner+ roles only (same `canManageSchedule()` gate).
- Only rendered when at least one team is assigned to the season (same condition as the FA Draft button).

### Rating Range

- If an FA draft record exists for the season (i.e., a `drafts` row with `type='fa'` and matching `season_id`): use the draft's configured `ratingMin` and `ratingMax` directly — no prompt.
- If no FA draft record exists: clicking the button reveals an inline form with two number inputs (Min OVR, Max OVR, pre-filled with 70 and 84) and a "Download" button.

### Fetch Logic

- Fires parallel `GET /fa-roster?team={abbr}&min={min}&max={max}` requests to the Worker for each team abbreviation in the season's `league_teams`.
- Team names are resolved to abbreviations via `DNA_CONFIG.mlbTeams`.
- Results are aggregated and sorted by OVR descending.
- During fetch: button shows "Fetching…" and is disabled. On error: inline error message below the button.

### CSV Structure

**Filename:** `fa-pool-{seasonName}-{min}-{max}.csv`

All players share a single flat column set. Pitcher-only columns are blank for hitters and vice versa.

| Column | Hitters | Pitchers |
|--------|---------|----------|
| Name | ✓ | ✓ |
| OVR | ✓ | ✓ |
| Pos | ✓ | ✓ |
| Team | ✓ | ✓ |
| Bats | ✓ | ✓ |
| Throws | ✓ | ✓ |
| Contact L | ✓ | — |
| Contact R | ✓ | — |
| Power L | ✓ | — |
| Power R | ✓ | — |
| Plate Vision | ✓ | — |
| Plate Discipline | ✓ | — |
| Clutch | ✓ | — |
| Speed | ✓ | — |
| Stealing | ✓ | — |
| Fielding | ✓ | — |
| Arm Strength | ✓ | — |
| Arm Accuracy | ✓ | — |
| Stamina | — | ✓ |
| Pitching Clutch | — | ✓ |
| Velocity | — | ✓ |
| Control | — | ✓ |
| Break | — | ✓ |
| H/BF L | — | ✓ |
| H/BF R | — | ✓ |
| K/BF L | — | ✓ |
| K/BF R | — | ✓ |
| BB/BF | — | ✓ |
| HR/BF | — | ✓ |
| Pitch Arsenal | — | ✓ (e.g. `Four-Seam:95:65; Slider:88:72`) |
| Quirks | ✓ | ✓ (semicolon-separated) |

### New Functions

All added to `index.html`:

- **`fetchFaPool(teamAbbrs, min, max)`** — async. Fires parallel Worker `/fa-roster` requests for each team abbr, merges, sorts by OVR desc, returns player array.
- **`buildFaPoolCsv(players)`** — pure. Takes player array, returns CSV string with full column set. Blanks non-applicable fields per player type.
- **`downloadFaPoolCsv(season, min, max)`** — orchestrates: resolves team abbrs from season → calls `fetchFaPool` → calls `buildFaPoolCsv` → triggers browser download via temporary `<a>` element. Manages button loading/error state.

---

## Feature 2: Team Assignment Override

### Trigger & Placement

- A pencil icon (✏) is added next to each member's team display in the Teams tab.
- Visible to commissioner+ roles only.
- Clicking the icon for a row puts that row into edit mode. Only one row can be in edit mode at a time — opening a new row cancels any open edit without saving.

### Edit Mode UI

- The team display is replaced by a `<select>` dropdown populated with all 30 MLB teams from `DNA_CONFIG.mlbTeams`.
- A "— No Team —" option is included at the top to allow clearing an assignment.
- Confirm (✓) and Cancel (✗) buttons appear inline.
- Confirm saves and exits edit mode; Cancel restores the previous display without saving.

### Save Logic

- Modifies `saveTeamAssignment(seasonId, memberId, teamName)` to use `.upsert()` instead of `.update()`.
- Upsert fields: `season_id`, `member_id`, `mlb_team_id` (resolved via `getMlbTeamId()`).
- Also updates the in-memory `seasonState` `teamAssignments` object and re-renders the season card.
- If "— No Team —" is selected: sets `mlb_team_id` to `null` in `league_teams` and removes the key from `teamAssignments`.

### Edge Cases

- Members with no existing `league_teams` row: upsert inserts a new row.
- Clearing a team: sets `mlb_team_id = null` in Supabase, removes from local `teamAssignments`.
- Commissioner cannot assign the same team to two members (no enforcement in DB, but this is an intentional override tool — no client-side restriction needed).

---

## Files Changed

| File | Change |
|------|--------|
| `index.html` | Add `fetchFaPool`, `buildFaPoolCsv`, `downloadFaPoolCsv` functions; add export button + inline OVR form to Teams tab template; add pencil icon + edit mode to team assignment rows; modify `saveTeamAssignment` to use upsert |

No changes to `worker.js`, `fa-draft-room.js`, `js/config.js`, or any other file.

---

## Verification

- Export button only appears for commissioner+ with at least one team assigned.
- CSV downloads with correct filename and all columns populated.
- Pitcher rows have blank hitter columns; hitter rows have blank pitcher columns.
- Edit icon appears per row; only one row editable at a time.
- Saving a new team updates both Supabase and local state without a page reload.
- Clearing a team removes the assignment from both Supabase and local state.
- Upsert creates a `league_teams` row for members who had none.
