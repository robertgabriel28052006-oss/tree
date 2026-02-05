import os
import datetime
import json
from flask import Flask, request, jsonify, session, send_from_directory
from flask_cors import CORS
import firebase_admin
from firebase_admin import credentials, firestore
from werkzeug.security import generate_password_hash, check_password_hash
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__, static_folder='.', static_url_path='')
app.secret_key = os.environ.get('SECRET_KEY', 'dev_secret_key_change_in_prod')
CORS(app, supports_credentials=True)

@app.route('/')
def index():
    return send_from_directory('.', 'index.html')

# Initialize Firebase
# Expecting GOOGLE_APPLICATION_CREDENTIALS env var or a specific file
cred_path = os.environ.get('FIREBASE_CREDENTIALS', 'serviceAccountKey.json')

if os.path.exists(cred_path):
    cred = credentials.Certificate(cred_path)
    firebase_admin.initialize_app(cred)
    db = firestore.client()
    print("Firebase initialized with credentials.")
else:
    print(f"Warning: {cred_path} not found. Firebase not initialized. Backend will not function correctly without it.")
    db = None

# Admin Configuration
ADMIN_EMAIL = os.environ.get('ADMIN_EMAIL', 'admin@spalatorie.com')
# Default password hash for 'p20spal' (the one in memory) or use a strong one.
# For now, let's allow setting it via env var.
ADMIN_PASSWORD_HASH = os.environ.get('ADMIN_PASSWORD_HASH')
if not ADMIN_PASSWORD_HASH:
    # Default to 'p20spal' for compatibility if not set
    ADMIN_PASSWORD_HASH = generate_password_hash('p20spal')

def is_admin():
    return session.get('is_admin', False)

@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "ok", "firebase": db is not None})

# -----------------------------------------------------------------------------
# AUTH ENDPOINTS
# -----------------------------------------------------------------------------

@app.route('/api/login', methods=['POST'])
def login():
    data = request.json
    email = data.get('email')
    password = data.get('password')

    # Simple "Firewall": Check email and password against env vars
    # In a real app, use a database for admins. Here we use the config.
    if email == ADMIN_EMAIL and check_password_hash(ADMIN_PASSWORD_HASH, password):
        session['is_admin'] = True
        return jsonify({"success": True})

    return jsonify({"success": False, "error": "Invalid credentials"}), 401

@app.route('/api/logout', methods=['POST'])
def logout():
    session.pop('is_admin', None)
    return jsonify({"success": True})

@app.route('/api/check_auth', methods=['GET'])
def check_auth():
    return jsonify({"is_admin": is_admin()})

# -----------------------------------------------------------------------------
# BOOKING ENDPOINTS
# -----------------------------------------------------------------------------

@app.route('/api/book', methods=['POST'])
def book_slot():
    if not db:
        return jsonify({"error": "Database not connected"}), 500

    data = request.json
    try:
        user_name = data.get('userName')
        phone = data.get('phoneNumber')
        pin = data.get('pin')
        machine = data.get('machineType')
        date = data.get('date')
        start_time = data.get('startTime')
        duration = int(data.get('duration'))

        # 1. Validation
        if not all([user_name, phone, pin, machine, date, start_time, duration]):
            return jsonify({"error": "Missing fields"}), 400

        if len(str(pin)) != 4:
            return jsonify({"error": "PIN must be 4 digits"}), 400

        # 2. Check Lock / Availability (Simplified transaction logic)
        slot_id = f"{date}_{machine}_{start_time}"
        slot_ref = db.collection('slots_lock').document(slot_id)

        # Transactional logic needed here ideally.
        # For simplicity in Flask without complex callbacks, we check and set.
        # Note: Firestore transactions in Python are possible but let's keep it simple first.

        @firestore.transactional
        def create_booking_in_transaction(transaction, slot_ref):
            snapshot = slot_ref.get(transaction=transaction)
            if snapshot.exists:
                locked_data = snapshot.to_dict()
                locked_at = locked_data.get('lockedAt')
                if locked_at:
                    # Parse ISO format.
                    # Note: Python fromisoformat might need adjustment for 'Z'
                    locked_time = datetime.datetime.fromisoformat(locked_at.replace('Z', '+00:00'))
                    now = datetime.datetime.now(datetime.timezone.utc)
                    if (now - locked_time).total_seconds() < 300: # 5 mins
                        raise Exception("Slot already booked/locked")

            # Create Lock
            transaction.set(slot_ref, {
                "lockedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "machine": machine,
                "date": date,
                "start": start_time
            })

            # Create Reservation with HASHED PIN
            hashed_pin = generate_password_hash(pin)
            new_booking_ref = db.collection('rezervari').document()
            transaction.set(new_booking_ref, {
                "userName": user_name,
                "phoneNumber": phone,
                "code": hashed_pin, # STORE HASH
                "machineType": machine,
                "date": date,
                "startTime": start_time,
                "duration": duration,
                "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat()
            })
            return new_booking_ref.id

        transaction = db.transaction()
        booking_id = create_booking_in_transaction(transaction, slot_ref)

        return jsonify({"success": True, "id": booking_id})

    except Exception as e:
        return jsonify({"error": str(e)}), 400


@app.route('/api/reservations', methods=['GET'])
def get_reservations():
    if not db:
        return jsonify({"error": "Database not connected"}), 500

    try:
        # Fetch relevant range (e.g., yesterday to next week)
        # For simplicity, we can fetch all or filter.
        # Frontend logic was: yesterday to next week.

        now = datetime.datetime.now()
        yesterday = (now - datetime.timedelta(days=1)).strftime('%Y-%m-%d')
        next_week = (now + datetime.timedelta(days=7)).strftime('%Y-%m-%d')

        reservations_ref = db.collection('rezervari')
        query = reservations_ref.where('date', '>=', yesterday).where('date', '<=', next_week)
        docs = query.stream()

        results = []
        for doc in docs:
            data = doc.to_dict()
            data['id'] = doc.id
            # SECURITY: REMOVE THE CODE/PIN BEFORE SENDING
            if 'code' in data:
                del data['code']
            results.append(data)

        return jsonify(results)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/delete', methods=['POST'])
def delete_booking():
    if not db:
        return jsonify({"error": "Database not connected"}), 500

    data = request.json
    booking_id = data.get('id')
    entered_pin = data.get('pin')

    if not booking_id:
        return jsonify({"error": "Missing ID"}), 400

    # Retrieve booking
    doc_ref = db.collection('rezervari').document(booking_id)
    doc = doc_ref.get()

    if not doc.exists:
        return jsonify({"error": "Booking not found"}), 404

    booking_data = doc.to_dict()
    stored_code = booking_data.get('code')

    # AUTH CHECK
    authorized = False

    # 1. Admin bypass
    if is_admin():
        authorized = True

    # 2. PIN Check
    elif entered_pin:
        if len(stored_code) == 4:
            # Legacy plain text PIN
            if stored_code == entered_pin:
                authorized = True
        else:
            # Hashed PIN
            if check_password_hash(stored_code, entered_pin):
                authorized = True

    if not authorized:
        return jsonify({"error": "Unauthorized / Incorrect PIN"}), 403

    # PERFORM DELETE
    # 1. Delete Lock (Best effort)
    try:
        slot_id = f"{booking_data['date']}_{booking_data['machineType']}_{booking_data['startTime']}"
        db.collection('slots_lock').document(slot_id).delete()
    except:
        pass # Ignore lock delete errors

    # 2. Delete Reservation
    doc_ref.delete()

    return jsonify({"success": True})

@app.route('/api/settings', methods=['GET', 'POST'])
def settings():
    if not db:
        return jsonify({"error": "Database not connected"}), 500

    settings_ref = db.collection('settings').document('appState')

    if request.method == 'GET':
        doc = settings_ref.get()
        if doc.exists:
            return jsonify(doc.to_dict())
        return jsonify({})

    if request.method == 'POST':
        if not is_admin():
            return jsonify({"error": "Unauthorized"}), 403

        data = request.json
        settings_ref.set(data, merge=True)
        return jsonify({"success": True})

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5000))
    app.run(host='0.0.0.0', port=port)
