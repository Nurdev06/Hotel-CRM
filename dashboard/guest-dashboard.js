// ================================================================
// HotelOS — Guest Portal Dashboard Logic
// ================================================================

// Standard menu from the room_service backend
const MENU = [
  { key: 'coffee',    emoji: '☕', name: 'Kofe',      price: 5.0  },
  { key: 'sandwich',  emoji: '🥪', name: 'Sendvich',  price: 12.0 },
  { key: 'burger',    emoji: '🍔', name: 'Burger',    price: 15.0 },
  { key: 'soda',      emoji: '🥤', name: 'Gazli suv', price: 3.0  },
  { key: 'fries',     emoji: '🍟', name: 'Kartoshka', price: 6.0  },
];

let guestSession = null; // { room_number, guest_name }
let myOrders = [];
let selectedItems = new Set();
let myIssues = [];

document.addEventListener('DOMContentLoaded', () => {
  const saved = sessionStorage.getItem('guest_session');
  if (!saved) {
    location.href = 'guest.html';
    return;
  }

  try {
    guestSession = JSON.parse(saved);
    validateSessionAndInit();
  } catch {
    location.href = 'guest.html';
  }
});

async function validateSessionAndInit() {
  try {
    const res = await fetch(`${URLS.reception}/rooms/public`);
    if (!res.ok) throw new Error();
    const rooms = await res.json();
    const room = rooms.find(r => Number(r.room_number) === Number(guestSession.room_number));
    if (room && room.status === 'Occupied' && room.guest_name && room.guest_name.toLowerCase() === guestSession.guest_name.toLowerCase()) {
      initDashboard();
    } else {
      sessionStorage.removeItem('guest_session');
      guestSession = null;
      location.href = 'guest.html';
    }
  } catch {
    // If reception API is down, fallback to init anyway to avoid locking guest out
    initDashboard();
  }
}

function initDashboard() {
  document.getElementById('gw-title').textContent = `Xush kelibsiz, ${guestSession.guest_name}!`;
  document.getElementById('gw-sub').textContent = `Xona ${guestSession.room_number}`;

  renderMenu();
  fetchMyOrders();
  fetchMyIssues();
  fetchCharges();

  // Bind issue report button
  document.getElementById('report-issue-btn').addEventListener('click', reportIssue);

  // WS for live order updates
  connectWS('*', onGuestWsEvent, () => {});

  document.getElementById('logout-btn').addEventListener('click', () => {
    sessionStorage.removeItem('guest_session');
    guestSession = null;
    location.href = 'guest.html';
  });
}

// ── Menu ──────────────────────────────────────────────────────────
function renderMenu() {
  const grid = document.getElementById('menu-grid');
  grid.innerHTML = MENU.map(item => `
    <div class="menu-item" data-key="${item.key}" onclick="toggleMenuItem('${item.key}')">
      <span class="item-emoji">${item.emoji}</span>
      <div class="item-name">${item.name}</div>
      <div class="item-price">$${item.price.toFixed(2)}</div>
    </div>
  `).join('');

  document.getElementById('order-btn').addEventListener('click', placeOrder);
}

function toggleMenuItem(key) {
  if (selectedItems.has(key)) {
    selectedItems.delete(key);
  } else {
    selectedItems.add(key);
  }

  // Update UI styling
  document.querySelectorAll('.menu-item').forEach(el => {
    el.classList.toggle('selected', selectedItems.has(el.dataset.key));
  });

  const btn = document.getElementById('order-btn');
  if (selectedItems.size > 0) {
    const total = Array.from(selectedItems).reduce((s, k) => s + (MENU.find(m => m.key === k)?.price || 0), 0);
    btn.disabled = false;
    btn.textContent = `📦 Buyurtma berish ($${total.toFixed(2)})`;
  } else {
    btn.disabled = true;
    btn.textContent = '📦 Buyurtma berish';
  }
}

// ── Place order ───────────────────────────────────────────────────
async function placeOrder() {
  if (selectedItems.size === 0) return;

  const items = Array.from(selectedItems);

  try {
    const res = await api(`${URLS.roomService}/orders`, {
      method: 'POST',
      token: STAFF_TOKEN,
      body: JSON.stringify({
        room_number: Number(guestSession.room_number),
        items: items,
      }),
    });

    const data = await res.json();
    if (res.ok) {
      showToast('✅', 'Buyurtma qabul qilindi!', `${items.join(', ')} — $${(data.order?.total_price || 0).toFixed(2)}`, 'success');
      selectedItems.clear();
      document.querySelectorAll('.menu-item').forEach(el => el.classList.remove('selected'));
      const btn = document.getElementById('order-btn');
      btn.disabled = true;
      btn.textContent = '📦 Buyurtma berish';
      myOrders.push(data.order || data);
      renderMyOrders();
      fetchCharges();
    } else {
      showToast('❌', 'Xato', parseErrorDetail(data.detail), 'error');
    }
  } catch (err) {
    showToast('❌', 'Xato', err.message, 'error');
  }
}

// ── My orders ─────────────────────────────────────────────────────
async function fetchMyOrders() {
  try {
    const res = await api(`${URLS.roomService}/orders`, { token: STAFF_TOKEN });
    if (res.ok) {
      const all = await res.json();
      myOrders = all.filter(o => Number(o.room_number) === Number(guestSession.room_number));
      renderMyOrders();
    }
  } catch {}
}

function statusIcon(s) {
  const map = {
    'Received':         '📥',
    'Preparing':        '👨‍🍳',
    'Out for delivery': '🚶',
    'Delivered':        '✅',
  };
  return map[s] || '📋';
}

function statusLabel(s) {
  const map = {
    'Received':         'Qabul qilindi',
    'Preparing':        'Tayyorlanmoqda',
    'Out for delivery': 'Yetkazilmoqda',
    'Delivered':        'Yetkazildi',
  };
  return map[s] || s;
}

function statusPillClass(s) {
  const map = {
    'Received':         'pill-received',
    'Preparing':        'pill-preparing',
    'Out for delivery': 'pill-delivery',
    'Delivered':        'pill-delivered',
  };
  return map[s] || '';
}

function renderMyOrders() {
  const container = document.getElementById('my-orders-list');
  document.getElementById('my-orders-count').textContent = `${myOrders.length} ta`;

  if (myOrders.length === 0) {
    container.innerHTML = '<div class="empty-state">Siz hali buyurtma bermadingiz</div>';
    return;
  }

  container.innerHTML = myOrders.slice().reverse().map(o => `
    <div class="task-card">
      <div class="task-card-icon">${statusIcon(o.status)}</div>
      <div class="task-card-body">
        <div class="task-card-title">${o.items.join(', ')}</div>
        <div class="task-card-meta">
          $${(o.total_price || 0).toFixed(2)} ·
          <span class="status-pill ${statusPillClass(o.status)}">${statusLabel(o.status)}</span>
        </div>
      </div>
    </div>
  `).join('');
}

// ── Charges ───────────────────────────────────────────────────────
async function fetchCharges() {
  try {
    const res = await api(`${URLS.reception}/rooms`, { token: STAFF_TOKEN });
    if (res.ok) {
      const rooms = await res.json();
      const room = rooms.find(r => Number(r.room_number) === Number(guestSession.room_number));
      if (room) {
        document.getElementById('gw-charges').textContent = `$${(room.room_service_charges || 0).toFixed(2)}`;
      }
    }
  } catch {}
}

// ── Maintenance Issue Helpers ─────────────────────────────────────
async function fetchMyIssues() {
  try {
    const res = await api(`${URLS.maintenance}/issues`, { token: STAFF_TOKEN });
    if (res.ok) {
      const all = await res.json();
      myIssues = all.filter(i => Number(i.room_number) === Number(guestSession.room_number));
      renderMyIssues();
    }
  } catch {}
}

function issueStatusIcon(s) {
  const map = {
    'Pending':  '🟡',
    'Assigned': '🔵',
    'Resolved': '🟢',
  };
  return map[s] || '📋';
}

function issueStatusLabel(s) {
  const map = {
    'Pending':  'Kutilmoqda',
    'Assigned': 'Bajarilmoqda',
    'Resolved': 'Tuzatildi',
  };
  return map[s] || s;
}

function issueStatusPillClass(s) {
  const map = {
    'Pending':  'pill-dirty',
    'Assigned': 'pill-cleaning',
    'Resolved': 'pill-clean',
  };
  return map[s] || '';
}

function renderMyIssues() {
  const container = document.getElementById('my-issues-list');
  document.getElementById('my-issues-count').textContent = `${myIssues.length} ta`;

  if (myIssues.length === 0) {
    container.innerHTML = '<div class="empty-state">Hozircha hech qanday nosozlik xabari yuborilmagan</div>';
    return;
  }

  container.innerHTML = myIssues.slice().reverse().map(i => `
    <div class="task-card">
      <div class="task-card-icon">${issueStatusIcon(i.status)}</div>
      <div class="task-card-body">
        <div class="task-card-title">${i.description}</div>
        <div class="task-card-meta">
          <span class="tag-badge ${i.urgency.toLowerCase()}">${i.urgency}</span> · 
          <span class="status-pill ${issueStatusPillClass(i.status)}">${issueStatusLabel(i.status)}</span>
          ${i.assigned_technician ? ` · 👤 ${i.assigned_technician}` : ''}
        </div>
      </div>
    </div>
  `).join('');
}

async function reportIssue() {
  const desc = document.getElementById('issue-desc').value.trim();
  const urgency = document.getElementById('issue-urgency').value;

  if (!desc || desc.length < 3) {
    showToast('⚠️', 'Xato', 'Muammo tavsifi kamida 3 ta belgidan iborat bo\'lishi kerak', 'error');
    return;
  }

  try {
    const res = await api(`${URLS.maintenance}/issues`, {
      method: 'POST',
      token: STAFF_TOKEN,
      body: JSON.stringify({
        room_number: Number(guestSession.room_number),
        description: desc,
        urgency: urgency,
      }),
    });

    const data = await res.json();
    if (res.ok) {
      showToast('🔧', 'Xabar yuborildi!', 'Texnik xodim xabardor qilindi.', 'success');
      document.getElementById('issue-desc').value = '';
      myIssues.push(data.issue || data);
      renderMyIssues();
    } else {
      showToast('❌', 'Xato', parseErrorDetail(data.detail), 'error');
    }
  } catch (err) {
    showToast('❌', 'Xato', err.message, 'error');
  }
}

// ── WS events ─────────────────────────────────────────────────────
function onGuestWsEvent(event) {
  const { event_type, payload } = event;

  if (event_type === 'room_service_status_changed' && Number(payload.room_number) === Number(guestSession.room_number)) {
    const order = myOrders.find(o => o.order_id === payload.order_id);
    if (order) {
      order.status = payload.status;
    }
    renderMyOrders();

    if (payload.status === 'Delivered') {
      showToast('✅', 'Buyurtma yetkazildi!', `${payload.items?.join(', ') || 'Sizning buyurtmangiz'} yetib keldi`, 'success', 6000);
      fetchCharges();
    } else {
      showToast('📋', 'Buyurtma yangilandi', `${statusIcon(payload.status)} ${statusLabel(payload.status)}`, 'info', 4000);
    }
  }

  if (event_type === 'room_service_order_placed' && Number(payload.room_number) === Number(guestSession.room_number)) {
    if (!myOrders.find(o => o.order_id === payload.order_id)) {
      myOrders.push(payload);
      renderMyOrders();
    }
  }

  if (event_type === 'maintenance_status_changed' && Number(payload.room_number) === Number(guestSession.room_number)) {
    const issue = myIssues.find(i => i.issue_id === payload.issue_id);
    if (issue) {
      issue.status = payload.status;
      if (payload.assigned_technician) issue.assigned_technician = payload.assigned_technician;
    }
    renderMyIssues();

    if (payload.status === 'Resolved') {
      showToast('✅', 'Muammo bartaraf etildi!', `Xonadagi muammo tuzatildi.`, 'success', 6000);
    } else {
      showToast('🔧', 'Nosozlik holati o\'zgardi', `Status: ${issueStatusLabel(payload.status)}`, 'info', 4000);
    }
  }

  if (event_type === 'maintenance_reported' && Number(payload.room_number) === Number(guestSession.room_number)) {
    if (!myIssues.find(i => i.issue_id === payload.issue_id)) {
      myIssues.push(payload);
      renderMyIssues();
    }
  }
}
