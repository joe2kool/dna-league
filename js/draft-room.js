// ============================================================
// THE DNA LEAGUE — draft-room.js
// Live draft room engine.
// Handles: timer, pick board, team selection, commissioner
// controls, Supabase Realtime sync, auto-save to season.
// ============================================================

const DraftRoom = (() => {

  // ── STATE ─────────────────────────────────────────────────
  let _db           = null;
  let _member       = null;
  let _draft        = null;   // full draft object from localStorage/DB
  let _realtimeChannel = null;
  let _mlbTeamsLookup = []; // { id, name, abbreviation }

  let _timer        = null;   // setInterval handle
  let _timerSeconds = 0;      // current countdown value
  let _timerTotal   = 90;     // full duration for this draft

  let _isPaused     = false;
  let _isComplete   = false;

  // ── INIT ──────────────────────────────────────────────────
  function init(db, member, mlbTeamsLookup) {
    _db             = db;
    _member         = member;
    _mlbTeamsLookup = mlbTeamsLookup || [];
  }

  function _getMlbTeamId(teamAbbr) {
    const t = _mlbTeamsLookup.find(t => t.abbreviation === teamAbbr);
    return t ? t.id : null;
  }

  function _getMlbTeamAbbr(mlbTeamId) {
    const t = _mlbTeamsLookup.find(t => t.id === mlbTeamId);
    return t ? t.abbreviation : null;
  }

  // ── LOAD DRAFT FROM STATE ─────────────────────────────────
  function loadDraft(draft) {
    _draft        = draft;
    _timerTotal   = draft.timerSeconds || DNA_CONFIG.draft.defaultTimerSeconds;
    _timerSeconds = _timerTotal;
    _isPaused     = draft.status === 'paused';
    _isComplete   = draft.status === 'completed';
  }

  async function loadDraftFromDB(draftId) {
    if (!_db) return null;

    const draftRes = await _db.from('drafts').select('*').eq('id', draftId).single();
    if (draftRes.error) { console.error('loadDraftFromDB drafts:', draftRes.error.message); return null; }

    const slotsRes = await _db.from('draft_slots')
      .select('*')
      .eq('draft_id', draftId)
      .order('pick_number', { ascending: true });
    if (slotsRes.error) { console.error('loadDraftFromDB slots:', slotsRes.error.message); return null; }

    const picksRes = await _db.from('draft_picks')
      .select('*')
      .eq('draft_id', draftId);
    if (picksRes.error) { console.error('loadDraftFromDB picks:', picksRes.error.message); return null; }

    // Build a map of slot_id → pick for fast lookup
    const picksMap = {};
    (picksRes.data || []).forEach(p => { picksMap[p.slot_id] = p; });

    const slots = (slotsRes.data || []).map(s => {
      const pick = picksMap[s.id];
      return {
        _dbId:      s.id,
        pickNumber: s.pick_number,
        memberId:   s.member_id,
        memberName: s.member_name,
        color:      s.color || '#6a9ec7',
        skipped:    s.skipped || false,
        pickedTeam: pick ? _getMlbTeamAbbr(pick.mlb_team_id) : null,
        pickedAt:   pick ? pick.picked_at : null,
      };
    });

    // availableTeams = all 30 teams minus those already picked
    const pickedAbbrs = slots.filter(s => s.pickedTeam).map(s => s.pickedTeam);
    const availableTeams = DNA_CONFIG.mlbTeams.map(t => t.abbr).filter(a => !pickedAbbrs.includes(a));

    const d = draftRes.data;
    return {
      id:           d.id,
      name:         d.name,
      seasonId:     d.season_id,
      status:       d.status,
      timerSeconds: d.timer_seconds || DNA_CONFIG.draft.defaultTimerSeconds,
      slots,
      availableTeams,
      teamRatings:  {}, // populated in boot() after DnaRatings.getTeamRatings()
      createdAt:    d.created_at,
      completedAt:  null,
    };
  }

  // ── TIMER ─────────────────────────────────────────────────
  function startTimer() {
    stopTimer();
    if (_isPaused || _isComplete) return;
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
    const el = document.getElementById('dr-timer-val');
    const ring = document.getElementById('dr-timer-ring');
    if (!el) return;
    const mins = Math.floor(_timerSeconds / 60);
    const secs = _timerSeconds % 60;
    el.textContent = `${mins}:${secs.toString().padStart(2,'0')}`;
    // Color shifts: green → gold → red
    const pct = _timerSeconds / _timerTotal;
    el.style.color = pct > 0.5 ? 'var(--green)' : pct > 0.25 ? 'var(--gold)' : 'var(--red)';
    // SVG ring progress
    if (ring) {
      const circ = 2 * Math.PI * 44; // r=44
      ring.style.strokeDashoffset = circ * (1 - pct);
      ring.style.stroke = pct > 0.5 ? 'var(--green)' : pct > 0.25 ? 'var(--gold)' : 'var(--red)';
    }
    // Warning pulse when under 15s
    const wrap = document.getElementById('dr-timer-wrap');
    if (wrap) wrap.classList.toggle('timer-warning', _timerSeconds <= 15 && _timerSeconds > 0);
  }

  function _onTimerExpired() {
    if (!_draft) return;
    const cur = _getCurrentPick();
    if (!cur) return;

    // Show a toast — if commissioner is present they can confirm skip or reset
    // Auto-skip only happens after a grace period if no action is taken
    DraftUI.toast(`⏰ Time expired for ${cur.memberName}!`, 5000);

    // Show skip confirmation banner if commissioner is watching
    if (DnaAuth.isAdmin(_member)) {
      if (confirm(`Time expired for ${cur.memberName}.\n\nSkip them (they can pick later)?\n\nPress Cancel to reset their timer instead.`)) {
        cur.skipped = true;
        _draft.slots[_draft.slots.indexOf(cur)] = cur;
        _saveDraftState();
        _advancePick();
        DraftBoard.render(_draft);
        _broadcast({ type: 'skip', pickNumber: cur.pickNumber, memberName: cur.memberName });
      } else {
        // Reset timer — give them another full duration
        startTimer();
        DraftUI.toast(`Timer reset for ${cur.memberName}`);
      }
    } else {
      // Non-commissioner view — just notify, commissioner handles it
      DraftUI.toast(`Waiting for commissioner to advance the draft...`, 8000);
    }
  }

  // ── PICK LOGIC ────────────────────────────────────────────
  // Normal pick: first non-picked, non-skipped slot
  // Skipped pick mode: first skipped slot that still hasn't picked
  function _getCurrentPick() {
    if (!_draft?.slots) return null;
    if (_draft.status === 'skipped_picks') {
      // Allow skipped players to pick in their original order
      return _draft.slots.find(s => s.skipped && !s.pickedTeam) || null;
    }
    return _draft.slots.find(s => !s.pickedTeam && !s.skipped) || null;
  }

  function _getNextPick() {
    if (!_draft?.slots) return null;
    if (_draft.status === 'skipped_picks') {
      const skipped = _draft.slots.filter(s => s.skipped && !s.pickedTeam);
      return skipped[1] || null;
    }
    const active = _draft.slots.filter(s => !s.pickedTeam && !s.skipped);
    return active[1] || null;
  }

  function canPick(memberId) {
    const cur = _getCurrentPick();
    if (!cur) return false;
    // The on-clock player can always pick
    if (cur.memberId === memberId) return true;
    // Commissioner/admin can pick for anyone (override)
    if (DnaAuth.isAdmin(_member)) return true;
    return false;
  }

  async function makePick(teamAbbr) {
    // Close the team detail panel if open
    const panel = document.getElementById('dr-team-detail');
    if (panel) panel.style.display = 'none';
    const cur = _getCurrentPick();
    if (!cur) {
      DraftUI.toast('No active pick slot');
      return;
    }
    // Commissioner picking for someone else — require confirmation
    if (cur.memberId !== _member?.id && DnaAuth.isAdmin(_member)) {
      if (!confirm(`Pick ${teamAbbr} on behalf of ${cur.memberName}?`)) return;
    } else if (!canPick(_member?.id)) {
      DraftUI.toast('It\'s not your turn');
      return;
    }
    if (!_draft.availableTeams.includes(teamAbbr)) {
      DraftUI.toast('That team is not available');
      return;
    }

    // Apply pick
    cur.pickedTeam = teamAbbr;
    cur.pickedAt   = new Date().toISOString();
    cur.skipped    = false; // clear skip flag if they were skipped
    _draft.availableTeams = _draft.availableTeams.filter(t => t !== teamAbbr);

    // Auto-save to season team assignments
    _savePickToSeason(cur.memberId, teamAbbr);

    // Broadcast to all
    _broadcast({ type: 'pick', pickNumber: cur.pickNumber, memberId: cur.memberId, teamAbbr });

    // Persist pick to Supabase
    await _savePickToDB(cur, teamAbbr);

    // Check if draft complete
    const remaining = _draft.slots.filter(s => !s.pickedTeam && !s.skipped);
    const skipped   = _draft.slots.filter(s => s.skipped && !s.pickedTeam);

    if (remaining.length === 0 && skipped.length === 0) {
      _completeDraft();
    } else if (remaining.length === 0 && skipped.length > 0) {
      // All non-skipped done — now handle skipped players in order
      _draft.status = 'skipped_picks';
      await _saveStatusToDB('skipped_picks');
      stopTimer(); // no timer pressure for skipped picks
      DraftUI.updatePauseBtn(false);
      DraftUI.toast(`Main draft complete! ${skipped.length} skipped player(s) may now pick.`);
      const nextSkipped = _getCurrentPick();
      if (nextSkipped) {
        document.getElementById('dr-on-clock-name').textContent = nextSkipped.memberName + ' (skipped)';
        if (nextSkipped.memberId === _member?.id || DnaAuth.isAdmin(_member)) {
          DraftUI.showYourTurnBanner();
        }
      }
    } else if (_draft.status === 'skipped_picks') {
      // Another skipped player just picked — check if all done
      const stillSkipped = _draft.slots.filter(s => s.skipped && !s.pickedTeam);
      if (stillSkipped.length === 0) {
        _completeDraft();
      } else {
        DraftBoard.render(_draft);
        DraftUI.renderAvailableTeams(_draft.availableTeams, _draft.teamRatings);
        updateOnClock();
        return;
      }
    } else {
      _advancePick();
    }

    DraftBoard.render(_draft);
    DraftUI.renderAvailableTeams(_draft.availableTeams, _draft.teamRatings);
  }

  function _advancePick() {
    resetTimer();
    startTimer();
    const next = _getCurrentPick();
    if (next) {
      DraftUI.toast(`Now on the clock: ${next.memberName}`);
      // Highlight if it's the current user's turn
      if (next.memberId === _member?.id) {
        DraftUI.showYourTurnBanner();
      } else {
        DraftUI.hideYourTurnBanner();
      }
    }
  }

  async function undoLastPick() {
    if (!DnaAuth.isAdmin(_member)) return;
    const lastPicked = [..._draft.slots].reverse().find(s => s.pickedTeam);
    if (!lastPicked) { DraftUI.toast('No picks to undo'); return; }
    if (!confirm(`Undo ${lastPicked.memberName}'s pick of ${lastPicked.pickedTeam}?`)) return;
    const undoTeamAbbr = lastPicked.pickedTeam;
    _draft.availableTeams.push(undoTeamAbbr);
    lastPicked.pickedTeam = null;
    lastPicked.pickedAt   = null;
    _removePickFromSeason(lastPicked.memberId);
    _broadcast({ type: 'undo', pickNumber: lastPicked.pickNumber, teamAbbr: undoTeamAbbr });
    await _deletePickFromDB(lastPicked);
    DraftBoard.render(_draft);
    DraftUI.renderAvailableTeams(_draft.availableTeams, _draft.teamRatings);
    resetTimer();
    startTimer();
    DraftUI.toast('Pick undone');
  }

  async function overridePick(pickNumber, teamAbbr) {
    if (!DnaAuth.isAdmin(_member)) return;
    const slot = _draft.slots.find(s => s.pickNumber === pickNumber);
    if (!slot) return;
    // Release old team back to pool
    if (slot.pickedTeam) _draft.availableTeams.push(slot.pickedTeam);
    slot.pickedTeam = teamAbbr;
    slot.pickedAt   = new Date().toISOString();
    _draft.availableTeams = _draft.availableTeams.filter(t => t !== teamAbbr);
    _savePickToSeason(slot.memberId, teamAbbr);
    _broadcast({ type: 'override', pickNumber, teamAbbr });
    await _deletePickFromDB(slot);
    await _savePickToDB(slot, teamAbbr);
    DraftBoard.render(_draft);
    DraftUI.renderAvailableTeams(_draft.availableTeams, _draft.teamRatings);
    DraftUI.toast('Pick overridden');
  }

  async function pauseDraft() {
    if (!DnaAuth.isAdmin(_member)) return;
    _isPaused = true;
    _draft.status = 'paused';
    stopTimer();
    await _saveStatusToDB('paused');
    _broadcast({ type: 'pause' });
    DraftUI.updatePauseBtn(true);
    DraftUI.toast('Draft paused');
  }

  async function resumeDraft() {
    if (!DnaAuth.isAdmin(_member)) return;
    _isPaused = false;
    _draft.status = 'active';
    await _saveStatusToDB('active');
    _broadcast({ type: 'resume' });
    DraftUI.updatePauseBtn(false);
    startTimer();
    DraftUI.toast('Draft resumed');
  }

  async function _completeDraft() {
    stopTimer();
    _isComplete = true;
    _draft.status = 'completed';
    _draft.completedAt = new Date().toISOString();
    await _saveStatusToDB('completed', _draft.completedAt);
    _broadcast({ type: 'complete' });

    // Save draft recap to league state so it shows in activity log
    try {
      const raw = localStorage.getItem('dna_league');
      if (raw) {
        const leagueState = JSON.parse(raw);
        leagueState.draftsGenerated = (leagueState.draftsGenerated || 0) + 1;
        if (!leagueState.activityLog) leagueState.activityLog = [];
        const picks = _draft.slots.filter(s => s.pickedTeam).length;
        leagueState.activityLog.unshift({
          text: `Team Draft completed — ${picks} picks made`,
          time: new Date().toLocaleTimeString(),
          date: new Date().toLocaleDateString(),
        });
        localStorage.setItem('dna_league', JSON.stringify(leagueState));
      }
    } catch(e) { console.error('draft completion save:', e); }

    DraftUI.showRecap(_draft);
    DraftUI.toast('Draft complete! 🎉');
  }

  // ── SEASON AUTO-SAVE ──────────────────────────────────────
  async function _savePickToSeason(memberId, teamAbbr) {
    if (!_draft.seasonId) {
      console.warn('Draft has no seasonId — pick not saved to season');
    } else {
      // Update league_teams with the picked mlb_team_id
      const mlbTeamId = _getMlbTeamId(teamAbbr);
      if (mlbTeamId) {
        const res = await _db.from('league_teams')
          .update({ mlb_team_id: mlbTeamId })
          .eq('season_id', _draft.seasonId)
          .eq('member_id', memberId);
        if (res.error) console.error('_savePickToSeason league_teams:', res.error.message);
      }
    }

    // Update player draft history in dna_league localStorage (stays local for now)
    try {
      const leagueRaw = localStorage.getItem('dna_league');
      if (leagueRaw) {
        const leagueState = JSON.parse(leagueRaw);
        const player = (leagueState.players || []).find(p => p.id === memberId);
        if (player) {
          if (!player.draftHistory) player.draftHistory = [];
          const pickNumber = _draft.slots.find(s => s.memberId === memberId)?.pickNumber;
          const today = new Date().toLocaleDateString();
          const existingLive = _draft.seasonId
            ? player.draftHistory.find(d => d.type === 'live' && d.seasonId === _draft.seasonId)
            : null;
          if (existingLive) {
            existingLive.team = teamAbbr;
            existingLive.pick = pickNumber;
            existingLive.date = today;
          } else {
            player.draftHistory.unshift({
              type:       'live',
              seasonId:   _draft.seasonId,
              seasonName: _draft.seasonName || 'Draft',
              team:       teamAbbr,
              pick:       pickNumber,
              date:       today,
            });
          }
          localStorage.setItem('dna_league', JSON.stringify(leagueState));
        }
      }
    } catch(e) { console.error('draft history save:', e); }
  }

  async function _removePickFromSeason(memberId) {
    if (!_draft.seasonId) return;
    const res = await _db.from('league_teams')
      .update({ mlb_team_id: null })
      .eq('season_id', _draft.seasonId)
      .eq('member_id', memberId);
    if (res.error) console.error('_removePickFromSeason:', res.error.message);
  }

  // ── PERSISTENCE ───────────────────────────────────────────
  async function _savePickToDB(slot, teamAbbr) {
    if (!_db || !_draft) return;
    const mlbTeamId = _getMlbTeamId(teamAbbr);
    if (!mlbTeamId) { console.error('_savePickToDB: unknown team', teamAbbr); return; }
    const res = await _db.from('draft_picks').insert({
      draft_id:    _draft.id,
      slot_id:     slot._dbId,
      member_id:   slot.memberId,
      pick_number: slot.pickNumber,
      mlb_team_id: mlbTeamId,
      picked_at:   slot.pickedAt,
    });
    if (res.error) console.error('_savePickToDB:', res.error.message);
  }

  async function _saveSkipToDB(slot) {
    if (!_db || !slot._dbId) return;
    const res = await _db.from('draft_slots')
      .update({ skipped: true })
      .eq('id', slot._dbId);
    if (res.error) console.error('_saveSkipToDB:', res.error.message);
  }

  async function _saveStatusToDB(status, completedAt) {
    if (!_db || !_draft) return;
    const update = { status, paused: status === 'paused' };
    if (completedAt) update.completed_at = completedAt;
    const res = await _db.from('drafts').update(update).eq('id', _draft.id);
    if (res.error) console.error('_saveStatusToDB:', res.error.message);
  }

  async function _deletePickFromDB(slot) {
    if (!_db || !slot._dbId) return;
    const res = await _db.from('draft_picks').delete().eq('slot_id', slot._dbId);
    if (res.error) console.error('_deletePickFromDB:', res.error.message);
  }

  function _saveDraftState() {
    // Draft state now persisted to Supabase — no localStorage write needed
  }

  function loadSavedDraft() {
    try {
      const raw = localStorage.getItem('dna_live_draft');
      return raw ? JSON.parse(raw) : null;
    } catch(e) { return null; }
  }

  function clearDraft() {
    localStorage.removeItem('dna_live_draft');
    _draft = null;
    stopTimer();
  }

  // ── SUPABASE REALTIME ─────────────────────────────────────
  function _broadcast(event) {
    if (!_realtimeChannel) return;
    _realtimeChannel.send({
      type:    'broadcast',
      event:   'draft_event',
      payload: { ...event, draftId: _draft?.id, ts: Date.now() },
    }).catch(e => console.warn('broadcast error:', e));
  }

  function subscribeRealtime(draftId) {
    if (!_db) return;
    _realtimeChannel = _db.channel(`draft:${draftId}`)
      .on('broadcast', { event: 'draft_event' }, ({ payload }) => {
        _handleRemoteEvent(payload);
      })
      .subscribe();
  }

  function unsubscribeRealtime() {
    if (_realtimeChannel) {
      _db.removeChannel(_realtimeChannel);
      _realtimeChannel = null;
    }
  }

  function _handleRemoteEvent(payload) {
    if (!_draft) return;
    switch (payload.type) {
      case 'pick':
        const slot = _draft.slots.find(s => s.pickNumber === payload.pickNumber);
        if (slot && !slot.pickedTeam) {
          slot.pickedTeam = payload.teamAbbr;
          slot.pickedAt   = new Date().toISOString();
          _draft.availableTeams = _draft.availableTeams.filter(t => t !== payload.teamAbbr);
          _savePickToSeason(payload.memberId, payload.teamAbbr);
          DraftBoard.render(_draft);
          DraftUI.renderAvailableTeams(_draft.availableTeams, _draft.teamRatings);
          _advancePick();
        }
        break;
      case 'pause':
        _isPaused = true; stopTimer();
        DraftUI.updatePauseBtn(true);
        DraftUI.toast('Commissioner paused the draft');
        break;
      case 'resume':
        _isPaused = false; startTimer();
        DraftUI.updatePauseBtn(false);
        DraftUI.toast('Draft resumed');
        break;
      case 'undo':
        // Re-fetch fresh state on undo
        const s2 = loadSavedDraft();
        if (s2) { _draft = s2; DraftBoard.render(_draft); DraftUI.renderAvailableTeams(_draft.availableTeams, _draft.teamRatings); }
        break;
      case 'skip':
        DraftUI.toast(`${payload.memberName || 'A player'} was skipped`);
        DraftBoard.render(_draft);
        break;
      case 'complete':
        stopTimer();
        _isComplete = true;
        DraftUI.showRecap(_draft);
        break;
    }
  }

  // ── PUBLIC API ────────────────────────────────────────────
  return {
    init, loadDraft, loadSavedDraft, loadDraftFromDB, clearDraft,
    startTimer, stopTimer, resetTimer,
    canPick, makePick, undoLastPick, overridePick,
    pauseDraft, resumeDraft,
    saveSkip:   _saveSkipToDB,
    saveStatus: _saveStatusToDB,
    broadcast:  _broadcast,
    subscribeRealtime, unsubscribeRealtime,
    getCurrentPick: _getCurrentPick,
    getNextPick:    _getNextPick,
    getDraft: () => _draft,
    isPaused: () => _isPaused,
    isComplete: () => _isComplete,
  };
})();