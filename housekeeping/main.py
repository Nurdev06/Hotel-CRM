import os
import time
import asyncio
import httpx
import websockets
import json
from typing import List, Optional
from fastapi import FastAPI, HTTPException, status, Depends
from fastapi.security import APIKeyHeader
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from shared.models import RoomStatus, BrokerEvent

app = FastAPI(
    title="HotelOS Housekeeping Service",
    description="Manages cleaning schedules and rooms transition from Dirty -> Being Cleaned -> Clean."
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API Token authentication
API_KEY_NAME = "Authorization"
api_key_header = APIKeyHeader(name=API_KEY_NAME, auto_error=False)

def verify_token(token: str = Depends(api_key_header)):
    if not token or token != "admin_hotel_os":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Unauthorized: Invalid security token."
        )

# In-memory queue of cleaning tasks (stored as dicts)
cleaning_queue = []
queue_lock = asyncio.Lock()

# Message Broker coordinates
BROKER_API_URL = os.getenv("BROKER_API_URL", "http://localhost:8000/publish")
BROKER_WS_URL = os.getenv("BROKER_WS_URL", "ws://localhost:8000/ws")

async def emit_event(event_type: str, payload: dict):
    """Publish event to central broker via REST API."""
    try:
        async with httpx.AsyncClient() as client:
            await client.post(BROKER_API_URL, json={
                "event_type": event_type,
                "payload": payload
            })
    except Exception as e:
        print(f"[Housekeeping] Failed to emit event {event_type}: {e}")

@app.get("/queue")
async def get_cleaning_queue(token: str = Depends(verify_token)):
    """Returns the list of dirty and cleaning tasks."""
    return cleaning_queue

@app.post("/start-cleaning/{room_number}")
async def start_cleaning(room_number: int, housekeeper_name: str, token: str = Depends(verify_token)):
    """Transitions a room from Dirty to Being Cleaned."""
    async with queue_lock:
        task = next((t for t in cleaning_queue if t["room_number"] == room_number), None)
        if not task:
            # If not in the queue, let's create a dirty entry dynamically (allows flexibility)
            task = {
                "room_number": room_number,
                "status": RoomStatus.DIRTY,
                "housekeeper": None,
                "timestamp": time.time()
            }
            cleaning_queue.append(task)
            
        if task["status"] == RoomStatus.CLEANING:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Room {room_number} is already being cleaned by {task['housekeeper']}."
            )
            
        # Transition status
        task["status"] = RoomStatus.CLEANING
        task["housekeeper"] = housekeeper_name
        
        # Publish event
        await emit_event("room_status_changed", {
            "room_number": room_number,
            "status": RoomStatus.CLEANING,
            "housekeeper_name": housekeeper_name
        })
        
        return {"message": f"Cleaning started for room {room_number}.", "task": task}

@app.post("/finish-cleaning/{room_number}")
async def finish_cleaning(room_number: int, token: str = Depends(verify_token)):
    """Transitions a room from Being Cleaned to Clean and removes it from the housekeeping queue."""
    async with queue_lock:
        task = next((t for t in cleaning_queue if t["room_number"] == room_number), None)
        if not task:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Room {room_number} is not in the housekeeping queue."
            )
            
        if task["status"] != RoomStatus.CLEANING:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Cannot finish cleaning; Room {room_number} is not in 'Being cleaned' status."
            )
            
        # Remove from queue
        cleaning_queue.remove(task)
        
        # Publish clean status update (sends timestamp for longest clean logic)
        now = time.time()
        await emit_event("room_status_changed", {
            "room_number": room_number,
            "status": RoomStatus.CLEAN,
            "last_cleaned_time": now
        })
        
        return {"message": f"Room {room_number} is clean and ready for check-in."}

# Event Listener loop to synchronize updates from broker
async def handle_broker_messages():
    """Listens for room checkout (room_vacated) events to enqueue cleaning tasks."""
    url = f"{BROKER_WS_URL}?topics=room_vacated"
    while True:
        try:
            async with websockets.connect(url) as ws:
                print("[Housekeeping] Connected to Message Broker WS channel.")
                while True:
                    msg = await ws.recv()
                    event = json.loads(msg)
                    event_type = event.get("event_type")
                    payload = event.get("payload", {})
                    
                    if event_type == "room_vacated":
                        room_num = payload.get("room_number")
                        async with queue_lock:
                            # Avoid duplicates
                            if not any(t["room_number"] == room_num for t in cleaning_queue):
                                cleaning_queue.append({
                                    "room_number": room_num,
                                    "status": RoomStatus.DIRTY,
                                    "housekeeper": None,
                                    "timestamp": time.time()
                                })
                                print(f"[Housekeeping] Enqueued room {room_num} for cleaning.")
        except Exception as e:
            print(f"[Housekeeping] Broker WS subscription disconnected ({e}). Retrying in 2 seconds...")
            await asyncio.sleep(2)

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(handle_broker_messages())
