// ================================================================
// HotelOS — Shared Utilities
// Used by all role-based dashboards
// ================================================================

const host = window.location.hostname || '127.0.0.1';



const URLS = {
  reception:    `http://${host}:8001`,
  roomService:  `http://${host}:8002`,
  maintenance:  `http://${host}:8003`,
  housekeeping: `http://${host}:8004`,
  brokerWS:     `ws://${host}:8000/ws`,
  broker:       `http://${host}:8000`,
};

const STAFF_TOKEN = 'admin_hotel_os';

// ── Auth helpers ─────────────────────────────────────────────────
function getToken() {
  return localStorage.getItem('hotel_token') || '';
}
function setToken(t) {
  localStorage.setItem('hotel_token', t);
}
function clearToken() {
  localStorage.removeItem('hotel_token');
}
function isAuthenticated() {
  return getToken() === STAFF_TOKEN;
}

// ── API call with Authorization header ───────────────────────────
async function api(url, opts = {}) {
  const token = opts.token !== undefined ? opts.token : getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: token } : {}),
    ...(opts.headers || {}),
  };
  const res = await fetch(url, {
    ...opts,
    headers,
    body: opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined,
  });
  return res;
}

// ── Pydantic v2 error parser ─────────────────────────────────────
function parseErrorDetail(detail) {
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail.map(e => {
      const loc = e.loc ? e.loc.join(' → ') : '';
      return loc ? `${loc}: ${e.msg}` : (e.msg || JSON.stringify(e));
    }).join('\n');
  }
  return JSON.stringify(detail);
}

// ── Toast notification system ─────────────────────────────────────
function showToast(icon, title, message, type = 'info', durationMs = 5000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <div class="toast-icon">${icon}</div>
    <div class="toast-body">
      <div class="toast-title">${title}</div>
      <div class="toast-message">${message}</div>
    </div>
    <button class="toast-close" onclick="this.parentElement.remove()">✕</button>
    <div class="toast-progress"></div>
  `;
  container.appendChild(toast);

  const progress = toast.querySelector('.toast-progress');
  progress.style.transition = `width ${durationMs}ms linear`;
  requestAnimationFrame(() => requestAnimationFrame(() => { progress.style.width = '0%'; }));
  requestAnimationFrame(() => toast.classList.add('toast-show'));
  setTimeout(() => {
    toast.classList.remove('toast-show');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  }, durationMs);
}

// ── WebSocket with auto-reconnect ─────────────────────────────────
function connectWS(topics, onEvent, onStatusChange) {
  const topicStr = Array.isArray(topics) ? topics.join(',') : (topics || '*');
  let ws = null;
  let reconnectTimer = null;
  let destroyed = false;

  function connect() {
    if (destroyed) return;
    ws = new WebSocket(`${URLS.brokerWS}?topics=${topicStr}`);

    ws.onopen = () => {
      if (onStatusChange) onStatusChange('online');
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    };
    ws.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        if (event.event_type && onEvent) onEvent(event);
      } catch {}
    };
    ws.onclose = () => {
      if (destroyed) return;
      if (onStatusChange) onStatusChange('offline');
      reconnectTimer = setTimeout(connect, 3000);
    };
    ws.onerror = () => ws.close();
  }

  connect();
  return {
    close() { destroyed = true; if (ws) ws.close(); }
  };
}

// ── Navigation bar ────────────────────────────────────────────────
const NAV_ITEMS = [
  { key: 'admin',        label: '🖥️ Admin',        href: '/' },
  { key: 'reception',    label: '🏨 Reception',     href: '/reception.html' },
  { key: 'roomservice',  label: '🍽️ Room Service',  href: '/room-service.html' },
  { key: 'housekeeping', label: '🧹 Housekeeping',  href: '/housekeeping.html' },
  { key: 'maintenance',  label: '🔧 Maintenance',   href: '/maintenance.html' },
  { key: 'guest',        label: '👤 Guest Portal',  href: '/guest.html' },
];

const ROLE_LABELS = {
  admin:        'Admin',
  reception:    'Reception',
  roomservice:  'Room Service',
  housekeeping: 'Housekeeping',
  maintenance:  'Maintenance',
  guest:        'Guest Portal',
};

function renderNavBar(activeKey) {
  const existing = document.getElementById('top-nav');
  if (existing) existing.remove();

  const nav = document.createElement('nav');
  nav.id = 'top-nav';
  nav.className = 'top-nav glass';

  // Hide guest from staff nav (it's a different kind of access)
  const staffItems = NAV_ITEMS.filter(i => i.key !== 'guest' || activeKey === 'guest');

  nav.innerHTML = `
    <a class="nav-logo" href="/">🏨 GrandStay</a>
    <div class="nav-links">
      ${staffItems.map(item => `
        <a href="${item.href}" class="nav-link ${item.key === activeKey ? 'active' : ''}">
          ${item.label}
        </a>
      `).join('')}
    </div>
    <div class="nav-right">
      <span class="nav-role-badge role-${activeKey}">${ROLE_LABELS[activeKey] || activeKey}</span>
      <div class="nav-ws-wrap">
        <div class="status-indicator" id="nav-ws-dot"></div>
        <span id="nav-ws-text">Connecting...</span>
      </div>
    </div>
  `;

  document.body.insertBefore(nav, document.body.firstChild);
}

function updateNavWS(status) {
  const dot  = document.getElementById('nav-ws-dot');
  const text = document.getElementById('nav-ws-text');
  if (!dot || !text) return;
  if (status === 'online') {
    dot.className  = 'status-indicator online';
    text.textContent = 'Live';
  } else {
    dot.className  = 'status-indicator offline';
    text.textContent = 'Offline…';
  }
}

// ── Staff auth gate ───────────────────────────────────────────────
// Call at start of each staff page; shows inline modal if not authenticated
function requireStaffAuth(onSuccess) {
  if (isAuthenticated()) { onSuccess(); return; }

  // Inject auth overlay
  const overlay = document.createElement('div');
  overlay.id = 'auth-overlay';
  overlay.className = 'auth-overlay';
  overlay.innerHTML = `
    <div class="auth-box glass">
      <div class="auth-logo">🏨</div>
      <h2>GrandStay HotelOS</h2>
      <p>Staff access requires an administrator token.</p>
      <div class="input-group">
        <input type="password" id="staff-token-input" placeholder="Staff Token" autocomplete="current-password">
      </div>
      <button id="staff-auth-btn" class="btn-primary">Authenticate</button>
      <p id="staff-auth-err" class="error-text hidden">Invalid token. Try again.</p>
    </div>
  `;
  document.body.appendChild(overlay);

  function tryAuth() {
    const val = document.getElementById('staff-token-input').value.trim();
    if (val === STAFF_TOKEN) {
      setToken(val);
      overlay.remove();
      onSuccess();
    } else {
      document.getElementById('staff-auth-err').classList.remove('hidden');
    }
  }
  document.getElementById('staff-auth-btn').addEventListener('click', tryAuth);
  document.getElementById('staff-token-input').addEventListener('keypress', e => {
    if (e.key === 'Enter') tryAuth();
  });
}

// ── Utility helpers ───────────────────────────────────────────────
function formatTime(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit' });
}

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Math.floor((Date.now() - ts * 1000) / 60000);
  if (diff < 1)  return 'hozir';
  if (diff < 60) return `${diff} daqiqa oldin`;
  return `${Math.floor(diff / 60)} soat oldin`;
}
