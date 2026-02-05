
// ------------------------------------------------------------------
// CONFIGURARE BACKEND
// ------------------------------------------------------------------
const API_BASE = '/api';

// ------------------------------------------------------------------
// LOGICA APLICATIEI
// ------------------------------------------------------------------

let localBookings = [];
let historyBookings = [];
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

    generateSlots(startHour = 0, endHour = 24) {
        const slots = [];
        for (let h = startHour; h < endHour; h++) {
            slots.push(`${h.toString().padStart(2, '0')}:00`);
            slots.push(`${h.toString().padStart(2, '0')}:30`);
        }
        return slots;
    },

    isSlotFree(machine, date, start, duration) {
        const sameDayBookings = localBookings.filter(b => b.machineType === machine && b.date === date);
        const reqStart = utils.timeToMins(start);
        const reqEnd = reqStart + parseInt(duration);

        const overlapSameDay = sameDayBookings.some(b => {
            const bStart = utils.timeToMins(b.startTime);
            const bEnd = bStart + parseInt(b.duration);
            return (reqStart < bEnd && reqEnd > bStart);
        });

        if (overlapSameDay) return false;

        const prevDate = utils.addDays(date, -1);
        const prevDayBookings = localBookings.filter(b => b.machineType === machine && b.date === prevDate);

        const overlapPrevDay = prevDayBookings.some(b => {
            const bStart = utils.timeToMins(b.startTime);
            const bDuration = parseInt(b.duration);
            const bEndTotal = bStart + bDuration;

            if (bEndTotal > 1440) {
                const spillEnd = bEndTotal - 1440;
                return reqStart < spillEnd;
            }
            return false;
        });

        return !overlapPrevDay;
    },

    canUserBook(userName) {
        const limit = 4;
        const today = new Date().toISOString().split('T')[0];
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

        // --- 1. FEATURE: AUTO-FILL (Ține-mă minte) ---
        const savedName = localStorage.getItem('studentName');
        const savedPhone = localStorage.getItem('studentPhone');
        if (savedName) {
            const nameInput = document.getElementById('userName');
            if(nameInput) nameInput.value = savedName;
        }
        if (savedPhone) {
            const phoneInput = document.getElementById('phoneNumber');
            if(phoneInput) phoneInput.value = savedPhone;
        }

        // Auth Check
        this.checkAuth();

        // Safety Timeout Loader
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
        }, 5000);

        // Theme Init
        const savedTheme = localStorage.getItem('theme');
        if (savedTheme === 'dark') {
            document.body.classList.add('dark-mode');
            const themeIcon = document.querySelector('#themeToggleBtn i');
            if(themeIcon) themeIcon.className = 'fa-solid fa-sun';
        }

        const dateInput = document.getElementById('bookingDate');
        const today = new Date().toISOString().split('T')[0];
        dateInput.min = today;
        dateInput.value = this.currentDate;

        this.updateDateDisplay();
        this.startMidnightWatcher();

        // Start Live Status Loop
        this.updateMachineStatus();
        setInterval(() => this.updateMachineStatus(), 60000);

        // Initial Fetch
        this.fetchBookings();
        this.fetchSettings();

        // Polling
        setInterval(() => {
            this.fetchBookings();
            this.fetchSettings();
        }, 10000);
    },

    async fetchSettings() {
        try {
            const res = await fetch(`${API_BASE}/settings`);
            if (res.ok) {
                const data = await res.json();
                const maintenanceMode = data.maintenance || false;

                const toggle = document.getElementById('maintenanceToggle');
                if(toggle) toggle.checked = maintenanceMode;

                const statusLabel = document.getElementById('maintenanceStatusLabel');
                if(statusLabel) {
                    statusLabel.textContent = maintenanceMode ? "Sistem Offline (Mentenanță)" : "Sistem Online";
                    if(maintenanceMode) statusLabel.classList.add('offline'); else statusLabel.classList.remove('offline');
                }

                const overlay = document.getElementById('maintenanceOverlay');
                // Don't show overlay if admin mode is active
                if (maintenanceMode && !isAdmin) {
                    if(overlay) overlay.style.display = 'flex';
                } else {
                    if(overlay) overlay.style.display = 'none';
                }
            }
        } catch (e) {
            console.error("Settings fetch error", e);
        }
    },

    async checkAuth() {
        try {
            const res = await fetch(`${API_BASE}/check_auth`);
            const data = await res.json();
            this.setAdminMode(data.is_admin);
        } catch (e) {
            console.error("Auth check failed", e);
        }
    },

    setAdminMode(active) {
        isAdmin = active;
        if (active) {
            document.body.classList.add('admin-mode');
            const form = document.getElementById('adminLoginForm');
            if(form) form.style.display = 'none';
            const content = document.getElementById('adminContent');
            if(content) content.style.display = 'block';
            const overlay = document.getElementById('maintenanceOverlay');
            if(overlay) overlay.style.display = 'none';
            this.renderAdminDashboard();
        } else {
            document.body.classList.remove('admin-mode');
            const content = document.getElementById('adminContent');
            if(content) content.style.display = 'none';
            const form = document.getElementById('adminLoginForm');
            if(form) form.style.display = 'block';
            const pwd = document.getElementById('adminPassword');
            if(pwd) pwd.value = '';
        }
    },

    async fetchBookings() {
        try {
            const res = await fetch(`${API_BASE}/reservations`);
            if (!res.ok) throw new Error("Failed to fetch");
            const data = await res.json();

            // Diff check or just replace? Replace is easier.
            localBookings = data;

            const loader = document.getElementById('appLoader');
            if(loader && loader.style.display !== 'none') {
                loader.style.opacity = '0';
                setTimeout(() => loader.style.display = 'none', 500);
            }

            this.renderAll();
        } catch (e) {
            console.error("Fetch error:", e);
        }
    },

    startMidnightWatcher() {
        setInterval(() => {
            const realToday = new Date().toISOString().split('T')[0];
            const dateInput = document.getElementById('bookingDate');
            if (dateInput.min !== realToday) {
                dateInput.min = realToday;
                if (this.currentDate < realToday) {
                    this.currentDate = realToday;
                    dateInput.value = realToday;
                    this.updateDateDisplay();
                    this.renderAll();
                    utils.showToast('Zi nouă! Calendarul s-a actualizat.');
                }
            }
        }, 60000);
    },

    updateMachineStatus() {
        const today = new Date().toISOString().split('T')[0];
        const now = new Date();
        const currentMins = now.getHours() * 60 + now.getMinutes();

        Object.keys(logic.machines).forEach(machineKey => {
            const statusEl = document.getElementById(`status-${machineKey}`);
            if (!statusEl) return;

            const activeBooking = localBookings.find(b => {
                if (b.machineType !== machineKey) return false;
                if (b.date !== today) return false;

                const startMins = utils.timeToMins(b.startTime);
                const endMins = startMins + parseInt(b.duration);

                return currentMins >= startMins && currentMins < endMins;
            });

            if (activeBooking) {
                const startMins = utils.timeToMins(activeBooking.startTime);
                const endMins = startMins + parseInt(activeBooking.duration);
                const remaining = endMins - currentMins;

                statusEl.textContent = `Ocupat (${remaining} min)`;
                statusEl.className = 'live-status busy';
            } else {
                statusEl.textContent = 'Liber';
                statusEl.className = 'live-status free';
            }
        });
    },

    setupEventListeners() {
        document.getElementById('bookingForm').addEventListener('submit', this.handleBooking.bind(this));

        document.getElementById('prevDay').onclick = () => this.changeDate(-1);
        document.getElementById('nextDay').onclick = () => this.changeDate(1);

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

        // Visual Selector
        document.querySelectorAll('.selector-card').forEach(card => {
            card.onclick = () => {
                document.querySelectorAll('.selector-card').forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                const value = card.dataset.value;
                const select = document.getElementById('machineType');
                select.value = value;
                select.dispatchEvent(new Event('change'));
            };
        });

        document.getElementById('userName').oninput = () => this.renderMyBookings();

        document.querySelectorAll('.modal-close').forEach(btn => btn.onclick = () => {
            document.getElementById('modalOverlay').style.display = 'none';
            document.getElementById('confirmModal').style.display = 'none';
            document.getElementById('adminModal').style.display = 'none';
            document.getElementById('deletePinModal').style.display = 'none';
        });

        // Delete handlers
        const reqDelBtn = document.getElementById('requestDeleteBtn');
        if (reqDelBtn) reqDelBtn.onclick = () => this.requestDelete();

        const confirmPinBtn = document.getElementById('confirmPinDeleteBtn');
        if (confirmPinBtn) confirmPinBtn.onclick = () => this.confirmPinDelete();

        const cancelPinBtn = document.getElementById('cancelPinDeleteBtn');
        if (cancelPinBtn) cancelPinBtn.onclick = () => {
             document.getElementById('deletePinModal').style.display = 'none';
        };

        // Maintenance Toggle
        const maintToggle = document.getElementById('maintenanceToggle');
        if (maintToggle) {
            maintToggle.onchange = async (e) => {
                const isChecked = e.target.checked;
                try {
                    const res = await fetch(`${API_BASE}/settings`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ maintenance: isChecked })
                    });
                    const result = await res.json();
                    if (result.success) {
                        utils.showToast(isChecked ? "Mentenanță ACTIVATĂ" : "Mentenanță DEZACTIVATĂ");
                        this.fetchSettings(); // Force update
                    } else {
                        throw new Error(result.error);
                    }
                } catch (err) {
                    console.error(err);
                    utils.showToast("Eroare la salvarea setării.", "error");
                    e.target.checked = !isChecked;
                }
            };
        }

        document.getElementById('maintenanceAdminBtn').onclick = () => {
             document.getElementById('modalOverlay').style.display = 'flex';
             document.getElementById('adminModal').style.display = 'block';
             document.getElementById('phoneModal').style.display = 'none';
             document.getElementById('confirmModal').style.display = 'none';
        };

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

        // Admin Search & Tabs
        const searchInput = document.getElementById('adminSearchInput');
        if(searchInput) searchInput.addEventListener('input', () => this.renderAdminDashboard());
        const dateFilter = document.getElementById('adminDateFilter');
        if(dateFilter) dateFilter.addEventListener('change', () => this.renderAdminDashboard());

        document.getElementById('tabActive').onclick = () => {
             adminViewMode = 'active';
             document.getElementById('tabActive').classList.add('active');
             document.getElementById('tabHistory').classList.remove('active');
             document.getElementById('listTitle').textContent = "Rezervări Active";
             this.renderAdminDashboard();
        };
        document.getElementById('tabHistory').onclick = async () => {
             // History logic might need a dedicated API endpoint or just client-side filtering if we fetch all.
             // Current fetch gets next week + yesterday.
             // If we want deeper history, we need backend support.
             // For now, let's keep it simple.
             adminViewMode = 'history';
             document.getElementById('tabHistory').classList.add('active');
             document.getElementById('tabActive').classList.remove('active');
             document.getElementById('listTitle').textContent = "Istoric";
             // fetch history from backend?
        };

        // --- 2. FEATURE: EXPORT CSV ---
        const exportBtn = document.getElementById('exportCsvBtn');
        if (exportBtn) {
            exportBtn.onclick = () => {
                const dataToExport = (adminViewMode === 'active') ? localBookings : historyBookings;

                if (dataToExport.length === 0) {
                    utils.showToast("Nu sunt date de exportat!", "error");
                    return;
                }

                let csvContent = "data:text/csv;charset=utf-8,";
                csvContent += "Data,Ora,Nume,Telefon,Masina,Durata\n";

                dataToExport.forEach(row => {
                    const rowData = [
                        row.date,
                        row.startTime,
                        row.userName,
                        row.phoneNumber,
                        logic.machines[row.machineType],
                        row.duration
                    ];
                    csvContent += rowData.join(",") + "\n";
                });

                const encodedUri = encodeURI(csvContent);
                const link = document.createElement("a");
                link.setAttribute("href", encodedUri);
                link.setAttribute("download", `raport_${adminViewMode}.csv`);
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
            };
        }

        // Admin Cancel Delete
        const cancelDeleteBtn = document.getElementById('cancelDeleteBtn');
        if(cancelDeleteBtn) cancelDeleteBtn.onclick = () => {
            document.getElementById('modalOverlay').style.display = 'none';
            document.getElementById('confirmModal').style.display = 'none';
            deleteId = null;
        };

        // Admin Confirm Delete
        const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
        if(confirmDeleteBtn) confirmDeleteBtn.onclick = async () => {
             await this.performDelete(deleteId);
        };

        document.getElementById('adminToggleBtn').onclick = () => {
            document.getElementById('phoneModal').style.display = 'none';
            document.getElementById('confirmModal').style.display = 'none';
            document.getElementById('modalOverlay').style.display = 'flex';
            document.getElementById('adminModal').style.display = 'block';
        };
        document.getElementById('adminLoginBtn').onclick = this.handleAdminLogin.bind(this);
        document.getElementById('adminLogoutBtn').onclick = () => {
            fetch(`${API_BASE}/logout`, { method: 'POST' })
            .then(() => {
                utils.showToast("Deconectare reușită");
                this.setAdminMode(false);
            });
        };
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

        submitBtn.disabled = true;
        submitBtn.innerHTML = '<div class="spinner" style="width:20px;height:20px;border-width:2px;margin:0;display:inline-block;"></div> Verificare...';

        try {
            let userName = document.getElementById('userName').value.trim();
            const phone = document.getElementById('phoneNumber').value.trim();
            const pin = document.getElementById('userPin').value.trim();
            const machine = document.getElementById('machineType').value;
            const start = document.getElementById('startTime').value;
            const duration = parseInt(document.getElementById('duration').value);

            if (!start) throw new Error("Te rog selectează ora!");
            if (!machine) throw new Error("Alege o mașină!");
            if (userName.length < 3) throw new Error("Introdu un nume complet (minim 3 litere).");

            userName = utils.capitalize(userName);
            const cleanPhone = phone.replace(/\D/g, '');

            if (cleanPhone.length !== 10 || !cleanPhone.startsWith('07')) {
                throw new Error("Număr invalid! Trebuie 10 cifre și să înceapă cu 07.");
            }

            if (!pin || pin.length !== 4 || isNaN(pin)) {
                throw new Error("PIN-ul trebuie să aibă exact 4 cifre.");
            }

            if (!logic.canUserBook(userName)) {
                throw new Error("Ai atins limita de rezervări active!");
            }

            // POST to backend
            const payload = {
                userName,
                phoneNumber: cleanPhone,
                pin,
                machineType: machine,
                date: this.currentDate,
                startTime: start,
                duration
            };

            const res = await fetch(`${API_BASE}/book`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            const result = await res.json();

            if (!result.success) throw new Error(result.error || "Eroare necunoscută.");

            localStorage.setItem('studentName', userName);
            localStorage.setItem('studentPhone', cleanPhone);

            // Mock logEvent
            // logEvent(analytics, 'rezervare_noua', ...);

            utils.showToast('Rezervare salvată cu succes!');
            e.target.reset();

            document.getElementById('userName').value = userName;
            document.getElementById('bookingDate').value = this.currentDate;
            document.getElementById('startTime').style.borderColor = 'var(--border)';
            document.querySelectorAll('.selected-slot').forEach(el => el.classList.remove('selected-slot'));

            // Refresh
            this.fetchBookings();

        } catch (error) {
            console.error(error);
            let msg = 'Eroare server.';
            if (typeof error === 'string') msg = error;
            else if (error.message) msg = error.message;
            utils.showToast(msg, 'error');
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalBtnText;
        }
    },

    renderAll() {
        this.renderSchedule();
        this.renderMyBookings();
        this.renderUpcoming();
        this.updateMachineStatus();
        if (document.getElementById('adminContent').style.display === 'block') {
            this.renderAdminDashboard();
        }
    },

    renderSchedule() {
        const grid = document.getElementById('scheduleGrid'); grid.innerHTML = '';
        const slots = logic.generateSlots();
        const todaysBookings = localBookings.filter(b => b.date === this.currentDate);
        const prevDate = utils.addDays(this.currentDate, -1);
        const spillBookings = localBookings.filter(b => {
            if (b.date !== prevDate) return false;
            const end = utils.timeToMins(b.startTime) + parseInt(b.duration);
            return end > 1440;
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
                    if (b.date === prevDate) { bStart = 0; bEnd = bEnd - 1440; }
                    return (bStart < nextSlotMins && bEnd > slotMins);
                });

                const div = document.createElement('div'); div.className = `time-slot ${booking ? 'occupied' : 'available'}`;

                if (booking) {
                    let bStart = utils.timeToMins(booking.startTime);
                    let bEnd = bStart + parseInt(booking.duration);
                    let isSpill = false;
                    if (booking.date === prevDate) { isSpill = true; bStart = 0; bEnd = bEnd - 1440; }

                    const isStartOfBookingInGrid = (bStart >= slotMins && bStart < nextSlotMins);

                    if (bStart >= slotMins) div.classList.add('booking-start');
                    if (bEnd <= nextSlotMins) div.classList.add('booking-end');
                    if (bStart < slotMins && bEnd > nextSlotMins) div.classList.add('booking-middle');

                    if (isStartOfBookingInGrid) {
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
        deleteId = booking.id;
        document.getElementById('modalUserName').textContent = booking.userName;

        const phoneEl = document.getElementById('modalPhoneNumber');
        const callBtn = document.getElementById('callPhoneBtn');
        const copyBtn = document.getElementById('copyPhoneBtn');

        phoneEl.textContent = booking.phoneNumber;
        callBtn.style.display = 'inline-block';
        copyBtn.style.display = 'inline-block';
        callBtn.href = `tel:${booking.phoneNumber}`;
        copyBtn.onclick = () => {
            navigator.clipboard.writeText(booking.phoneNumber).then(() => { utils.showToast('Număr copiat!'); });
        };

        document.getElementById('adminModal').style.display = 'none';
        document.getElementById('confirmModal').style.display = 'none';
        document.getElementById('deletePinModal').style.display = 'none';
        document.getElementById('modalOverlay').style.display = 'flex';
        document.getElementById('phoneModal').style.display = 'block';
    },

    requestDelete(id) {
        if (id) deleteId = id;
        document.getElementById('phoneModal').style.display = 'none';
        document.getElementById('deletePinModal').style.display = 'block';
        const input = document.getElementById('deletePinInput');
        input.value = '';
        input.focus();
    },

    async confirmPinDelete() {
        const input = document.getElementById('deletePinInput');
        const enteredPin = input.value.trim();

        if (!enteredPin || enteredPin.length !== 4) {
            utils.showToast("Introdu PIN-ul de 4 cifre.", "error");
            return;
        }

        // Send to backend
        try {
            const res = await fetch(`${API_BASE}/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: deleteId, pin: enteredPin })
            });
            const result = await res.json();

            if (result.success) {
                utils.showToast('Rezervare ștearsă cu succes!');
                this.fetchBookings();
                document.getElementById('modalOverlay').style.display = 'none';
                document.getElementById('deletePinModal').style.display = 'none';
            } else {
                utils.showToast(result.error || "Eroare la ștergere.", "error");
            }
        } catch (e) {
            console.error(e);
            utils.showToast("Eroare de rețea.", "error");
        }
    },

    async performDelete(id) {
        // This is primarily for Admin delete (bypass PIN)
        if (!id) return;

        try {
            // Admin delete also goes through same endpoint but without PIN (Session Auth handles it)
            const res = await fetch(`${API_BASE}/delete`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: id })
            });
            const result = await res.json();

            if (result.success) {
                utils.showToast('Rezervare ștearsă (Admin).');
                this.fetchBookings();
                document.getElementById('modalOverlay').style.display = 'none';
                document.getElementById('confirmModal').style.display = 'none';
            } else {
                utils.showToast(result.error || "Eroare la ștergere.", "error");
            }
        } catch (e) {
            console.error(e);
            utils.showToast("Eroare server.", "error");
        }
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
             return `<div class="booking-item"><div class="booking-info"><strong>${logic.machines[b.machineType]}</strong><span>${utils.formatDateRO(b.date)} • ${b.startTime} - ${endTime}</span></div><button class="btn-delete" onclick="window.app.requestDelete('${b.id}')">Anulează</button></div>`;
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
            const res = await fetch(`${API_BASE}/login`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password })
            });
            const result = await res.json();

            if (result.success) {
                utils.showToast('Autentificare reușită!');
                this.setAdminMode(true);
            } else {
                utils.showToast(result.error || 'Email sau parolă greșită', 'error');
            }
        } catch (error) {
            console.error(error);
            utils.showToast('Eroare de rețea', 'error');
        }
    },

    renderAdminDashboard() {
        const today = new Date().toISOString().split('T')[0];
        const todayBookings = localBookings.filter(b => b.date === today).length;
        const totalActive = localBookings.length;

        const elToday = document.getElementById('statToday');
        if(elToday) elToday.textContent = todayBookings;
        const elTotal = document.getElementById('statTotal');
        if(elTotal) elTotal.textContent = totalActive;

        const sourceData = (adminViewMode === 'active') ? localBookings : historyBookings;
        const searchInput = document.getElementById('adminSearchInput');
        const searchTerm = searchInput ? searchInput.value.toLowerCase() : '';
        const dateInput = document.getElementById('adminDateFilter');
        const filterDate = dateInput ? dateInput.value : '';

        const filteredData = sourceData.filter(b => {
            const nameMatch = b.userName.toLowerCase().includes(searchTerm);
            const phoneMatch = b.phoneNumber.includes(searchTerm);
            const dateMatch = filterDate ? b.date === filterDate : true;
            return (nameMatch || phoneMatch) && dateMatch;
        });

        const elBadge = document.getElementById('listBadgeCount');
        if(elBadge) elBadge.textContent = filteredData.length;

        const list = document.getElementById('adminBookingsList');
        const bookings = [...filteredData].sort((a, b) => {
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
