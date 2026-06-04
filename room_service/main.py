import os
import time
import uuid
import asyncio
import httpx
from typing import List, Optional
from fastapi import FastAPI, HTTPException, status, Depends
from fastapi.security import APIKeyHeader
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from shared.models import RoomServiceOrder, RoomServiceStatus

app = FastAPI(
    title="HotelOS Room Service",
    description="Manages guest food and beverage orders, pushing order status updates to the dashboard."
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

# Standard menu pricing
MENU = {
    "coffee": 5.0,
    "sandwich": 12.0,
    "burger": 15.0,
    "soda": 3.0,
    "fries": 6.0
}

class CreateOrderRequest(BaseModel):
    room_number: int = Field(..., ge=101, le=308)
    items: List[str] = Field(..., min_length=1)

# In-memory FIFO queue for orders
orders_db: List[RoomServiceOrder] = []
order_lock = asyncio.Lock()

# Message Broker coordinates
BROKER_API_URL = os.getenv("BROKER_API_URL", "http://localhost:8000/publish")

async def emit_event(event_type: str, payload: dict):
    """Publish event to central broker via REST API."""
    try:
        async with httpx.AsyncClient() as client:
            await client.post(BROKER_API_URL, json={
                "event_type": event_type,
                "payload": payload
            })
    except Exception as e:
        print(f"[RoomService] Failed to emit event {event_type}: {e}")

@app.get("/orders")
def get_orders(token: str = Depends(verify_token)):
    """Fetch all room service orders."""
    return orders_db

@app.post("/orders", status_code=status.HTTP_201_CREATED)
async def create_order(request: CreateOrderRequest, token: str = Depends(verify_token)):
    """Creates a new order, calculates total price, and enqueues it."""
    async with order_lock:
        # Calculate total price based on menu
        total_price = 0.0
        validated_items = []
        for item in request.items:
            clean_item = item.strip().lower()
            if clean_item not in MENU:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=f"Item '{item}' is not on the room service menu."
                )
            total_price += MENU[clean_item]
            validated_items.append(clean_item)
            
        new_order = RoomServiceOrder(
            order_id=str(uuid.uuid4())[:8],  # short readable uuid
            room_number=request.room_number,
            items=validated_items,
            total_price=total_price,
            status=RoomServiceStatus.RECEIVED,
            timestamp=time.time()
        )
        
        orders_db.append(new_order)
        
        # Publish creation event
        await emit_event("room_service_order_placed", new_order.dict())
        
        return {"message": "Order created successfully", "order": new_order}

@app.post("/orders/{order_id}/progress")
async def progress_order(order_id: str, token: str = Depends(verify_token)):
    """Progresses an order to the next stage: Received -> Preparing -> Out for delivery -> Delivered."""
    async with order_lock:
        order = next((o for o in orders_db if o.order_id == order_id), None)
        if not order:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Order {order_id} not found."
            )
            
        current = order.status
        if current == RoomServiceStatus.RECEIVED:
            next_status = RoomServiceStatus.PREPARING
        elif current == RoomServiceStatus.PREPARING:
            next_status = RoomServiceStatus.DELIVERING
        elif current == RoomServiceStatus.DELIVERING:
            next_status = RoomServiceStatus.DELIVERED
        else:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Order has already been delivered."
            )
            
        order.status = next_status
        
        # Emit status change event
        await emit_event("room_service_status_changed", order.dict())
        
        return {"message": f"Order progressed to {next_status.value}.", "order": order}
