// ============================================================
// THE DNA LEAGUE — auth.js
// Shared authentication helpers used by all pages.
// ============================================================

const DnaAuth = (() => {
  let _db = null;
  let _currentUser = null;
  let _currentMember = null;

  function init(db) {
    _db = db;
  }

  async function getSession() {
    const { data } = await _db.auth.getSession();
    return data?.session || null;
  }

  async function loadMember(userId) {
    const { data, error } = await _db
      .from('league_members')
      .select('*, leagues(*)')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) { console.error('loadMember:', error.message); return null; }
    return data;
  }

  function canManage(member) {
    if (!member) return false;
    return ['admin', 'commissioner', 'co_commissioner'].includes(member.role);
  }

  function isAdmin(member) {
    if (!member) return false;
    return ['admin', 'commissioner'].includes(member.role);
  }

  async function signOut() {
    await _db.auth.signOut();
    _currentUser = null;
    _currentMember = null;
  }

  function onAuthChange(callback) {
    _db.auth.onAuthStateChange(callback);
  }

  return { init, getSession, loadMember, canManage, isAdmin, signOut, onAuthChange };
})();
