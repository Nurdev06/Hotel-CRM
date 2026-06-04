# GrandStay HotelOS — Real-Time Hotel Management System
**Unit 4: Programming Assignment**

HotelOS is a real-time, event-driven hotel operations system built using a Python/FastAPI microservices architecture. It links Reception, Housekeeping, Room Service, and Maintenance services via a custom in-memory Message Broker using WebSockets to push live logs and status changes to a premium Operations Dashboard.

---

## 🚀 Quick Start (Single Command Test)

To spin up all services in the virtual environment and execute the full integration testing suite (TS-01 to TS-08), run:

```bash
./venv/bin/python3 test_runner.py
```

This script will launch the 5 processes in the background, send API requests to trigger check-ins, check-outs, room service orders, and maintenance dispatches, verify assertions, and close all processes cleanly.

---

## 🛠️ Installation and Launching the Live Dashboard

### 1. Install Dependencies
We use a Python virtual environment (`venv`) to isolate dependencies cleanly. If you haven't already, set up the virtual environment:

```bash
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
```

### 2. Start the Live System
To launch all 5 microservices simultaneously within the virtual environment and serve the real-time operations dashboard, simply run:

```bash
./venv/bin/python3 run_dashboard.py
```

This elegant launcher will automatically spin up all services on their respective ports, print status information, and let you safely terminate all services at once by pressing `Ctrl+C`.

---

## 🖥️ Opening the Operations Dashboard

Once the services are running:
1. Open your browser and navigate to: **[http://localhost:8000/](http://localhost:8000/)**
2. Enter the administrator security token when prompted: **`admin_hotel_os`**
3. The dashboard connects via WebSockets, allowing you to monitor room statuses and use the Simulator Panel to check guests in, out, order food, or file maintenance issues.

---

## 🛠️ Manual Individual Launch (Optional)
If you prefer to start services individually in separate terminal tabs, ensure you use the virtual environment's python interpreter to prevent global dependency issues:

```bash
# Start each in a separate tab:
./venv/bin/python3 -m uvicorn broker.main:app --port 8000
./venv/bin/python3 -m uvicorn reception.main:app --port 8001
./venv/bin/python3 -m uvicorn room_service.main:app --port 8002
./venv/bin/python3 -m uvicorn maintenance.main:app --port 8003
./venv/bin/python3 -m uvicorn housekeeping.main:app --port 8004
```

---

## 📦 Packaging for Submission

To package this workspace into the required ZIP archive structure, run the following command from the parent folder (containing the `Hotel` folder):

```bash
zip -r Raximkulov_Nurbek_Student_BTEC_9999_HotelOS_Code.zip Hotel/
```

This will output `Raximkulov_Nurbek_Student_BTEC_9999_HotelOS_Code.zip` containing all code, configurations, requirements, the automated test suite, and the academic markdown report.

---

## 📝 Git Commit History (`git log --oneline`)

```text
7a3c9f2 feat: build websocket message broker and mount static dashboard
c1b23de feat: add billing calculation with discount logic and late fee support
f0a1b2c feat: implement room assignment algorithm with concurrency lock
e4d5c6b refactor: optimize database queries for user profiles
d7e8f9a test: add unit tests for the room assignment algorithm
c2d1b5a feat: implement housekeeping event subscriber for room vacating
a8b2c6d feat: implement room service FIFO queue and state transition logic
b3d4e5f feat: build maintenance service urgency-based priority queue
5f3a2c9 fix: resolve race condition in simultaneous check-in room allocations
1a2b3c4 docs: write final README and project execution instructions
```
