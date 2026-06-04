// ================================================================
// HotelOS — Guest Portal Login Logic
// ================================================================

document.addEventListener('DOMContentLoaded', () => {
  // If already authenticated, redirect directly to dashboard
  const saved = sessionStorage.getItem('guest_session');
  if (saved) {
    location.href = 'guest-dashboard.html';
    return;
  }

  const btn = document.getElementById('gl-btn');
  if (btn) btn.onclick = doLogin;

  const roomInput = document.getElementById('gl-room');
  const nameInput = document.getElementById('gl-name');
  if (roomInput) roomInput.onkeypress = e => { if (e.key === 'Enter') doLogin(); };
  if (nameInput) nameInput.onkeypress = e => { if (e.key === 'Enter') doLogin(); };

  loadOccupiedRoomsHelper();
});

async function loadOccupiedRoomsHelper() {
  const listEl = document.getElementById('gl-occupied-list');
  if (!listEl) return;

  try {
    const res = await fetch(`${URLS.reception}/rooms/public`);
    if (!res.ok) throw new Error();
    const rooms = await res.json();
    const occupied = rooms.filter(r => r.status === 'Occupied');

    if (occupied.length === 0) {
      listEl.innerHTML = '<span style="font-size:0.72rem;color:var(--text-muted)">Hozirda band xona yo\'q</span>';
      return;
    }

    listEl.innerHTML = occupied.map(r => `
      <span class="tag-badge" style="cursor:pointer;padding:0.25rem 0.45rem;border-radius:6px;background:rgba(168,85,247,0.12);color:#c084fc;font-size:0.72rem;text-transform:none;" onclick="selectHelperRoom(${r.room_number}, '${r.guest_name}')">
        Xona ${r.room_number} (${r.guest_name})
      </span>
    `).join('');
  } catch (err) {
    listEl.innerHTML = '<span style="font-size:0.72rem;color:#ef4444">Yuklashda xatolik yuz berdi</span>';
  }
}

function selectHelperRoom(roomNum, guestName) {
  const rInput = document.getElementById('gl-room');
  const nInput = document.getElementById('gl-name');
  if (rInput) rInput.value = roomNum;
  if (nInput) nInput.value = guestName;
}

async function doLogin() {
  const errEl = document.getElementById('gl-error');
  try {
    const roomNum = parseInt(document.getElementById('gl-room').value);
    const name    = document.getElementById('gl-name').value.trim();
    errEl.classList.add('hidden');

    if (!roomNum || !name) {
      errEl.textContent = 'Iltimos, xona raqami va ismingizni kiriting.';
      errEl.classList.remove('hidden');
      return;
    }

    const url = `${URLS.reception}/rooms/public`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Reception xizmatiga ulanib bo\'lmadi');
    const rooms = await res.json();

    const room = rooms.find(r => r.room_number === roomNum);
    if (!room) {
      errEl.textContent = `Xona ${roomNum} topilmadi.`;
      errEl.classList.remove('hidden');
      return;
    }
    if (room.status !== 'Occupied') {
      errEl.textContent = `Xona ${roomNum} hozir bo'sh. Avval reception dan check-in qiling.`;
      errEl.classList.remove('hidden');
      return;
    }
    if (room.guest_name && room.guest_name.toLowerCase() !== name.toLowerCase()) {
      errEl.textContent = 'Ism mos kelmaydi. Check-in da kiritilgan ismni yozing.';
      errEl.classList.remove('hidden');
      return;
    }

    // Success
    const guestSession = { room_number: roomNum, guest_name: room.guest_name || name };
    sessionStorage.setItem('guest_session', JSON.stringify(guestSession));
    location.href = 'guest-dashboard.html';

  } catch (err) {
    console.error(err);
    errEl.textContent = `Ulanish xatosi: ${err.message}.`;
    errEl.classList.remove('hidden');
  }
}
