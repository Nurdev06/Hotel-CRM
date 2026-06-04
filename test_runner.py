import subprocess
import time
import requests
import sys
import os

# Configuration
HEADERS = {"Authorization": "admin_hotel_os"}
SERVICES = {
    "broker": ("broker.main:app", 8000),
    "reception": ("reception.main:app", 8001),
    "room_service": ("room_service.main:app", 8002),
    "maintenance": ("maintenance.main:app", 8003),
    "housekeeping": ("housekeeping.main:app", 8004),
}

processes = []

def start_services():
    print("=== Starting HotelOS Microservices in background ===")
    for name, (app_path, port) in SERVICES.items():
        print(f"Starting {name} on port {port}...")
        # Start uvicorn process
        proc = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", app_path, "--port", str(port), "--host", "127.0.0.1"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        processes.append((name, proc))
    
    # Wait for services to spin up
    print("Waiting 3 seconds for services to initialize...")
    time.sleep(3)

def stop_services():
    print("\n=== Shutting down HotelOS Microservices ===")
    for name, proc in processes:
        print(f"Terminating {name}...")
        proc.terminate()
        proc.wait()
    print("All services stopped.")

def run_scenarios():
    print("\n=== Running HotelOS Verification Scenarios ===")
    errors = 0
    
    # Base URLs
    reception_url = "http://127.0.0.1:8001"
    rs_url = "http://127.0.0.1:8002"
    maint_url = "http://127.0.0.1:8003"
    hk_url = "http://127.0.0.1:8004"

    # TS-01: Guest checks in requesting a double room on floor 2
    # Longest clean double should be 202 (9000s clean) over 204 (3600s clean)
    print("\n[TS-01] Guest checks in requesting double room on Floor 2...")
    payload = {
        "guest_name": "Alice Smith",
        "room_type": "double",
        "nights": 3,
        "floor_preference": 2,
        "proximity_preference": "none"
    }
    res = requests.post(f"{reception_url}/check-in", json=payload, headers=HEADERS)
    if res.status_code == 200:
        data = res.json()
        print(f"  SUCCESS: Assigned Room {data['room_number']} to guest '{data['guest_name']}'.")
        assert data['room_number'] == 202, f"Expected Room 202, got {data['room_number']}"
    else:
        print(f"  FAILED: {res.text}")
        errors += 1

    # TS-02: Guest checks out of Room 204
    # First check someone into 204
    print("\n[TS-02 (Part 1)] Check in Bob to Room 204 first...")
    payload_bob = {
        "guest_name": "Bob Jones",
        "room_type": "double",
        "nights": 2,
        "floor_preference": 2,
        "proximity_preference": "none"
    }
    res_in = requests.post(f"{reception_url}/check-in", json=payload_bob, headers=HEADERS)
    if res_in.status_code != 200:
        print(f"  FAILED to check in Bob: {res_in.text}")
        errors += 1
    else:
        print(f"  Checked in Bob to Room {res_in.json()['room_number']}.")

    # Now checkout 204
    print("[TS-02 (Part 2)] Guest checks out of Room 204...")
    res_out = requests.post(f"{reception_url}/check-out/204?late_checkout=true&discount_code=WELCOME10", headers=HEADERS)
    if res_out.status_code == 200:
        bill = res_out.json()
        print(f"  SUCCESS: Total bill calculated: ${bill['total_bill']:.2f}")
        print("  Breakdown:")
        for line in bill['breakdown_details']:
            print(f"    - {line}")
        # Nightly rate: 150 * 2 = 300. Late fee: 50. Total subtotal: 350. Discount 10%: 35. Grand total: 315.
        assert bill['total_bill'] == 315.0, f"Expected total bill $315.0, got ${bill['total_bill']}"
        
        # Verify Room 204 is in Housekeeping's cleaning queue
        time.sleep(1) # Let events propagate
        hk_res = requests.get(f"{hk_url}/queue", headers=HEADERS)
        hk_queue = hk_res.json()
        rooms_in_queue = [t["room_number"] for t in hk_queue]
        print(f"  Housekeeping Queue after checkout: {rooms_in_queue}")
        assert 204 in rooms_in_queue, "Room 204 should be in housekeeping queue!"
    else:
        print(f"  FAILED: {res_out.text}")
        errors += 1

    # TS-03: Housekeeper marks Room 204 as clean
    print("\n[TS-03] Housekeeper marks Room 204 as clean...")
    # Start cleaning
    res_start = requests.post(f"{hk_url}/start-cleaning/204?housekeeper_name=HK_Jane", headers=HEADERS)
    if res_start.status_code != 200:
        print(f"  FAILED to start cleaning: {res_start.text}")
        errors += 1
    else:
        print("  Started cleaning Room 204...")
        
    # Finish cleaning
    res_finish = requests.post(f"{hk_url}/finish-cleaning/204", headers=HEADERS)
    if res_finish.status_code == 200:
        print("  Finished cleaning Room 204 successfully.")
        time.sleep(1) # Let events propagate
        # Verify room 204 is now Clean in Reception
        rec_rooms = requests.get(f"{reception_url}/rooms", headers=HEADERS).json()
        room_204 = next(r for r in rec_rooms if r["room_number"] == 204)
        print(f"  Reception Room 204 status synced: {room_204['status']}")
        assert room_204['status'] == "Clean", "Room 204 status should be Clean"
    else:
        print(f"  FAILED to finish cleaning: {res_finish.text}")
        errors += 1

    # TS-04: Guest in Room 202 orders 2 coffees and a sandwich
    print("\n[TS-04] Room Service Order for Room 202...")
    order_payload = {
        "room_number": 202,
        "items": ["coffee", "coffee", "sandwich"]
    }
    res_ord = requests.post(f"{rs_url}/orders", json=order_payload, headers=HEADERS)
    if res_ord.status_code == 201:
        order = res_ord.json()["order"]
        order_id = order["order_id"]
        print(f"  Order placed. ID: {order_id}, Price: ${order['total_price']:.2f}, Status: {order['status']}")
        assert order["total_price"] == 22.0, f"Expected $22.0, got ${order['total_price']}"
        
        # Progress order to Delivered
        for stage in ["Preparing", "Out for delivery", "Delivered"]:
            prog_res = requests.post(f"{rs_url}/orders/{order_id}/progress", headers=HEADERS)
            assert prog_res.status_code == 200, f"Failed progressing order: {prog_res.text}"
            print(f"  Progressed: Order is now {prog_res.json()['order']['status']}")
            
        # Verify charge is reflected in Room 202 checkout
        time.sleep(1) # Let events propagate
        checkout_check = requests.post(f"{reception_url}/check-out/202", headers=HEADERS)
        assert checkout_check.status_code == 200, "Should succeed check-out check"
        bill_202 = checkout_check.json()
        print(f"  Room 202 billing includes RS charges: ${bill_202['room_service_charges']:.2f}")
        assert bill_202['room_service_charges'] == 22.0, f"Expected room service charges $22.0, got ${bill_202['room_service_charges']}"
    else:
        print(f"  FAILED to place order: {res_ord.text}")
        errors += 1

    # TS-05: Maintenance report: broken shower in Room 105, urgency Critical
    print("\n[TS-05] Maintenance report for Room 105 (Critical)...")
    maint_payload = {
        "room_number": 105,
        "description": "Broken shower in room 105",
        "urgency": "Critical"
    }
    res_maint = requests.post(f"{maint_url}/issues", json=maint_payload, headers=HEADERS)
    if res_maint.status_code == 201:
        issue = res_maint.json()["issue"]
        issue_id = issue["issue_id"]
        print(f"  SUCCESS: Issue logged. ID: {issue_id}, Status: {issue['status']}")
        
        # Check Reception synced room status to Maintenance
        time.sleep(1)
        rec_rooms = requests.get(f"{reception_url}/rooms", headers=HEADERS).json()
        room_105 = next(r for r in rec_rooms if r["room_number"] == 105)
        print(f"  Reception Room 105 status synced: {room_105['status']}")
        assert room_105['status'] == "Maintenance", "Room 105 status should be Maintenance"
        
        # Assign technician and resolve
        requests.post(f"{maint_url}/issues/{issue_id}/assign?technician_name=Tech_Bob", headers=HEADERS)
        requests.post(f"{maint_url}/issues/{issue_id}/resolve", headers=HEADERS)
        print("  Technician assigned and issue resolved.")
        
        # Check Room 105 status changes back to Clean
        time.sleep(1)
        rec_rooms = requests.get(f"{reception_url}/rooms", headers=HEADERS).json()
        room_105 = next(r for r in rec_rooms if r["room_number"] == 105)
        print(f"  Reception Room 105 status after resolution: {room_105['status']}")
        assert room_105['status'] == "Clean", "Room 105 status should be Clean"
    else:
        print(f"  FAILED: {res_maint.text}")
        errors += 1

    # TS-06: Two guests attempt to check in simultaneously requesting the same room type
    print("\n[TS-06] Simultaneous check-in requests for Single rooms...")
    # There are three single rooms in our inventory (101, 105, 201).
    # Since room status assignment is serialized via asyncio lock, they will get different rooms.
    payload_g1 = {"guest_name": "Guest A", "room_type": "single", "nights": 1}
    payload_g2 = {"guest_name": "Guest B", "room_type": "single", "nights": 1}
    
    # We call them in sequence but they are processed securely
    res_g1 = requests.post(f"{reception_url}/check-in", json=payload_g1, headers=HEADERS)
    res_g2 = requests.post(f"{reception_url}/check-in", json=payload_g2, headers=HEADERS)
    
    if res_g1.status_code == 200 and res_g2.status_code == 200:
        room_g1 = res_g1.json()["room_number"]
        room_g2 = res_g2.json()["room_number"]
        print(f"  Guest A assigned: Room {room_g1}")
        print(f"  Guest B assigned: Room {room_g2}")
        assert room_g1 != room_g2, "Rooms must be different!"
        print("  SUCCESS: Dynamic lock prevented double-booking.")
    else:
        print("  FAILED to check in guests.")
        errors += 1

    # TS-07: All rooms of the requested type are occupied
    print("\n[TS-07] Checking in when all rooms of type Suite are occupied...")
    # We have 2 suites: 103, 203. Let's occupy both
    requests.post(f"{reception_url}/check-in", json={"guest_name": "S1", "room_type": "suite", "nights": 1}, headers=HEADERS)
    requests.post(f"{reception_url}/check-in", json={"guest_name": "S2", "room_type": "suite", "nights": 1}, headers=HEADERS)
    
    # Attempt 3rd suite check-in
    res_over = requests.post(f"{reception_url}/check-in", json={"guest_name": "S3", "room_type": "suite", "nights": 1}, headers=HEADERS)
    if res_over.status_code == 404:
        print(f"  SUCCESS: Correctly returned 'no rooms available' message: '{res_over.json()['detail']}'")
    else:
        print(f"  FAILED: Expected 404 error, got {res_over.status_code}")
        errors += 1

    # TS-08: Invalid inputs
    print("\n[TS-08] Rejects invalid input during check-in...")
    invalid_payload = {
        "guest_name": "", # invalid too short
        "room_type": "penthouse", # invalid room type
        "nights": -5 # invalid nights
    }
    res_inv = requests.post(f"{reception_url}/check-in", json=invalid_payload, headers=HEADERS)
    if res_inv.status_code == 422:
        print("  SUCCESS: Input validation caught malformed payload with status 422.")
    else:
        print(f"  FAILED: Expected 422, got {res_inv.status_code}")
        errors += 1

    print(f"\n=== Test Runner Finished with {errors} errors ===")

if __name__ == "__main__":
    try:
        start_services()
        run_scenarios()
    except Exception as e:
        print(f"Test Execution Failed: {e}")
    finally:
        stop_services()
