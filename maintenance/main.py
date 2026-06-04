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

from shared.models import MaintenanceIssue, MaintenanceUrgency, MaintenanceStatus, RoomStatus

app = FastAPI(
    title="HotelOS Maintenance Service",
    description="Manages maintenance issues, ranks them using a custom priority queue, and dispatches technicians."
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

# Mapping of urgency to numeric priority scores
URGENCY_SCORES = {
    MaintenanceUrgency.CRITICAL: 4,
    MaintenanceUrgency.HIGH: 3,
    MaintenanceUrgency.NORMAL: 2,
    MaintenanceUrgency.LOW: 1
}

class CreateIssueRequest(BaseModel):
    room_number: int = Field(..., ge=101, le=308)
    description: str = Field(..., min_length=3, max_length=500)
    urgency: MaintenanceUrgency

# In-memory priority queue
issues_db: List[dict] = []
maintenance_lock = asyncio.Lock()

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
        print(f"[Maintenance] Failed to emit event {event_type}: {e}")

def sort_priority_queue():
    """
    Priority Queue Algorithm:
    Primary Sort: Urgency score (descending, higher score = higher priority)
    Secondary Sort: Timestamp (ascending, older request = higher priority)
    """
    issues_db.sort(key=lambda x: (-URGENCY_SCORES[x["urgency"]], x["created_at"]))

@app.get("/issues")
def get_issues(token: str = Depends(verify_token)):
    """Returns issues sorted by priority queue logic."""
    sort_priority_queue()
    return issues_db

@app.post("/issues", status_code=status.HTTP_201_CREATED)
async def report_issue(request: CreateIssueRequest, token: str = Depends(verify_token)):
    """Reports a new issue, places it in the priority queue, and sets room to Maintenance."""
    async with maintenance_lock:
        new_issue = {
            "issue_id": str(uuid.uuid4())[:8],
            "room_number": request.room_number,
            "description": request.description,
            "urgency": request.urgency,
            "status": MaintenanceStatus.PENDING,
            "assigned_technician": None,
            "created_at": time.time(),
            "resolved_at": None
        }
        
        issues_db.append(new_issue)
        sort_priority_queue()
        
        # Publish event that issue was reported
        await emit_event("maintenance_reported", new_issue)
        
        # Publish event to change room status to Maintenance
        await emit_event("room_status_changed", {
            "room_number": request.room_number,
            "status": RoomStatus.MAINTENANCE
        })
        
        return {"message": "Issue reported and room put in Maintenance status.", "issue": new_issue}

@app.post("/issues/{issue_id}/assign")
async def assign_technician(issue_id: str, technician_name: str, token: str = Depends(verify_token)):
    """Assigns the next technician to a pending issue."""
    async with maintenance_lock:
        issue = next((i for i in issues_db if i["issue_id"] == issue_id), None)
        if not issue:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Issue {issue_id} not found."
            )
            
        if issue["status"] != MaintenanceStatus.PENDING:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Issue is already in status {issue['status']}."
            )
            
        issue["status"] = MaintenanceStatus.ASSIGNED
        issue["assigned_technician"] = technician_name
        
        await emit_event("maintenance_status_changed", {
            "issue_id": issue_id,
            "room_number": issue["room_number"],
            "status": MaintenanceStatus.ASSIGNED,
            "assigned_technician": technician_name
        })
        
        return {"message": f"Issue assigned to {technician_name}.", "issue": issue}

@app.post("/issues/{issue_id}/resolve")
async def resolve_issue(issue_id: str, token: str = Depends(verify_token)):
    """Resolves an issue, updates its status, and resets room back to Clean."""
    async with maintenance_lock:
        issue = next((i for i in issues_db if i["issue_id"] == issue_id), None)
        if not issue:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"Issue {issue_id} not found."
            )
            
        if issue["status"] == MaintenanceStatus.RESOLVED:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Issue is already resolved."
            )
            
        issue["status"] = MaintenanceStatus.RESOLVED
        issue["resolved_at"] = time.time()
        
        # Publish issue resolution
        await emit_event("maintenance_status_changed", {
            "issue_id": issue_id,
            "room_number": issue["room_number"],
            "status": MaintenanceStatus.RESOLVED,
            "assigned_technician": issue["assigned_technician"],
            "resolved_at": issue["resolved_at"]
        })
        
        # Room is now clean and available
        await emit_event("room_status_changed", {
            "room_number": issue["room_number"],
            "status": RoomStatus.CLEAN,
            "last_cleaned_time": time.time()
        })
        
        # Remove from active DB or mark resolved
        # In this implementation we keep it in DB but set status
        return {"message": f"Issue {issue_id} resolved. Room {issue['room_number']} marked Clean.", "issue": issue}
