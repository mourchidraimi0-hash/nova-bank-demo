/* ==========================================================================
   NOVA BANK — back-office : garde de session, thème, rôles
   ========================================================================== */

const ADMIN_UI = (() => {

  async function guard() {
    const session = await DB.requireAdminAuth();
    if (!session) return null;
    startInactivityWatch();
    renderIdentity(session);
    applyRolePermissions(session.role);
    return session;
  }

  function startInactivityWatch() {
    ['click', 'keydown', 'mousemove', 'scroll', 'touchstart'].forEach(evt => {
      document.addEventListener(evt, throttleRefresh, { passive: true });
    });
    setInterval(async () => {
      const s = await DB.getAdminSession();
      if (!s) { window.location.href = 'admin-connexion.html'; }
    }, 15000);
  }
  let lastRefresh = 0;
  function throttleRefresh() {
    const now = Date.now();
    if (now - lastRefresh > 5000) { lastRefresh = now; DB.refreshAdminSession(); }
  }

  function renderIdentity(session) {
    document.querySelectorAll('[data-admin-name]').forEach(el => el.textContent = session.name);
    document.querySelectorAll('[data-admin-role]').forEach(el => el.textContent = DB.roleLabel(session.role));
  }

  function applyRolePermissions(role) {
    const canManage = DB.canManageAccounts(role);
    const canManageAdmins = DB.canManageAdmins(role);
    if (!canManage) {
      document.querySelectorAll('[data-requires="manage"]').forEach(el => {
        el.classList.add('role-hidden');
        if (el.tagName === 'BUTTON' || el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') el.disabled = true;
      });
    }
    if (!canManageAdmins) {
      document.querySelectorAll('[data-requires="super_admin"]').forEach(el => el.classList.add('role-hidden'));
    }
  }

  function initTheme() {
    const saved = localStorage.getItem('cac_admin_theme') || 'light';
    if (saved === 'dark') document.body.setAttribute('data-theme', 'dark');
    document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
      updateThemeIcon(btn, saved);
      btn.addEventListener('click', () => {
        const isDark = document.body.getAttribute('data-theme') === 'dark';
        if (isDark) { document.body.removeAttribute('data-theme'); localStorage.setItem('cac_admin_theme', 'light'); }
        else { document.body.setAttribute('data-theme', 'dark'); localStorage.setItem('cac_admin_theme', 'dark'); }
        updateThemeIcon(btn, isDark ? 'light' : 'dark');
        document.dispatchEvent(new CustomEvent('cac-theme-changed', { detail: { theme: isDark ? 'light' : 'dark' } }));
      });
    });
  }
  function updateThemeIcon(btn, theme) {
    btn.innerHTML = theme === 'dark' ? '<i class="fa-solid fa-sun"></i>' : '<i class="fa-solid fa-moon"></i>';
  }

  function initSidebar() {
    const toggle = document.querySelector('[data-sidebar-toggle]');
    const sidebar = document.querySelector('.admin-sidebar');
    if (!toggle || !sidebar) return;
    toggle.addEventListener('click', () => sidebar.classList.toggle('open'));
    document.addEventListener('click', (e) => {
      if (sidebar.classList.contains('open') && !sidebar.contains(e.target) && !toggle.contains(e.target)) {
        sidebar.classList.remove('open');
      }
    });
    const path = window.location.pathname.split('/').pop();
    document.querySelectorAll('.admin-nav a').forEach(a => {
      if (a.getAttribute('href') === path) a.classList.add('active');
    });
  }

  function logout() {
    DB.adminLogout();
    window.location.href = 'admin-connexion.html';
  }

  document.addEventListener('DOMContentLoaded', () => {
    initTheme();
    initSidebar();
    document.querySelectorAll('[data-admin-logout]').forEach(b => b.addEventListener('click', logout));
  });

  return { guard, logout, initTheme };
})();
