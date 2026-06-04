import time
from enum import Enum
from typing import List, Optional
from pydantic import BaseModel, Field

class RoomType(str, Enum):
    SINGLE = "single"
    DOUBLE = "double"
    SUITE = "suite"
    ACCESSIBLE = "accessible"

class RoomStatus(str, Enum):
    CLEAN = "Clean"
    DIRTY = "Dirty"
    CLEANING = "Being cleaned"
    OCCUPIED = "Occupied"
    MAINTENANCE = "Maintenance"

class RoomServiceStatus(str, Enum):
    RECEIVED = "Received"
    PREPARING = "Preparing"
    DELIVERING = "Out for delivery"
    DELIVERED = "Delivered"

class MaintenanceUrgency(str, Enum):
    CRITICAL = "Critical"
    HIGH = "High"
    NORMAL = "Normal"
    LOW = "Low"

class MaintenanceStatus(str, Enum):
    PENDING = "Pending"
    ASSIGNED = "Assigned"
    RESOLVED = "Resolved"

# --- Payload Schemas ---

class CheckInRequest(BaseModel):
    guest_name: str = Field(..., min_length=2, max_length=100)
    room_type: RoomType
    nights: int = Field(..., gt=0, lt=365)
    floor_preference: Optional[int] = Field(None, ge=1, le=3)
    proximity_preference: Optional[str] = Field(None, pattern="^(elevator|stairs|none)$")

class CheckOutResponse(BaseModel):
    room_number: int
    guest_name: str
    nights: int
    room_charges: float
    room_service_charges: float
    late_checkout_fee: float
    extra_charges: float
    discount_applied: float
    total_bill: float
    breakdown_details: List[str]

class RoomUpdate(BaseModel):
    room_number: int
    status: RoomStatus
    guest_name: Optional[str] = None
    last_cleaned_time: Optional[float] = None

class RoomServiceOrder(BaseModel):
    order_id: str
    room_number: int
    items: List[str]
    total_price: float = Field(..., ge=0)
    status: RoomServiceStatus = RoomServiceStatus.RECEIVED
    timestamp: float = Field(default_factory=time.time)

class MaintenanceIssue(BaseModel):
    issue_id: str
    room_number: int
    description: str = Field(..., min_length=3, max_length=500)
    urgency: MaintenanceUrgency
    status: MaintenanceStatus = MaintenanceStatus.PENDING
    assigned_technician: Optional[str] = None
    created_at: float = Field(default_factory=time.time)
    resolved_at: Optional[float] = None

class BrokerEvent(BaseModel):
    event_type: str  # e.g., "room_vacated", "room_status_changed"
    payload: dict
    timestamp: float = Field(default_factory=time.time)
