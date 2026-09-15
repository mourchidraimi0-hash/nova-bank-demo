/* ==========================================================================
   NOVA BANK — interactions du site public
   ========================================================================== */

document.addEventListener('DOMContentLoaded', () => {
  if (window.AOS) AOS.init({ duration: 700, once: true, offset: 60 });

  initNavbar();
  initMobileDrawer();
  initCounters();
  initProgressBars();
  initTestimonials();
  initParticles();
  initDropzones();
  initPasswordStrength();
  initEntranceAnimations();
  initFaqAccordions();
  initSidebarToggle();
  initNotifBadge();
});

// ---------------------------------------------------------------- badge de notifications non lues (sidebar client)
async function initNotifBadge() {
  if (typeof DB === 'undefined' || !DB.getCurrentUser) return;
  const user = await DB.getCurrentUser();
  if (!user) return;
  const count = (user.notifications || []).filter(n => !n.read).length;
  document.querySelectorAll('[data-notif-badge]').forEach(el => {
    if (count > 0) { el.textContent = count > 9 ? '9+' : String(count); el.classList.remove('hidden'); }
    else { el.classList.add('hidden'); }
  });
}

// ---------------------------------------------------------------- animations d'entrée (cascade)
function initEntranceAnimations() {
  document.querySelectorAll('[data-animate-group]').forEach(group => {
    [...group.children].forEach((el, i) => {
      el.style.animationDelay = (i * 0.06) + 's';
      el.classList.add('animate-in');
    });
  });
}

// ---------------------------------------------------------------- accordéon FAQ réutilisable
function initFaqAccordions() {
  document.querySelectorAll('.faq-question').forEach(q => {
    q.addEventListener('click', () => {
      const item = q.closest('.faq-item');
      const wasOpen = item.classList.contains('open');
      item.parentElement.querySelectorAll('.faq-item.open').forEach(o => { if (o !== item) o.classList.remove('open'); });
      item.classList.toggle('open', !wasOpen);
    });
  });
}

// ---------------------------------------------------------------- bascule générique de la sidebar (espace client)
function initSidebarToggle() {
  const toggle = document.getElementById('sidebarToggle');
  const sidebar = document.getElementById('sidebar');
  if (!toggle || !sidebar) return;
  toggle.addEventListener('click', () => sidebar.classList.toggle('open'));
  document.addEventListener('click', (e) => {
    if (sidebar.classList.contains('open') && !sidebar.contains(e.target) && !toggle.contains(e.target)) {
      sidebar.classList.remove('open');
    }
  });
  const path = window.location.pathname.split('/').pop();
  document.querySelectorAll('.app-nav a').forEach(a => {
    if (a.getAttribute('href') === path) a.classList.add('active');
  });
}

// ---------------------------------------------------------------- navbar
function initNavbar() {
  const nav = document.querySelector('.navbar');
  if (!nav) return;
  const onScroll = () => {
    if (window.scrollY > 40) nav.classList.add('scrolled');
    else nav.classList.remove('scrolled');
  };
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
}

function initMobileDrawer() {
  const burger = document.querySelector('.nav-burger');
  const drawer = document.querySelector('.mobile-drawer');
  const overlay = document.querySelector('.drawer-overlay');
  if (!burger || !drawer) return;
  const close = () => { drawer.classList.remove('open'); overlay?.classList.remove('open'); document.body.classList.remove('menu-open'); };
  const open = () => { drawer.classList.add('open'); overlay?.classList.add('open'); document.body.classList.add('menu-open'); };
  burger.addEventListener('click', () => drawer.classList.contains('open') ? close() : open());
  overlay?.addEventListener('click', close);
  drawer.querySelectorAll('a').forEach(a => a.addEventListener('click', close));
}

// ---------------------------------------------------------------- counters
function initCounters() {
  const counters = document.querySelectorAll('[data-counter]');
  if (!counters.length) return;
  const animate = (el) => {
    const target = parseFloat(el.getAttribute('data-counter'));
    const suffix = el.getAttribute('data-suffix') || '';
    const duration = 1400;
    const start = performance.now();
    const step = (t) => {
      const p = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.floor(eased * target).toLocaleString('en-US') + suffix;
      if (p < 1) requestAnimationFrame(step);
      else el.textContent = target.toLocaleString('en-US') + suffix;
    };
    requestAnimationFrame(step);
  };
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => { if (e.isIntersecting) { animate(e.target); io.unobserve(e.target); } });
  }, { threshold: 0.4 });
  counters.forEach(c => io.observe(c));
}

// ---------------------------------------------------------------- progress bars
function initProgressBars() {
  const bars = document.querySelectorAll('.progress-bar > span[data-width]');
  if (!bars.length) return;
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) { e.target.style.width = e.target.getAttribute('data-width') + '%'; io.unobserve(e.target); }
    });
  }, { threshold: 0.3 });
  bars.forEach(b => io.observe(b));
}

// ---------------------------------------------------------------- testimonials
function initTestimonials() {
  const items = document.querySelectorAll('.testi');
  const dotsWrap = document.querySelector('.testi-dots');
  if (!items.length) return;
  let idx = 0;
  const show = (i) => {
    items.forEach((it, n) => it.classList.toggle('active', n === i));
    if (dotsWrap) [...dotsWrap.children].forEach((d, n) => d.classList.toggle('active', n === i));
    idx = i;
  };
  if (dotsWrap) {
    items.forEach((_, n) => {
      const b = document.createElement('button');
      b.addEventListener('click', () => show(n));
      dotsWrap.appendChild(b);
    });
  }
  show(0);
  setInterval(() => show((idx + 1) % items.length), 5000);
}

// ---------------------------------------------------------------- hero particles
function initParticles() {
  const canvas = document.querySelector('canvas.particles');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let w, h, particles;
  function resize() {
    w = canvas.width = canvas.offsetWidth;
    h = canvas.height = canvas.offsetHeight;
  }
  function init() {
    particles = Array.from({ length: 60 }, () => ({
      x: Math.random() * w, y: Math.random() * h,
      r: Math.random() * 2 + 0.6,
      vx: (Math.random() - 0.5) * 0.3, vy: (Math.random() - 0.5) * 0.3
    }));
  }
  function tick() {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(110,231,183,.65)';
    particles.forEach(p => {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > h) p.vy *= -1;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    });
    requestAnimationFrame(tick);
  }
  resize(); init(); tick();
  window.addEventListener('resize', () => { resize(); init(); });
}

// ---------------------------------------------------------------- dropzones réutilisables
// Usage: <div class="dropzone" data-dropzone="idPhoto" data-accept="image/jpeg,image/png" data-maxsize="5242880">
function initDropzones() {
  document.querySelectorAll('[data-dropzone]').forEach(zone => setupDropzone(zone));
}

function setupDropzone(zone) {
  const key = zone.getAttribute('data-dropzone');
  const input = document.getElementById('input-' + key);
  const preview = document.getElementById('preview-' + key);
  const errorEl = document.getElementById('error-' + key);
  const accept = (zone.getAttribute('data-accept') || '').split(',').map(s => s.trim()).filter(Boolean);
  const maxSize = parseInt(zone.getAttribute('data-maxsize') || '5242880', 10);
  if (!input) return;

  window.dzFiles = window.dzFiles || {};

  function showError(msg) {
    if (errorEl) { errorEl.textContent = msg; errorEl.classList.add('show'); }
  }
  function clearError() { if (errorEl) errorEl.classList.remove('show'); }

  function handleFile(file) {
    clearError();
    if (!file) return;
    if (accept.length && !accept.includes(file.type)) {
      showError('Unsupported format. Accepted formats: ' + accept.map(a => a.split('/')[1]).join(', ').toUpperCase());
      return;
    }
    if (file.size > maxSize) {
      showError('File too large (max ' + (maxSize / 1048576).toFixed(0) + ' MB).');
      return;
    }
    window.dzFiles[key] = file;
    zone.classList.add('hidden');
    if (preview) {
      preview.classList.add('show');
      const nameEl = preview.querySelector('.fname');
      const sizeEl = preview.querySelector('.fsize');
      const imgEl = preview.querySelector('img');
      const iconEl = preview.querySelector('.dz-icon');
      if (nameEl) nameEl.textContent = file.name;
      if (sizeEl) sizeEl.textContent = (file.size / 1024).toFixed(0) + ' KB';
      if (file.type.startsWith('image/') && imgEl) {
        const reader = new FileReader();
        reader.onload = (e) => { imgEl.src = e.target.result; imgEl.classList.remove('hidden'); if (iconEl) iconEl.classList.add('hidden'); };
        reader.readAsDataURL(file);
      } else if (iconEl) {
        iconEl.classList.remove('hidden');
        if (imgEl) imgEl.classList.add('hidden');
      }
    }
  }

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault(); zone.classList.remove('dragover');
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  input.addEventListener('change', () => { if (input.files.length) handleFile(input.files[0]); });

  const removeBtn = preview ? preview.querySelector('.dz-remove') : null;
  if (removeBtn) {
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      delete window.dzFiles[key];
      input.value = '';
      preview.classList.remove('show');
      zone.classList.remove('hidden');
      clearError();
    });
  }
}

function getDzFileMeta(key) {
  const f = window.dzFiles && window.dzFiles[key];
  if (!f) return null;
  return { name: f.name, type: f.type, size: f.size };
}

// ---------------------------------------------------------------- password strength
function initPasswordStrength() {
  const input = document.getElementById('password');
  const bars = document.querySelectorAll('.pw-strength span');
  const label = document.querySelector('.pw-strength-label');
  if (!input || !bars.length) return;
  input.addEventListener('input', () => {
    const v = input.value;
    let score = 0;
    if (v.length >= 8) score++;
    if (/[A-Z]/.test(v) && /[a-z]/.test(v)) score++;
    if (/\d/.test(v)) score++;
    if (/[^A-Za-z0-9]/.test(v)) score++;
    const colors = ['#C0392B', '#e08e0b', '#22C55E', '#166534'];
    const labels = ['Very weak', 'Weak', 'Good', 'Excellent'];
    bars.forEach((b, i) => { b.style.background = i < score ? colors[Math.max(score - 1, 0)] : '#e6e6e6'; });
    if (label) label.textContent = v ? 'Password strength: ' + (labels[Math.max(score - 1, 0)] || 'Very weak') : '';
  });
}

// ---------------------------------------------------------------- chargement différé d'une librairie externe (ex : Chart.js)
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Failed to load: ' + src));
    document.head.appendChild(s);
  });
}

// ---------------------------------------------------------------- status helpers (partagé public/admin)
const STATUS_LABELS = {
  confirmed: 'Confirmed', pending: 'Pending', processing: 'Processing',
  rejected: 'Rejected', cancelled: 'Cancelled',
  active: 'Active', suspended: 'Suspended', pending_info: 'Info Required'
};
function statusBadge(status) {
  const label = STATUS_LABELS[status] || status;
  return `<span class="badge badge-${status}">${label}</span>`;
}
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function timeAgo(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' }) + ' at ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}
