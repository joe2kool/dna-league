// ============================================================
// THE DNA LEAGUE — draft-board.js
// Renders the live pick board and available teams panel.
// Separated from logic so UI can be restyled independently.
// ============================================================

// ── DRAFT BOARD ───────────────────────────────────────────
const DraftBoard = (() => {

  function render(draft) {
    const el = document.getElementById('dr-board');
    if (!el || !draft?.slots) return;

    const currentPick = draft.slots.find(s => !s.pickedTeam && !s.skipped);
    const nextPick    = draft.slots.filter(s => !s.pickedTeam && !s.skipped)[1];

    el.innerHTML = draft.slots.map((slot, i) => {
      const isCurrent  = currentPick && slot.pickNumber === currentPick.pickNumber;
      const isNext     = nextPick    && slot.pickNumber === nextPick.pickNumber;
      const isPicked   = !!slot.pickedTeam;
      const isSkipped  = slot.skipped && !slot.pickedTeam;

      let rowClass = 'board-row';
      if (isCurrent) rowClass += ' board-row--current';
      if (isPicked)  rowClass += ' board-row--picked';
      if (isSkipped) rowClass += ' board-row--skipped';

      const teamInfo = isPicked
        ? DNA_CONFIG.mlbTeams.find(t => t.abbr === slot.pickedTeam)
        : null;

      return `
        <div class="${rowClass}" id="board-row-${slot.pickNumber}">
          <div class="board-pick-num">${slot.pickNumber}</div>
          <div class="board-avatar" style="background:${slot.color || '#6a9ec7'}">
            ${(slot.memberName || '?').slice(0,2).toUpperCase()}
          </div>
          <div class="board-member">
            <div class="board-member-name">${escHtml(slot.memberName || 'Unknown')}</div>
            ${isCurrent ? '<div class="board-on-clock">ON THE CLOCK ⏱</div>' : ''}
            ${isNext    ? '<div class="board-up-next">UP NEXT</div>'  : ''}
            ${isSkipped ? '<div class="board-skipped">SKIPPED — can pick anytime</div>' : ''}
          </div>
          <div class="board-pick">
            ${isPicked
              ? `<div class="board-picked-team">
                   <span class="board-team-abbr">${teamInfo?.abbr || slot.pickedTeam}</span>
                   <span class="board-team-name">${teamInfo?.name || slot.pickedTeam}</span>
                 </div>`
              : isCurrent
                ? `<div class="board-pending">Picking...</div>`
                : `<div class="board-pending board-pending--dim">Waiting</div>`
            }
          </div>
        </div>`;
    }).join('');
  }

  return { render };
})();

// ── DRAFT UI HELPERS ──────────────────────────────────────
const DraftUI = (() => {

  // Toast notification
  function toast(msg, duration = 3000) {
    const el = document.getElementById('dr-toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('show'), duration);
  }

  // Render available teams grid with ratings
  function renderAvailableTeams(available, teamRatings) {
    const el = document.getElementById('dr-teams-grid');
    if (!el) return;

    if (!available.length) {
      el.innerHTML = '<div class="dr-teams-empty">All teams have been drafted</div>';
      return;
    }

    // Sort by overall rating descending
    const sorted = [...available].sort((a, b) => {
      const ra = teamRatings?.[a]?.overall || 0;
      const rb = teamRatings?.[b]?.overall || 0;
      return rb - ra;
    });

    el.innerHTML = sorted.map(abbr => {
      const info   = DNA_CONFIG.mlbTeams.find(t => t.abbr === abbr) || { name: abbr, abbr };
      const rating = teamRatings?.[abbr] || {};
      const ovr    = rating.overall || '—';
      const ovrColor = ovr >= 88 ? 'var(--green)' : ovr >= 82 ? 'var(--gold)' : 'var(--text2)';

      return `
        <div class="team-card" onclick="DraftRoom.makePick('${abbr}')" id="tc-${abbr}" title="${info.name}">
          <div class="team-card-abbr">${abbr}</div>
          <div class="team-card-name">${escHtml(info.name)}</div>
          <div class="team-card-ovr" style="color:${ovrColor}">${ovr}</div>
          <div class="team-card-league">${info.league || ''} ${info.division || ''}</div>
          <div class="team-card-breakdown" id="tcb-${abbr}">
            <span class="team-card-breakdown-loading">loading...</span>
          </div>
          <button type="button" class="team-card-btn" onclick="event.stopPropagation();DraftUI.showTeamDetail('${abbr}')">
            Top 5 ▸
          </button>
        </div>`;
    }).join('');
  }

  // Team detail panel (top 5 players)
  async function showTeamDetail(abbr) {
    const panel = document.getElementById('dr-team-detail');
    if (!panel) return;

    panel.innerHTML = `<div class="dr-detail-loading">Loading roster...</div>`;
    panel.style.display = '';

    const info    = DNA_CONFIG.mlbTeams.find(t => t.abbr === abbr) || { name: abbr };
    const roster  = await DnaRatings.getTeamRoster(abbr);

    panel.innerHTML = `
      <div class="dr-detail-header">
        <div>
          <div class="dr-detail-abbr">${abbr}</div>
          <div class="dr-detail-team">${escHtml(info.name)}</div>
          <div class="dr-detail-meta">${info.league} · ${info.division}</div>
        </div>
        <button type="button" class="btn btn-ghost" onclick="document.getElementById('dr-team-detail').style.display='none'">✕</button>
      </div>
      <div class="dr-detail-title">Top Players</div>
      ${roster.length
        ? roster.map((p, i) => `
          <div class="dr-player-row">
            <span class="dr-player-rank">${i + 1}</span>
            <div class="dr-player-info">
              <span class="dr-player-name">${escHtml(p.name)}</span>
              <span class="dr-player-pos">${p.pos}</span>
              ${p.series ? `<span class="dr-player-series">${escHtml(p.series)}</span>` : ''}
            </div>
            <span class="dr-player-ovr" style="color:${p.overall >= 90 ? 'var(--green)' : p.overall >= 82 ? 'var(--gold)' : 'var(--text2)'}">${p.overall}</span>
          </div>`).join('')
        : '<div class="dr-detail-loading">No player data available</div>'
      }
      <button type="button" class="btn btn-gold" style="width:100%;justify-content:center;margin-top:1rem;"
        onclick="DraftRoom.makePick('${abbr}')">
        Draft ${abbr}
      </button>`;
  }

  function updatePauseBtn(paused) {
    const btn = document.getElementById('dr-pause-btn');
    if (!btn) return;
    btn.textContent = paused ? '▶ Resume Draft' : '⏸ Pause Draft';
    btn.style.color = paused ? 'var(--green)' : 'var(--gold)';
  }

  function showYourTurnBanner() {
    const el = document.getElementById('dr-your-turn');
    if (el) { el.style.display = ''; el.classList.add('pulse'); }
    const panel = document.getElementById('dr-pick-panel');
    if (panel) panel.style.display = '';
  }

  function hideYourTurnBanner() {
    const el = document.getElementById('dr-your-turn');
    if (el) { el.style.display = 'none'; el.classList.remove('pulse'); }
  }

  function showRecap(draft) {
    const el = document.getElementById('dr-recap');
    if (!el) return;

    el.style.display = '';
    document.getElementById('dr-pick-panel').style.display  = 'none';
    document.getElementById('dr-your-turn').style.display   = 'none';

    const picks = draft.slots.filter(s => s.pickedTeam).sort((a,b) => a.pickNumber - b.pickNumber);

    el.innerHTML = `
      <div class="recap-header">
        <div class="recap-title">Draft Complete 🏆</div>
        <div class="recap-sub">${picks.length} of ${draft.slots.length} teams drafted · ${new Date(draft.completedAt || Date.now()).toLocaleString()}</div>
      </div>
      <div class="recap-grid">
        ${picks.map(slot => {
          const team = DNA_CONFIG.mlbTeams.find(t => t.abbr === slot.pickedTeam) || { name: slot.pickedTeam, abbr: slot.pickedTeam };
          const rating = draft.teamRatings?.[slot.pickedTeam]?.overall;
          return `
            <div class="recap-row">
              <div class="recap-pick">#${slot.pickNumber}</div>
              <div class="recap-avatar" style="background:${slot.color || '#6a9ec7'}">
                ${(slot.memberName || '?').slice(0,2).toUpperCase()}
              </div>
              <div class="recap-member">${escHtml(slot.memberName)}</div>
              <div class="recap-arrow">→</div>
              <div class="recap-team">
                <span class="recap-abbr">${team.abbr}</span>
                <span class="recap-tname">${escHtml(team.name)}</span>
              </div>
              ${rating ? `<div class="recap-ovr">${rating}</div>` : ''}
            </div>`;
        }).join('')}
      </div>
      <div style="display:flex;gap:10px;justify-content:center;margin-top:1.5rem;flex-wrap:wrap;">
        <button type="button" class="btn btn-gold" onclick="window.location.href='index.html'">Back to League</button>
        <button type="button" class="btn btn-outline" onclick="exportRecapPNG(DraftRoom.getDraft())">Download Recap PNG</button>
      </div>`;
  }

  function updateTeamCardBreakdown(abbr, breakdown) {
    const el = document.getElementById('tcb-' + abbr);
    if (!el) return;
    function fmt(val) { return val != null ? val : '—'; }
    el.innerHTML = `
      <div class="tcb-group">
        <span class="tcb-label">Pitching</span>
        <span class="tcb-badge tcb-green">SP ${fmt(breakdown?.sp)}</span>
        <span class="tcb-badge tcb-green">RP ${fmt(breakdown?.rp)}</span>
      </div>
      <div class="tcb-group">
        <span class="tcb-label">Hitting</span>
        <span class="tcb-badge tcb-gold">PWR ${fmt(breakdown?.power)}</span>
        <span class="tcb-badge tcb-gold">CON ${fmt(breakdown?.contact)}</span>
      </div>
      <div class="tcb-group">
        <span class="tcb-label">Athletic</span>
        <span class="tcb-badge tcb-blue">SPD ${fmt(breakdown?.speed)}</span>
        <span class="tcb-badge tcb-blue">DEF ${fmt(breakdown?.defense)}</span>
      </div>`;
  }

  // NOTE: call loadTeamBreakdowns() after every renderAvailableTeams() call —
  // re-renders reset the tcb-* placeholders and need to be re-populated.
  function loadTeamBreakdowns(teamAbbrs) {
    teamAbbrs.forEach(abbr => {
      DnaRatings.getTeamBreakdown(abbr).then(breakdown => {
        updateTeamCardBreakdown(abbr, breakdown);
      }).catch(() => {});
    });
  }

  return {
    toast, renderAvailableTeams, showTeamDetail,
    updatePauseBtn, showYourTurnBanner, hideYourTurnBanner, showRecap,
    loadTeamBreakdowns, updateTeamCardBreakdown,
  };
})();

// ── SHARED UTIL ───────────────────────────────────────────
function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── RECAP PNG EXPORT ──────────────────────────────────────
function exportRecapPNG(draft) {
  if (!draft?.slots) return;
  const picks = draft.slots.filter(s => s.pickedTeam).sort((a,b) => a.pickNumber - b.pickNumber);

  const ROW_H = 48, PAD = 24, HEADER = 80;
  const W = 700;
  const H = HEADER + (picks.length * ROW_H) + PAD * 2;

  const canvas = document.createElement('canvas');
  canvas.width  = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#0a0d12';
  ctx.fillRect(0, 0, W, H);

  // Header
  ctx.fillStyle = '#151c24';
  ctx.fillRect(0, 0, W, HEADER);
  ctx.fillStyle = '#a8bdd4';
  ctx.font = 'bold 24px Arial';
  ctx.fillText('THE DNA LEAGUE — DRAFT RECAP', PAD, 36);
  ctx.fillStyle = '#5a7a94';
  ctx.font = '13px Arial';
  const seasonName = draft.seasonId ? (draft.seasonName || 'Season') : 'Draft';
  ctx.fillText(`${seasonName} · ${picks.length} picks · ${new Date(draft.completedAt || Date.now()).toLocaleDateString()}`, PAD, 58);

  let y = HEADER + PAD;
  picks.forEach((slot, i) => {
    const bg = i % 2 === 0 ? '#0f1318' : '#111720';
    ctx.fillStyle = bg;
    ctx.fillRect(PAD, y, W - PAD*2, ROW_H - 2);

    // Pick number
    ctx.fillStyle = '#5a7a94';
    ctx.font = 'bold 13px Arial';
    ctx.fillText(`#${slot.pickNumber}`, PAD + 8, y + ROW_H/2 + 5);

    // Avatar
    ctx.beginPath();
    ctx.arc(PAD + 56, y + ROW_H/2, 16, 0, Math.PI*2);
    ctx.fillStyle = slot.color || '#6a9ec7';
    ctx.fill();
    ctx.fillStyle = '#080b10';
    ctx.font = 'bold 11px Arial';
    ctx.textAlign = 'center';
    ctx.fillText((slot.memberName || '?').slice(0,2).toUpperCase(), PAD + 56, y + ROW_H/2 + 4);
    ctx.textAlign = 'left';

    // Member name
    ctx.fillStyle = '#dde6ef';
    ctx.font = 'bold 14px Arial';
    ctx.fillText(slot.memberName || '—', PAD + 80, y + ROW_H/2 + 5);

    // Arrow
    ctx.fillStyle = '#5a7a94';
    ctx.fillText('→', PAD + 250, y + ROW_H/2 + 5);

    // Team
    const team = DNA_CONFIG.mlbTeams.find(t => t.abbr === slot.pickedTeam) || { name: slot.pickedTeam, abbr: slot.pickedTeam };
    ctx.fillStyle = '#a8bdd4';
    ctx.font = 'bold 13px Arial';
    ctx.fillText(team.abbr, PAD + 275, y + ROW_H/2 + 5);
    ctx.fillStyle = '#7a9ab0';
    ctx.font = '12px Arial';
    ctx.fillText(team.name, PAD + 315, y + ROW_H/2 + 5);

    // Rating
    const ovr = draft.teamRatings?.[slot.pickedTeam]?.overall;
    if (ovr) {
      ctx.fillStyle = ovr >= 88 ? '#2ecc71' : ovr >= 82 ? '#c9a84c' : '#5a7a94';
      ctx.font = 'bold 14px Arial';
      ctx.textAlign = 'right';
      ctx.fillText(ovr, W - PAD, y + ROW_H/2 + 5);
      ctx.textAlign = 'left';
    }

    y += ROW_H;
  });

  // Footer
  ctx.fillStyle = '#5a7a94';
  ctx.font = '11px Arial';
  ctx.fillText('The DNA League · Generated ' + new Date().toLocaleDateString(), PAD, H - 8);

  canvas.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = 'draft-recap.png';
    a.click();
    URL.revokeObjectURL(url);
  }, 'image/png');
}