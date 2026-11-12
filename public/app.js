(() => {
  const toggle = document.querySelector('.menu-toggle');
  const nav = document.querySelector('.landing-nav, .app-nav');

  if (toggle && nav) {
    const closeMenu = () => {
      nav.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Open navigation');
    };

    toggle.addEventListener('click', () => {
      const open = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', String(!open));
      toggle.setAttribute('aria-label', open ? 'Open navigation' : 'Close navigation');
      nav.classList.toggle('is-open', !open);
    });

    nav.querySelectorAll('a').forEach(link => link.addEventListener('click', closeMenu));
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        closeMenu();
        toggle.focus();
      }
    });
    document.addEventListener('click', event => {
      if (nav.classList.contains('is-open') && !nav.contains(event.target) && !toggle.contains(event.target)) {
        closeMenu();
      }
    });
    window.addEventListener('resize', () => {
      if (window.innerWidth > 860) closeMenu();
    }, { passive: true });
  }

  const year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();
})();

// Parent Web Push enrollment. This runs only after the parent taps the enable button.
(() => {
  const enable = document.querySelector('[data-enable-push]');
  const disable = document.querySelector('[data-disable-push]');
  const status = document.querySelector('[data-push-status]');
  if (!enable && !disable) return;
  const show = message => { if (status) status.textContent = message; };
  fetch('/push/config').then(response => response.json()).then(config => {
    if (config.subscribed) { if (enable) enable.hidden = true; if (disable) disable.hidden = false; }
  }).catch(() => {});
  const decodeKey = value => {
    const padding = '='.repeat((4 - value.length % 4) % 4);
    const base64 = (value + padding).replace(/-/g, '+').replace(/_/g, '/');
    return Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  };
  async function api(path, body) {
    const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not update notification settings.');
    return data;
  }
  enable?.addEventListener('click', async () => {
    enable.disabled = true;
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) throw new Error('This browser does not support Web Push notifications.');
      if (!window.isSecureContext) throw new Error('Web Push requires HTTPS. Open the deployed Render HTTPS website.');
      const configResponse = await fetch('/push/config');
      const config = await configResponse.json();
      if (!config.enabled || !config.publicKey) throw new Error('Web Push is not configured on the server yet. The administrator must add VAPID keys.');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Notification permission was not granted.');
      const registration = await navigator.serviceWorker.register('/sw.js');
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeKey(config.publicKey) });
      const result = await api('/push/subscribe', subscription.toJSON());
      show(result.message || 'Web Push enabled on this device.');
      enable.hidden = true;
      if (disable) disable.hidden = false;
    } catch (error) { show(error.message); }
    finally { enable.disabled = false; }
  });
  disable?.addEventListener('click', async () => {
    disable.disabled = true;
    try {
      const registration = await navigator.serviceWorker.getRegistration('/');
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await api('/push/unsubscribe', { endpoint: subscription.endpoint });
        await subscription.unsubscribe();
      }
      show('Web Push disabled on this device.');
      disable.hidden = true;
      if (enable) enable.hidden = false;
    } catch (error) { show(error.message); }
    finally { disable.disabled = false; }
  });
})();
