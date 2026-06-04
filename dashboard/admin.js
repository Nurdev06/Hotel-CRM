// ================================================================
// HotelOS — Admin Dashboard Logic (Monitoring Only)
// ================================================================

let roomsData = [];
let ordersData = [];
let issuesData = [];
let hkQueue = [];

let currentFloorFilter = 'all';
let currentLogFilter = 'all';
let logsList = [];

document.addEventListener('DOMContentLoaded', () => {
  requireStaffAuth(init);
});

function init() {
  renderNavBar('admin');
  document.getElementById('admin-app').classList.remove('hidden');
  setupFloorFilters();
  setupLogControls();
  fetchInitialState();
  connectWS('*', onWsEvent, updateNavWS);
}

// ── Floor filter pills ────────────────────────────────────────────
function setupFloorFilters() {
  document.querySelectorAll('.floor-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.floor-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFloorFilter = btn.dataset.floor;
      renderRooms();
    });
  });
}

// ── Log filter / clear ────────────────────────────────────────────
function setupLogControls() {
  document.getElementById('log-filter').addEventListener('change', (e) => {
    currentLogFilter = e.target.value;
    renderLogs();
  });
  document.getElementById('clear-logs').addEventListener('click', () => {
    logsList = [];
    const counter = document.getElementById('log-counter');
    if (counter) counter.textContent = '0 ta hodisa';
    renderLogs();
  });
  
  // Bind auto-scroll checkbox to force scroll immediately if checked
  const autoScroll = document.getElementById('auto-scroll-chk');
  if (autoScroll) {
    autoScroll.addEventListener('change', () => {
      if (autoScroll.checked) {
        const terminal = document.getElementById('event-terminal');
        if (terminal) terminal.scrollTop = terminal.scrollHeight;
      }
    });
  }
}

// ── Fetch initial state ───────────────────────────────────────────
async function fetchInitialState() {
  try {
    const [rRes, oRes, iRes, hRes] = await Promise.all([
      api(`${URLS.reception}/rooms`),
      api(`${URLS.roomService}/orders`),
      api(`${URLS.maintenance}/issues`),
      api(`${URLS.housekeeping}/queue`),
    ]);
    if (rRes.ok) roomsData = await rRes.json();
    if (oRes.ok) ordersData = await oRes.json();
    if (iRes.ok) issuesData = await iRes.json();
    if (hRes.ok) hkQueue = await hRes.json();

    renderRooms();
    updateStatsBar();
    renderRSPanel();
    renderMaintPanel();
    renderHKPanel();
    addLog('SYSTEM', 'All microservices initialized successfully.');
  } catch (err) {
    addLog('ERROR', `Failed to fetch initial state: ${err.message}`);
  }
}

// ── Stats bar ─────────────────────────────────────────────────────
function updateStatsBar() {
  const total = roomsData.length;
  if (total === 0) return;

  const roomsWithIssues = new Set(
    issuesData.filter(i => i.status !== 'Resolved').map(i => i.room_number)
  );
  const cleanCount     = roomsData.filter(r => r.status === 'Clean').length;
  const occupiedCount  = roomsData.filter(r => r.status === 'Occupied').length;
  const okCount        = roomsData.filter(r => !roomsWithIssues.has(r.room_number)).length;
  const availableCount = roomsData.filter(r => r.status === 'Clean' && !roomsWithIssues.has(r.room_number)).length;

  const C = 2 * Math.PI * 18;
  const pct = n => Math.round(n / total * 100);

  function setRing(id, count) {
    const el = document.getElementById(id);
    if (el) el.style.strokeDasharray = `${((count/total)*C).toFixed(2)} ${C.toFixed(2)}`;
  }
  function setBar(id, count) {
    const el = document.getElementById(id);
    if (el) el.style.width = `${pct(count)}%`;
  }
  function setNum(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    const s = String(value);
    if (el.textContent !== s) {
      el.textContent = s;
      el.classList.remove('updated');
      void el.offsetWidth;
      el.classList.add('updated');
    }
  }
  function setTxt(id, txt) {
    const el = document.getElementById(id);
    if (el) el.textContent = txt;
  }

  setRing('ring-clean', cleanCount);   setBar('bar-clean', cleanCount);
  setNum('stat-clean', cleanCount);    setTxt('stat-clean-total', `/${total}`);
  setTxt('stat-clean-pct', `${pct(cleanCount)}% tozalangan`);

  setRing('ring-occupied', occupiedCount); setBar('bar-occupied', occupiedCount);
  setNum('stat-occupied', occupiedCount);  setTxt('stat-occupied-total', `/${total}`);
  setTxt('stat-occupied-pct', `${pct(occupiedCount)}% band`);

  setRing('ring-ok', okCount);         setBar('bar-ok', okCount);
  setNum('stat-ok', okCount);          setTxt('stat-ok-total', `/${total}`);
  const issues = total - okCount;
  setTxt('stat-ok-pct', issues === 0 ? "Muammo yo'q ✓" : `${issues} ta muammo`);

  setRing('ring-available', availableCount); setBar('bar-available', availableCount);
  setNum('stat-available', availableCount);  setTxt('stat-available-total', `/${total}`);
  setTxt('stat-available-pct', availableCount > 0 ? `${availableCount} ta tayyor` : "Tayyor yo'q");
}

// ── Rooms grid ────────────────────────────────────────────────────
function renderRooms() {
  const grid = document.getElementById('rooms-grid');
  grid.innerHTML = '';
  roomsData.sort((a, b) => a.room_number - b.room_number);

  const filtered = roomsData.filter(room => {
    if (currentFloorFilter === 'all') return true;
    const f = room.floor ?? Math.floor(room.room_number / 100);
    return f === parseInt(currentFloorFilter);
  });

  filtered.forEach(room => {
    const card = document.createElement('div');
    card.className = 'room-card';
    card.setAttribute('data-status', room.status);

    let guestHtml = '';
    if (room.status === 'Occupied' && room.guest_name) {
      guestHtml = `<div class="room-guest-info"><span class="guest-icon">👤</span>${room.guest_name}</div>`;
    }

    const floor = room.floor ?? Math.floor(room.room_number / 100);
    card.innerHTML = `
      <div class="room-card-header">
        <span class="room-num">${room.room_number}</span>
        <span class="room-floor">FL ${floor}</span>
      </div>
      <div class="room-type-lbl">${room.room_type}</div>
      <span class="room-status-badge">${room.status}</span>
      ${guestHtml}
    `;
    grid.appendChild(card);
  });

  updateStatsBar();
}

// ── Right panel: Room Service ─────────────────────────────────────
function renderRSPanel() {
  const container = document.getElementById('rs-list');
  const active = ordersData.filter(o => o.status !== 'Delivered');
  document.getElementById('rs-badge').textContent = `${active.length} faol`;

  if (active.length === 0) {
    container.innerHTML = '<div class="empty-state" style="font-size:0.78rem">Faol buyurtma yo\'q</div>';
    return;
  }
  container.innerHTML = active.slice(0, 8).map(o => `
    <div class="list-item" style="padding:0.4rem 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:0.78rem">
      <span style="color:var(--text-primary);font-weight:600">Xona ${o.room_number}</span> —
      ${o.items.join(', ')} ·
      <span style="color:var(--dirty-color)">${o.status}</span>
    </div>
  `).join('');
}

// ── Right panel: Maintenance ──────────────────────────────────────
function renderMaintPanel() {
  const container = document.getElementById('maint-list');
  const open = issuesData.filter(i => i.status !== 'Resolved');
  const resolved = issuesData.filter(i => i.status === 'Resolved');
  
  document.getElementById('maint-badge').textContent = `${open.length} ta faol`;
  
  let html = '';
  
  // Active issues section
  html += `<div style="font-weight:600;font-size:0.75rem;color:var(--text-secondary);margin-bottom:0.25rem;">Faol nosozliklar:</div>`;
  if (open.length === 0) {
    html += '<div class="empty-state" style="font-size:0.72rem;padding:0.25rem 0;">Muammo yo\'q ✓</div>';
  } else {
    html += open.map(i => `
      <div class="list-item" style="padding:0.4rem 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:0.72rem">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.15rem;">
          <span style="color:var(--text-primary);font-weight:600">Xona ${i.room_number}</span>
          <span class="tag-badge ${i.urgency.toLowerCase()}">${i.urgency}</span>
        </div>
        <div style="color:var(--text-secondary);margin-bottom:0.15rem;word-break:break-all;">${i.description || '—'}</div>
        <div style="font-size:0.65rem;color:var(--text-muted);">
          Holat: <span style="color:${i.status === 'Pending' ? 'var(--dirty-color)' : 'var(--cleaning-color)'}">${i.status}</span>
          ${i.assigned_technician ? ` · 👤 ${i.assigned_technician}` : ''}
        </div>
      </div>
    `).join('');
  }
  
  // Resolved issues section
  html += `<div style="font-weight:600;font-size:0.75rem;color:var(--text-secondary);margin-top:0.75rem;margin-bottom:0.25rem;">Tuzatilganlar:</div>`;
  if (resolved.length === 0) {
    html += '<div class="empty-state" style="font-size:0.72rem;padding:0.25rem 0;">Hozircha yo\'q</div>';
  } else {
    html += resolved.slice(0, 5).map(i => `
      <div class="list-item" style="padding:0.4rem 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:0.72rem;opacity:0.75">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.15rem;">
          <span style="color:var(--text-primary);font-weight:600">Xona ${i.room_number}</span>
          <span style="font-size:0.65rem;color:var(--clean-color);">Tuzatildi ✓</span>
        </div>
        <div style="color:var(--text-muted);text-decoration:line-through;margin-bottom:0.15rem;word-break:break-all;">${i.description || '—'}</div>
        <div style="font-size:0.65rem;color:var(--text-muted);">
          Texnik: ${i.assigned_technician || '—'} · Vaqt: ${formatTime(i.resolved_at)}
        </div>
      </div>
    `).join('');
  }
  
  container.innerHTML = html;
}

// ── Right panel: Housekeeping ─────────────────────────────────────
function renderHKPanel() {
  const container = document.getElementById('hk-list');
  document.getElementById('hk-badge').textContent = `${hkQueue.length} ta`;

  if (hkQueue.length === 0) {
    container.innerHTML = '<div class="empty-state" style="font-size:0.78rem">Tozalash kutmoqda yo\'q ✓</div>';
    return;
  }
  container.innerHTML = hkQueue.slice(0, 8).map(t => `
    <div class="list-item" style="padding:0.4rem 0;border-bottom:1px solid rgba(255,255,255,0.04);font-size:0.78rem">
      <span style="color:var(--text-primary);font-weight:600">Xona ${t.room_number}</span> —
      ${t.housekeeper || '—'} ·
      <span style="color:${t.status === 'Dirty' ? 'var(--dirty-color)' : 'var(--cleaning-color)'}">${t.status}</span>
    </div>
  `).join('');
}

// ── Event log ─────────────────────────────────────────────────────
function addLog(source, payload) {
  const now = new Date().toLocaleTimeString('uz-UZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  logsList.push({ time: now, source, payload });
  if (logsList.length > 200) logsList.shift();
  
  const counter = document.getElementById('log-counter');
  if (counter) counter.textContent = `${logsList.length} ta hodisa`;
  
  renderLogs();
}

function syntaxHighlightJson(jsonObj) {
  let str = JSON.stringify(jsonObj, null, 2);
  str = str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return str.replace(/("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g, function (match) {
    let cls = 'json-number';
    if (/^"/.test(match)) {
      if (/:$/.test(match)) {
        cls = 'json-key';
      } else {
        cls = 'json-string';
      }
    } else if (/true|false/.test(match)) {
      cls = 'json-boolean';
    } else if (/null/.test(match)) {
      cls = 'json-null';
    }
    return '<span class="term-' + cls + '">' + match + '</span>';
  });
}

function renderLogs() {
  const terminal = document.getElementById('event-terminal');
  if (!terminal) return;

  const filtered = logsList.filter(l => {
    if (currentLogFilter === 'all') return true;
    if (currentLogFilter === 'reception') return ['guest_checked_in', 'room_vacated'].includes(l.source);
    if (currentLogFilter === 'room_service') return ['room_service_order_placed', 'room_service_status_changed'].includes(l.source);
    if (currentLogFilter === 'maintenance') return ['maintenance_reported', 'maintenance_status_changed'].includes(l.source);
    if (currentLogFilter === 'housekeeping') return l.source === 'room_status_changed';
    return l.source === currentLogFilter;
  });

  terminal.innerHTML = filtered.map((l, index) => {
    let badgeClass = 'badge-system';
    let badgeText = l.source;
    let messageHtml = '';
    
    if (l.source === 'guest_checked_in') {
      badgeClass = 'badge-reception';
      badgeText = 'RECEPTION';
      messageHtml = `Mehmon <span class="highlight">${l.payload.guest_name}</span> <b>${l.payload.room_number}-xonaga</b> joylashdi (Nights: ${l.payload.nights})`;
    } else if (l.source === 'room_vacated') {
      badgeClass = 'badge-reception';
      badgeText = 'RECEPTION';
      messageHtml = `<b>${l.payload.room_number}-xona</b> bo'shatildi. Jami hisob: <span class="highlight">$${(l.payload.total_bill || 0).toFixed(2)}</span>`;
    } else if (l.source === 'room_status_changed') {
      badgeClass = 'badge-room';
      badgeText = 'ROOM';
      messageHtml = `<b>${l.payload.room_number}-xona</b> holati o'zgardi: <span class="status-pill pill-${l.payload.status.toLowerCase()}">${l.payload.status}</span>`;
    } else if (l.source === 'room_service_order_placed') {
      badgeClass = 'badge-rs';
      badgeText = 'ROOM SERVICE';
      messageHtml = `<b>${l.payload.room_number}-xonadan</b> yangi buyurtma: <span class="highlight">${l.payload.items.join(', ')}</span> ($${(l.payload.total_price || 0).toFixed(2)})`;
    } else if (l.source === 'room_service_status_changed') {
      badgeClass = 'badge-rs';
      badgeText = 'ROOM SERVICE';
      messageHtml = `Buyurtma <code>${l.payload.order_id}</code> holati o'zgardi: <span class="status-pill pill-${l.payload.status.toLowerCase().replace(/ /g, '-')}">${l.payload.status}</span>`;
    } else if (l.source === 'maintenance_reported') {
      badgeClass = 'badge-maint';
      badgeText = 'MAINTENANCE';
      messageHtml = `<b>${l.payload.room_number}-xonadan</b> nosozlik: <i>"${l.payload.description}"</i> (${l.payload.urgency})`;
    } else if (l.source === 'maintenance_status_changed') {
      badgeClass = 'badge-maint';
      badgeText = 'MAINTENANCE';
      messageHtml = `Nosozlik <code>${l.payload.issue_id}</code> holati o'zgardi: <span class="status-pill pill-${l.payload.status === 'Resolved' ? 'clean' : (l.payload.status === 'Assigned' ? 'cleaning' : 'dirty')}">${l.payload.status}</span>`;
    } else {
      messageHtml = typeof l.payload === 'object' ? JSON.stringify(l.payload) : String(l.payload || '');
    }

    const payloadId = `payload-${index}`;
    const hasPayload = typeof l.payload === 'object' && l.payload !== null;
    const payloadHtml = hasPayload 
      ? `<span class="payload-toggle" onclick="document.getElementById('${payloadId}').classList.toggle('hidden')">▶ payload</span>
         <pre id="${payloadId}" class="payload-content hidden">${syntaxHighlightJson(l.payload)}</pre>`
      : '';

    return `
      <div class="log-line">
        <span class="log-time">[${l.time}]</span>
        <span class="log-badge ${badgeClass}">${badgeText}</span>
        <span class="log-msg">${messageHtml}</span>
        ${payloadHtml}
      </div>
    `;
  }).join('');

  const autoScroll = document.getElementById('auto-scroll-chk');
  if (!autoScroll || autoScroll.checked) {
    terminal.scrollTop = terminal.scrollHeight;
  }
}

// ── WS event handler ──────────────────────────────────────────────
function onWsEvent(event) {
  const { event_type, payload } = event;

  // Log everything
  addLog(event_type, payload);

  // Update local state
  if (event_type === 'guest_checked_in') {
    const room = roomsData.find(r => r.room_number === payload.room_number);
    if (room) {
      room.status = 'Occupied';
      room.guest_name = payload.guest_name;
    }
    renderRooms();
  }

  if (event_type === 'room_vacated') {
    const room = roomsData.find(r => r.room_number === payload.room_number);
    if (room) {
      room.status = 'Dirty';
      room.guest_name = null;
    }
    renderRooms();
    renderHKPanel();
  }

  if (event_type === 'room_status_changed') {
    const room = roomsData.find(r => r.room_number === payload.room_number);
    if (room) {
      room.status = payload.status;
      if (payload.last_cleaned_time) room.last_cleaned_time = payload.last_cleaned_time;
    }
    // Refresh HK queue
    api(`${URLS.housekeeping}/queue`).then(async r => {
      if (r.ok) { hkQueue = await r.json(); renderHKPanel(); }
    }).catch(() => {});
    renderRooms();
  }

  if (event_type === 'room_service_order_placed') {
    ordersData.push(payload);
    renderRSPanel();
  }
  if (event_type === 'room_service_status_changed') {
    const order = ordersData.find(o => o.order_id === payload.order_id);
    if (order) order.status = payload.status;
    if (payload.status === 'Delivered') {
      const room = roomsData.find(r => r.room_number === payload.room_number);
      if (room) room.room_service_charges += payload.total_price || 0;
    }
    renderRSPanel();
    renderRooms();
  }

  if (event_type === 'maintenance_reported') {
    issuesData.push(payload);
    renderMaintPanel();
    updateStatsBar();
  }
  if (event_type === 'maintenance_status_changed') {
    const issue = issuesData.find(i => i.issue_id === payload.issue_id);
    if (issue) {
      issue.status = payload.status;
      if (payload.assigned_technician) issue.assigned_technician = payload.assigned_technician;
      if (payload.resolved_at) issue.resolved_at = payload.resolved_at;
    } else {
      issuesData.push(payload);
    }
    renderMaintPanel();
    updateStatsBar();
  }
}
