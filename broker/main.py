import os
import json
import asyncio
from typing import Dict, Set, List
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, status, Depends
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from shared.models import BrokerEvent

app = FastAPI(
    title="HotelOS Message Broker",
    description="Central pub/sub message broker routing events between microservices and real-time dashboard."
)

# Enable CORS for cross-service HTTP calls
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Subscription Registry: topic/event_type -> set of WebSocket connections
subscriptions: Dict[str, Set[WebSocket]] = {}
active_connections: Set[WebSocket] = set()
lock = asyncio.Lock()

async def send_message(websocket: WebSocket, text_data: str):
    """Helper function to send data over websocket safely."""
    try:
        await websocket.send_text(text_data)
    except Exception:
        # Socket might be stale; cleanup happens on disconnect detection
        pass

@app.get("/health")
def health_check():
    return {
        "status": "healthy",
        "active_sockets": len(active_connections),
        "topics": list(subscriptions.keys())
    }

@app.post("/publish", status_code=status.HTTP_200_OK)
async def publish_event(event: BrokerEvent):
    """
    Publish an event to the broker. 
    Routes to all WebSockets subscribed to this event_type, or subscribed to '*'.
    """
    async with lock:
        # Determine target clients
        specific_subs = subscriptions.get(event.event_type, set())
        wildcard_subs = subscriptions.get("*", set())
        targets = specific_subs.union(wildcard_subs)
        
        if targets:
            message_payload = event.json()
            # Asynchronously dispatch to all targets
            await asyncio.gather(
                *(send_message(ws, message_payload) for ws in targets),
                return_exceptions=True
            )
            
    return {
        "status": "published",
        "routed_to": len(targets)
    }

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket, topics: str = "*"):
    """
    WebSocket endpoint for subscribing to broker topics.
    Query parameter `topics` can be comma-separated, e.g., /ws?topics=room_vacated,room_status_changed
    Or client can send subscription commands via socket message.
    """
    await websocket.accept()
    
    async with lock:
        active_connections.add(websocket)
        # Parse initial topics
        topic_list = [t.strip() for t in topics.split(",") if t.strip()]
        for topic in topic_list:
            if topic not in subscriptions:
                subscriptions[topic] = set()
            subscriptions[topic].add(websocket)
            
    try:
        while True:
            # Maintain connection and listen for client changes
            data = await websocket.receive_text()
            try:
                cmd = json.loads(data)
                if cmd.get("action") == "subscribe":
                    new_topics = cmd.get("topics", [])
                    async with lock:
                        # Clear old subscriptions for this connection
                        for t, ws_set in subscriptions.items():
                            ws_set.discard(websocket)
                        
                        # Add new subscriptions
                        for topic in new_topics:
                            if topic not in subscriptions:
                                subscriptions[topic] = set()
                            subscriptions[topic].add(websocket)
                            
                        # Send confirmation
                        await websocket.send_text(json.dumps({
                            "type": "subscription_ack",
                            "subscribed_topics": new_topics
                        }))
            except (json.JSONDecodeError, KeyError, TypeError):
                # Safely ignore malformed control commands from clients
                pass
    except WebSocketDisconnect:
        async with lock:
            active_connections.discard(websocket)
            for ws_set in subscriptions.values():
                ws_set.discard(websocket)

# Mount static files for dashboard if directories exist
DASHBOARD_DIR = "/Users/nurbekrakhimkulov/Desktop/Hotel/dashboard"
os.makedirs(DASHBOARD_DIR, exist_ok=True)
app.mount("/", StaticFiles(directory=DASHBOARD_DIR, html=True), name="dashboard")
