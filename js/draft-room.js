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

  let _timer        = null;   // setInterval handle
  let _timerSeconds = 0;      // current countdown value
  let _timerTotal   = 90;     // full duration for this draft

  let _isPaused     = false;
  let _isComplete   = false;

  // ── INIT ──────────────────────────────────────────────────
  function init(db, member) {
    _db     = db;
    _member = member;
  }

  // ── LOAD DRAFT FROM STATE ─────────────────────────────────
  function loadDraft(draft) {
    _draft        = draft;
    _timerTotal   = draft.timerSeconds || DNA_CONFIG.draft.defaultTimerSeconds;
    _timerSeconds = _timerTotal;
    _isPaused     = draft.status === 'paused';
    _isComplete   = draft.status === 'completed';
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

    // Persist draft state
    _saveDraftState();

    // Check if draft complete
    const remaining = _draft.slots.filter(s => !s.pickedTeam && !s.skipped);
    const skipped   = _draft.slots.filter(s => s.skipped && !s.pickedTeam);

    if (remaining.length === 0 && skipped.length === 0) {
      _completeDraft();
    } else if (remaining.length === 0 && skipped.length > 0) {
      // All non-skipped done — now handle skipped players in order
      _draft.status = 'skipped_picks';
      _saveDraftState();
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

  function undoLastPick() {
    if (!DnaAuth.isAdmin(_member)) return;
    const lastPicked = [..._draft.slots].reverse().find(s => s.pickedTeam);
    if (!lastPicked) { DraftUI.toast('No picks to undo'); return; }
    if (!confirm(`Undo ${lastPicked.memberName}'s pick of ${lastPicked.pickedTeam}?`)) return;
    _draft.availableTeams.push(lastPicked.pickedTeam);
    lastPicked.pickedTeam = null;
    lastPicked.pickedAt   = null;
    _removePickFromSeason(lastPicked.memberId);
    _broadcast({ type: 'undo', pickNumber: lastPicked.pickNumber });
    _saveDraftState();
    DraftBoard.render(_draft);
    DraftUI.renderAvailableTeams(_draft.availableTeams, _draft.teamRatings);
    resetTimer();
    startTimer();
    DraftUI.toast('Pick undone');
  }

  function overridePick(pickNumber, teamAbbr) {
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
    _saveDraftState();
    DraftBoard.render(_draft);
    DraftUI.renderAvailableTeams(_draft.availableTeams, _draft.teamRatings);
    DraftUI.toast('Pick overridden');
  }

  function pauseDraft() {
    if (!DnaAuth.isAdmin(_member)) return;
    _isPaused = true;
    _draft.status = 'paused';
    stopTimer();
    _saveDraftState();
    _broadcast({ type: 'pause' });
    DraftUI.updatePauseBtn(true);
    DraftUI.toast('Draft paused');
  }

  function resumeDraft() {
    if (!DnaAuth.isAdmin(_member)) return;
    _isPaused = false;
    _draft.status = 'active';
    _saveDraftState();
    _broadcast({ type: 'resume' });
    DraftUI.updatePauseBtn(false);
    startTimer();
    DraftUI.toast('Draft resumed');
  }

  function _completeDraft() {
    stopTimer();
    _isComplete = true;
    _draft.status = 'completed';
    _draft.completedAt = new Date().toISOString();
    _saveDraftState();
    _broadcast({ type: 'complete' });
    DraftUI.showRecap(_draft);
    DraftUI.toast('Draft complete! 🎉');
  }

  // ── SEASON AUTO-SAVE ──────────────────────────────────────
  function _savePickToSeason(memberId, teamAbbr) {
    if (!_draft.seasonId) return;
    try {
      const key = 'dna_seasons';
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const seasonState = JSON.parse(raw);
      const season = seasonState.seasons?.find(s => s.id === _draft.seasonId);
      if (!season) return;
      if (!season.teamAssignments) season.teamAssignments = {};
      season.teamAssignments[memberId] = teamAbbr;
      localStorage.setItem(key, JSON.stringify(seasonState));
    } catch(e) { console.error('season auto-save:', e); }
  }

  function _removePickFromSeason(memberId) {
    if (!_draft.seasonId) return;
    try {
      const key = 'dna_seasons';
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const seasonState = JSON.parse(raw);
      const season = seasonState.seasons?.find(s => s.id === _draft.seasonId);
      if (!season?.teamAssignments) return;
      delete season.teamAssignments[memberId];
      localStorage.setItem(key, JSON.stringify(seasonState));
    } catch(e) { console.error('season undo-save:', e); }
  }

  // ── PERSISTENCE ───────────────────────────────────────────
  function _saveDraftState() {
    try {
      localStorage.setItem('dna_live_draft', JSON.stringify(_draft));
    } catch(e) { console.error('draft save:', e); }
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
    init, loadDraft, loadSavedDraft, clearDraft,
    startTimer, stopTimer, resetTimer,
    canPick, makePick, undoLastPick, overridePick,
    pauseDraft, resumeDraft,
    subscribeRealtime, unsubscribeRealtime,
    getCurrentPick: _getCurrentPick,
    getNextPick:    _getNextPick,
    getDraft: () => _draft,
    isPaused: () => _isPaused,
    isComplete: () => _isComplete,
  };
})();