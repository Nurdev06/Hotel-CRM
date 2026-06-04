// ================================================================
// HotelOS — Maintenance Dashboard Logic
// ================================================================

let issuesData = [];

document.addEventListener('DOMContentLoaded', () => {
  requireStaffAuth(init);
});

function init() {
  renderNavBar('maintenance');
  document.getElementById('maint-app').classList.remove('hidden');

  // Restore technician name
  const saved = localStorage.getItem('maint_tech_name');
  if (saved) document.getElementById('maint-tech-name').value = saved;
  document.getElementById('maint-tech-name').addEventListener('input', (e) => {
    localStorage.setItem('maint_tech_name', e.target.value.trim());
  });

  fetchIssues();
  connectWS('*', onWsEvent, updateNavWS);
}

// ── Fetch data ────────────────────────────────────────────────────
async function fetchIssues() {
  try {
    const res = await api(`${URLS.maintenance}/issues`);
    if (res.ok) {
      issuesData = await res.json();
      render();
    } else {
      showToast('⚠️', 'Xato', 'Muammolar ro\'yxatini yuklab bo\'lmadi', 'error');
    }
  } catch (e) {
    showToast('⚠️', 'Xato', 'Xizmatlarga ulanib bo\'lmadi', 'error');
  }
}

// ── Render ─────────────────────────────────────────────────────────
function render() {
  renderStats();
  renderPending();
  renderAssigned();
  renderResolved();
}

function renderStats() {
  const pending  = issuesData.filter(i => i.status === 'Pending').length;
  const assigned = issuesData.filter(i => i.status === 'Assigned').length;
  const resolved = issuesData.filter(i => i.status === 'Resolved').length;

  document.getElementById('maint-pending').textContent  = pending;
  document.getElementById('maint-assigned').textContent = assigned;
  document.getElementById('maint-resolved').textContent = resolved;
}

// ── Pending issues list ───────────────────────────────────────────
function renderPending() {
  const container = document.getElementById('pending-list');
  const pending = issuesData.filter(i => i.status === 'Pending');
  document.getElementById('pending-count').textContent = pending.length;

  if (pending.length === 0) {
    container.innerHTML = '<div class="empty-state">Hozircha kutilayotgan muammo yo\'q ✨</div>';
    return;
  }

  container.innerHTML = pending.map(i => `
    <div class="task-card">
      <div class="task-card-icon">🟡</div>
      <div class="task-card-body">
        <div class="task-card-title">Xona ${i.room_number}</div>
        <div class="task-card-meta">
          <span class="tag-badge ${i.urgency.toLowerCase()}">${i.urgency}</span> · 
          ${timeAgo(i.created_at)}
        </div>
        <div class="task-card-desc" style="font-size:0.8rem;color:var(--text-secondary);margin-top:0.25rem">${i.description}</div>
      </div>
      <div class="task-card-actions">
        <button class="btn-action-small" onclick="assignIssue('${i.issue_id}')">🔧 Biriktirish</button>
      </div>
    </div>
  `).join('');
}

// ── Assigned issues list ──────────────────────────────────────────
function renderAssigned() {
  const container = document.getElementById('assigned-list');
  const assigned = issuesData.filter(i => i.status === 'Assigned');
  document.getElementById('assigned-count').textContent = assigned.length;

  if (assigned.length === 0) {
    container.innerHTML = '<div class="empty-state">Hozircha bajarilayotgan ish yo\'q</div>';
    return;
  }

  container.innerHTML = assigned.map(i => `
    <div class="task-card">
      <div class="task-card-icon">🔵</div>
      <div class="task-card-body">
        <div class="task-card-title">Xona ${i.room_number}</div>
        <div class="task-card-meta">
          <span class="tag-badge ${i.urgency.toLowerCase()}">${i.urgency}</span> · 
          👤 ${i.assigned_technician || 'Noma\'lum'}
        </div>
        <div class="task-card-desc" style="font-size:0.8rem;color:var(--text-secondary);margin-top:0.25rem">${i.description}</div>
      </div>
      <div class="task-card-actions">
        <button class="btn-action-small" onclick="resolveIssue('${i.issue_id}')">✅ Yakunlash</button>
      </div>
    </div>
  `).join('');
}

// ── Resolved issues list ──────────────────────────────────────────
function renderResolved() {
  const container = document.getElementById('resolved-list');
  const resolved = issuesData.filter(i => i.status === 'Resolved');
  document.getElementById('resolved-count').textContent = resolved.length;

  if (resolved.length === 0) {
    container.innerHTML = '<div class="empty-state">Bugun tuzatilgan muammolar yo\'q</div>';
    return;
  }

  container.innerHTML = resolved.map(i => `
    <div class="task-card" style="opacity:0.7">
      <div class="task-card-icon">🟢</div>
      <div class="task-card-body">
        <div class="task-card-title">Xona ${i.room_number}</div>
        <div class="task-card-meta">
          👤 ${i.assigned_technician || '—'} · 
          Tuzatildi: ${formatTime(i.resolved_at)}
        </div>
        <div class="task-card-desc" style="font-size:0.8rem;color:var(--text-muted);margin-top:0.25rem">${i.description}</div>
      </div>
    </div>
  `).join('');
}

// ── Assign issue to technician ─────────────────────────────────────
async function assignIssue(issueId) {
  const techName = document.getElementById('maint-tech-name').value.trim();
  if (!techName) {
    showToast('⚠️', 'Xato', 'Iltimos, texnik ismini kiriting', 'error');
    document.getElementById('maint-tech-name').focus();
    return;
  }

  try {
    const res = await api(`${URLS.maintenance}/issues/${issueId}/assign?technician_name=${encodeURIComponent(techName)}`, {
      method: 'POST',
    });
    if (res.ok) {
      showToast('🔧', 'Ish biriktirildi', `Texnik: ${techName}`, 'success', 3000);
      fetchIssues();
    } else {
      const data = await res.json();
      showToast('❌', 'Xato', parseErrorDetail(data.detail), 'error');
    }
  } catch (err) {
    showToast('❌', 'Xato', err.message, 'error');
  }
}

// ── Resolve issue ──────────────────────────────────────────────────
async function resolveIssue(issueId) {
  try {
    const res = await api(`${URLS.maintenance}/issues/${issueId}/resolve`, {
      method: 'POST',
    });
    if (res.ok) {
      showToast('✅', 'Muammo tuzatildi', 'Xona holati "Clean" qilib belgilandi', 'success', 3000);
      fetchIssues();
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

  if (event_type === 'maintenance_reported') {
    showToast('🔧', 'Yangi nosozlik xabari!', `Xona ${payload.room_number} — ${payload.urgency} darajada`, 'info', 8000);
    fetchIssues();
  }

  if (event_type === 'maintenance_status_changed' || event_type === 'room_status_changed') {
    fetchIssues();
  }
}
