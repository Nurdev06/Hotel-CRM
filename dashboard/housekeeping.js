// ================================================================
// HotelOS — Housekeeping Dashboard Logic
// ================================================================

let roomsData = [];
let cleaningQueue = [];

document.addEventListener('DOMContentLoaded', () => {
  requireStaffAuth(init);
});

function init() {
  renderNavBar('housekeeping');
  document.getElementById('hk-app').classList.remove('hidden');

  // Restore housekeeper name
  const saved = localStorage.getItem('hk_name');
  if (saved) document.getElementById('hk-name').value = saved;
  document.getElementById('hk-name').addEventListener('input', (e) => {
    localStorage.setItem('hk_name', e.target.value.trim());
  });

  fetchAll();
  connectWS('*', onWsEvent, updateNavWS);
}

// ── Fetch data ────────────────────────────────────────────────────
async function fetchAll() {
  try {
    const [qRes, rRes] = await Promise.all([
      api(`${URLS.housekeeping}/queue`),
      api(`${URLS.reception}/rooms`),
    ]);
    if (qRes.ok) cleaningQueue = await qRes.json();
    if (rRes.ok) roomsData = await rRes.json();
    render();
  } catch (e) {
    showToast('⚠️', 'Xato', 'Xizmatlarga ulanib bo\'lmadi', 'error');
  }
}

// ── Render ─────────────────────────────────────────────────────────
function render() {
  renderStats();
  renderDirty();
  renderCleaning();
  renderClean();
}

function renderStats() {
  const dirty    = cleaningQueue.filter(t => t.status === 'Dirty').length;
  const cleaning = cleaningQueue.filter(t => t.status === 'Being cleaned').length;
  const clean    = roomsData.filter(r => r.status === 'Clean').length;

  document.getElementById('hk-dirty').textContent    = dirty;
  document.getElementById('hk-cleaning').textContent = cleaning;
  document.getElementById('hk-clean').textContent    = clean;
}

// ── Dirty rooms list ──────────────────────────────────────────────
function renderDirty() {
  const container = document.getElementById('dirty-list');
  const dirty = cleaningQueue.filter(t => t.status === 'Dirty');
  document.getElementById('dirty-count').textContent = dirty.length;

  if (dirty.length === 0) {
    container.innerHTML = '<div class="empty-state">Barcha xonalar toza ✨</div>';
    return;
  }

  container.innerHTML = dirty.map(t => `
    <div class="task-card">
      <div class="task-card-icon">🟡</div>
      <div class="task-card-body">
        <div class="task-card-title">Xona ${t.room_number}</div>
        <div class="task-card-meta">${timeAgo(t.timestamp)} · <span class="status-pill pill-dirty">Tozalanmagan</span></div>
      </div>
      <div class="task-card-actions">
        <button class="btn-action-small" onclick="startCleaning(${t.room_number})">🧹 Tozalashni boshlash</button>
      </div>
    </div>
  `).join('');
}

// ── Cleaning rooms list ───────────────────────────────────────────
function renderCleaning() {
  const container = document.getElementById('cleaning-list');
  const cleaning = cleaningQueue.filter(t => t.status === 'Being cleaned');
  document.getElementById('cleaning-count').textContent = cleaning.length;

  if (cleaning.length === 0) {
    container.innerHTML = '<div class="empty-state">Hozir tozalanayotgan xona yo\'q</div>';
    return;
  }

  container.innerHTML = cleaning.map(t => `
    <div class="task-card">
      <div class="task-card-icon">🔵</div>
      <div class="task-card-body">
        <div class="task-card-title">Xona ${t.room_number}</div>
        <div class="task-card-meta">👤 ${t.housekeeper || 'Noma\'lum'} · <span class="status-pill pill-cleaning">Tozalanmoqda</span></div>
      </div>
      <div class="task-card-actions">
        <button class="btn-action-small" onclick="finishCleaning(${t.room_number})">✅ Yakunlash</button>
      </div>
    </div>
  `).join('');
}

// ── Clean rooms list ──────────────────────────────────────────────
function renderClean() {
  const container = document.getElementById('clean-list');
  const clean = roomsData.filter(r => r.status === 'Clean');
  document.getElementById('clean-count').textContent = clean.length;

  if (clean.length === 0) {
    container.innerHTML = '<div class="empty-state">Hali bugun tozalangan xona yo\'q</div>';
    return;
  }

  container.innerHTML = clean.map(r => `
    <div class="task-card" style="opacity:0.7">
      <div class="task-card-icon">🟢</div>
      <div class="task-card-body">
        <div class="task-card-title">Xona ${r.room_number}</div>
        <div class="task-card-meta">${r.floor}-qavat · ${r.room_type} · <span class="status-pill pill-clean">Toza</span></div>
      </div>
    </div>
  `).join('');
}

// ── Start cleaning ────────────────────────────────────────────────
async function startCleaning(roomNumber) {
  const name = document.getElementById('hk-name').value.trim();
  if (!name) {
    showToast('⚠️', 'Xato', 'Iltimos, housekeeper ismini kiriting', 'error');
    document.getElementById('hk-name').focus();
    return;
  }

  try {
    const res = await api(`${URLS.housekeeping}/start-cleaning/${roomNumber}?housekeeper_name=${encodeURIComponent(name)}`, {
      method: 'POST',
    });
    if (res.ok) {
      showToast('🧹', 'Tozalash boshlandi', `Xona ${roomNumber} — ${name}`, 'success', 3000);
      fetchAll();
    } else {
      const data = await res.json();
      showToast('❌', 'Xato', parseErrorDetail(data.detail), 'error');
    }
  } catch (err) {
    showToast('❌', 'Xato', err.message, 'error');
  }
}

// ── Finish cleaning ───────────────────────────────────────────────
async function finishCleaning(roomNumber) {
  try {
    const res = await api(`${URLS.housekeeping}/finish-cleaning/${roomNumber}`, {
      method: 'POST',
    });
    if (res.ok) {
      showToast('✅', 'Tozalash tugadi', `Xona ${roomNumber} endi toza va tayyor`, 'success', 3000);
      fetchAll();
    } else {
      const data = await res.json();
      showToast('❌', 'Xato', parseErrorDetail(data.detail), 'error');
    }
  } catch (err) {
    showToast('❌', 'Xato', err.message, 'error');
  }
}

// ── WebSocket event handler ───────────────────────────────────────
function onWsEvent(event) {
  const { event_type, payload } = event;

  if (event_type === 'room_vacated') {
    showToast('🚪', 'Yangi tozalash vazifasi!', `Xona ${payload.room_number} bo'shatildi — tozalash kerak`, 'info', 8000);
    fetchAll();
  }

  if (event_type === 'room_status_changed') {
    fetchAll();
  }
}
