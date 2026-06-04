#!/usr/bin/env python3
"""
GrandStay HotelOS — Single Command Launcher
Run with: python3 run_dashboard.py
"""

import subprocess
import time
import sys
import os
import signal
import threading
import webbrowser

# ─── Configuration ────────────────────────────────────────────────────────────
SERVICES = {
    "broker":       ("broker.main:app",       8000),
    "reception":    ("reception.main:app",     8001),
    "room_service": ("room_service.main:app",  8002),
    "maintenance":  ("maintenance.main:app",   8003),
    "housekeeping": ("housekeeping.main:app",  8004),
}

STARTUP_WAIT_SECONDS = 3   # seconds to wait before opening the browser

# ─── Colour helpers ───────────────────────────────────────────────────────────
C = {
    "reset":  "\033[0m",
    "blue":   "\033[94m",
    "green":  "\033[92m",
    "yellow": "\033[93m",
    "cyan":   "\033[96m",
    "red":    "\033[91m",
    "purple": "\033[95m",
    "bold":   "\033[1m",
}

def c(color, text):
    return f"{C[color]}{text}{C['reset']}"

def banner():
    print()
    print(c("cyan", "╔═══════════════════════════════════════════╗"))
    print(c("cyan", "║") + c("bold", "   🏨  GrandStay HotelOS  — All-in-One    ") + c("cyan", "║"))
    print(c("cyan", "╚═══════════════════════════════════════════╝"))
    print()

# ─── Detect the correct Python interpreter ────────────────────────────────────
def find_python():
    """
    Priority:
    1. venv/bin/python3  (local virtual environment inside the project)
    2. The interpreter that launched this script (sys.executable)
    """
    script_dir = os.path.dirname(os.path.abspath(__file__))
    candidates = [
        os.path.join(script_dir, "venv", "bin", "python3"),
        os.path.join(script_dir, "venv", "bin", "python"),
    ]
    for path in candidates:
        if os.path.isfile(path):
            return path
    return sys.executable   # fallback: whatever ran this script

# ─── Ensure dependencies are installed ────────────────────────────────────────
def ensure_deps(python_bin):
    script_dir = os.path.dirname(os.path.abspath(__file__))
    req_file   = os.path.join(script_dir, "requirements.txt")

    # Quick check: try importing fastapi & uvicorn
    check = subprocess.run(
        [python_bin, "-c", "import fastapi, uvicorn, httpx"],
        capture_output=True
    )
    if check.returncode == 0:
        return   # already installed

    # If venv doesn't exist yet, create it
    venv_dir = os.path.join(script_dir, "venv")
    if not os.path.isdir(venv_dir):
        print(c("yellow", "⚙  Virtual environment not found — creating..."))
        subprocess.run([sys.executable, "-m", "venv", venv_dir], check=True)

    print(c("yellow", "📦  Installing dependencies from requirements.txt..."))
    subprocess.run(
        [python_bin, "-m", "pip", "install", "-q", "-r", req_file],
        check=True
    )
    print(c("green", "✅  Dependencies installed."))

# ─── Process manager ──────────────────────────────────────────────────────────
processes = []   # list of (name, app_path, port, Popen)

def start_service(name, app_path, port, python_bin, script_dir):
    proc = subprocess.Popen(
        [python_bin, "-m", "uvicorn", app_path,
         "--port", str(port), "--host", "127.0.0.1"],
        cwd=script_dir,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    return proc

def shutdown(signum=None, frame=None):
    print()
    print(c("purple", "═" * 45))
    print(c("red", "🛑  Shutting down HotelOS microservices..."))
    for name, _, _, proc in processes:
        try:
            proc.terminate()
            proc.wait(timeout=5)
        except Exception:
            pass
        print(f"   {c('yellow', '⬛')} {name} stopped.")
    print()
    print(c("green", "✅  All services stopped. Goodbye! 👋"))
    print(c("purple", "═" * 45))
    sys.exit(0)

signal.signal(signal.SIGINT,  shutdown)
signal.signal(signal.SIGTERM, shutdown)

# ─── Health ticker thread ─────────────────────────────────────────────────────
def health_ticker():
    """Periodically prints a live heartbeat and watches for crashed services."""
    while True:
        time.sleep(10)
        crashed = []
        for i, (name, app_path, port, proc) in enumerate(processes):
            if proc.poll() is not None:       # process died
                crashed.append((i, name, app_path, port))

        if crashed:
            python_bin  = find_python()
            script_dir  = os.path.dirname(os.path.abspath(__file__))
            for i, name, app_path, port in crashed:
                print(c("red", f"⚠  {name} crashed! Restarting..."))
                new_proc = start_service(name, app_path, port, python_bin, script_dir)
                processes[i] = (name, app_path, port, new_proc)
                print(c("green", f"✅  {name} restarted on port {port}."))

# ─── Main ─────────────────────────────────────────────────────────────────────
def main():
    banner()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    python_bin = find_python()

    print(c("blue",   f"🐍  Using Python  : {python_bin}"))
    print(c("blue",   f"📁  Project root  : {script_dir}"))
    print()

    # Make sure packages are available
    ensure_deps(python_bin)

    # Launch all services
    print(c("yellow", "🚀  Starting microservices..."))
    for name, (app_path, port) in SERVICES.items():
        proc = start_service(name, app_path, port, python_bin, script_dir)
        processes.append((name, app_path, port, proc))
        print(f"   {c('green', '▶')}  {c('yellow', name):<22} → port {c('cyan', str(port))}")

    # Wait for services to warm up
    print()
    print(c("yellow", f"⏳  Waiting {STARTUP_WAIT_SECONDS}s for services to initialise..."))
    time.sleep(STARTUP_WAIT_SECONDS)

    # Open the browser automatically
    dashboard_url = "http://localhost:8000/"
    try:
        webbrowser.open(dashboard_url)
        print(c("green", f"🌐  Browser opened → {dashboard_url}"))
    except Exception:
        print(c("yellow", f"ℹ  Open your browser and go to → {dashboard_url}"))

    # Print access information
    print()
    print(c("purple", "═" * 45))
    print(c("bold",   "   HotelOS Operations Dashboard is LIVE"))
    print(c("purple", "═" * 45))
    print(f"   URL   : {c('cyan', dashboard_url)}")
    print(f"   Token : {c('cyan', 'admin_hotel_os')}")
    print(c("purple", "═" * 45))
    print()
    print(c("red", "   Press  Ctrl+C  to stop all services."))
    print()

    # Start background health watcher
    t = threading.Thread(target=health_ticker, daemon=True)
    t.start()

    # Keep alive
    while True:
        time.sleep(1)

if __name__ == "__main__":
    main()
