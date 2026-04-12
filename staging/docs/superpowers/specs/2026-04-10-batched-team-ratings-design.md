# Batched Team Ratings Endpoint Design

**Date:** 2026-04-10  
**Status:** Approved

## Overview

Replace the current two-phase team ratings load (31 requests: 1× `/teams` + 30× `/team-breakdown`) with a single parallel batch of 15 requests to a new `/teams-full` endpoint. Each request returns overall + all 6 breakdown stats for 2 teams, eliminating the `loading...` placeholder state entirely.

---

## Worker — `GET /teams-full?chunk=N`

Chunks are 0-indexed. 30 teams ÷ 2 teams per chunk = 15 chunks (chunk 0–14).

Teams are split by index order of `Object.keys(TEAM_MAP)` — deterministic, no state needed.

### Per-chunk processing (2 teams in parallel)

For each team in the chunk:
1. Fetch 2 pages of Live Series listings (sorted rank desc) — 2 subrequests
2. Select representative players from ~40 results:
   - Top 5 SPs by overall
   - Top 7 RP/CPs by overall
   - Best card at each of C, 1B, 2B, 3B, SS, LF, CF, RF (8 slots)
   - 9th hitter: best DH if present, else next highest unselected hitter
3. Fetch item API for each selected player (~21 subrequests)
4. Compute: `overall` (avg OVR of top 5 from listings page 1), `sp`, `rp`, `power`, `contact`, `speed`, `defense`

**Subrequest budget per chunk:** 2 teams × (2 listing pages + ~21 item fetches) = ~46 subrequests. Under CF's 50/invocation hard limit.

### Calculation formulas

| Stat | Formula |
|------|---------|
| overall | avg OVR of top 5 players from listings page 1 |
| sp | avg `ovr` of up to 5 SP item responses |
| rp | avg `ovr` of up to 7 RP/CP item responses |
| power | avg of `(power_left + power_right) / 2` across 9 hitter reps |
| contact | avg of `(contact_left + contact_right) / 2` across 9 hitter reps |
| speed | avg `speed` across 9 hitter reps |
| defense | avg `fielding_ability` across 9 hitter reps |

Any stat with zero qualifying players returns `null`.

### Response shape

```json
{
  "chunk": 0,
  "teams": {
    "ARI": { "overall": 83, "sp": 86, "rp": 80, "power": 84, "contact": 82, "speed": 79, "defense": 77 },
    "ATL": { "overall": 90, "sp": 90, "rp": 82, "power": 88, "contact": 85, "speed": 81, "defense": 83 }
  }
}
```

### Cache

1 hour via `cf: { cacheTtl: 3600, cacheEverything: true }` on all subrequests. The chunk response itself is not separately cached at the CF edge — the subrequest caches provide the benefit.

### Error handling

- Individual team failure: that team's entry is omitted from `teams` (partial results returned)
- Full chunk failure: returns `{ error: message }` with 500
- Invalid chunk index (< 0 or ≥ 15): returns 400

### Backward compatibility

Existing `/teams` and `/team-breakdown` endpoints remain unchanged. They can be removed after `/teams-full` is confirmed working in production.

---

## Client — `js/ratings.js`

### New `getTeamRatingsFull()` method

```
getTeamRatingsFull() → Promise<{ abbr: { overall, sp, rp, power, contact, speed, defense } }>
```

- Fires all 15 chunk requests in parallel via `Promise.all`
- Merges chunk results into a single flat map keyed by team abbr
- Separate 1-hour in-memory cache (`_cache.full`, `_cache.fullFetchedAt`)
- On Worker failure: falls back to `getTeamRatings()` static data (overall only, breakdown stats null)
- Exposed in `DnaRatings` public return object

---

## Client — `draft.html`

Replace the two-phase sequence:

```js
// OLD — two phases
DnaRatings.getTeamRatings().then(ratings => {
  DraftUI.renderAvailableTeams(draft.availableTeams, ratings);
  DraftUI.loadTeamBreakdowns(draft.availableTeams);
});
```

With single call:

```js
// NEW — one phase
DnaRatings.getTeamRatingsFull().then(ratings => {
  DraftUI.renderAvailableTeams(draft.availableTeams, ratings);
});
```

All three `renderAvailableTeams` call sites in `draft.html` get this treatment. The paired `loadTeamBreakdowns` calls are removed from `draft.html`.

The same change applies to the 7 `renderAvailableTeams` + `loadTeamBreakdowns` pairs in `draft-room.js` — replace with `renderAvailableTeams` only (breakdown data is already in `_draft.teamRatings` which is populated from `getTeamRatingsFull`).

---

## Client — `draft-board.js`

`renderAvailableTeams(available, teamRatings)` already accepts a ratings map. No changes needed to the rendering logic — it reads `rating.overall` for the OVR display. The breakdown section needs to be populated on initial render rather than via `updateTeamCardBreakdown`.

Two changes:
1. `renderAvailableTeams` renders breakdown badges directly (same grouped badge HTML as `updateTeamCardBreakdown`) using `rating.sp`, `rating.rp` etc. from the ratings map — no `loading...` placeholder
2. `loadTeamBreakdowns` and `updateTeamCardBreakdown` are kept in the codebase (they may still be called from `draft-room.js` during the transition) but the `loading...` placeholder path is removed

---

## Migration Path

1. Deploy new Worker endpoint `/teams-full`
2. Update `ratings.js` with `getTeamRatingsFull()`
3. Update `draft-board.js` to render breakdowns inline
4. Update `draft.html` and `draft-room.js` to use `getTeamRatingsFull()`
5. Test in staging — confirm all 30 teams show all 7 stats immediately on load
6. After production confirmation, remove `/teams` and `/team-breakdown` from `worker.js` and `loadTeamBreakdowns`/`updateTeamCardBreakdown` from `draft-board.js`
