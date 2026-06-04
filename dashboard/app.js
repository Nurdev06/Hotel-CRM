// --- Service Ports and Configuration ---
const RECEPTION_URL = "http://localhost:8001";
const ROOM_SERVICE_URL = "http://localhost:8002";
const MAINTENANCE_URL = "http://localhost:8003";
const HOUSEKEEPING_URL = "http://localhost:8004";
const BROKER_WS_URL = "ws://localhost:8000/ws";

let authToken = "";
let roomsData = [];
let ordersData = [];
let issuesData = [];
let housekeepingQueue = [];
let wsConn = null;

// Filtering states for 120-room management
let currentFloorFilter = "all";
let currentLogFilter = "all";
let logsList = [];

// --- Helper: Parse API error detail (Pydantic v2 returns arrays of objects) ---
function parseErrorDetail(detail) {
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) {
        return detail.map(e => {
            const loc = e.loc ? e.loc.join(" → ") : "";
            return loc ? `${loc}: ${e.msg}` : (e.msg || JSON.stringify(e));
        }).join("\n");
    }
    return JSON.stringify(detail);
}

// --- Toast Notification System ---
function showToast(icon, title, message, type = "info", durationMs = 5000) {
    let container = document.getElementById("toast-container");
    if (!container) {
        container = document.createElement("div");
        container.id = "toast-container";
        document.body.appendChild(container);
    }

    const toast = document.createElement("div");
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

    // Animate progress bar
    const progress = toast.querySelector(".toast-progress");
    progress.style.transition = `width ${durationMs}ms linear`;
    requestAnimationFrame(() => {
        requestAnimationFrame(() => { progress.style.width = "0%"; });
    });

    // Slide in
    requestAnimationFrame(() => toast.classList.add("toast-show"));

    // Auto-remove
    setTimeout(() => {
        toast.classList.remove("toast-show");
        toast.addEventListener("transitionend", () => toast.remove(), { once: true });
    }, durationMs);
}

// --- DOM Elements ---
const authModal = document.getElementById("auth-modal");
const authTokenInput = document.getElementById("auth-token");
const authBtn = document.getElementById("auth-btn");
const authError = document.getElementById("auth-error");
const dashboardContainer = document.getElementById("dashboard-container");
const wsIndicator = document.getElementById("ws-indicator");
const wsStatusText = document.getElementById("ws-status-text");

const roomsGrid = document.getElementById("rooms-grid-container");
const rsOrderContainer = document.getElementById("rs-order-container");
const maintIssueContainer = document.getElementById("maint-issue-container");
const rsCountBadge = document.getElementById("rs-count");
const maintCountBadge = document.getElementById("maint-count");

const eventTerminal = document.getElementById("event-terminal");
const clearLogsBtn = document.getElementById("clear-logs");
const hkButtonsContainer = document.getElementById("hk-buttons-container");

// Room dropdowns in simulator
const roomSelectors = document.querySelectorAll(".room-selector");

// --- Initialization & Auth Check ---
document.addEventListener("DOMContentLoaded", () => {
    // Check localStorage for token
    const cachedToken = localStorage.getItem("hotel_os_token");
    if (cachedToken === "admin_hotel_os") {
        authToken = cachedToken;
        authModal.classList.add("hidden");
        dashboardContainer.classList.remove("hidden");
        startDashboard();
    } else {
        // Show auth modal
        authModal.classList.remove("hidden");
    }
});

authBtn.addEventListener("click", performAuth);
authTokenInput.addEventListener("keypress", (e) => {
    if (e.key === "Enter") performAuth();
});

function performAuth() {
    const entered = authTokenInput.value.trim();
    if (entered === "admin_hotel_os") {
        authToken = entered;
        localStorage.setItem("hotel_os_token", entered);
        authModal.classList.add("hidden");
        dashboardContainer.classList.remove("hidden");
        authError.classList.add("hidden");
        startDashboard();
    } else {
        authError.classList.remove("hidden");
    }
}

// --- Start System Services & Sync ---
async function startDashboard() {
    setupTabs();
    setupFloorFilters();
    setupLogFilters();
    await fetchInitialState();
    connectToMessageBroker();
    setupSimulatorForms();
}

async function fetchInitialState() {
    try {
        const headers = { "Authorization": authToken };
        
        // Fetch rooms
        const roomsRes = await fetch(`${RECEPTION_URL}/rooms`, { headers });
        if (roomsRes.ok) roomsData = await roomsRes.json();
        
        // Fetch room service orders
        const ordersRes = await fetch(`${ROOM_SERVICE_URL}/orders`, { headers });
        if (ordersRes.ok) ordersData = await ordersRes.json();
        
        // Fetch maintenance issues
        const issuesRes = await fetch(`${MAINTENANCE_URL}/issues`, { headers });
        if (issuesRes.ok) issuesData = await issuesRes.json();
        
        // Fetch housekeeping cleaning queue
        const hkRes = await fetch(`${HOUSEKEEPING_URL}/queue`, { headers });
        if (hkRes.ok) housekeepingQueue = await hkRes.json();
        
        // Render current data
        renderRooms();
        renderRoomServiceQueue();
        renderMaintenanceQueue();
        renderHousekeepingSection();
        updateRoomSelectors();
        updateStatsBar();
        
        appendTerminalLog("SYSTEM", "Initialized state successfully from all microservices.");
    } catch (err) {
        console.error("Error fetching state:", err);
        appendTerminalLog("ERROR", `Failed to fetch initial state. Make sure all backend services are running. Details: ${err.message}`);
    }
}

// --- WebSocket Live Connection ---
function connectToMessageBroker() {
    wsIndicator.className = "status-indicator";
    wsStatusText.textContent = "Connecting to broker...";
    
    // Subscribe to all events using '*' wildcard parameter
    wsConn = new WebSocket(`${BROKER_WS_URL}?topics=*`);
    
    wsConn.onopen = () => {
        wsIndicator.className = "status-indicator online";
        wsStatusText.textContent = "Live Stream Connected";
        appendTerminalLog("WS", "WebSocket channel successfully opened with Message Broker.");
    };
    
    wsConn.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleBrokerEvent(data);
        } catch (e) {
            console.error("Failed to parse event:", e);
        }
    };
    
    wsConn.onclose = () => {
        wsIndicator.className = "status-indicator offline";
        wsStatusText.textContent = "Disconnected (Retrying...)";
        appendTerminalLog("WS", "Disconnected from Message Broker. Reconnecting in 3 seconds...");
        setTimeout(connectToMessageBroker, 3000);
    };
    
    wsConn.onerror = (err) => {
        console.error("WebSocket Error:", err);
    };
}

// --- Event Processing Engine ---
function handleBrokerEvent(event) {
    const type = event.event_type;
    const payload = event.payload;
    
    appendTerminalLog(type, JSON.stringify(payload, null, 2));
    
    if (type === "room_status_changed") {
        // Sync local room details
        const room = roomsData.find(r => r.room_number === payload.room_number);
        if (room) {
            room.status = payload.status;
            if (payload.guest_name !== undefined) room.guest_name = payload.guest_name;
            if (payload.status === "Clean") {
                room.room_service_charges = 0.0; // Reset charges
            }
        } else {
            // Room does not exist in cached list, refresh
            fetchInitialState();
            return;
        }
        
        // If clean, it removes from housekeeping queue locally
        if (payload.status === "Clean") {
            housekeepingQueue = housekeepingQueue.filter(t => t.room_number !== payload.room_number);
        } else if (payload.status === "Being cleaned" || payload.status === "Dirty") {
            // Sync status in cleaning queue
            const hkTask = housekeepingQueue.find(t => t.room_number === payload.room_number);
            if (hkTask) {
                hkTask.status = payload.status;
                if (payload.housekeeper_name) hkTask.housekeeper = payload.housekeeper_name;
            } else {
                housekeepingQueue.push({
                    room_number: payload.room_number,
                    status: payload.status,
                    housekeeper: payload.housekeeper_name || null
                });
            }
        }
        
        renderRooms();
        renderHousekeepingSection();
        updateRoomSelectors();
    }
    
    else if (type === "room_vacated") {
        const roomNum = payload.room_number;
        const guestName = payload.guest_name || "Guest";

        // Immediately add to local housekeeping queue (don't wait for secondary event)
        const alreadyQueued = housekeepingQueue.some(t => t.room_number === roomNum);
        if (!alreadyQueued) {
            housekeepingQueue.push({
                room_number: roomNum,
                status: "Dirty",
                housekeeper: null,
                timestamp: Date.now() / 1000
            });
        }

        // Update room status locally too
        const room = roomsData.find(r => r.room_number === roomNum);
        if (room) {
            room.status = "Dirty";
            room.guest_name = null;
        }

        // Re-render affected panels
        renderRooms();
        renderHousekeepingSection();
        updateRoomSelectors();

        // Log to terminal
        appendTerminalLog("HOUSEKEEPING",
            `🧹 Room ${roomNum} vacated by ${guestName} → Cleaning task auto-assigned to Housekeeping queue.`);

        // Show prominent toast notification
        showToast(
            "🧹",
            `Housekeeping Task — Room ${roomNum}`,
            `${guestName} checked out. Room marked Dirty and added to cleaning queue.`,
            "housekeeping",
            7000
        );
    }
    
    else if (type === "room_service_order_placed") {
        // Add new order
        ordersData.push(payload);
        renderRoomServiceQueue();
    }
    
    else if (type === "room_service_status_changed") {
        // Sync order status
        const order = ordersData.find(o => o.order_id === payload.order_id);
        if (order) {
            order.status = payload.status;
        }
        // If status is Delivered, update room's charges in memory (since reception does this too)
        if (payload.status === "Delivered") {
            const room = roomsData.find(r => r.room_number === payload.room_number);
            if (room) {
                room.room_service_charges += payload.total_price;
            }
        }
        renderRooms();
        renderRoomServiceQueue();
    }
    
    else if (type === "maintenance_reported") {
        // Add new issue
        issuesData.push(payload);
        renderMaintenanceQueue();
    }
    
    else if (type === "maintenance_status_changed") {
        const issue = issuesData.find(i => i.issue_id === payload.issue_id);
        if (issue) {
            issue.status = payload.status;
            if (payload.assigned_technician) issue.assigned_technician = payload.assigned_technician;
        }
        renderMaintenanceQueue();
    }
}

// --- Receptionist Stats Bar ---
function updateStatsBar() {
    const total = roomsData.length;
    if (total === 0) return;

    // Rooms with any open (non-Resolved) maintenance issue
    const roomsWithIssues = new Set(
        issuesData
            .filter(i => i.status !== "Resolved")
            .map(i => i.room_number)
    );

    const cleanCount     = roomsData.filter(r => r.status === "Clean").length;
    const occupiedCount  = roomsData.filter(r => r.status === "Occupied").length;
    const okCount        = roomsData.filter(r => !roomsWithIssues.has(r.room_number)).length;
    const availableCount = roomsData.filter(r => r.status === "Clean" && !roomsWithIssues.has(r.room_number)).length;

    const circumference = 2 * Math.PI * 18; // r=18 → ~113.1

    function pct(n) { return Math.round(n / total * 100); }

    function animateRing(ringId, count) {
        const el = document.getElementById(ringId);
        if (!el) return;
        const filled = (count / total) * circumference;
        el.style.strokeDasharray = `${filled.toFixed(2)} ${circumference.toFixed(2)}`;
    }

    function animateBar(barId, count) {
        const el = document.getElementById(barId);
        if (el) el.style.width = `${pct(count)}%`;
    }

    function setNum(id, value) {
        const el = document.getElementById(id);
        if (!el) return;
        const str = String(value);
        if (el.textContent !== str) {
            el.textContent = str;
            el.classList.remove("updated");
            void el.offsetWidth;
            el.classList.add("updated");
        }
    }

    function setTotal(id, value) {
        const el = document.getElementById(id);
        if (el) el.textContent = `/${value}`;
    }

    function setPct(id, text) {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    }

    // Clean
    animateRing("ring-clean",     cleanCount);
    animateBar ("bar-clean",      cleanCount);
    setNum     ("stat-clean",     cleanCount);
    setTotal   ("stat-clean-total", total);
    setPct     ("stat-clean-pct", `${pct(cleanCount)}% tozalangan`);

    // Occupied
    animateRing("ring-occupied",  occupiedCount);
    animateBar ("bar-occupied",   occupiedCount);
    setNum     ("stat-occupied",  occupiedCount);
    setTotal   ("stat-occupied-total", total);
    setPct     ("stat-occupied-pct", `${pct(occupiedCount)}% band`);

    // Equipment OK
    animateRing("ring-ok",        okCount);
    animateBar ("bar-ok",         okCount);
    setNum     ("stat-ok",        okCount);
    setTotal   ("stat-ok-total",  total);
    const issueCount = total - okCount;
    setPct     ("stat-ok-pct",    issueCount === 0 ? "Muammo yo'q ✓" : `${issueCount} ta xonada muammo`);

    // Available (clean + no issues)
    animateRing("ring-available",  availableCount);
    animateBar ("bar-available",   availableCount);
    setNum     ("stat-available",  availableCount);
    setTotal   ("stat-available-total", total);
    setPct     ("stat-available-pct", availableCount > 0 ? `${availableCount} ta xona tayyor` : "Tayyor xona yo'q");
}

// --- Render Helper Functions ---
function renderRooms() {
    roomsGrid.innerHTML = "";
    
    // Sort room data
    roomsData.sort((a,b) => a.room_number - b.room_number);
    
    // Filter rooms by selected floor with mathematical fallback if floor field is missing
    const filteredRooms = roomsData.filter(room => {
        if (currentFloorFilter === "all") return true;
        
        // Defensive check: if backend didn't supply floor, compute it from room number (e.g. 204 -> Floor 2)
        const roomFloor = room.floor !== undefined ? room.floor : Math.floor(room.room_number / 100);
        return roomFloor === parseInt(currentFloorFilter);
    });
    
    filteredRooms.forEach(room => {
        const card = document.createElement("div");
        card.className = "room-card";
        card.setAttribute("data-status", room.status);
        
        let guestInfoHtml = "";
        if (room.status === "Occupied") {
            guestInfoHtml = `
                <div class="room-guest">👤 ${room.guest_name}</div>
                <div class="room-details-text">Bills: $${room.room_service_charges.toFixed(2)} (RS)</div>
            `;
        } else {
            guestInfoHtml = `<div class="room-guest" style="opacity:0.4;">Vacant</div>`;
        }
        
        const displayFloor = room.floor !== undefined ? room.floor : Math.floor(room.room_number / 100);
        
        card.innerHTML = `
            <div class="room-card-header">
                <span class="room-num">${room.room_number}</span>
                <span class="room-floor">FL ${displayFloor}</span>
            </div>
            <div class="room-type-lbl">${room.room_type} | Prox: ${room.proximity}</div>
            <span class="room-status-badge">${room.status}</span>
            ${guestInfoHtml}
        `;
        roomsGrid.appendChild(card);
    });
    updateStatsBar();
}

function renderRoomServiceQueue() {
    rsOrderContainer.innerHTML = "";
    // Filter active orders (not delivered)
    const active = ordersData.filter(o => o.status !== "Delivered");
    rsCountBadge.textContent = `${active.length} Active`;
    
    if (active.length === 0) {
        rsOrderContainer.innerHTML = `<div class="empty-state">No active room service orders.</div>`;
        return;
    }
    
    // Sort oldest first (FIFO)
    active.sort((a,b) => a.timestamp - b.timestamp);
    
    active.forEach(order => {
        const div = document.createElement("div");
        div.className = "list-item";
        
        let nextBtnHtml = "";
        if (order.status === "Received") {
            nextBtnHtml = `<button onclick="progressRSOrder('${order.order_id}')" class="btn-action-small">Prepare</button>`;
        } else if (order.status === "Preparing") {
            nextBtnHtml = `<button onclick="progressRSOrder('${order.order_id}')" class="btn-action-small">Deliver</button>`;
        } else if (order.status === "Out for delivery") {
            nextBtnHtml = `<button onclick="progressRSOrder('${order.order_id}')" class="btn-action-small">Mark Delivered</button>`;
        }
        
        div.innerHTML = `
            <div class="item-info">
                <span class="item-title">Room ${order.room_number} — ID: ${order.order_id}</span>
                <span class="item-subtitle">${order.items.join(", ")}</span>
                <span class="item-meta">Total: $${order.total_price.toFixed(2)} | Status: <strong>${order.status}</strong></span>
            </div>
            <div class="item-actions">
                ${nextBtnHtml}
            </div>
        `;
        rsOrderContainer.appendChild(div);
    });
}

function renderMaintenanceQueue() {
    maintIssueContainer.innerHTML = "";
    const active = issuesData.filter(i => i.status !== "Resolved");
    maintCountBadge.textContent = `${active.length} Open`;
    
    if (active.length === 0) {
        maintIssueContainer.innerHTML = `<div class="empty-state">No open maintenance issues.</div>`;
        return;
    }
    
    // Renders sorted list based on priority (done on server but sort just in case)
    // Critical = 4, High = 3, etc.
    const priorityMap = { "Critical": 4, "High": 3, "Normal": 2, "Low": 1 };
    active.sort((a,b) => {
        const diff = priorityMap[b.urgency] - priorityMap[a.urgency];
        if (diff !== 0) return diff;
        return a.created_at - b.created_at;
    });
    
    active.forEach(issue => {
        const div = document.createElement("div");
        div.className = "list-item";
        
        let actionBtnHtml = "";
        if (issue.status === "Pending") {
            actionBtnHtml = `<button onclick="assignTechnician('${issue.issue_id}')" class="btn-action-small">Assign Tech</button>`;
        } else if (issue.status === "Assigned") {
            actionBtnHtml = `<button onclick="resolveIssue('${issue.issue_id}')" class="btn-action-small">Resolve</button>`;
        }
        
        const urgencyClass = issue.urgency.toLowerCase();
        
        div.innerHTML = `
            <div class="item-info">
                <span class="item-title">Room ${issue.room_number} — <span class="tag-badge ${urgencyClass}">${issue.urgency}</span></span>
                <span class="item-subtitle">${issue.description}</span>
                <span class="item-meta">Status: <strong>${issue.status}</strong> ${issue.assigned_technician ? `(Assigned: ${issue.assigned_technician})` : ""}</span>
            </div>
            <div class="item-actions">
                ${actionBtnHtml}
            </div>
        `;
        maintIssueContainer.appendChild(div);
    });
    updateStatsBar();
}

function renderHousekeepingSection() {
    hkButtonsContainer.innerHTML = "";
    
    // Find rooms that need cleaning in roomsData (status Dirty or Being cleaned)
    const dirtyRooms = roomsData.filter(r => r.status === "Dirty" || r.status === "Being cleaned");
    
    if (dirtyRooms.length === 0) {
        hkButtonsContainer.innerHTML = `<div class="empty-state" style="width:100%;">No rooms need cleaning.</div>`;
        return;
    }
    
    dirtyRooms.forEach(room => {
        const btn = document.createElement("div");
        const isDirty = room.status === "Dirty";
        btn.className = `hk-room-btn ${isDirty ? 'dirty' : 'cleaning'}`;
        
        if (isDirty) {
            btn.innerHTML = `
                <span>Room ${room.room_number}</span>
                <span class="hk-btn-sub">Click to Clean</span>
            `;
            btn.onclick = () => startCleaningRoom(room.room_number);
        } else {
            btn.innerHTML = `
                <span>Room ${room.room_number}</span>
                <span class="hk-btn-sub">Click to Finish</span>
            `;
            btn.onclick = () => finishCleaningRoom(room.room_number);
        }
        hkButtonsContainer.appendChild(btn);
    });
}

function updateRoomSelectors() {
    // Rooms selectors in checkout, roomservice, and maintenance forms
    roomSelectors.forEach(select => {
        const currentVal = select.value;
        select.innerHTML = "";
        
        // Add all rooms
        roomsData.sort((a,b) => a.room_number - b.room_number).forEach(r => {
            const opt = document.createElement("option");
            opt.value = r.room_number;
            
            let statusSuffix = "";
            if (select.id === "co-room") {
                // Checkout: only rooms that are Occupied
                if (r.status !== "Occupied") return;
            } else if (select.id === "rs-room") {
                // Room service: only occupied
                if (r.status !== "Occupied") return;
            }
            
            opt.textContent = `Room ${r.room_number} (${r.status})`;
            select.appendChild(opt);
        });
        
        if (currentVal) select.value = currentVal;
    });
}

// --- Action Functions (API Calls) ---

async function progressRSOrder(orderId) {
    try {
        const res = await fetch(`${ROOM_SERVICE_URL}/orders/${orderId}/progress`, {
            method: "POST",
            headers: { "Authorization": authToken }
        });
        if (!res.ok) {
            const err = await res.json();
            alert(`Error: ${err.detail}`);
        }
    } catch (e) {
        alert(`Failed: ${e.message}`);
    }
}

async function assignTechnician(issueId) {
    const tech = prompt("Enter Technician Name:", "Tech Dave");
    if (!tech) return;
    try {
        const res = await fetch(`${MAINTENANCE_URL}/issues/${issueId}/assign?technician_name=${encodeURIComponent(tech)}`, {
            method: "POST",
            headers: { "Authorization": authToken }
        });
        if (!res.ok) {
            const err = await res.json();
            alert(`Error: ${err.detail}`);
        }
    } catch (e) {
        alert(`Failed: ${e.message}`);
    }
}

async function resolveIssue(issueId) {
    try {
        const res = await fetch(`${MAINTENANCE_URL}/issues/${issueId}/resolve`, {
            method: "POST",
            headers: { "Authorization": authToken }
        });
        if (!res.ok) {
            const err = await res.json();
            alert(`Error: ${err.detail}`);
        }
    } catch (e) {
        alert(`Failed: ${e.message}`);
    }
}

async function startCleaningRoom(roomNum) {
    const hkName = prompt("Enter Housekeeper Name:", "Housekeeper Jane");
    if (!hkName) return;
    try {
        const res = await fetch(`${HOUSEKEEPING_URL}/start-cleaning/${roomNum}?housekeeper_name=${encodeURIComponent(hkName)}`, {
            method: "POST",
            headers: { "Authorization": authToken }
        });
        if (!res.ok) {
            const err = await res.json();
            alert(`Error: ${err.detail}`);
        }
    } catch (e) {
        alert(`Failed: ${e.message}`);
    }
}

async function finishCleaningRoom(roomNum) {
    try {
        const res = await fetch(`${HOUSEKEEPING_URL}/finish-cleaning/${roomNum}`, {
            method: "POST",
            headers: { "Authorization": authToken }
        });
        if (!res.ok) {
            const err = await res.json();
            alert(`Error: ${err.detail}`);
        }
    } catch (e) {
        alert(`Failed: ${e.message}`);
    }
}

// --- Form Submissions Handler ---
function setupSimulatorForms() {
    // Check-in Form
    document.getElementById("checkin-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const payload = {
            guest_name: document.getElementById("ci-guest").value,
            room_type: document.getElementById("ci-type").value,
            nights: parseInt(document.getElementById("ci-nights").value),
            proximity_preference: document.getElementById("ci-prox").value
        };
        const floor = document.getElementById("ci-floor").value;
        if (floor) payload.floor_preference = parseInt(floor);
        
        try {
            const res = await fetch(`${RECEPTION_URL}/check-in`, {
                method: "POST",
                headers: { 
                    "Content-Type": "application/json",
                    "Authorization": authToken 
                },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (res.ok) {
                alert(`Checked in successfully! Assigned Room: ${data.room_number}`);
                document.getElementById("ci-guest").value = "";
            } else {
                alert(`Check-in failed: ${parseErrorDetail(data.detail)}`);
            }
        } catch (err) {
            alert(`Network error: ${err.message}`);
        }
    });

    // Check-out Form
    document.getElementById("checkout-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const roomNum = document.getElementById("co-room").value;
        const discount = document.getElementById("co-discount").value;
        const late = document.getElementById("co-late").checked;
        
        if (!roomNum) {
            alert("No occupied rooms to check out.");
            return;
        }
        
        let url = `${RECEPTION_URL}/check-out/${roomNum}?late_checkout=${late}`;
        if (discount) url += `&discount_code=${discount}`;
        
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "Authorization": authToken }
            });
            const data = await res.json();
            if (res.ok) {
                // Show Invoice Breakdown in Simulator panel
                const invoiceBox = document.getElementById("invoice-modal");
                invoiceBox.classList.remove("hidden");
                invoiceBox.innerHTML = `
                    <strong>Invoice Breakdown — Room ${data.room_number}</strong><br>
                    Guest: ${data.guest_name}<br>
                    <hr style="margin: 0.4rem 0; border-color: rgba(16,185,129,0.3);">
                    ${data.breakdown_details.join("<br>")}
                `;
                document.getElementById("co-late").checked = false;
                document.getElementById("co-discount").value = "";
            } else {
                alert(`Check-out failed: ${parseErrorDetail(data.detail)}`);
            }
        } catch (err) {
            alert(`Network error: ${err.message}`);
        }
    });

    // Room Service Order Form
    document.getElementById("rs-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const roomNum = document.getElementById("rs-room").value;
        const selectedItems = Array.from(document.querySelectorAll("input[name='rs-items']:checked")).map(el => el.value);
        
        if (!roomNum) {
            alert("No occupied rooms to order room service.");
            return;
        }
        if (selectedItems.length === 0) {
            alert("Please select at least one item.");
            return;
        }
        
        try {
            const res = await fetch(`${ROOM_SERVICE_URL}/orders`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": authToken
                },
                body: JSON.stringify({
                    room_number: parseInt(roomNum),
                    items: selectedItems
                })
            });
            const data = await res.json();
            if (res.ok) {
                alert("Order placed successfully!");
                document.querySelectorAll("input[name='rs-items']:checked").forEach(el => el.checked = false);
            } else {
                alert(`Failed to place order: ${parseErrorDetail(data.detail)}`);
            }
        } catch (err) {
            alert(`Network error: ${err.message}`);
        }
    });

    // Maintenance Form
    document.getElementById("maint-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const payload = {
            room_number: parseInt(document.getElementById("maint-room").value),
            urgency: document.getElementById("maint-urgency").value,
            description: document.getElementById("maint-desc").value
        };
        
        try {
            const res = await fetch(`${MAINTENANCE_URL}/issues`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": authToken
                },
                body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (res.ok) {
                alert(`Issue reported successfully! Task enqueued.`);
                document.getElementById("maint-desc").value = "";
            } else {
                alert(`Failed to report issue: ${parseErrorDetail(data.detail)}`);
            }
        } catch (err) {
            alert(`Network error: ${err.message}`);
        }
    });
}

// --- UI Utility: Tabs Manager ---
function setupTabs() {
    const tabs = document.querySelectorAll(".tab-btn");
    tabs.forEach(tab => {
        tab.addEventListener("click", () => {
            tabs.forEach(t => t.classList.remove("active"));
            tab.classList.add("active");
            
            const tabId = tab.getAttribute("data-tab");
            document.querySelectorAll(".tab-content").forEach(tc => tc.classList.remove("active"));
            document.getElementById(tabId).classList.add("active");
            
            // Hide invoice box if switching away from checkout tab
            if (tabId !== "checkout-tab") {
                document.getElementById("invoice-modal").classList.add("hidden");
            }
        });
    });
}

// --- Terminal Log Helper ---
function renderTerminalLogs() {
    eventTerminal.textContent = "";
    
    const filteredLogs = logsList.filter(log => {
        if (currentLogFilter === "all") return true;
        if (currentLogFilter === "room") {
            return log.topic === "room_status_changed" || log.topic === "room_vacated" || log.topic === "EVENT-INFO";
        }
        if (currentLogFilter === "room_service") {
            return log.topic.startsWith("room_service");
        }
        if (currentLogFilter === "maintenance") {
            return log.topic.startsWith("maintenance");
        }
        return false;
    });
    
    if (filteredLogs.length === 0) {
        eventTerminal.textContent = "// No events matching this filter category...\n";
        return;
    }
    
    let content = "";
    filteredLogs.forEach(log => {
        const cleanMsg = log.message.replace(/\\n/g, '\n');
        content += `[${log.timestamp}] [${log.topic}] ${cleanMsg}\n\n`;
    });
    eventTerminal.textContent = content;
    
    // Auto Scroll to bottom
    const container = eventTerminal.parentElement;
    container.scrollTop = container.scrollHeight;
}

function appendTerminalLog(topic, message) {
    logsList.push({
        timestamp: new Date().toLocaleTimeString(),
        topic,
        message
    });
    
    // Cap event storage logs list at 200 logs
    if (logsList.length > 200) {
        logsList.shift();
    }
    
    renderTerminalLogs();
}

// --- Dynamic Filter Controls Setup ---
function setupFloorFilters() {
    const pills = document.querySelectorAll(".floor-pill");
    pills.forEach(pill => {
        pill.addEventListener("click", () => {
            pills.forEach(p => p.classList.remove("active"));
            pill.classList.add("active");
            currentFloorFilter = pill.getAttribute("data-floor");
            renderRooms();
        });
    });
}

function setupLogFilters() {
    const btns = document.querySelectorAll(".term-filter-btn");
    btns.forEach(btn => {
        btn.addEventListener("click", () => {
            btns.forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            currentLogFilter = btn.getAttribute("data-filter");
            renderTerminalLogs();
        });
    });
    
    clearLogsBtn.addEventListener("click", () => {
        logsList = [];
        renderTerminalLogs();
    });
}
