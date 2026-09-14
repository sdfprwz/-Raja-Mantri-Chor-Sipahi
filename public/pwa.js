/* PWA helpers: SW registration, install prompt, backend URL for store builds. */
(function () {
  'use strict';

  // ---- Backend URL resolution (web = same-origin, native app = hosted server) ----
  // Priority: ?server= param > localStorage rmcs_server_url > <meta name="rmcs-server"> > ''
  function resolveServerUrl() {
    try {
      const qs = new URLSearchParams(window.location.search);
      const q = (qs.get('server') || '').trim().replace(/\/$/, '');
      if (q && /^https?:\/\//i.test(q)) {
        try { localStorage.setItem('rmcs_server_url', q); } catch (_) {}
        return q;
      }
    } catch (_) {}
    try {
      const saved = (localStorage.getItem('rmcs_server_url') || '').trim().replace(/\/$/, '');
      if (saved && /^https?:\/\//i.test(saved)) return saved;
    } catch (_) {}
    try {
      const meta = document.querySelector('meta[name="rmcs-server"]');
      const m = ((meta && meta.content) || '').trim().replace(/\/$/, '');
      if (m && /^https?:\/\//i.test(m)) return m;
    } catch (_) {}
    // Capacitor / file:// builds have no same-origin server — fall back to prod if set at build time.
    try {
      if (window.CAPACITOR_SERVER_URL && /^https?:\/\//i.test(window.CAPACITOR_SERVER_URL)) {
        return String(window.CAPACITOR_SERVER_URL).replace(/\/$/, '');
      }
    } catch (_) {}
    return '';
  }
  window.RMCS_SERVER_URL = resolveServerUrl();
  window.getServerUrl = resolveServerUrl;

  // ---- Service worker ----
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      // Skip SW on native file:// / capacitor:// origins (no SW support there).
      if (window.location.protocol === 'http:' || window.location.protocol === 'https:') {
        navigator.serviceWorker.register('/sw.js').catch(() => {});
      }
    });
  }

  // ---- Install prompt (Android/Chrome/Edge; iOS uses Share > Add to Home Screen) ----
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    const btn = document.getElementById('btnInstall');
    if (btn) btn.classList.remove('hidden');
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    const btn = document.getElementById('btnInstall');
    if (btn) btn.classList.add('hidden');
  });

  async function promptInstall() {
    const btn = document.getElementById('btnInstall');
    if (deferredPrompt) {
      deferredPrompt.prompt();
      try { await deferredPrompt.userChoice; } catch (_) {}
      deferredPrompt = null;
      if (btn) btn.classList.add('hidden');
      return;
    }
    // iOS / fallback instructions
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    alert(isIOS
      ? 'To install: tap Share (⬆️) in Safari, then “Add to Home Screen”.'
      : 'To install: open the browser menu (⋮) and choose “Install app” / “Add to Home screen”.');
  }

  window.addEventListener('DOMContentLoaded', () => {
    const btn = document.getElementById('btnInstall');
    if (btn) btn.addEventListener('click', promptInstall);
    // Hide install button when already installed/standalone
    try {
      const standalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
      if (standalone && btn) btn.classList.add('hidden');
    } catch (_) {}
  });
})();
