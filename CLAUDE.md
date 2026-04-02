# The DNA League — Claude Reference

Custom MLB The Show 26 online league management web app.

---

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla HTML/CSS/JS (multi-file, no build step) |
| Backend | Supabase (PostgreSQL + Auth + Realtime) |
| Hosting | GitHub Pages — joe2kool.github.io/dna-league |
| API Proxy | Cloudflare Worker — dna-league.josephisaacii.workers.dev |
| CI/CD | GitHub Actions |

---

## File Structure

```
index.html          — Main app (all pages except draft room)
draft.html          — Live draft room (standalone page)
worker.js           — Cloudflare Worker source (deploy manually to Cloudflare)
css/draft.css       — Draft room styles
js/config.js        — Supabase config, MLB teams array, Worker URL
js/auth.js          — Shared auth helpers (DnaAuth)
js/ratings.js       — Live Series ratings fetcher (DnaRatings)
js/draft-room.js    — Live draft engine (DraftRoom)
js/draft-board.js   — Draft board renderer (DraftBoard / DraftUI)
.github/workflows/
  security-pipeline.yml   — Secret scan, lint, HTML validation on every push
  deploy-staging.yml      — Auto-deploy to staging branch
  deploy-production.yml   — Auto-deploy to main branch
```

---

## Pages (inside index.html)

All pages are `<div id="page-X" class="page">` toggled via `showPage(id, tabEl)`.

| Page ID | Nav Label | Who Can See |
|---------|-----------|-------------|
| `home` | Home | Everyone |
| `draft` | Draft Order | Everyone |
| `seasons` | Seasons | Everyone |
| `schedule` | Schedule | Everyone |
| `profiles` | Members | Everyone |
| `league` | League | commissioner+ only (hidden from members) |

---

## State Management

**Primary persistence: localStorage**

| Key | Contents |
|-----|----------|
| `dna_league` | `{ players[], lastResult, draftsGenerated, draftMode, slotCount, activityLog[] }` |
| `dna_seasons` | `{ seasons[] }` |
| `dna_schedule` | `{ generatedWeeks[], seriesLength, matchupsPerWeek, seasonId, savedAt }` |
| `dna_live_draft` | Active draft session state |

**Supabase sync:** Only for real auth accounts. `syncPlayersFromDB()` merges DB users into existing localStorage state — never replaces. `loadState()` must run BEFORE `syncPlayersFromDB()`. Draft history (Supabase-sourced entries with `dbPickId`) is rebuilt from scratch on every sync so deletes propagate to all devices.

**Supabase table:** `league_members` — columns include `id`, `user_id`, `league_id`, `display_name`, `real_name`, `avatar_color`, `favorite_mlb_team`, `role`, `joined_at`, `gamertag`, `platform`, `wins`, `losses`, `championships`, `playoffs`, `mvp`, `cyyoung`

**Seasons/schedule stored in Supabase:** `seasons`, `league_teams`, `drafts`, `draft_slots`, `draft_picks`. The `dna_seasons` and `dna_schedule` localStorage keys are removed on login (one-time cleanup in `loadLeagueContext`).

**`handle_new_user` trigger:** Auto-inserts new signups into `league_members` with role `member`. If members are missing from the app after signup, check this trigger exists in Supabase.

---

## Roles & Permissions

```
admin > commissioner > co_commissioner > helper > member
```

| Role | Permissions |
|------|-------------|
| `admin` / `commissioner` | Full control — seasons, draft, schedule, roles |
| `co_commissioner` | Manage seasons, schedule, draft — cannot change roles |
| `helper` | Read-only assist |
| `member` | Standard player |

Key functions: `canManageSchedule()` in index.html, `DnaAuth.canManage(member)` / `DnaAuth.isAdmin(member)` in draft.html only.

**IMPORTANT:** `DnaAuth` (from `js/auth.js`) is only loaded in `draft.html`. Do NOT use `DnaAuth.*` in `index.html` — use inline role checks instead: `['admin','commissioner'].includes(currentMember.role)`.

---

## Player Object Shape

```js
{
  id,               // UUID (Supabase) or 'local-TIMESTAMP' (commissioner-added)
  name,             // Display name
  realname,         // Optional real name
  color,            // Avatar hex color
  team,             // Favorite MLB team (string)
  role,             // 'admin' | 'commissioner' | 'co_commissioner' | 'helper' | 'member'
  gamertag,         // MLB The Show in-game username
  platform,         // 'psn' | 'xbl' | 'mlbts' | 'nsw'
  wins, losses,     // Last season record
  championships, playoffs, mvp, cyyoung,  // Career award totals
  joinDate,
  localOnly,        // true if commissioner-added, not yet a real Supabase user
  draftHistory: [   // Array of draft entries
    {
      dbPickId,     // Present on Supabase-sourced entries; absent on local Draft Order Generator saves
      type,         // 'live' | 'order'
      seasonId,     // Present for live draft picks; absent for Draft Order Generator saves
      seasonName,
      team,         // MLB team abbreviation (live drafts)
      pick,
      date,
    }
  ],
  standingsHistory: [ { label, finish } ],
}
```

**Key pattern:** `local-` prefix IDs = commissioner-added players with no Supabase account yet. UUID format = real Supabase users. Never delete local- players during DB sync.

---

## Season Object Shape

```js
{
  id, name, number, game, status,  // status: 'upcoming' | 'active' | 'completed'
  startDate,         // ISO date string — used for weekly date ranges and auto-advancement
  endDate,
  roster: [ { memberId, status } ],
  teamAssignments: { memberId: 'Full Team Name' },  // FULL NAMES not abbreviations
}
```

**Critical:** `teamAssignments` stores full team names (e.g. `"Baltimore Orioles"`), NOT abbreviations. The draft room saves abbreviations — always resolve via `DNA_CONFIG.mlbTeams` before writing to `teamAssignments`.

---

## Schedule Object Shape

```js
// generatedWeeks[]
{
  weekNum,
  matchups: [
    {
      home, away,    // player names
      result: {      // null until scanned/detected
        winner,      // player name
        homeScore, awayScore,
        potg: { name, stats },  // Player of the Game
        gameId,
        scannedAt,
      }
    }
  ],
  byes: [],          // player names with no matchup this week
  completed,         // boolean flag (fallback when no startDate)
}
```

---

## Cloudflare Worker Routes

Worker source: `worker.js` (deploy manually at dash.cloudflare.com/workers)

| Route | Description | Cache |
|-------|-------------|-------|
| `GET /teams` | Average OVR of top 5 Live Series cards per team | 1 hour |
| `GET /roster?team=LAD` | Top 5 Live Series players for a team | 1 hour |
| `GET /fa-roster?team=LAD&min=70&max=84` | All Live Series players for a team in OVR range, full attributes | 1 hour |
| `GET /history?username=X&platform=Y&page=1` | Player's Diamond Dynasty game history | 5 min |
| `GET /gamelog?id=X` | Full box score for a completed game | 24 hours |

Platform options: `psn`, `xbl`, `mlbts`, `nsw`

MLB The Show API base: `https://mlb26.theshow.com/apis`
Live Series series_id: `1337`
WSH in our app = `WAS` in the MLB API — handled by `TEAM_MAP` in worker.js

---

## MLB The Show 26 API Endpoints (via Worker)

| API | Path | Notes |
|-----|------|-------|
| Game History | `/apis/game_history.json` | Requires username, platform, mode |
| Game Log | `/apis/game_log.json` | Requires game id |
| Item | `/apis/item.json` | Requires uuid |
| Items | `/apis/items.json` | Paginated card list |
| Player Search | `/apis/player_search.json` | Requires username |
| Roster Update | `/apis/roster_update.json` | Requires id |
| Roster Updates | `/apis/roster_updates.json` | List of all updates |
| Meta Data | `/apis/meta_data.json` | Series, brands, sets |

---

## Key Patterns & Gotchas

- **Team abbreviations vs full names:** Draft room and player_search use abbreviations. Season `teamAssignments` and schedule dropdowns use full names. Always convert via `DNA_CONFIG.mlbTeams`.
- **Draft history type:** Entries with `seasonId` = live draft picks. Entries without = Draft Order Generator saves. Both coexist in `player.draftHistory`.
- **Weekly date math:** Week N starts at `startDate + (N-1)*7 days`. Always parse startDate as `new Date(startDate + 'T00:00:00')` to avoid UTC offset issues.
- **Auto week advancement:** Calculated from `Math.floor(daysSinceStart / 7)`. Falls back to `completed` flag if no startDate.
- **Local-only players excluded from League page** — they have no `league_members` DB row so role changes can't be saved.
- **`syncPlayersFromDB()` never wipes local players** — it only adds new DB users and updates name/color/role on existing ones. Stale UUID players (deleted accounts) are filtered out.
- **Commissioner controls gated by** `canManageSchedule()` in index.html and `DnaAuth.canManage()` / `DnaAuth.isAdmin()` in draft.html.
- **Commissioner cannot delete admin accounts** — guarded in both `deleteProfile()` and the UI.
- **`league_members.role` for admins** — admins have role `'admin'` in the DB. The `get_my_role(p_league_id uuid)` Supabase function must use the param name `p_league_id` (not `league_id`) or season delete RLS will fail.
- **`draft_picks.member_id` and `league_teams.mlb_team_id`** — both have `NOT NULL` dropped to support null picks and roster adds without full data.
- **`mlbTeamsLookup`** — must be loaded via `loadMlbTeamsLookup()` before `syncPlayersFromDB()` runs, so team abbreviations can be resolved for draft history entries.
- **FA draft entry:** `fa-draft.html?season=<id>` — linked from the season card Teams tab (commissioner+ only when teams are assigned). Config screen shown only to admin/commissioner if no FA draft exists yet.
- **FA draft player pool:** Loaded from Worker `/fa-roster` for each team in `league_teams` for the season. Pitcher cards include pitch repertoire (`pitch_arsenal` array). Trade return player selection matches position group (P→P, C→C, IF→IF, OF→OF), falling back to absolute lowest if same-group candidate is within 5 OVR of the drafted player.

---

## GitHub Workflow

```
feature branch → staging (auto-deploys on merge) → main (production)
```

- Always branch from `staging` (not `main`) for new features
- When pulling before starting a branch: `git pull origin staging`
- `gh` CLI is installed — invoke via `cmd.exe /c "gh ..."` from bash if not on PATH directly
- Commits include `Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>`

---

## Features Built (Chronological)

| Issue/Feature | Branch | Description |
|--------------|--------|-------------|
| #31 | `31-feature-auto-load-teams-into-create-season` | Auto-load team assignments from draft history. Fixed abbr→full name mismatch. |
| #32 | `32-feature-display-weekly-dates` | Weekly date ranges in schedule headers and home widget. Auto-advancement by date. |
| #33 | `33-feature-improve-mobile-draft-ui` | Mobile draft room tab bar (Teams / Draft Order). |
| — | `feature-gamertag-match-tracking` | Gamertag linking per player, auto match result scanning via game history API, Worker v3 (/history + /gamelog routes), League management page for role assignment. |
| — | `feature/supabase-draft` | Full Supabase integration: drafts/picks/seasons/league_teams write to DB; profile fields (gamertag, platform, stats) synced; draft history rebuilt from DB on sync; admin Reset Test Data button in League page danger zone. |
| — | `feature/fa-draft` | Standalone FA draft room (`fa-draft.html`). Reversed snake order from team draft, configurable rating range with tier buttons, full player attribute cards (hitting/pitching/pitch arsenal/quirks), CSV + printable trade checklist export. |

---

## Planned / Not Yet Built

- **Player search profile stats** — link gamertag to pull live W/L, ERA, BA from `player_search` API
- **Roster update tracker** — show card rating changes since draft day per team
- **Match box score display** — full inning-by-inning view from `game_log` (POTG is implemented; full box score is not)
- **Game history activity feed** — surface recent H2H games between members on home page

---

## Platform Notes

- Windows 11, shell: bash (Git Bash / WSL) — use Unix path syntax
- VSCode extension environment — file references should use markdown link format
- No build tooling — edits go directly to source files
- `gh` CLI is installed — invoke via `cmd.exe /c "gh ..."` from bash if not on PATH directly
