// ============================================================
// THE DNA LEAGUE — fa-draft-room.js
// Free Agent draft engine.
// Handles: config, snake order, player pool, picks, timer,
// Supabase Realtime sync, export generation.
// ============================================================

const FADraftRoom = (() => {

  // ── STATE ─────────────────────────────────────────────────
  let _db              = null;
  let _member          = null;
  let _draft           = null;   // full draft object
  let _realtimeChannel = null;
  let _playerPool      = [];     // all available players (loaded from Worker)
  let _pickedPlayerIds = new Set(); // track by "name|team" key
  let _tradeReturnPool = {};    // teamAbbr → low-OVR players for trade return suggestions
  let _memberTeamMap   = {};    // memberId → drafted team abbreviation

  let _timer        = null;
  let _timerSeconds = 0;
  let _timerTotal   = 120;

  let _isPaused  = false;
  let _isComplete = false;

  // ── HTML ESCAPE ───────────────────────────────────────────
  function _esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── INIT ──────────────────────────────────────────────────
  function init(db, member) {
    _db     = db;
    _member = member;
  }

  // ── DRAFT OBJECT SHAPE ────────────────────────────────────
  // _draft = {
  //   id, seasonId, name, status, timerSeconds,
  //   settings: { ratingMin, ratingMax, rounds },
  //   slots: [{ pickNumber, memberId, memberName, round,
  //             pickedPlayerName, pickedPlayerRating,
  //             pickedPlayerPos, pickedFromTeam,
  //             pickedAt, skipped, _dbId }],
  // }

  // ── LOAD FROM DB ──────────────────────────────────────────
  async function loadDraftFromDB(draftId) {
    const draftRes = await _db.from('drafts').select('*').eq('id', draftId).single();
    if (draftRes.error) throw new Error(draftRes.error.message);

    const slotsRes = await _db.from('draft_slots')
      .select('id, pick_number, member_id, skipped, league_members(display_name)')
      .eq('draft_id', draftId)
      .order('pick_number', { ascending: true });
    if (slotsRes.error) throw new Error(slotsRes.error.message);

    const picksRes = await _db.from('draft_picks')
      .select('id, slot_id, player_name, player_rating, mlb_team_id, picked_at')
      .eq('draft_id', draftId);
    if (picksRes.error) throw new Error(picksRes.error.message);

    const picksBySlot = {};
    (picksRes.data || []).forEach(p => { picksBySlot[p.slot_id] = p; });

    const d = draftRes.data;
    const settings = d.settings || {};

    const slots = (slotsRes.data || []).map(s => {
      const pick = picksBySlot[s.id];
      return {
        _dbId:             s.id,
        pickNumber:        s.pick_number,
        memberId:          s.member_id,
        memberName:        s.league_members?.display_name || 'Unknown',
        round:             Math.ceil(s.pick_number / _countMembers(slotsRes.data, d.settings?.rounds || 1)),
        skipped:           s.skipped || false,
        pickedPlayerName:  pick?.player_name   || null,
        pickedPlayerRating:pick?.player_rating || null,
        pickedPlayerPos:   null, // reconstructed from player pool on load
        pickedFromTeam:    pick ? _mlbTeamIdToAbbr(pick.mlb_team_id) : null,
        pickedAt:          pick?.picked_at || null,
      };
    });

    // Rebuild picked set
    _pickedPlayerIds.clear();
    slots.filter(s => s.pickedPlayerName && s.pickedFromTeam).forEach(s => {
      _pickedPlayerIds.add(`${s.pickedPlayerName}|${s.pickedFromTeam}`);
    });

    return {
      id:           d.id,
      seasonId:     d.season_id,
      name:         d.name || 'FA Draft',
      status:       d.status,
      timerSeconds: d.timer_seconds || 0,
      settings: {
        ratingMin: settings.ratingMin ?? 70,
        ratingMax: settings.ratingMax ?? 79,
        rounds:    settings.rounds    ?? 1,
      },
      slots,
    };
  }

  // Helper: count members from slots given rounds
  function _countMembers(slots, rounds) {
    return Math.round(slots.length / rounds) || slots.length;
  }

  // Will be set after mlbTeamsLookup is available
  let _mlbTeamsLookup = [];
  function setTeamsLookup(lookup) { _mlbTeamsLookup = lookup; }
  function _mlbTeamIdToAbbr(id) {
    if (!id) return '';
    const t = _mlbTeamsLookup.find(t => t.id === id);
    return t ? t.abbreviation : '';
  }
  function _mlbTeamAbbrToId(abbr) {
    const t = _mlbTeamsLookup.find(t => t.abbreviation === abbr);
    return t ? t.id : null;
  }

  function loadDraft(draft) {
    _draft        = draft;
    _timerTotal   = draft.timerSeconds || 0;
    _timerSeconds = _timerTotal;
    _isPaused     = draft.status === 'paused';
    _isComplete   = ['completed'].includes(draft.status);
  }

  // ── PLAYER POOL ───────────────────────────────────────────
  async function loadPlayerPool(teamAbbrs, ratingMin, ratingMax, workerUrl) {
    _playerPool = [];
    const results = await Promise.all(
      teamAbbrs.map(abbr =>
        fetch(`${workerUrl}/fa-roster?team=${abbr}&min=${ratingMin}&max=${ratingMax}`)
          .then(r => r.ok ? r.json() : { players: [] })
          .catch(() => ({ players: [] }))
      )
    );
    results.forEach((res, i) => {
      const abbr = teamAbbrs[i];
      (res.players || []).forEach(p => {
        _playerPool.push({ ...p, fromTeam: abbr });
      });
    });
    // Sort: highest overall first
    _playerPool.sort((a, b) => b.overall - a.overall);
    return _playerPool;
  }

  // Fetches ≤65 OVR players from each member's drafted team for trade return suggestions.
  // memberTeamMap: { memberId: teamAbbr }
  async function loadTradeReturnRosters(memberTeamMap, workerUrl) {
    _memberTeamMap   = memberTeamMap;
    _tradeReturnPool = {};
    const uniqueTeams = [...new Set(Object.values(memberTeamMap))].filter(Boolean);
    const results = await Promise.all(uniqueTeams.map(abbr =>
      fetch(`${workerUrl}/fa-roster?team=${abbr}&min=0&max=65`)
        .then(r => r.ok ? r.json() : { players: [] })
        .catch(() => ({ players: [] }))
    ));
    uniqueTeams.forEach((abbr, i) => {
      _tradeReturnPool[abbr] = (results[i].players || []).sort((a, b) => a.overall - b.overall);
    });
  }

  function getAvailablePlayers(posFilter) {
    return _playerPool.filter(p => {
      if (_pickedPlayerIds.has(`${p.name}|${p.fromTeam}`)) return false;
      if (posFilter && posFilter !== 'ALL') {
        const group = _posGroup(p.pos);
        if (group !== posFilter) return false;
      }
      return true;
    });
  }

  function _posGroup(pos) {
    if (['SP','RP','CP'].includes(pos)) return 'P';
    if (['C'].includes(pos))            return 'C';
    if (['1B','2B','3B','SS'].includes(pos)) return 'IF';
    if (['LF','CF','RF','DH'].includes(pos)) return 'OF';
    return 'OTHER';
  }

  // ── TIMER ─────────────────────────────────────────────────
  function startTimer() {
    if (!_timerTotal || _isPaused || _isComplete) return;
    stopTimer();
    _timerSeconds = _timerTotal;
    _renderTimer();
    _timer = setInterval(() => {
      if (_isPaused) return;
      _timerSeconds--;
      _renderTimer();
      if (_timerSeconds <= 0) {
        stopTimer();
        _onTimerExpired();
      }
    }, 1000);
  }

  function stopTimer() {
    if (_timer) { clearInterval(_timer); _timer = null; }
  }

  function resetTimer() {
    stopTimer();
    _timerSeconds = _timerTotal;
    _renderTimer();
  }

  function _renderTimer() {
    const el = document.getElementById('fa-timer-val');
    if (!el) return;
    if (!_timerTotal) { el.textContent = ''; el.className = 'fa-timer'; return; }
    const mins = Math.floor(_timerSeconds / 60);
    const secs = _timerSeconds % 60;
    el.textContent = `${mins}:${secs.toString().padStart(2,'0')}`;
    const pct = _timerSeconds / _timerTotal;
    el.className = 'fa-timer ' + (pct > 0.5 ? 'ok' : pct > 0.25 ? 'warning' : 'urgent');
  }

  async function _onTimerExpired() {
    if (!_draft) return;
    const cur = _getCurrentPick();
    if (!cur) return;
    faToast(`⏰ Time expired for ${cur.memberName} — skipping`);
    cur.skipped = true;
    await _saveSkipToDB(cur);
    _broadcast({ type: 'skip', pickNumber: cur.pickNumber });
    const remaining = _draft.slots.filter(s => !s.pickedPlayerName && !s.skipped);
    if (remaining.length === 0) {
      await _completeDraft();
    } else {
      _advancePick();
    }
    if (typeof renderDraftBoard === 'function') renderDraftBoard();
  }

  // ── PICK LOGIC ────────────────────────────────────────────
  function _getCurrentPick() {
    if (!_draft?.slots) return null;
    return _draft.slots.find(s => !s.pickedPlayerName && !s.skipped) || null;
  }

  function _getNextPick() {
    if (!_draft?.slots) return null;
    const active = _draft.slots.filter(s => !s.pickedPlayerName && !s.skipped);
    return active[1] || null;
  }

  function canPick(memberId) {
    const cur = _getCurrentPick();
    if (!cur) return false;
    if (cur.memberId === memberId) return true;
    if (_isAdminMember()) return true;
    return false;
  }

  function _isAdminMember() {
    return _member && ['admin','commissioner'].includes(_member.role);
  }

  async function makePick(player) {
    // player = { name, overall, pos, fromTeam, ...attrs }
    const cur = _getCurrentPick();
    if (!cur) { faToast('No active pick slot'); return; }
    if (cur.memberId !== _member?.id && !_isAdminMember()) {
      faToast("It's not your turn"); return;
    }
    if (cur.memberId !== _member?.id && _isAdminMember()) {
      if (!confirm(`Pick ${player.name} on behalf of ${cur.memberName}?`)) return;
    }
    const key = `${player.name}|${player.fromTeam}`;
    if (_pickedPlayerIds.has(key)) { faToast('Player already picked'); return; }

    cur.pickedPlayerName   = player.name;
    cur.pickedPlayerRating = player.overall;
    cur.pickedPlayerPos    = player.pos;
    cur.pickedFromTeam     = player.fromTeam;
    cur.pickedAt           = new Date().toISOString();
    _pickedPlayerIds.add(key);

    _broadcast({ type: 'pick', pickNumber: cur.pickNumber, playerName: player.name,
                 playerRating: player.overall, playerPos: player.pos, fromTeam: player.fromTeam });

    await _savePickToDB(cur, player);

    const remaining = _draft.slots.filter(s => !s.pickedPlayerName && !s.skipped);
    if (remaining.length === 0) {
      await _completeDraft();
    } else {
      _advancePick();
    }
    if (typeof renderDraftBoard === 'function') renderDraftBoard();
    if (typeof renderAvailablePlayers === 'function') renderAvailablePlayers();
  }

  function _advancePick() {
    resetTimer();
    startTimer();
    if (typeof updateOnClock === 'function') updateOnClock();
    if (typeof checkYourTurn === 'function') checkYourTurn();
    const next = _getCurrentPick();
    if (next) faToast(`Now on the clock: ${next.memberName}`);
  }

  async function _completeDraft() {
    stopTimer();
    _isComplete = true;
    _draft.status = 'completed';
    _draft.completedAt = new Date().toISOString();
    await _saveStatusToDB('completed', _draft.completedAt);
    _broadcast({ type: 'complete' });
    if (typeof updateOnClock === 'function') updateOnClock();
    if (typeof showRecap === 'function') showRecap();
    faToast('FA Draft complete! 🎉');
  }

  async function undoLastPick() {
    if (!_isAdminMember()) return;
    const lastPicked = [..._draft.slots].reverse().find(s => s.pickedPlayerName);
    if (!lastPicked) { faToast('No picks to undo'); return; }
    if (!confirm(`Undo ${lastPicked.memberName}'s pick of ${lastPicked.pickedPlayerName}?`)) return;
    const key = `${lastPicked.pickedPlayerName}|${lastPicked.pickedFromTeam}`;
    _pickedPlayerIds.delete(key);
    lastPicked.pickedPlayerName   = null;
    lastPicked.pickedPlayerRating = null;
    lastPicked.pickedPlayerPos    = null;
    lastPicked.pickedFromTeam     = null;
    lastPicked.pickedAt           = null;
    _broadcast({ type: 'undo', pickNumber: lastPicked.pickNumber });
    await _deletePickFromDB(lastPicked);
    if (typeof renderDraftBoard === 'function') renderDraftBoard();
    if (typeof renderAvailablePlayers === 'function') renderAvailablePlayers();
    resetTimer(); startTimer();
    faToast('Pick undone');
  }

  async function pauseDraft() {
    if (!_isAdminMember()) return;
    _isPaused = true;
    _draft.status = 'paused';
    stopTimer();
    await _saveStatusToDB('paused');
    _broadcast({ type: 'pause' });
    faToast('Draft paused');
    if (typeof updatePauseBtn === 'function') updatePauseBtn(true);
  }

  async function resumeDraft() {
    if (!_isAdminMember()) return;
    _isPaused = false;
    _draft.status = 'active';
    await _saveStatusToDB('active');
    _broadcast({ type: 'resume' });
    startTimer();
    faToast('Draft resumed');
    if (typeof updatePauseBtn === 'function') updatePauseBtn(false);
  }

  async function manualSkipCurrent() {
    if (!_isAdminMember()) return;
    const cur = _getCurrentPick();
    if (!cur) return;
    cur.skipped = true;
    await _saveSkipToDB(cur);
    _broadcast({ type: 'skip', pickNumber: cur.pickNumber });
    const remaining = _draft.slots.filter(s => !s.pickedPlayerName && !s.skipped);
    if (remaining.length === 0) {
      await _completeDraft();
    } else {
      _advancePick();
    }
    if (typeof renderDraftBoard === 'function') renderDraftBoard();
    faToast(`Skipped ${cur.memberName}`);
  }

  async function endDraftEarly() {
    if (!_isAdminMember()) return;
    if (!confirm('End the FA draft now? Remaining picks will be forfeited.')) return;
    await _completeDraft();
  }

  // ── EXPORT ────────────────────────────────────────────────
  // Requires loadTradeReturnRosters to have been called so _tradeReturnPool is populated.

  function getExportData() {
    if (!_draft) return [];
    return _draft.slots
      .filter(s => s.pickedPlayerName)
      .map(s => {
        const tradeReturn = _findTradeReturn(s);
        return {
          round:               s.round,
          pick:                s.pickNumber,
          playerName:          s.pickedPlayerName,
          playerOvr:           s.pickedPlayerRating,
          playerPos:           s.pickedPlayerPos || '',
          originalTeam:        s.pickedFromTeam  || '',
          draftedBy:           s.memberName,
          tradeReturnName:     tradeReturn?.name    || '—',
          tradeReturnOvr:      tradeReturn?.overall || '—',
          tradeReturnPos:      tradeReturn?.pos     || '—',
        };
      });
  }

  function _findTradeReturn(slot) {
    // Trade return comes from the receiving member's drafted team at low OVR (≤65).
    const teamAbbr = _memberTeamMap[slot.memberId];
    if (!teamAbbr) return null;
    const candidates = _tradeReturnPool[teamAbbr];
    if (!candidates || !candidates.length) return null;

    // candidates already sorted ascending by OVR
    const group = _posGroup(slot.pickedPlayerPos || '');

    const sameGroup = candidates.filter(p => _posGroup(p.pos) === group);
    if (sameGroup.length) return sameGroup[0];

    // Fallback: same broader group for position players
    if (group !== 'P') {
      const posPlayers = candidates.filter(p => _posGroup(p.pos) !== 'P');
      if (posPlayers.length) return posPlayers[0];
    }

    return candidates[0]; // absolute lowest
  }

  function downloadCSV() {
    const rows = getExportData();
    if (!rows.length) { faToast('No picks to export'); return; }
    const headers = ['Round','Pick','Player','OVR','Pos','Original Team','Drafted By','Trade Return','Return OVR','Return Pos'];
    const lines = [headers.join(',')];
    rows.forEach(r => {
      lines.push([
        r.round, r.pick,
        `"${r.playerName.replace(/"/g,'""')}"`, r.playerOvr, r.playerPos,
        r.originalTeam, `"${r.draftedBy.replace(/"/g,'""')}"`,
        `"${String(r.tradeReturnName).replace(/"/g,'""')}"`, r.tradeReturnOvr, r.tradeReturnPos,
      ].join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `fa-draft-${_draft.seasonId || 'results'}.csv`;
    a.click();
  }

  function openPrintChecklist() {
    const rows = getExportData();
    if (!rows.length) { faToast('No picks to export'); return; }

    // Group by original team
    const byTeam = {};
    rows.forEach(r => {
      if (!byTeam[r.originalTeam]) byTeam[r.originalTeam] = [];
      byTeam[r.originalTeam].push(r);
    });

    const tierColor = ovr => ovr >= 85 ? '#b9d4ff' : ovr >= 80 ? '#f5c542' : ovr >= 75 ? '#c0c0c0' : ovr >= 70 ? '#cd7f32' : '#a8bdd4';

    const teamSections = Object.keys(byTeam).sort().map(team => {
      const picks = byTeam[team];
      const tradeRows = picks.map((r, idx) => `
        <div class="trade-row" id="tr-${_esc(team)}-${idx}">
          <input type="checkbox" onchange="document.getElementById('tr-${_esc(team)}-${idx}').classList.toggle('done',this.checked);updateProgress()">
          <div class="trade-info">
            <div class="trade-player">
              <strong>${_esc(r.playerName)}</strong>
              <span class="ovr-badge" style="color:${tierColor(r.playerOvr)};border-color:${tierColor(r.playerOvr)}">${r.playerOvr}</span>
              <span class="pos">${_esc(r.playerPos)}</span>
              <span class="pick-num">Rd ${r.round}, Pick ${r.pick}</span>
            </div>
            <div class="trade-details">
              Drafted by: <strong>${_esc(r.draftedBy)}</strong>
              &nbsp;·&nbsp;
              Trade return: <strong style="color:#d94040">${_esc(r.tradeReturnName)}</strong>
              <span class="ovr-badge" style="color:#d94040;border-color:#d94040">${r.tradeReturnOvr}</span>
              <span class="pos">${_esc(r.tradeReturnPos)}</span>
            </div>
            <div class="trade-hint">Rejoin as ${_esc(team)} → trade ${_esc(r.playerName)} to ${_esc(r.draftedBy)}'s team</div>
          </div>
        </div>`).join('');
      return `<div class="team-section"><div class="team-header">${_esc(team)} &mdash; ${picks.length} trade${picks.length !== 1 ? 's' : ''}</div>${tradeRows}</div>`;
    }).join('');

    const total = rows.length;
    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>FA Draft Trade Checklist</title>
<style>
  body{font-family:Arial,sans-serif;background:#fff;color:#111;max-width:800px;margin:0 auto;padding:20px;}
  h1{font-size:22px;margin-bottom:4px;}
  .subtitle{color:#555;font-size:13px;margin-bottom:16px;}
  .instructions{background:#f0f4ff;border:1px solid #c0d0ff;border-radius:6px;padding:10px 14px;font-size:12px;margin-bottom:20px;}
  .team-section{margin-bottom:24px;}
  .team-header{font-size:14px;font-weight:700;border-bottom:2px solid #333;padding-bottom:4px;margin-bottom:10px;}
  .trade-row{display:flex;align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid #eee;}
  .trade-row.done{opacity:0.4;}
  .trade-row input{margin-top:4px;width:16px;height:16px;flex-shrink:0;}
  .trade-player{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:3px;}
  .ovr-badge{border:1px solid;border-radius:3px;padding:1px 5px;font-size:11px;font-weight:700;}
  .pos{color:#555;font-size:12px;}
  .pick-num{color:#888;font-size:11px;}
  .trade-details{font-size:12px;color:#555;margin-bottom:2px;}
  .trade-hint{font-size:11px;color:#888;font-style:italic;}
  .progress{background:#f5f5f5;border:1px solid #ddd;border-radius:6px;padding:8px 14px;display:flex;justify-content:space-between;font-size:13px;margin-top:20px;}
  @media print{.progress{position:fixed;bottom:0;left:0;right:0;border-radius:0;}}
</style>
</head><body>
<h1>FA Draft Trade Checklist</h1>
<div class="subtitle">Season Draft — ${total} trades to execute</div>
<div class="instructions"><strong>How to execute:</strong> For each trade, leave the league → rejoin as the <em>original team</em> → trade the drafted player to the new owner's team (receive the listed return player back).</div>
${teamSections}
<div class="progress"><span>Progress: <strong id="prog">0</strong> / ${total} trades</span></div>
<script>function updateProgress(){document.getElementById('prog').textContent=document.querySelectorAll('.trade-row.done').length;}<\/script>
</body></html>`;

    const w = window.open('', '_blank');
    w.document.write(html);
    w.document.close();
  }

  // ── PERSISTENCE ───────────────────────────────────────────
  async function _savePickToDB(slot, player) {
    const mlbTeamId = _mlbTeamAbbrToId(player.fromTeam);
    const res = await _db.from('draft_picks').insert({
      draft_id:     _draft.id,
      slot_id:      slot._dbId,
      member_id:    slot.memberId,
      pick_number:  slot.pickNumber,
      player_name:  player.name,
      player_rating:player.overall,
      mlb_team_id:  mlbTeamId || null,
      picked_at:    slot.pickedAt,
    });
    if (res.error) console.error('_savePickToDB:', res.error.message);
  }

  async function _saveSkipToDB(slot) {
    if (!slot._dbId) return;
    const res = await _db.from('draft_slots').update({ skipped: true }).eq('id', slot._dbId);
    if (res.error) console.error('_saveSkipToDB:', res.error.message);
  }

  async function _saveStatusToDB(status, completedAt) {
    const update = { status, paused: status === 'paused' };
    if (completedAt) update.completed_at = completedAt;
    const res = await _db.from('drafts').update(update).eq('id', _draft.id);
    if (res.error) console.error('_saveStatusToDB:', res.error.message);
  }

  async function _deletePickFromDB(slot) {
    const res = await _db.from('draft_picks').delete().eq('slot_id', slot._dbId);
    if (res.error) console.error('_deletePickFromDB:', res.error.message);
  }

  // ── REALTIME ──────────────────────────────────────────────
  function _broadcast(event) {
    if (!_realtimeChannel) return;
    _realtimeChannel.send({
      type: 'broadcast', event: 'fa_draft_event',
      payload: { ...event, draftId: _draft?.id, ts: Date.now() },
    }).catch(e => console.warn('broadcast error:', e));
  }

  function subscribeRealtime(draftId) {
    if (!_db) return;
    _realtimeChannel = _db.channel(`fa_draft:${draftId}`)
      .on('broadcast', { event: 'fa_draft_event' }, ({ payload }) => {
        _handleRemoteEvent(payload);
      })
      .subscribe();
  }

  function unsubscribeRealtime() {
    if (_realtimeChannel) { _db.removeChannel(_realtimeChannel); _realtimeChannel = null; }
  }

  function _handleRemoteEvent(payload) {
    if (!_draft || payload.ts <= (_draft._lastEventTs || 0)) return;
    _draft._lastEventTs = payload.ts;

    if (payload.type === 'pick') {
      const slot = _draft.slots.find(s => s.pickNumber === payload.pickNumber);
      if (slot && !slot.pickedPlayerName) {
        slot.pickedPlayerName   = payload.playerName;
        slot.pickedPlayerRating = payload.playerRating;
        slot.pickedPlayerPos    = payload.playerPos;
        slot.pickedFromTeam     = payload.fromTeam;
        slot.pickedAt           = new Date().toISOString();
        _pickedPlayerIds.add(`${payload.playerName}|${payload.fromTeam}`);
        _advancePick();
        if (typeof renderDraftBoard === 'function') renderDraftBoard();
        if (typeof renderAvailablePlayers === 'function') renderAvailablePlayers();
      }
    } else if (payload.type === 'skip') {
      const slot = _draft.slots.find(s => s.pickNumber === payload.pickNumber);
      if (slot) { slot.skipped = true; _advancePick(); if (typeof renderDraftBoard === 'function') renderDraftBoard(); }
    } else if (payload.type === 'undo') {
      const slot = _draft.slots.find(s => s.pickNumber === payload.pickNumber);
      if (slot) {
        const key = `${slot.pickedPlayerName}|${slot.pickedFromTeam}`;
        _pickedPlayerIds.delete(key);
        slot.pickedPlayerName = null; slot.pickedPlayerRating = null;
        slot.pickedPlayerPos = null; slot.pickedFromTeam = null; slot.pickedAt = null;
        if (typeof renderDraftBoard === 'function') renderDraftBoard();
        if (typeof renderAvailablePlayers === 'function') renderAvailablePlayers();
        resetTimer(); startTimer();
        if (typeof updateOnClock === 'function') updateOnClock();
        if (typeof checkYourTurn === 'function') checkYourTurn();
      }
    } else if (payload.type === 'pause') {
      _isPaused = true; _draft.status = 'paused'; stopTimer();
      if (typeof updatePauseBtn === 'function') updatePauseBtn(true);
    } else if (payload.type === 'resume') {
      _isPaused = false; _draft.status = 'active';
      startTimer();
      if (typeof updatePauseBtn === 'function') updatePauseBtn(false);
    } else if (payload.type === 'complete') {
      _isComplete = true; _draft.status = 'completed'; stopTimer();
      if (typeof updateOnClock === 'function') updateOnClock();
      if (typeof showRecap === 'function') showRecap();
    }
  }

  // ── PUBLIC API ────────────────────────────────────────────
  return {
    init, setTeamsLookup, loadDraftFromDB, loadDraft,
    loadPlayerPool, loadTradeReturnRosters, getAvailablePlayers,
    startTimer, stopTimer, resetTimer,
    canPick, makePick, undoLastPick,
    pauseDraft, resumeDraft, manualSkipCurrent, endDraftEarly,
    getCurrentPick: _getCurrentPick,
    getNextPick: _getNextPick,
    downloadCSV, openPrintChecklist, getExportData,
    subscribeRealtime, unsubscribeRealtime,
  };
})();
