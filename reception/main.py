import os
import time
import asyncio
import httpx
import websockets
import json
from typing import List, Optional
from fastapi import FastAPI, HTTPException, status, Depends, BackgroundTasks
from fastapi.security import APIKeyHeader
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from shared.models import (
    RoomType, RoomStatus, CheckInRequest, CheckOutResponse,
    RoomUpdate, BrokerEvent, RoomServiceStatus
)

app = FastAPI(
    title="HotelOS Reception Service",
    description="Manages room inventory, guest check-in (assignment), and check-out (billing)."
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

# Thread-safe in-memory room inventory
# 24 rooms across 3 floors (8 rooms per floor)
_room_types = [RoomType.SINGLE, RoomType.DOUBLE, RoomType.SUITE, RoomType.ACCESSIBLE,
               RoomType.SINGLE, RoomType.DOUBLE, RoomType.SUITE, RoomType.ACCESSIBLE]
_proximities = ["stairs", "elevator", "none", "elevator", "stairs", "none", "elevator", "stairs"]

rooms = []
for _floor in range(1, 4):           # 3 floors
    for _r in range(1, 9):           # 8 rooms per floor
        rooms.append({
            "room_number":         _floor * 100 + _r,
            "room_type":           _room_types[_r - 1],
            "status":              RoomStatus.CLEAN,
            "floor":               _floor,
            "proximity":           _proximities[_r - 1],
            "last_cleaned_time":   time.time() - (3600 * _r),
            "guest_name":          None,
            "nights":              0,
            "room_service_charges": 0.0,
        })

# Nightly Rates
RATES = {
    RoomType.SINGLE: 100.0,
    RoomType.DOUBLE: 150.0,
    RoomType.SUITE: 300.0,
    RoomType.ACCESSIBLE: 120.0
}

# Lock to avoid double assignment or race conditions on inventory changes
assignment_lock = asyncio.Lock()

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
        print(f"[Reception] Failed to emit event {event_type}: {e}")

@app.get("/rooms")
def get_rooms(token: str = Depends(verify_token)):
    """Returns list of rooms with restricted data filters to avoid sensitive leak."""
    return [
        {
            "room_number": r["room_number"],
            "room_type":   r["room_type"],
            "status":      r["status"],
            "floor":       r["floor"],
            "proximity":   r["proximity"],
            "guest_name":  r["guest_name"],
            "room_service_charges": r["room_service_charges"]
        }
        for r in rooms
    ]

@app.get("/rooms/public")
def get_rooms_public():
    """
    Public endpoint for guest portal login — no auth token required.
    Returns only status and guest_name for occupied rooms so guests can
    verify their room number and name match.
    """
    return [
        {
            "room_number": r["room_number"],
            "status":      r["status"],
            "floor":       r["floor"],
            "guest_name":  r["guest_name"] if r["status"] == "Occupied" else None,
        }
        for r in rooms
    ]

@app.post("/check-in")
async def check_in(request: CheckInRequest, token: str = Depends(verify_token)):
    """
    Check in a guest. Runs the multi-criteria room assignment algorithm.
    """
    async with assignment_lock:
        # Step 2: Filter by Room Type and Cleanliness
        eligible_rooms = [
            r for r in rooms 
            if r["room_type"] == request.room_type and r["status"] == RoomStatus.CLEAN
        ]
        
        if not eligible_rooms:
            # Safe error messages returned to user, no raw stack trace exposure
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="No rooms of the requested type are currently available and clean."
            )
            
        # Step 3: Sort by Longest Clean (smallest last_cleaned_time timestamp first)
        eligible_rooms.sort(key=lambda r: r["last_cleaned_time"])
        
        # Step 4: Floor Preference Filter (Secondary Filter)
        if request.floor_preference is not None:
            floor_matches = [
                r for r in eligible_rooms 
                if r["floor"] == request.floor_preference
            ]
            if floor_matches:
                eligible_rooms = floor_matches  # Filter applied, if none, fall back
                
        # Step 5: Proximity Preference (Final Tiebreaker)
        if request.proximity_preference is not None and request.proximity_preference != "none":
            # Put rooms matching proximity at the front, preserving the longest clean sort
            eligible_rooms.sort(key=lambda r: 0 if r["proximity"] == request.proximity_preference else 1)
            
        # Step 6: Select the best room
        assigned_room = eligible_rooms[0]
        
        # Step 7: Update room state
        assigned_room["status"] = RoomStatus.OCCUPIED
        assigned_room["guest_name"] = request.guest_name
        assigned_room["nights"] = request.nights
        assigned_room["room_service_charges"] = 0.0  # Reset charges for new stay
        
        # Publish room status change event
        await emit_event("room_status_changed", {
            "room_number": assigned_room["room_number"],
            "status": RoomStatus.OCCUPIED,
            "guest_name": request.guest_name
        })
        
        # Publish guest_checked_in event for dashboards
        await emit_event("guest_checked_in", {
            "room_number": assigned_room["room_number"],
            "room_type": assigned_room["room_type"],
            "floor": assigned_room["floor"],
            "guest_name": request.guest_name,
            "nights": request.nights
        })
        
        return {
            "message": "Check-in successful",
            "room_number": assigned_room["room_number"],
            "room_type": assigned_room["room_type"],
            "floor": assigned_room["floor"],
            "proximity": assigned_room["proximity"],
            "guest_name": assigned_room["guest_name"],
            "nights": assigned_room["nights"]
        }

class CheckOutRequest(BaseModel):
    room_number: int
    late_checkout: bool = False
    discount_code: Optional[str] = None

@app.post("/check-out", response_model=CheckOutResponse)
async def check_out(request: CheckOutRequest, token: str = Depends(verify_token)):
    """
    Check out a guest. Runs the billing calculation algorithm.
    """
    room_number = request.room_number
    late_checkout = request.late_checkout
    discount_code = request.discount_code
    async with assignment_lock:
        # Find room
        room = next((r for r in rooms if r["room_number"] == room_number), None)
        if not room:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Room {room_number} does not exist in inventory."
            )
            
        if room["status"] != RoomStatus.OCCUPIED:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Room {room_number} is not currently occupied."
            )
            
        # billing calculation algorithm (Task 1.2)
        nightly_rate = RATES[room["room_type"]]
        nights = room["nights"]
        room_charges = nightly_rate * nights
        room_service_charges = room["room_service_charges"]
        
        # Additional charges
        late_checkout_fee = 50.0 if late_checkout else 0.0
        extra_charges = 0.0  # e.g., minibar placeholder
        
        subtotal = room_charges + room_service_charges + late_checkout_fee + extra_charges
        
        # Discount logic
        discount_applied = 0.0
        if discount_code == "WELCOME10":
            discount_applied = subtotal * 0.10
        elif discount_code == "VIP20":
            discount_applied = subtotal * 0.20
            
        total_bill = subtotal - discount_applied
        
        # Build breakdown text details
        breakdown = [
            f"Room Charge: {nights} nights x ${nightly_rate:.2f} = ${room_charges:.2f}",
            f"Room Service Total: ${room_service_charges:.2f}",
            f"Late Checkout Fee: ${late_checkout_fee:.2f}",
            f"Extra Charges: ${extra_charges:.2f}",
            f"Subtotal: ${subtotal:.2f}",
            f"Discount Applied: -${discount_applied:.2f}" if discount_applied > 0 else "Discount: None",
            f"Grand Total: ${total_bill:.2f}"
        ]
        
        guest_name = room["guest_name"]
        
        # Update room status to Dirty
        room["status"] = RoomStatus.DIRTY
        room["guest_name"] = None
        room["nights"] = 0
        room["room_service_charges"] = 0.0
        
        # Publish room status change event
        await emit_event("room_status_changed", {
            "room_number": room_number,
            "status": RoomStatus.DIRTY,
            "guest_name": None
        })
        
        # Publish room vacated event
        await emit_event("room_vacated", {
            "room_number": room_number,
            "guest_name": guest_name
        })
        
        return CheckOutResponse(
            room_number=room_number,
            guest_name=guest_name,
            nights=nights,
            room_charges=room_charges,
            room_service_charges=room_service_charges,
            late_checkout_fee=late_checkout_fee,
            extra_charges=extra_charges,
            discount_applied=discount_applied,
            total_bill=total_bill,
            breakdown_details=breakdown
        )

# Event Listener loop to synchronize updates from broker
async def handle_broker_messages():
    """Listens for room status updates and room service charges from message broker."""
    topics = "room_status_changed,room_service_status_changed,maintenance_status_changed"
    url = f"{BROKER_WS_URL}?topics={topics}"
    
    while True:
        try:
            async with websockets.connect(url) as ws:
                print("[Reception] Connected to Message Broker WS channel.")
                while True:
                    msg = await ws.recv()
                    event = json.loads(msg)
                    event_type = event.get("event_type")
                    payload = event.get("payload", {})
                    
                    async with assignment_lock:
                        if event_type == "room_service_status_changed":
                            # Accumulate charges when an order transitions to 'Delivered'
                            if payload.get("status") == RoomServiceStatus.DELIVERED:
                                room_num = payload.get("room_number")
                                total_price = payload.get("total_price", 0.0)
                                room = next((r for r in rooms if r["room_number"] == room_num), None)
                                if room and room["status"] == RoomStatus.OCCUPIED:
                                    room["room_service_charges"] += total_price
                                    print(f"[Reception] Charged ${total_price} to Room {room_num} for room service.")
                                    
                        elif event_type in ("room_status_changed", "maintenance_status_changed"):
                            room_num = payload.get("room_number")
                            status = payload.get("status")
                            # If housekeeping or maintenance changes room status, sync local inventory
                            room = next((r for r in rooms if r["room_number"] == room_num), None)
                            if room:
                                # Standard status mappings
                                if status in [RoomStatus.CLEAN, RoomStatus.DIRTY, RoomStatus.CLEANING, RoomStatus.MAINTENANCE]:
                                    room["status"] = status
                                    if status == RoomStatus.CLEAN:
                                        room["last_cleaned_time"] = time.time()
                                    print(f"[Reception] Synced Room {room_num} status to {status} from broker event.")
        except Exception as e:
            print(f"[Reception] Broker WS subscription disconnected ({e}). Retrying in 2 seconds...")
            await asyncio.sleep(2)

@app.on_event("startup")
async def startup_event():
    # Start the event loop listener in the background
    asyncio.create_task(handle_broker_messages())
