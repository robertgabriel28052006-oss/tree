// ------------------------------------------------------------------
// 1. IMPORTURI FIREBASE
// ------------------------------------------------------------------
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, collection, addDoc, deleteDoc, doc, setDoc, onSnapshot, query, orderBy, where, runTransaction, writeBatch, limit, getDocs } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

// ------------------------------------------------------------------
// 2. CONFIGURARE (Datele Tale)
// ------------------------------------------------------------------
const firebaseConfig = {
  apiKey: "AIzaSyA3uDKfPBvMfuqTk3Z1tLyLOwP40zFtohs",
  authDomain: "spalatoriep20-b123d.firebaseapp.com",
  projectId: "spalatoriep20-b123d",
  storageBucket: "spalatoriep20-b123d.firebasestorage.app",
  messagingSenderId: "899577919587",
  appId: "1:899577919587:web:7e32821c02144ce61a6056"
};

// Inițializare aplicație
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
let auth = null;
try {
    auth = getAuth(app);
} catch (e) {
    console.warn("Auth initialization failed (likely configuration issue):", e);
}
const bookingsCollection = collection(db, "rezervari");

// ------------------------------------------------------------------
// 3. LOGICA APLICATIEI
// ------------------------------------------------------------------

let localBookings = [];
let historyBookings = []; // Separate array for history
let deleteId = null;
let isAdmin = false;
let adminViewMode = 'active';

const utils = {
    showToast(message, type = 'success') {
        const toast = document.getElementById('toast');
        if (toast) {
            toast.textContent = message;
            toast.className = `toast ${type} show`;
            setTimeout(() => toast.classList.remove('show'), 3000);
        } else {
            alert(message);
        }
    },
    formatDateRO(dateStr) {
        const options = { weekday: 'long', day: 'numeric', month: 'long' };
        // Adaugam T12:00:00 pentru a evita probleme de timezone
        return new Date(dateStr + 'T12:00:00').toLocaleDateString('ro-RO', options);
    },
    timeToMins(time) { 
        if(!time) return 0;
        const [h, m] = time.split(':').map(Number); 
        return h * 60 + m; 
    },
    minsToTime(mins) { 
        let h = Math.floor(mins / 60); 
        const m = mins % 60; 
        if (h >= 24) h = h - 24; 
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}`; 
    },
    addDays(dateStr, days) {
        const date = new Date(dateStr);
        date.setDate(date.getDate() + days);
        return date.toISOString().split('T')[0];
    },
    
    capitalize(str) {
        if (!str) return '';
        return str.toLowerCase().split(' ').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
    }
};

const logic = {
    machines: { 'masina1': 'Mașină Spălat 1', 'masina2': 'Mașină Spălat 2', 'uscator1': 'Uscător 1', 'uscator2': 'Uscător 2' },
    
    // Generăm sloturi de 30 minute pentru vizualizare 24h
    generateSlots(startHour = 0, endHour = 24) {
        const slots = [];
        for (let h = startHour; h < endHour; h++) { 
            slots.push(`${h.toString().padStart(2, '0')}:00`); 
            slots.push(`${h.toString().padStart(2, '0')}:30`); 
        }
        return slots;
    },

    isSlotFree(machine, date, start, duration) {
        // 1. Check SAME DAY conflicts
        const sameDayBookings = localBookings.filter(b => b.machineType === machine && b.date === date);
        const reqStart = utils.timeToMins(start);
        const reqEnd = reqStart + parseInt(duration);
        
        const overlapSameDay = sameDayBookings.some(b => {
            const bStart = utils.timeToMins(b.startTime);
            const bEnd = bStart + parseInt(b.duration);
            return (reqStart < bEnd && reqEnd > bStart);
        });

        if (overlapSameDay) return false;

        // 2. Check PREVIOUS DAY Spillover (e.g. booked yesterday at 23:30 for 90 mins -> ends today at 01:00)
        const prevDate = utils.addDays(date, -1);
        const prevDayBookings = localBookings.filter(b => b.machineType === machine && b.date === prevDate);
        
        const overlapPrevDay = prevDayBookings.some(b => {
            const bStart = utils.timeToMins(b.startTime);
            const bDuration = parseInt(b.duration);
            const bEndTotal = bStart + bDuration; // e.g., 23:50 (1430) + 90 = 1520
            
            if (bEndTotal > 1440) { // Spills over midnight
                const spillEnd = bEndTotal - 1440; // Ends at 01:20 (80 mins into today)
                // Check if our requested start time (today) is before the spill ends
                return reqStart < spillEnd;
            }
            return false;
        });

        return !overlapPrevDay;
    },

    canUserBook(userName) {
        const limit = 2; 
        const today = new Date().toISOString().split('T')[0];
        // Numaram doar rezervarile active (de azi inainte)
        const userBookings = localBookings.filter(b => 
            b.userName.toLowerCase() === userName.toLowerCase() && b.date >= today
        );
        return userBookings.length < limit;
    }
};

const ui = {
    currentDate: new Date().toISOString().split('T')[0],
    
    init() {
        this.setupEventListeners();
        if(auth) this.setupAuthListener();
        
        // SAFETY TIMEOUT FOR LOADER
        setTimeout(() => {
            const loader = document.getElementById('appLoader');
            if(loader && loader.style.display !== 'none') {
                const text = document.getElementById('loaderText');
                if(text) text.textContent = "Conexiunea durează mult...";
                const btn = document.getElementById('reloadBtn');
                if(btn) {
                    btn.style.display = 'inline-block';
                    btn.onclick = () => window.location.reload();
                }
            }
        }, 5000); // 5 seconds timeout

        // THEME INIT
        const savedTheme = localStorage.getItem('theme');
        if (savedTheme === 'dark') {
            document.body.classList.add('dark-mode');
            document.querySelector('#themeToggleBtn i').className = 'fa-solid fa-sun';
        }

        const dateInput = document.getElementById('bookingDate');
        const today = new Date().toISOString().split('T')[0];
        dateInput.min = today;
        dateInput.value = this.currentDate;
        
        this.updateDateDisplay();
        
        // --- VERIFICARE MIEZUL NOPȚII ---
        this.startMidnightWatcher();

        // Calculam data de ieri pentru a incarca doar rezervarile recente (Optimizare Costuri)
        const d = new Date(); 
        d.setDate(d.getDate() - 1); 
        const yesterday = d.toISOString().split('T')[0];
        
        const dNext = new Date();
        dNext.setDate(dNext.getDate() + 7);
        const nextWeek = dNext.toISOString().split('T')[0];

        // 1. ASCULTARE REZERVARI (DOAR SĂPTĂMÂNA CURENTĂ PENTRU STUDENȚI)
        // Aceasta reduce drastic costurile de citire.
        // NOTA: Necesita index compus in Firebase Console pentru "date ASC, startTime ASC".
        // Daca nu exista index, va da eroare in consola cu link de creare.
        const q = query(
            bookingsCollection, 
            where("date", ">=", yesterday), 
            where("date", "<=", nextWeek),
            orderBy("date"), 
            orderBy("startTime")
        );
        
        onSnapshot(q, (snapshot) => {
            localBookings = [];
            snapshot.docs.forEach(doc => localBookings.push({ ...doc.data(), id: doc.id }));
            
            const loader = document.getElementById('appLoader');
            if(loader) {
                loader.style.opacity = '0';
                setTimeout(() => loader.style.display = 'none', 500);
            }

            this.renderAll();
        }, (error) => { 
            console.error("Eroare Firebase:", error);
            
            // Show error in loader if still visible
            const loader = document.getElementById('appLoader');
            if(loader && loader.style.display !== 'none') {
                document.getElementById('loaderText').textContent = "Eroare conexiune. Verifică internetul.";
                document.getElementById('reloadBtn').style.display = 'inline-block';
                document.getElementById('reloadBtn').onclick = () => window.location.reload();
                return; // Stop execution to show error
            }

            // Fallback simplu daca indexul compus lipseste (incarca tot viitorul)
            const qFallback = query(bookingsCollection, where("date", ">=", yesterday), orderBy("date"));
            onSnapshot(qFallback, (snap) => {
                 localBookings = [];
                 snap.docs.forEach(doc => localBookings.push({ ...doc.data(), id: doc.id }));
                 this.renderAll();
                 
                 // Hide loader on fallback success
                 if(loader) {
                    loader.style.opacity = '0';
                    setTimeout(() => loader.style.display = 'none', 500);
                 }
            });
        });

        // 2. ASCULTARE SETARI (MENTENANTA)
        onSnapshot(doc(db, "settings", "appState"), (docSnap) => {
            if (docSnap.exists()) {
                const data = docSnap.data();
                const maintenanceMode = data.maintenance || false;
                
                // Actualizam Switch-ul din admin panel
                document.getElementById('maintenanceToggle').checked = maintenanceMode;
                
                // Aratam/Ascundem overlay-ul
                // Daca e mentenanta SI nu suntem logati ca admin, blocam ecranul
                const overlay = document.getElementById('maintenanceOverlay');
                if (maintenanceMode && !isAdmin) {
                    overlay.style.display = 'flex';
                } else {
                    overlay.style.display = 'none';
                }
            }
        });
    },

    // Funcția care verifică fiecare minut dacă data s-a schimbat
    startMidnightWatcher() {
        setInterval(() => {
            const realToday = new Date().toISOString().split('T')[0];
            const dateInput = document.getElementById('bookingDate');
            
            // Dacă data minimă (azi) nu mai corespunde cu realitatea
            if (dateInput.min !== realToday) {
                dateInput.min = realToday;
                
                // Dacă utilizatorul era pe ziua de "ieri", îl mutăm pe "azi"
                if (this.currentDate < realToday) {
                    this.currentDate = realToday;
                    dateInput.value = realToday;
                    this.updateDateDisplay();
                    this.renderAll();
                    utils.showToast('Zi nouă! Calendarul s-a actualizat.');
                }
            }
        }, 60000); // 60000 ms = 1 minut
    },

    setupEventListeners() {
        document.getElementById('bookingForm').addEventListener('submit', this.handleBooking.bind(this));
        
        document.getElementById('prevDay').onclick = () => this.changeDate(-1);
        document.getElementById('nextDay').onclick = () => this.changeDate(1);
        
        // Verificare vizuală la schimbarea orei manuale
        const timeInput = document.getElementById('startTime');
        if (timeInput) {
            timeInput.addEventListener('change', () => {
                const machine = document.getElementById('machineType').value;
                const date = document.getElementById('bookingDate').value;
                const start = timeInput.value;
                const duration = document.getElementById('duration').value;

                if (machine && date && start) {
                    if (!logic.isSlotFree(machine, date, start, duration)) {
                        utils.showToast('⚠️ Ora selectată se suprapune!', 'error');
                        timeInput.style.borderColor = 'var(--danger)';
                    } else {
                        timeInput.style.borderColor = 'var(--success)';
                    }
                }
            });
        }
        
        document.getElementById('bookingDate').onchange = (e) => { 
            this.currentDate = e.target.value; 
            this.updateDateDisplay(); 
            this.renderAll(); 
        };
        
        document.getElementById('machineType').onchange = () => {
             document.getElementById('startTime').style.borderColor = 'var(--border)';
        };

        // VISUAL SELECTOR LOGIC
        document.querySelectorAll('.selector-card').forEach(card => {
            card.onclick = () => {
                // Remove active class from all
                document.querySelectorAll('.selector-card').forEach(c => c.classList.remove('selected'));
                // Add to clicked
                card.classList.add('selected');
                // Update hidden select
                const value = card.dataset.value;
                const select = document.getElementById('machineType');
                select.value = value;
                // Trigger change event manually
                select.dispatchEvent(new Event('change'));
            };
        });

        document.getElementById('userName').oninput = () => this.renderMyBookings();
        
        document.querySelectorAll('.modal-close').forEach(btn => btn.onclick = () => {
            document.getElementById('modalOverlay').style.display = 'none';
            document.getElementById('confirmModal').style.display = 'none';
            document.getElementById('adminModal').style.display = 'none';
        });

        // Admin Maintenance Toggle
        document.getElementById('maintenanceToggle').onchange = async (e) => {
            const isChecked = e.target.checked;
            
            // Update UI label
            const statusLabel = document.getElementById('maintenanceStatusLabel');
            if(statusLabel) {
               statusLabel.textContent = isChecked ? "Sistem Offline (Mentenanță)" : "Sistem Online";
               if(isChecked) statusLabel.classList.add('offline'); else statusLabel.classList.remove('offline');
            }

            try {
                // Salvam starea in baza de date 'settings/appState'
                await setDoc(doc(db, "settings", "appState"), { maintenance: isChecked });
                utils.showToast(isChecked ? "Mentenanță ACTIVATĂ" : "Mentenanță DEZACTIVATĂ");
            } catch (err) {
                console.error(err);
                utils.showToast("Eroare la salvarea setării.", "error");
                e.target.checked = !isChecked; // Revert switch on error
                // Revert label
                if(statusLabel) {
                   statusLabel.textContent = !isChecked ? "Sistem Offline (Mentenanță)" : "Sistem Online";
                   if(!isChecked) statusLabel.classList.add('offline'); else statusLabel.classList.remove('offline');
                }
            }
        };

        // Butonul secret de pe ecranul de mentenanta
        document.getElementById('maintenanceAdminBtn').onclick = () => {
             document.getElementById('modalOverlay').style.display = 'flex';
             document.getElementById('adminModal').style.display = 'block';
             document.getElementById('phoneModal').style.display = 'none';
             document.getElementById('confirmModal').style.display = 'none';
        };
        
        // DARK MODE TOGGLE
        const themeBtn = document.getElementById('themeToggleBtn');
        if(themeBtn) {
            themeBtn.onclick = () => {
                document.body.classList.toggle('dark-mode');
                const isDark = document.body.classList.contains('dark-mode');
                localStorage.setItem('theme', isDark ? 'dark' : 'light');
                
                const icon = themeBtn.querySelector('i');
                if(icon) icon.className = isDark ? 'fa-solid fa-sun' : 'fa-solid fa-moon';
            };
        }

        // ADMIN EVENTS (Search, Tabs)
        document.getElementById('adminSearchInput').addEventListener('input', () => this.renderAdminDashboard());
        document.getElementById('adminDateFilter').addEventListener('change', () => this.renderAdminDashboard());
        
        document.getElementById('tabActive').onclick = () => {
             adminViewMode = 'active';
             document.getElementById('tabActive').classList.add('active');
             document.getElementById('tabHistory').classList.remove('active');
             document.getElementById('listTitle').textContent = "Rezervări Active";
             this.renderAdminDashboard();
        };
        document.getElementById('tabHistory').onclick = async () => {
             adminViewMode = 'history';
             document.getElementById('tabHistory').classList.add('active');
             document.getElementById('tabActive').classList.remove('active');
             document.getElementById('listTitle').textContent = "Istoric (Se încarcă...)";
             
             // LAZY LOAD HISTORY
             try {
                 const d = new Date(); 
                 d.setDate(d.getDate() - 1); 
                 const yesterday = d.toISOString().split('T')[0];

                 // Limit to 50 for performance
                 const qHistory = query(bookingsCollection, where("date", "<", yesterday), orderBy("date", "desc"), limit(50));
                 const snap = await getDocs(qHistory);
                 
                 historyBookings = []; // Reset history buffer
                 snap.docs.forEach(doc => {
                     historyBookings.push({ ...doc.data(), id: doc.id });
                 });
                 
                 document.getElementById('listTitle').textContent = "Istoric Rezervări";
                 this.renderAdminDashboard();
             } catch (e) {
                 console.error(e);
                 utils.showToast("Eroare încărcare istoric.", "error");
             }
        };

        const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
        if(cancelDeleteBtn) cancelDeleteBtn.onclick = () => {
            document.getElementById('modalOverlay').style.display = 'none';
            document.getElementById('confirmModal').style.display = 'none';
            deleteId = null;
        };

        const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
        if(confirmDeleteBtn) confirmDeleteBtn.onclick = async () => {
            if (deleteId) {
                try {
                    await deleteDoc(doc(db, "rezervari", deleteId));
                    // Manually remove from local arrays (Snapshot handles localBookings but not history)
                    localBookings = localBookings.filter(b => b.id !== deleteId);
                    historyBookings = historyBookings.filter(b => b.id !== deleteId);
                    
                    utils.showToast('Rezervare ștearsă.');
                    this.renderAdminDashboard(); // Refresh UI
                } catch (e) {
                    console.error(e);
                    utils.showToast('Eroare la ștergere', 'error');
                }
                document.getElementById('modalOverlay').style.display = 'none';
                document.getElementById('confirmModal').style.display = 'none';
                deleteId = null;
            }
        };

        document.getElementById('adminToggleBtn').onclick = () => { 
            // Reset state: close other modals
            document.getElementById('phoneModal').style.display = 'none';
            document.getElementById('confirmModal').style.display = 'none';
            
            // Open Admin
            document.getElementById('modalOverlay').style.display = 'flex'; 
            document.getElementById('adminModal').style.display = 'block';
        };
        document.getElementById('adminLoginBtn').onclick = this.handleAdminLogin.bind(this);
        document.getElementById('adminLogoutBtn').onclick = () => { 
            signOut(auth).then(() => {
                utils.showToast("Deconectare reușită");
            }).catch((error) => {
                console.error(error);
            });
        };
    },

    setupAuthListener() {
        onAuthStateChanged(auth, (user) => {
            if (user) {
                isAdmin = true;
                document.body.classList.add('admin-mode');
                document.getElementById('adminLoginForm').style.display = 'none'; 
                document.getElementById('adminContent').style.display = 'block'; 
                document.getElementById('maintenanceOverlay').style.display = 'none';
                
                this.renderAdminDashboard();
                this.cleanupOldBookings();
            } else {
                isAdmin = false;
                document.body.classList.remove('admin-mode');
                document.getElementById('adminContent').style.display = 'none'; 
                document.getElementById('adminLoginForm').style.display = 'block'; 
                document.getElementById('adminPassword').value = ''; 
                
                const toggle = document.getElementById('maintenanceToggle');
                if(toggle && toggle.checked) {
                    document.getElementById('maintenanceOverlay').style.display = 'flex';
                    document.getElementById('modalOverlay').style.display = 'none';
                }
            }
        });
    },

    changeDate(days) {
        const date = new Date(this.currentDate);
        date.setDate(date.getDate() + days);
        const newDateStr = date.toISOString().split('T')[0];
        
        const today = new Date().toISOString().split('T')[0];
        if (newDateStr < today) {
            utils.showToast('Nu poți vedea programul din trecut.', 'error');
            return;
        }

        this.currentDate = newDateStr;
        document.getElementById('bookingDate').value = this.currentDate;
        this.updateDateDisplay(); 
        this.renderAll(); 
    },

    updateDateDisplay() { 
        const display = document.getElementById('currentDateDisplay'); 
        const today = new Date().toISOString().split('T')[0]; 
        display.textContent = (this.currentDate === today) ? "Astăzi" : utils.formatDateRO(this.currentDate); 
    },

  async handleBooking(e) {
        e.preventDefault();
        const submitBtn = e.target.querySelector('button[type="submit"]');
        const originalBtnText = submitBtn.innerHTML;
        
        // Dezactivare buton pentru a preveni dublu-click accidental din interfață
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<div class="spinner" style="width:20px;height:20px;border-width:2px;margin:0;display:inline-block;"></div> Verificare...';

        try {
            let userName = document.getElementById('userName').value.trim();
            const phone = document.getElementById('phoneNumber').value.trim();
            const machine = document.getElementById('machineType').value;
            const start = document.getElementById('startTime').value;
            const duration = parseInt(document.getElementById('duration').value);

            // Validări de bază
            if (!start) throw new Error("Te rog selectează ora!");
            if (!machine) throw new Error("Alege o mașină!");

            userName = utils.capitalize(userName);
            const cleanPhone = phone.replace(/\D/g, '');

            // Validare telefon
            if (cleanPhone.length !== 10 || !cleanPhone.startsWith('07')) { 
                throw new Error("Număr invalid! Trebuie 10 cifre și să înceapă cu 07.");
            }
            
            // Validare limită rezervări
            if (!logic.canUserBook(userName)) {
                throw new Error("Ai atins limita de 2 rezervări active!");
            }

            // Validare suprapunere (Client side check rapid)
            if (!logic.isSlotFree(machine, this.currentDate, start, duration)) {
                 throw new Error("Intervalul este deja ocupat (verifica orarul).");
            }

            // --- UNICA TRANZACȚIE DE SALVARE ---
            await runTransaction(db, async (transaction) => {
                // 1. Creăm un ID unic pentru slot ca să prevenim duplicatele exacte
                // Format: Data_Masina_Ora (Ex: 2024-02-05_masina1_10:00)
                const slotID = `${this.currentDate}_${machine}_${start}`;
                const slotRef = doc(db, "slots_lock", slotID); 
                
                // 2. Verificăm dacă există deja acest lock (pentru concurență la milisecundă)
                const slotDoc = await transaction.get(slotRef);
                if (slotDoc.exists()) {
                    throw "Cineva a rezervat acest slot chiar acum!";
                }
                
                // 3. Scriem Lock-ul
                transaction.set(slotRef, { 
                    lockedAt: new Date().toISOString(),
                    machine,
                    date: this.currentDate,
                    start
                });

                // 4. Scriem Rezervarea propriu-zisă
                const newBookingRef = doc(collection(db, "rezervari"));
                transaction.set(newBookingRef, { 
                    userName, 
                    phoneNumber: cleanPhone, 
                    machineType: machine, 
                    date: this.currentDate, 
                    startTime: start, 
                    duration: duration, 
                    createdAt: new Date().toISOString() 
                });
            });

            // --- FINALIZARE CU SUCCES ---
            utils.showToast('Rezervare salvată cu succes!');
            e.target.reset(); 
            
            // Păstrăm numele completat pentru confort
            document.getElementById('userName').value = userName; 
            document.getElementById('bookingDate').value = this.currentDate;
            
            // Reset vizual
            document.getElementById('startTime').style.borderColor = 'var(--border)';
            document.querySelectorAll('.selected-slot').forEach(el => el.classList.remove('selected-slot'));
            
        } catch (error) { 
            console.error(error); 
            let msg = 'Eroare server.';
            // Gestionăm mesajele de eroare simple sau obiecte Error
            if (typeof error === 'string') msg = error;
            else if (error.message) msg = error.message;
            
            utils.showToast(msg, 'error'); 
        } finally {
            // Reactivăm butonul indiferent ce se întâmplă
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalBtnText;
        }
    },

    renderAll() { this.renderSchedule(); this.renderMyBookings(); this.renderUpcoming(); if (document.getElementById('adminContent').style.display === 'block') { this.renderAdminDashboard(); } },

    renderSchedule() {
        const grid = document.getElementById('scheduleGrid'); grid.innerHTML = '';
        const slots = logic.generateSlots();
        
        // Bookings for TODAY
        const todaysBookings = localBookings.filter(b => b.date === this.currentDate);
        
        // Bookings from YESTERDAY that spill over
        const prevDate = utils.addDays(this.currentDate, -1);
        const spillBookings = localBookings.filter(b => {
            if (b.date !== prevDate) return false;
            const end = utils.timeToMins(b.startTime) + parseInt(b.duration);
            return end > 1440; // Ends next day
        });

        const allBookings = [...todaysBookings, ...spillBookings];

        Object.keys(logic.machines).forEach(machineKey => {
            const col = document.createElement('div'); col.className = 'machine-column';
            const header = document.createElement('div'); header.className = 'machine-header';
            header.innerHTML = `<small>${machineKey.includes('masina') ? '🧺' : '🌬️'}</small><br>${logic.machines[machineKey]}`; col.appendChild(header);

            slots.forEach(slot => {
                const slotMins = utils.timeToMins(slot); 
                const nextSlotMins = slotMins + 30; 

                const booking = allBookings.find(b => {
                    if (b.machineType !== machineKey) return false;
                    
                    let bStart = utils.timeToMins(b.startTime);
                    let bEnd = bStart + parseInt(b.duration);   
                    
                    // Handle Spillover Display Logic
                    if (b.date === prevDate) {
                        // This booking started yesterday.
                        // For display TODAY, it effectively starts at 0 and ends at (total - 1440)
                        bStart = 0;
                        bEnd = bEnd - 1440;
                    }

                    return (bStart < nextSlotMins && bEnd > slotMins);
                });

                const div = document.createElement('div'); div.className = `time-slot ${booking ? 'occupied' : 'available'}`;
                
                if (booking) {
                    let bStart = utils.timeToMins(booking.startTime);
                    let bEnd = bStart + parseInt(booking.duration);
                    let isSpill = false;

                    if (booking.date === prevDate) {
                        isSpill = true;
                        bStart = 0;
                        bEnd = bEnd - 1440;
                    }
                    
                    const isStartOfBookingInGrid = (bStart >= slotMins && bStart < nextSlotMins);

                    if (bStart >= slotMins) div.classList.add('booking-start'); 
                    if (bEnd <= nextSlotMins) div.classList.add('booking-end'); 
                    if (bStart < slotMins && bEnd > nextSlotMins) div.classList.add('booking-middle');

                    if (isStartOfBookingInGrid) { 
                        // Logic to show correct time text
                        let timeText = "";
                        if (isSpill) {
                            timeText = `... - ${utils.minsToTime(bEnd)}`;
                        } else {
                            const realEnd = bStart + parseInt(booking.duration);
                            const endStr = realEnd > 1440 ? utils.minsToTime(realEnd - 1440) + " (mâine)" : utils.minsToTime(realEnd);
                            timeText = `${booking.startTime} - ${endStr}`;
                        }
                        div.innerHTML = `<div class="slot-content"><span class="slot-time">${timeText}</span><span class="slot-name">${booking.userName}</span></div>`; 
                    }
                    div.title = `Rezervat: ${booking.userName}`; 
                    div.onclick = () => this.showPhoneModal(booking);
                } else {
                    div.textContent = slot;
                    div.onclick = (e) => {
                        document.getElementById('machineType').value = machineKey; 
                        document.getElementById('duration').value = "60"; 
                        document.getElementById('startTime').value = slot; 
                        
                        document.querySelector('.booking-card').scrollIntoView({behavior: 'smooth', block: 'center'}); 
                        document.querySelector('.booking-card').classList.add('highlight-pulse'); 
                        setTimeout(() => document.querySelector('.booking-card').classList.remove('highlight-pulse'), 1000); 

                        // Visual selection
                        document.querySelectorAll('.selected-slot').forEach(el => el.classList.remove('selected-slot'));
                        e.target.classList.add('selected-slot');
                    };
                }
                col.appendChild(div);
            });
            grid.appendChild(col);
        });
    },

    showPhoneModal(booking) { 
        document.getElementById('modalUserName').textContent = booking.userName; 
        document.getElementById('modalPhoneNumber').textContent = booking.phoneNumber; 
        document.getElementById('callPhoneBtn').href = `tel:${booking.phoneNumber}`; 
        document.getElementById('copyPhoneBtn').onclick = () => { 
            navigator.clipboard.writeText(booking.phoneNumber).then(() => { utils.showToast('Număr copiat!'); }); 
        }; 
        document.getElementById('adminModal').style.display = 'none'; 
        document.getElementById('confirmModal').style.display = 'none';
        document.getElementById('modalOverlay').style.display = 'flex'; 
        document.getElementById('phoneModal').style.display = 'block'; 
    },

    confirmDelete(id) {
        deleteId = id;
        document.getElementById('modalOverlay').style.display = 'flex';
        document.getElementById('phoneModal').style.display = 'none';
        document.getElementById('adminModal').style.display = 'none';
        document.getElementById('confirmModal').style.display = 'block';
    },

    renderMyBookings() { 
        const container = document.getElementById('myBookings'); 
        const currentUser = document.getElementById('userName').value.trim().toLowerCase(); 
        if (!currentUser) { container.innerHTML = '<div class="empty-state">Introdu numele pentru a vedea rezervările.</div>'; return; } 
        const bookings = localBookings.filter(b => b.userName.toLowerCase().includes(currentUser)).sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime)); 
        container.innerHTML = bookings.length ? bookings.map(b => {
             const endMins = utils.timeToMins(b.startTime) + parseInt(b.duration);
             const endTime = utils.minsToTime(endMins);
             return `<div class="booking-item"><div class="booking-info"><strong>${logic.machines[b.machineType]}</strong><span>${utils.formatDateRO(b.date)} • ${b.startTime} - ${endTime}</span></div><button class="btn-delete" onclick="window.app.confirmDelete('${b.id}')">Anulează</button></div>`;
        }).join('') : '<div class="empty-state">Nu am găsit rezervări.</div>'; 
    },

    renderUpcoming() { 
        const container = document.getElementById('upcomingBookings'); 
        const today = new Date().toISOString().split('T')[0]; 
        const bookings = localBookings.filter(b => b.date > today).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 5); 
        container.innerHTML = bookings.length ? bookings.map(b => `<div class="booking-item"><div class="booking-info"><strong>${b.userName}</strong><span>${utils.formatDateRO(b.date)} • ${logic.machines[b.machineType]}</span></div></div>`).join('') : '<div class="empty-state">Nimic planificat.</div>'; 
    },

    async handleAdminLogin() { 
        const email = document.getElementById('adminEmail').value;
        const password = document.getElementById('adminPassword').value; 
        
        if (!email || !password) {
            utils.showToast("Introdu email și parolă", "error");
            return;
        }

        try {
            await signInWithEmailAndPassword(auth, email, password);
            utils.showToast('Autentificare reușită!'); 
        } catch (error) {
            console.error(error);
            utils.showToast('Email sau parolă greșită', 'error'); 
        }
    },

    async cleanupOldBookings() {
        // Sterge automat rezervarile mai vechi de 30 de zile
        try {
            const d = new Date();
            d.setDate(d.getDate() - 30);
            const cutoffDate = d.toISOString().split('T')[0];
            
            const q = query(bookingsCollection, where("date", "<", cutoffDate), limit(50));
            const snapshot = await getDocs(q);
            
            if (!snapshot.empty) {
                const batch = writeBatch(db);
                snapshot.docs.forEach(doc => {
                    batch.delete(doc.ref);
                });
                await batch.commit();
                console.log(`[Cleanup] Stearse ${snapshot.size} rezervari vechi.`);
            }
        } catch (e) {
            console.error("[Cleanup Error]", e);
        }
    },

    renderAdminDashboard() { 
        // 1. STATISTICI (Rămân neschimbate)
        const today = new Date().toISOString().split('T')[0];
        const todayBookings = localBookings.filter(b => b.date === today).length;
        const totalActive = localBookings.length;
        
        const elToday = document.getElementById('statToday');
        if(elToday) elToday.textContent = todayBookings;
        
        const elTotal = document.getElementById('statTotal');
        if(elTotal) elTotal.textContent = totalActive;
        
        // 2. LOGICA DE FILTRARE (Aici este FIX-ul)
        const sourceData = (adminViewMode === 'active') ? localBookings : historyBookings;
        
        // Preluăm valorile din input-uri
        const searchInput = document.getElementById('adminSearchInput');
        const searchTerm = searchInput ? searchInput.value.toLowerCase() : '';
        
        const dateInput = document.getElementById('adminDateFilter');
        const filterDate = dateInput ? dateInput.value : '';

        // Filtrăm datele
        const filteredData = sourceData.filter(b => {
            const nameMatch = b.userName.toLowerCase().includes(searchTerm);
            const phoneMatch = b.phoneNumber.includes(searchTerm);
            
            // Dacă s-a ales o dată, verificăm potrivirea. Dacă nu, trecem peste.
            const dateMatch = filterDate ? b.date === filterDate : true;
            
            return (nameMatch || phoneMatch) && dateMatch;
        });

        // 3. Update Badge cu numărul filtrat
        const elBadge = document.getElementById('listBadgeCount');
        if(elBadge) elBadge.textContent = filteredData.length;

        // 4. Update Status Label Mentenanță
        const toggle = document.getElementById('maintenanceToggle');
        const statusLabel = document.getElementById('maintenanceStatusLabel');
        if(toggle && statusLabel) {
             const isChecked = toggle.checked;
             statusLabel.textContent = isChecked ? "Sistem Offline (Mentenanță)" : "Sistem Online";
             if(isChecked) statusLabel.classList.add('offline'); else statusLabel.classList.remove('offline');
        }

        // 5. Generarea Listei (Folosim filteredData)
        const list = document.getElementById('adminBookingsList'); 
        const bookings = [...filteredData].sort((a, b) => {
             // Descending for history, Ascending for active
             if (adminViewMode === 'history') {
                 return b.date.localeCompare(a.date) || b.startTime.localeCompare(a.startTime);
             } else {
                 return a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime);
             }
        });
        
        list.innerHTML = bookings.length ? bookings.map(b => {
             const endMins = utils.timeToMins(b.startTime) + parseInt(b.duration);
             const endTime = utils.minsToTime(endMins);
             return `
             <div class="admin-list-item">
                <div class="admin-item-info">
                    <strong>${b.userName}</strong>
                    <span><i class="fa-solid fa-phone"></i> ${b.phoneNumber}</span>
                    <span><i class="fa-regular fa-calendar"></i> ${utils.formatDateRO(b.date)} • ${b.startTime}-${endTime}</span>
                    <span><i class="fa-solid fa-soap"></i> ${logic.machines[b.machineType]}</span>
                </div>
                <button class="btn-delete-vip" onclick="window.app.confirmDelete('${b.id}')" title="Șterge">
                    <i class="fa-solid fa-trash"></i>
                </button>
             </div>`;
        }).join('') : '<div class="empty-state">Nu am găsit rezervări conform căutării.</div>'; 
    }
};

window.app = ui; 
document.addEventListener('DOMContentLoaded', () => ui.init());
