const API_URL = "https://script.google.com/macros/s/AKfycbzWcVse-LJpaR9Glye5UzAVcwx3bVyhCm3GLW1ZMUfCFRNUClagblybq-OQQL4gucMs/exec"; 
const DB_NAME = "PureWater_POS";
const DB_VERSION = 13; 
window.db = null;

window.posSessions = [{ cart: [], customer: null }, { cart: [], customer: null }, { cart: [], customer: null }];
window.activeSessionIndex = 0; window.currentCart = window.posSessions[0].cart; window.activeCustomerProfile = window.posSessions[0].customer;
window.piutangTargetMember = null;

window.currentCashier = ""; window.currentPin = ""; window.currentShiftId = ""; window.currentLoginTime = ""; window.currentOutlet = "";
window.globalMenuData = []; window.currentCategory = ""; 
window.outletStocks = {}; window.isLoggingOut = false; window.currentVoidTarget = { type: null, id: null };
window.isMenuLocked = true; window.isSyncing = false; window.loyaltyEnabled = false; 
window.deferredPrompt = null;

window.bluetoothDevice = null;
window.printerCharacteristic = null;

window.formatDateReadable = function(dateInput) {
    if (!dateInput) return "-";
    try {
        let safeDate = dateInput;
        if (typeof safeDate === 'string' && safeDate.includes(' ') && !safeDate.includes('T')) { safeDate = safeDate.replace(' ', 'T'); }
        const d = new Date(safeDate);
        if(isNaN(d)) return dateInput;
        const months = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Ags", "Sep", "Okt", "Nov", "Des"];
        const pad = n => n < 10 ? '0' + n : n;
        return `${pad(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch(e) { return dateInput; }
}

window.hashPIN = async function(pin) {
    const msgUint8 = new TextEncoder().encode(pin);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

window.getWibDate = function() {
    const d = new Date(); const utc = d.getTime() + (d.getTimezoneOffset() * 60000); const nd = new Date(utc + (3600000 * 7)); 
    const pad = n => n < 10 ? '0' + n : n;
    return `${nd.getFullYear()}-${pad(nd.getMonth()+1)}-${pad(nd.getDate())} ${pad(nd.getHours())}:${pad(nd.getMinutes())}:${pad(nd.getSeconds())}`;
}

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); window.deferredPrompt = e;
    const installBtn = document.getElementById('btn-install'); const installBtnLogin = document.getElementById('btn-install-login');
    if(installBtn) installBtn.classList.remove('hidden'); if(installBtnLogin) installBtnLogin.classList.remove('hidden');
});

window.installPWA = function() {
    if (window.deferredPrompt) {
        window.deferredPrompt.prompt();
        window.deferredPrompt.userChoice.then((choiceResult) => {
            if (choiceResult.outcome === 'accepted') {
                const installBtn = document.getElementById('btn-install'); const installBtnLogin = document.getElementById('btn-install-login');
                if(installBtn) installBtn.classList.add('hidden'); if(installBtnLogin) installBtnLogin.classList.add('hidden');
            }
            window.deferredPrompt = null;
        });
    }
}

window.initDB = function() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (event) => {
            window.db = event.target.result;
            if (!window.db.objectStoreNames.contains("staff")) window.db.createObjectStore("staff", { keyPath: "pin" });
            if (!window.db.objectStoreNames.contains("menu")) window.db.createObjectStore("menu", { keyPath: "itemId" });
            if (!window.db.objectStoreNames.contains("settings")) window.db.createObjectStore("settings", { keyPath: "key" });
            if (!window.db.objectStoreNames.contains("orders")) window.db.createObjectStore("orders", { keyPath: "orderId" });
            if (!window.db.objectStoreNames.contains("active_shifts")) window.db.createObjectStore("active_shifts", { keyPath: "pin" }); 
            if (!window.db.objectStoreNames.contains("cash_drops")) window.db.createObjectStore("cash_drops", { keyPath: "dropId" }); 
            if (!window.db.objectStoreNames.contains("shift_reports")) window.db.createObjectStore("shift_reports", { keyPath: "shiftId" }); 
            if (!window.db.objectStoreNames.contains("expenses")) window.db.createObjectStore("expenses", { keyPath: "expenseId" });
            if (!window.db.objectStoreNames.contains("members")) window.db.createObjectStore("members", { keyPath: "phone" });
            if (!window.db.objectStoreNames.contains("unsynced_members")) window.db.createObjectStore("unsynced_members", { keyPath: "phone" });
            if (!window.db.objectStoreNames.contains("expense_categories")) window.db.createObjectStore("expense_categories", { keyPath: "name" });
            if (!window.db.objectStoreNames.contains("void_requests")) window.db.createObjectStore("void_requests", { keyPath: "id" });
            if (!window.db.objectStoreNames.contains("local_shift_history")) window.db.createObjectStore("local_shift_history", { keyPath: "shiftId" });
            if (!window.db.objectStoreNames.contains("stock_inbound")) window.db.createObjectStore("stock_inbound", { keyPath: "logId" });
            if (!window.db.objectStoreNames.contains("cuci_tandon")) window.db.createObjectStore("cuci_tandon", { keyPath: "logId" });
            if (!window.db.objectStoreNames.contains("lapor_masalah")) window.db.createObjectStore("lapor_masalah", { keyPath: "logId" });
            if (!window.db.objectStoreNames.contains("bayar_piutang")) window.db.createObjectStore("bayar_piutang", { keyPath: "payId" });
        };
        request.onsuccess = (e) => { window.db = e.target.result; resolve(window.db); };
        request.onerror = (e) => reject(e);
    });
}

window.getStaffFromDB = async function() {
    return new Promise(resolve => { window.db.transaction(["staff"], "readonly").objectStore("staff").getAll().onsuccess = e => resolve(e.target.result); });
}

window.checkAutoCloseShifts = async function() {
    if (!window.db) return;
    const shifts = await new Promise(res => window.db.transaction(["active_shifts"], "readonly").objectStore("active_shifts").getAll().onsuccess = e => res(e.target.result));
    const now = Date.now();
    for (let shift of shifts) {
        const loginTime = new Date(shift.loginTime).getTime();
        if (now - loginTime > 12 * 60 * 60 * 1000) { await window.forceCloseShift(shift); }
    }
}

window.forceCloseShift = async function(shift) {
    let tCust = 0, tOrders = 0, tOmset = 0, tCash = 0, tQris = 0, tTransfer = 0, tFree = 0, tExpense = 0, tPiutangGiven = 0, tPiutangPaidCash = 0;
    let foodSummary = {};
    
    const tx = window.db.transaction(["orders", "expenses", "bayar_piutang"], "readonly");
    const orders = await new Promise(r => tx.objectStore("orders").getAll().onsuccess = e => r(e.target.result));
    const expenses = await new Promise(r => tx.objectStore("expenses").getAll().onsuccess = e => r(e.target.result));
    const piutangs = await new Promise(r => tx.objectStore("bayar_piutang").getAll().onsuccess = e => r(e.target.result));
    
    orders.filter(o => o.shiftId === shift.shiftId && o.orderStatus !== "Voided" && o.orderStatus !== "Void Pending").forEach(o => {
        tOrders++; if(o.customerPhone && o.customerPhone !== "-") tCust++;
        tOmset += o.grandTotal; tCash += (o.cashAmount || 0); tQris += (o.qrisAmount || 0); tTransfer += (o.transferAmount || 0); tFree += (o.freeAmount || 0);
        tPiutangGiven += (o.debtAmount || 0);
        if (o.items) o.items.forEach(i => { foodSummary[i.name] = (foodSummary[i.name] || 0) + i.qty; });
    });
    
    expenses.filter(ex => ex.shiftId === shift.shiftId && ex.status === "Active").forEach(ex => { tExpense += (ex.amount || 0); });
    piutangs.filter(bp => bp.shiftId === shift.shiftId).forEach(bp => { tPiutangPaidCash += (bp.cashAmount || 0); });
    
    let liveDrawer = window.outletStocks && window.outletStocks[shift.outlet] && window.outletStocks[shift.outlet]["Saldo_Laci"] ? window.outletStocks[shift.outlet]["Saldo_Laci"] : (tCash + tPiutangPaidCash - tExpense);
    
    const shiftPayload = {
        shiftId: shift.shiftId, timestamp: window.getWibDate(), cashier: "SYSTEM (Auto-Close)", loginTime: shift.loginTime, logoutTime: window.getWibDate(), 
        totalCustomers: tCust, totalOrders: tOrders, totalOmset: tOmset, totalCash: tCash, totalQris: tQris, totalTransfer: tTransfer, totalFree: tFree,
        totalExpenses: tExpense, netCash: liveDrawer, foodSummary: foodSummary, meterWater: 0, outlet: shift.outlet, syncStatus: "Pending",
        piutangGiven: tPiutangGiven, piutangPaid: tPiutangPaidCash, autoClosed: true
    };

    const txWrite = window.db.transaction(["local_shift_history", "shift_reports", "active_shifts"], "readwrite");
    txWrite.objectStore("local_shift_history").add(shiftPayload);
    txWrite.objectStore("shift_reports").add(shiftPayload);
    txWrite.objectStore("active_shifts").delete(shift.pin);
}

window.attemptLogin = async function() {
    const pinInput = document.getElementById("cashier-pin").value.trim();
    if (!pinInput) return alert("Masukkan PIN!");
    if (!window.db) return alert("Database sedang memuat, harap tunggu...");

    const loginBtn = document.getElementById("login-btn");
    loginBtn.disabled = true; loginBtn.innerText = "Memverifikasi...";

    try {
        const hashedPinInput = await window.hashPIN(pinInput);
        let staffList = await window.getStaffFromDB();
        let staff = staffList.find(s => s.pin === hashedPinInput);

        if (!staff) {
            loginBtn.innerText = "Sinkronisasi...";
            await window.syncMasterData();
            staffList = await window.getStaffFromDB();
            staff = staffList.find(s => s.pin === hashedPinInput);
        }

        if (staff) {
            window.db.transaction(["active_shifts"], "readonly").objectStore("active_shifts").get(staff.pin).onsuccess = async (shiftReq) => {
                const activeShift = shiftReq.target.result;
                window.currentCashier = staff.name; window.currentPin = staff.pin; 
                
                const dropdownSelection = document.getElementById("login-outlet").value;
                if (dropdownSelection === "AUTO") { window.currentOutlet = staff.defaultOutlet || document.getElementById("login-outlet").options[1].value; } 
                else { window.currentOutlet = dropdownSelection; }

                if (activeShift) { 
                    window.currentShiftId = activeShift.shiftId; window.currentLoginTime = activeShift.loginTime; window.currentOutlet = activeShift.outlet || window.currentOutlet; 
                } else {
                    window.currentShiftId = "SHF-" + Date.now(); window.currentLoginTime = window.getWibDate();
                    window.db.transaction(["active_shifts"], "readwrite").objectStore("active_shifts").put({ pin: staff.pin, shiftId: window.currentShiftId, loginTime: window.currentLoginTime, outlet: window.currentOutlet });
                }
                document.getElementById("login-screen").classList.add("hidden"); document.getElementById("pos-screen").classList.remove("hidden");
                document.getElementById("display-cashier").innerText = window.currentCashier; document.getElementById("display-outlet").innerText = window.currentOutlet;
                
                await window.checkAutoCloseShifts();
                if (navigator.onLine) { window.syncMasterData(); }
                window.lockMenu(); 
            };
        } else { alert("PIN Salah atau Data Kasir Tidak Ditemukan."); }
    } catch (err) { console.error("Login Error:", err); alert("Terjadi kesalahan sistem saat login.");
    } finally { loginBtn.disabled = false; loginBtn.innerText = "Masuk / Buka Shift"; }
}

window.connectBluetoothPrinter = async function() {
    try {
        window.bluetoothDevice = await navigator.bluetooth.requestDevice({ filters: [{ services: [0x18F0] }], optionalServices: [0x18F0] });
        const server = await window.bluetoothDevice.gatt.connect(); const service = await server.getPrimaryService(0x18F0);
        window.printerCharacteristic = await service.getCharacteristic(0x2AF1);
        
        alert("Printer Thermal Berhasil Terhubung!");
        document.getElementById("btn-connect-printer").innerText = "🖨️ Printer Aktif"; document.getElementById("btn-connect-printer").style.background = "#27ae60"; document.getElementById("btn-connect-printer").style.borderColor = "#27ae60";
        
        window.bluetoothDevice.addEventListener('gattserverdisconnected', () => {
            alert("Koneksi Printer Terputus!");
            document.getElementById("btn-connect-printer").innerText = "🖨️ Printer"; document.getElementById("btn-connect-printer").style.background = "#f39c12"; document.getElementById("btn-connect-printer").style.borderColor = "#f39c12";
            window.printerCharacteristic = null;
        });
    } catch (error) { console.error(error); alert("Gagal koneksi printer: " + error.message); }
}

window.printViaBluetooth = async function(payloadUint8Array) {
    if (!window.printerCharacteristic) { alert("Printer belum terhubung! Silakan hubungkan dulu dengan tombol 'Printer'."); return false; }
    try {
        const CHUNK_SIZE = 20; 
        for (let i = 0; i < payloadUint8Array.length; i += CHUNK_SIZE) {
            const chunk = payloadUint8Array.slice(i, i + CHUNK_SIZE);
            await window.printerCharacteristic.writeValue(chunk);
            await new Promise(r => setTimeout(r, 10)); 
        }
        return true;
    } catch (error) { console.error("Print Error:", error); alert("Print Gagal: " + error.message); return false; }
}

window.manualPushSync = async function() {
    if (!navigator.onLine) return alert("Anda sedang offline!");
    document.getElementById("network-text").innerText = "Mengirim Data..."; document.getElementById("network-dot").style.backgroundColor = "#f39c12";
    await window.runBackgroundSync(); 
    document.getElementById("network-text").innerText = "Menarik Data..."; 
    await window.syncMasterData(); 
    alert("Sinkronisasi Database Berhasil!");
}

window.syncMasterData = async function() {
    if (!navigator.onLine) {
        if(document.getElementById("network-text")) document.getElementById("network-text").innerText = "Mode Offline";
        if(document.getElementById("network-dot")) document.getElementById("network-dot").style.backgroundColor = "#e74c3c"; return;
    }
    
    try {
        if (!window.db) { await window.initDB(); }

        if(document.getElementById("network-text")) document.getElementById("network-text").innerText = "Sinkron PIN (Cepat)...";
        if(document.getElementById("network-dot")) document.getElementById("network-dot").style.backgroundColor = "#f39c12";

        const authResponse = await fetch(API_URL + "?type=auth_only", { mode: 'cors', redirect: 'follow' });
        const authContentType = authResponse.headers.get("content-type");
        if (authContentType && authContentType.includes("text/html")) throw new Error("Akses Ditolak Google pada Phase 1.");
        
        const authResult = await authResponse.json();
        if (authResult.status === "Success") {
            const tx = window.db.transaction(["staff", "settings"], "readwrite");
            const staffStore = tx.objectStore("staff"); staffStore.clear(); authResult.data.staff.forEach(s => staffStore.put(s));
            const settingsStore = tx.objectStore("settings"); settingsStore.clear(); for (const [k, v] of Object.entries(authResult.data.settings)) { settingsStore.put({ key: k, value: v }); }
            const rawOutlets = authResult.data.settings["Outlet_List"] || "Pusat"; const outletArray = rawOutlets.split(",").map(s => s.trim()); const selectBox = document.getElementById("login-outlet");
            if(selectBox) { selectBox.innerHTML = `<option value="AUTO">🏠 Sesuai Cabang Asal</option>` + outletArray.map(o => `<option value="${o}">${o}</option>`).join(""); }
        }

        if(document.getElementById("network-text")) document.getElementById("network-text").innerText = "Download Data Member...";
        const fullResponse = await fetch(API_URL, { mode: 'cors', redirect: 'follow' });
        
        const fullContentType = fullResponse.headers.get("content-type");
        if (fullContentType && fullContentType.includes("text/html")) throw new Error("Akses Ditolak Google pada Phase 2 (Members).");

        const fullResult = await fullResponse.json();
        
        if (fullResult.status === "Success") {
            window.outletStocks = fullResult.data.outletStocks; 
            const tx2 = window.db.transaction(["menu", "members", "expense_categories"], "readwrite");
            
            const menuStore = tx2.objectStore("menu"); menuStore.clear(); fullResult.data.menu.forEach(m => menuStore.put(m));
            const memStore = tx2.objectStore("members"); memStore.clear(); fullResult.data.members.forEach(m => memStore.put(m));
            const expCatStore = tx2.objectStore("expense_categories"); expCatStore.clear(); 
            if(fullResult.data.expenseCategories) fullResult.data.expenseCategories.forEach(c => expCatStore.put({name: c}));
            
            if (fullResult.data.authStatuses) window.processServerUpdates(fullResult.data.authStatuses);
            window.globalMenuData = fullResult.data.menu; window.loyaltyEnabled = String(fullResult.data.settings["Enable_Loyalty"]).toUpperCase() === "TRUE";

            if(document.getElementById("network-text")) document.getElementById("network-text").innerText = "Online & Sinkron";
            if(document.getElementById("network-dot")) document.getElementById("network-dot").style.backgroundColor = "#2ecc71";
            if (!document.getElementById("pos-screen").classList.contains("hidden")) { window.loadMenuUI(); }
        }

    } catch (e) { 
        console.error("Sync Error:", e);
        if(document.getElementById("network-text")) document.getElementById("network-text").innerText = "Gagal Sinkron"; 
        if(document.getElementById("network-dot")) document.getElementById("network-dot").style.backgroundColor = "#e74c3c";
        if (e.name === 'InvalidStateError' || e.message.includes("closing")) { await window.initDB(); }
    }
}

window.handleAutocomplete = function(e) {
    if (!window.db) return; 
    const val = e.target.value.toLowerCase().trim(); 
    const resBox = document.getElementById("autocomplete-results");

    window.db.transaction(["members"], "readonly").objectStore("members").getAll().onsuccess = (ev) => {
        const members = ev.target.result || []; 
        let matches = members;
        
        if (val.length > 0) { 
            matches = members.filter(m => String(m.phone).toLowerCase().includes(val) || String(m.name).toLowerCase().includes(val)); 
        }
        
        matches.sort((a, b) => (b.spent || 0) - (a.spent || 0));
        matches = matches.slice(0, 15);

        if (matches.length > 0) {
            resBox.innerHTML = matches.map(m => {
                let wStr = JSON.stringify(m.wallet || {}).replace(/'/g, "\\'").replace(/"/g, '&quot;'); 
                let nameStr = String(m.name || "").replace(/'/g, "\\'").replace(/"/g, '&quot;');
                let fOut = String(m.firstOutlet || "").replace(/'/g, "\\'").replace(/"/g, '&quot;'); 
                let displayFOut = (fOut && fOut !== "Unknown") ? fOut : "-";
                let rOutStr = m.recentOutlets || "";
                let rOutList = rOutStr ? rOutStr.split(",").map(s => s.trim()) : [];
                let lOut = rOutList.length > 0 ? rOutList[rOutList.length - 1] : "-";
                let safePhone = String(m.phone || "").replace(/'/g, "\\'").replace(/"/g, '&quot;');
                
                let crossDebtWarning = "";
                let localDebt = m.piutang || 0;
                let remoteDebt = 0;
                let remoteOutlets = [];
                
                let outletBadge = `<span style="font-size:11px; background:#ecf0f1; color:#2c3e50; padding:2px 6px; border-radius:4px; margin-left:6px; font-weight:normal;">📍 Awal: ${displayFOut} | Akhir: ${lOut}</span>`;
                
                if (m.piutangBreakdown) {
                    localDebt = m.piutangBreakdown[window.currentOutlet] || 0;
                    for (let out in m.piutangBreakdown) {
                        if (out !== window.currentOutlet && m.piutangBreakdown[out] > 0) {
                            remoteDebt += m.piutangBreakdown[out];
                            remoteOutlets.push(out);
                        }
                    }
                }
                
                if (remoteDebt > 0) {
                    crossDebtWarning = `<div style="font-size:12px; color:#c0392b; font-weight:bold; margin-top:2px;">⚠️ Piutang Rp ${remoteDebt.toLocaleString('id-ID')} di cabang lain (${remoteOutlets.join(', ')})</div>`;
                }

                return `<div class="autocomplete-item" onclick="window.selectMember('${safePhone}', '${nameStr}', '${wStr}', ${m.bottlesBorrowed || 0}, ${localDebt}, '${fOut}', '${rOutStr}', '${crossDebtWarning.replace(/'/g, "\\'").replace(/"/g, '&quot;')}')">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <div class="autocomplete-name">${m.name} ${outletBadge} ${crossDebtWarning}</div>
                        <div class="autocomplete-phone" style="font-size:14px; color:#7f8c8d;">${m.phone}</div>
                    </div>
                </div>`;
            }).join("");
            resBox.classList.remove("hidden");
        } else { 
            resBox.innerHTML = `<div style="padding:15px; color:#7f8c8d; text-align:center; font-style:italic;">Tidak ada member ditemukan</div>`;
            resBox.classList.remove("hidden"); 
        }
    };
}

window.handleCategoryAutocomplete = function() {
    if (!window.db) return;
    const val = document.getElementById("exp-category").value.toLowerCase().trim(); 
    const resBox = document.getElementById("cat-autocomplete-results");
    
    window.db.transaction(["expense_categories"], "readonly").objectStore("expense_categories").getAll().onsuccess = (ev) => {
        let categories = ev.target.result.map(c => c.name);

        let matches = categories;
        if (val.length > 0) { matches = categories.filter(c => c.toLowerCase().includes(val)); }

        if (matches.length > 0) {
            resBox.innerHTML = matches.map(c => {
                let safeName = c.replace(/'/g, "\\'").replace(/"/g, '&quot;');
                return `<div class="autocomplete-item" onclick="window.selectCategory('${safeName}')"><div style="font-size:16px; font-weight:bold; color:#2c3e50;">${c}</div></div>`;
            }).join("");
            resBox.classList.remove("hidden");
        } else { resBox.classList.add("hidden"); }
    };
};

window.selectCategory = function(name) {
    document.getElementById("exp-category").value = name;
    document.getElementById("cat-autocomplete-results").classList.add("hidden");
};

window.selectMember = function(phone, name, walletStr, dbBottlesBorrowed, localPiutang, firstOutlet, recentOutlets, crossDebtWarningHTML) {
    document.getElementById("autocomplete-results").classList.add("hidden");
    let lockedQueue = window.isCustomerLocked(phone);
    if (lockedQueue) { return alert(`⚠️ PELANGGAN TERKUNCI:\nPelanggan ini sedang diproses di Antrean ${lockedQueue}. Selesaikan pesanan di sana terlebih dahulu.`); }

    document.getElementById("cust-phone").value = phone; document.getElementById("cust-name").value = name; 
    let wallet = {}; try { wallet = JSON.parse(walletStr.replace(/&quot;/g, '"')); } catch(e) {}
    window.activeCustomerProfile = { phone: phone, name: name, wallet: wallet, bottlesBorrowed: dbBottlesBorrowed, piutang: localPiutang, firstOutlet: firstOutlet, recentOutlets: recentOutlets, crossDebtHTML: crossDebtWarningHTML };
    window.updatePromoBanner(window.activeCustomerProfile);
};

window.saveMemberToDB = function(phone, name, wallet, bottles, piutang, fOut, rOut) {
    if(!phone || phone === "-") return; 
    window.db.transaction(["members"], "readonly").objectStore("members").get(phone).onsuccess = (e) => {
        let mem = e.target.result || { phone: phone, name: name, wallet: {}, spent: 0, bottlesBorrowed: 0, piutang: 0, firstOutlet: fOut || window.currentOutlet, recentOutlets: rOut || window.currentOutlet }; 
        mem.name = name; if(wallet !== undefined) mem.wallet = wallet; if(bottles !== undefined) mem.bottlesBorrowed = bottles; if(piutang !== undefined) mem.piutang = piutang; 
        if(fOut !== undefined) mem.firstOutlet = fOut; if(rOut !== undefined) mem.recentOutlets = rOut;
        window.db.transaction(["members"], "readwrite").objectStore("members").put(mem);
        window.db.transaction(["unsynced_members"], "readwrite").objectStore("unsynced_members").put(mem);
    };
}

window.loadMenuUI = function() {
    const visibleItems = window.globalMenuData.filter(i => !i.hideOnPos); const categories = [...new Set(visibleItems.map(i => i.category))]; 
    if(categories.length > 0) window.currentCategory = categories[0];
    const catContainer = document.getElementById("category-container"); catContainer.innerHTML = "";
    categories.forEach(cat => {
        const btn = document.createElement("button"); btn.className = `cat-btn ${cat === window.currentCategory ? "active" : ""}`; btn.innerText = cat;
        btn.onclick = () => { window.currentCategory = cat; document.querySelectorAll(".cat-btn").forEach(b => b.classList.remove("active")); btn.classList.add("active"); window.renderProductGrid(); };
        catContainer.appendChild(btn);
    }); window.renderProductGrid();
}

window.renderProductGrid = function() {
    const grid = document.getElementById("product-grid"); grid.innerHTML = "";
    const filteredMenu = window.globalMenuData.filter(i => {
        if (i.hideOnPos) return false; if (i.category !== window.currentCategory) return false;
        const availableList = (i.availableAt || "ALL").toUpperCase(); if (availableList === "ALL" || availableList === "") return true;
        return availableList.includes(window.currentOutlet.toUpperCase());
    });
    filteredMenu.forEach(item => {
        const card = document.createElement("div"); card.className = "product-card";
        card.innerHTML = `<div><h4 style="margin-top:0;">${item.name}</h4></div> <div class="price-badge">Rp ${item.price.toLocaleString('id-ID')}</div>`;
        card.onclick = () => { if(window.isMenuLocked) return; window.addToCart(item, 1); }; grid.appendChild(card);
    });
}

window.addToCart = function(item, qty) {
    const existing = window.currentCart.find(i => i.itemId === item.itemId);
    if (existing) { existing.qty += qty; } else { window.currentCart.push({ ...item, qty: qty, originalPrice: item.price, autoDeduct: item.autoDeduct, loyaltyThreshold: item.loyaltyThreshold, redeemed: 0 }); }
    window.renderCart();
}

window.updateCartQty = function(itemId, delta) {
    const item = window.currentCart.find(i => i.itemId === itemId);
    if (item) { item.qty += delta; if (item.qty <= 0) { window.currentCart = window.currentCart.filter(i => i.itemId !== itemId); window.posSessions[window.activeSessionIndex].cart = window.currentCart; } window.renderCart(); }
}

window.renderCart = function() {
    const container = document.getElementById("cart-items"); container.innerHTML = ""; let total = 0;
    window.currentCart.forEach(item => {
        const lineTotal = item.qty * item.price; total += lineTotal;
        container.innerHTML += `
        <div class="cart-item" style="display:flex; justify-content:space-between; align-items:center; padding:12px 0; border-bottom:1px dashed #ccc;">
            <div style="flex:1; font-weight:bold; font-size:14px;">${item.name}</div>
            <div style="display:flex; align-items:center; gap:8px; margin: 0 10px;">
                <button onclick="window.updateCartQty('${item.itemId}', -1)" style="width:30px; height:30px; background:#e74c3c; color:white; border:none; border-radius:6px; font-weight:bold; font-size:16px; cursor:pointer;">-</button>
                <span style="font-weight:bold; min-width:25px; text-align:center;">${item.qty}</span>
                <button onclick="window.updateCartQty('${item.itemId}', 1)" style="width:30px; height:30px; background:#2ecc71; color:white; border:none; border-radius:6px; font-weight:bold; font-size:16px; cursor:pointer;">+</button>
            </div>
            <div style="font-weight:bold; color:#2c3e50; min-width:80px; text-align:right;">Rp ${lineTotal.toLocaleString('id-ID')}</div>
        </div>`;
    });
    document.getElementById("cart-total").innerText = `Rp ${total.toLocaleString('id-ID')}`; window.cartSubtotal = total; window.cartGrandTotal = total; 
    
    window.posSessions.forEach((session, i) => {
        let qty = session.cart.reduce((sum, item) => sum + item.qty, 0); let btn = document.getElementById(`tab-btn-${i}`);
        if (qty > 0) { btn.innerHTML = `🛒 Antrean ${i+1} <span style="background:#e74c3c; color:white; border-radius:12px; padding:2px 6px; font-size:11px; margin-left:5px;">${qty}</span>`; } 
        else { btn.innerHTML = `🛒 Antrean ${i+1}`; }
    });
}

window.clearCart = function() { window.lockMenu(); }

window.reviewOrder = function() {
    if (window.currentCart.length === 0) return alert("Keranjang masih kosong!");
    window.cartGrandTotal = window.cartSubtotal;
    const redeemContainer = document.getElementById("redemption-items"); redeemContainer.innerHTML = ""; let hasRedeemable = false;

    if (window.loyaltyEnabled && window.activeCustomerProfile) {
        let wallet = window.activeCustomerProfile.wallet || {};
        window.currentCart.forEach(item => {
            if (item.loyaltyThreshold > 0) {
                let existingFree = wallet[item.name] ? wallet[item.name].free : 0;
                let existingPoints = wallet[item.name] ? wallet[item.name].points : 0;
                let t = item.loyaltyThreshold;
                
                let maxRedeemable = Math.min(existingFree, item.qty);
                
                for (let f = maxRedeemable; f <= item.qty; f++) {
                    let paidQty = item.qty - f;
                    let generatedFree = Math.floor((existingPoints + paidQty) / t);
                    if (f <= existingFree + generatedFree) {
                        maxRedeemable = f;
                    } else {
                        break;
                    }
                }
                
                if (maxRedeemable > 0) {
                    hasRedeemable = true;
                    let availText = maxRedeemable > existingFree 
                        ? `${existingFree} Saldo + ${maxRedeemable - existingFree} Dari Order Ini` 
                        : `${existingFree} Saldo`;

                    redeemContainer.innerHTML += `
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; padding-bottom:8px; border-bottom:1px dashed #bce8f1;">
                            <span style="font-size:14px; font-weight:bold; color:#2c3e50;">${item.name} <br><small style="font-weight:normal; color:#7f8c8d;">(Maks Tukar: ${maxRedeemable} | Info: ${availText})</small></span>
                            <div style="display:flex; align-items:center; gap:8px;"><label style="font-size:12px;">Pakai:</label><input type="number" class="redeem-input" data-item="${item.itemId}" data-price="${item.price}" max="${maxRedeemable}" min="0" value="0" style="width:60px; padding:8px; text-align:center; font-size:16px; border:2px solid #bdc3c7; border-radius:6px;" onclick="this.select()" oninput="window.recalcRedemptions()"></div>
                        </div>`;
                }
            }
        });
    }

    if (hasRedeemable) { document.getElementById("redemption-section").classList.remove("hidden"); } else { document.getElementById("redemption-section").classList.add("hidden"); }

    document.getElementById("pay-qris").value = 0; document.getElementById("pay-transfer").value = 0; document.getElementById("pay-free").value = 0; document.getElementById("pay-piutang").value = 0;
    let bottleRentBox = document.getElementById("rent-bottle-qty"); if(bottleRentBox) bottleRentBox.value = 0;
    
    document.getElementById("review-subtotal").innerText = `Rp ${window.cartSubtotal.toLocaleString('id-ID')}`; document.getElementById("review-grandtotal").innerText = `Rp ${window.cartGrandTotal.toLocaleString('id-ID')}`;
    document.getElementById("pay-cash").value = window.cartGrandTotal; window.calculateRemaining(); document.getElementById("review-modal").classList.remove("hidden");
}

window.recalcRedemptions = function() {
    let totalDiscount = 0;
    document.querySelectorAll(".redeem-input").forEach(input => {
        let qty = Number(input.value) || 0; let max = Number(input.getAttribute("max"));
        if(qty > max) { qty = max; input.value = max; } if(qty < 0) { qty = 0; input.value = 0; }
        let price = Number(input.getAttribute("data-price")); totalDiscount += (qty * price);
    });
    document.getElementById("pay-free").value = totalDiscount; window.autoBalanceCash();
}

window.autoBalancePiutang = function() {
    const c = Number(document.getElementById("pay-cash").value) || 0; const q = Number(document.getElementById("pay-qris").value) || 0; const t = Number(document.getElementById("pay-transfer").value) || 0; const f = Number(document.getElementById("pay-free").value) || 0;
    const totalAccounted = c + q + t + f; const remaining = Math.max(0, window.cartGrandTotal - totalAccounted);
    document.getElementById("pay-piutang").value = remaining; window.calculateRemaining();
}

window.autoBalanceCash = function() {
    const q = Number(document.getElementById("pay-qris").value) || 0; const t = Number(document.getElementById("pay-transfer").value) || 0; const f = Number(document.getElementById("pay-free").value) || 0; const p = Number(document.getElementById("pay-piutang").value) || 0;
    const totalAccounted = q + t + f + p; const remaining = Math.max(0, window.cartGrandTotal - totalAccounted);
    document.getElementById("pay-cash").value = remaining; window.calculateRemaining();
}

window.calculateRemaining = function() {
    const c = Number(document.getElementById("pay-cash").value) || 0; const q = Number(document.getElementById("pay-qris").value) || 0; const t = Number(document.getElementById("pay-transfer").value) || 0; const f = Number(document.getElementById("pay-free").value) || 0; const p = Number(document.getElementById("pay-piutang").value) || 0;
    const totalAccounted = c + q + t + f + p; const remaining = window.cartGrandTotal - totalAccounted;
    document.getElementById("review-remaining").innerText = `Rp ${remaining.toLocaleString('id-ID')}`;
}

window.closeReview = function() { document.getElementById("review-modal").classList.add("hidden"); }

window.switchCart = function(index) {
    window.posSessions[window.activeSessionIndex].customer = window.activeCustomerProfile; window.activeSessionIndex = index; window.currentCart = window.posSessions[window.activeSessionIndex].cart; window.activeCustomerProfile = window.posSessions[window.activeSessionIndex].customer;
    document.querySelectorAll(".cart-tab").forEach((btn, i) => {
        if (i === index) { btn.classList.add("active"); btn.style.background = "#2c3e50"; btn.style.color = "white"; btn.style.borderTop = "3px solid #3498db"; } 
        else { btn.classList.remove("active"); btn.style.background = "#34495e"; btn.style.color = "#bdc3c7"; btn.style.borderTop = "none"; }
    });
    window.renderCart();
    
    if (window.activeCustomerProfile) {
        document.getElementById("cust-name").value = window.activeCustomerProfile.name; document.getElementById("cust-phone").value = window.activeCustomerProfile.phone || "";
        document.getElementById("active-cust-name").innerText = window.activeCustomerProfile.name; document.getElementById("active-cust-phone").innerText = window.activeCustomerProfile.phone !== "-" ? `(${window.activeCustomerProfile.phone})` : "";
        document.getElementById("customer-input-section").classList.add("hidden"); document.getElementById("active-customer-banner").classList.remove("hidden");
        window.isMenuLocked = false; document.getElementById("glass-overlay").style.opacity = "0"; document.getElementById("glass-overlay").style.pointerEvents = "none";
        window.updatePromoBanner(window.activeCustomerProfile);
    } else {
        document.getElementById("customer-input-section").classList.remove("hidden"); document.getElementById("active-customer-banner").classList.add("hidden");
        document.getElementById("glass-overlay").style.opacity = "1"; document.getElementById("glass-overlay").style.pointerEvents = "auto";
        document.getElementById("cust-phone").value = ""; document.getElementById("cust-name").value = ""; 
        const promoBanner = document.getElementById("promo-indicator-banner"); if(promoBanner) promoBanner.classList.add("hidden");
        const piutangBanner = document.getElementById("piutang-indicator-banner"); if(piutangBanner) piutangBanner.classList.add("hidden");
        const warnBanner = document.getElementById("piutang-warning-banner"); if(warnBanner) warnBanner.classList.add("hidden");
        window.isMenuLocked = true;
    }
}

window.isCustomerLocked = function(phone) {
    if (!phone || phone === "-") return false;
    for (let i = 0; i < window.posSessions.length; i++) { if (i !== window.activeSessionIndex && window.posSessions[i].customer && window.posSessions[i].customer.phone === phone) { return i + 1; } }
    return false;
}

window.updatePromoBanner = function(member) {
    const promoBanner = document.getElementById("promo-indicator-banner");
    const piutangBanner = document.getElementById("piutang-indicator-banner");
    const warnBanner = document.getElementById("piutang-warning-banner");
    const outletDisplay = document.getElementById("active-cust-outlets");

    if (member && outletDisplay) {
        let fOut = member.firstOutlet && member.firstOutlet !== "Unknown" ? member.firstOutlet : "-";
        let rOutStr = member.recentOutlets || "";
        let rOutList = rOutStr ? rOutStr.split(",").map(s => s.trim()) : [];
        let lOut = rOutList.length > 0 ? rOutList[rOutList.length - 1] : "-";
        outletDisplay.innerHTML = `📍 Awal: <strong>${fOut}</strong> | Akhir: <strong>${lOut}</strong>`;
    }

    if (member && member.crossDebtHTML && member.crossDebtHTML !== "") {
        if(warnBanner) { warnBanner.innerHTML = member.crossDebtHTML.replace(/&quot;/g, '"'); warnBanner.classList.remove("hidden"); }
    } else { if(warnBanner) warnBanner.classList.add("hidden"); }

    if (member && member.piutang > 0) {
        piutangBanner.innerHTML = `<span>⚠️ <strong>Total Piutang Lokal:</strong> Rp ${member.piutang.toLocaleString('id-ID')}</span> <button onclick="window.openPiutangModal()" style="padding:5px 10px; background:#c0392b; color:white; border:none; border-radius:4px; font-weight:bold; cursor:pointer;">Lunasi Piutang</button>`;
        piutangBanner.classList.remove("hidden");
    } else { if(piutangBanner) piutangBanner.classList.add("hidden"); }

    if (!window.loyaltyEnabled || !promoBanner) { if(promoBanner) promoBanner.classList.add("hidden"); return; }

    let pointSummary = []; let wallet = member ? (member.wallet || {}) : {};
    let loyaltyItems = window.globalMenuData.filter(m => m.loyaltyThreshold > 0);
    loyaltyItems.forEach(item => {
        let w = wallet[item.name] || { points: 0, free: 0 };
        pointSummary.push(`💧 <strong>${item.name}</strong>: ${w.points}/${item.loyaltyThreshold} Poin${w.free > 0 ? ` <span style="color:#27ae60;">(🎁 ${w.free} Gratis)</span>` : ''}`);
    });
    for (let itemName in wallet) {
        if (!loyaltyItems.find(i => i.name === itemName)) {
             let w = wallet[itemName]; pointSummary.push(`💧 <strong>${itemName}</strong>: ${w.points} Poin${w.free > 0 ? ` <span style="color:#27ae60;">(🎁 ${w.free} Gratis)</span>` : ''}`);
        }
    }
    if (pointSummary.length > 0) { promoBanner.innerHTML = `🌟 <strong>Info Saldo Poin:</strong><br>` + pointSummary.join('<br>'); promoBanner.classList.remove("hidden"); } 
    else { promoBanner.innerHTML = `🌟 Promo Loyalty tidak ada barang aktif.`; promoBanner.classList.remove("hidden"); }
}

window.lockMenu = function() {
    window.isMenuLocked = true; window.activeCustomerProfile = null; window.posSessions[window.activeSessionIndex].customer = null; window.posSessions[window.activeSessionIndex].cart = []; window.currentCart = window.posSessions[window.activeSessionIndex].cart;
    document.getElementById("customer-input-section").classList.remove("hidden"); document.getElementById("active-customer-banner").classList.add("hidden");
    document.getElementById("glass-overlay").style.opacity = "1"; document.getElementById("glass-overlay").style.pointerEvents = "auto";
    document.getElementById("cust-phone").value = ""; document.getElementById("cust-name").value = ""; 
    window.renderCart();
    const promoBanner = document.getElementById("promo-indicator-banner"); if(promoBanner) promoBanner.classList.add("hidden");
    const piutangBanner = document.getElementById("piutang-indicator-banner"); if(piutangBanner) piutangBanner.classList.add("hidden");
    const warnBanner = document.getElementById("piutang-warning-banner"); if(warnBanner) warnBanner.classList.add("hidden");
    const outletDisplay = document.getElementById("active-cust-outlets"); if(outletDisplay) outletDisplay.innerHTML = "";
}

window.unlockMenu = function(isGuest) {
    let phone = "-"; let name = "Walk-in";
    const promoBanner = document.getElementById("promo-indicator-banner"); const piutangBanner = document.getElementById("piutang-indicator-banner"); const warnBanner = document.getElementById("piutang-warning-banner");
    const outletDisplay = document.getElementById("active-cust-outlets");

    if (isGuest) { 
        document.getElementById("cust-phone").value = ""; document.getElementById("cust-name").value = "Walk-in"; window.activeCustomerProfile = null; 
        document.getElementById("active-cust-name").innerText = name; document.getElementById("active-cust-phone").innerText = "";
        document.getElementById("customer-input-section").classList.add("hidden"); document.getElementById("active-customer-banner").classList.remove("hidden");
        if(promoBanner) promoBanner.classList.add("hidden"); if(piutangBanner) piutangBanner.classList.add("hidden"); if(warnBanner) warnBanner.classList.add("hidden");
        if(outletDisplay) outletDisplay.innerHTML = "";
        window.isMenuLocked = false; document.getElementById("glass-overlay").style.opacity = "0"; setTimeout(() => { document.getElementById("glass-overlay").style.pointerEvents = "none"; }, 300);
    } else {
        phone = document.getElementById("cust-phone").value.trim(); name = document.getElementById("cust-name").value.trim() || "Pelanggan";
        if (phone.length < 5) return alert("Harap masukkan Nomor WhatsApp yang valid terlebih dahulu.");

        let searchPhone = phone.replace(/\D/g, ''); if (searchPhone.startsWith('62')) searchPhone = '0' + searchPhone.substring(2);
        if (searchPhone.length > 0 && !searchPhone.startsWith('0')) searchPhone = '0' + searchPhone;

        let lockedQueue = window.isCustomerLocked(searchPhone);
        if (lockedQueue) { return alert(`⚠️ PELANGGAN TERKUNCI:\nPelanggan ini sedang diproses di Antrean ${lockedQueue}. Selesaikan pesanan di sana terlebih dahulu.`); }

        const tx = window.db.transaction(["members"], "readonly");
        tx.objectStore("members").get(searchPhone).onsuccess = (ev) => {
            const member = ev.target.result;
            if (member) { window.activeCustomerProfile = member; name = member.name; document.getElementById("cust-name").value = name; window.updatePromoBanner(member); } 
            else { window.activeCustomerProfile = { phone: searchPhone, name: name, wallet: {}, bottlesBorrowed: 0, piutang: 0, firstOutlet: window.currentOutlet, recentOutlets: window.currentOutlet }; window.updatePromoBanner(window.activeCustomerProfile); }

            document.getElementById("active-cust-name").innerText = name; document.getElementById("active-cust-phone").innerText = `(${searchPhone})`;
            document.getElementById("customer-input-section").classList.add("hidden"); document.getElementById("active-customer-banner").classList.remove("hidden");
            window.isMenuLocked = false; document.getElementById("glass-overlay").style.opacity = "0"; setTimeout(() => { document.getElementById("glass-overlay").style.pointerEvents = "none"; }, 300);
        };
    }
}

window.openBukuPiutang = function() {
    document.getElementById('buku-piutang-modal').classList.remove('hidden');
    document.getElementById('search-piutang').value = "";
    window.renderPiutangList();
}

window.renderPiutangList = function() {
    const filter = document.getElementById('search-piutang').value.toLowerCase().trim();
    const container = document.getElementById("piutang-list-container"); container.innerHTML = "";
    
    window.db.transaction(["members"], "readonly").objectStore("members").getAll().onsuccess = (e) => {
        let members = e.target.result.filter(m => m.piutang > 0);
        if (filter) members = members.filter(m => String(m.name).toLowerCase().includes(filter) || String(m.phone).includes(filter));
        
        if (members.length === 0) { container.innerHTML = `<div style="padding:20px; text-align:center; color:#7f8c8d;">Tidak ada data piutang ditemukan.</div>`; return; }
        
        members.forEach(m => {
            container.innerHTML += `
                <div class="history-row">
                    <div>
                        <strong style="color:#2c3e50;">${m.name}</strong> <span style="font-size:12px; color:#7f8c8d;">(${m.phone})</span><br>
                        <strong style="color:#c0392b; font-size:16px;">Rp ${m.piutang.toLocaleString('id-ID')}</strong>
                    </div>
                    <div>
                        <button onclick="window.triggerBayarPiutang('${m.phone}')" style="background:#27ae60; color:white; border:none; padding:8px 15px; border-radius:6px; font-weight:bold; cursor:pointer;">Lunasi Piutang</button>
                    </div>
                </div>`;
        });
    };
}

window.triggerBayarPiutang = function(phone) {
    window.db.transaction(["members"], "readonly").objectStore("members").get(phone).onsuccess = (e) => {
        const m = e.target.result; if(m) window.openPiutangModal(m);
    };
}

window.openPiutangModal = function(memberOverride) {
    window.piutangTargetMember = memberOverride || window.activeCustomerProfile;
    if(!window.piutangTargetMember || window.piutangTargetMember.piutang <= 0) return;
    
    document.getElementById("piutang-target-name").innerText = window.piutangTargetMember.name;
    document.getElementById("piutang-target-amount").innerText = "Rp " + window.piutangTargetMember.piutang.toLocaleString('id-ID');
    document.getElementById("piutang-pay-amount").value = window.piutangTargetMember.piutang;
    
    const orderSelect = document.getElementById("piutang-target-order"); orderSelect.innerHTML = `<option value="">-- Lunasi Saldo Global --</option>`;
    window.db.transaction(["orders"], "readonly").objectStore("orders").getAll().onsuccess = (e) => {
        const memberOrders = e.target.result.filter(o => o.customerPhone === window.piutangTargetMember.phone && o.debtAmount > 0 && String(o.paymentMethod).includes("Piutang"));
        memberOrders.forEach(o => { orderSelect.innerHTML += `<option value="${o.orderId}">Nota: ${o.orderId} (Hutang Rp ${o.debtAmount.toLocaleString('id-ID')})</option>`; });
        document.getElementById('buku-piutang-modal').classList.add('hidden');
        document.getElementById("piutang-modal").classList.remove("hidden");
    };
}

window.submitPiutang = function() {
    let payAmount = Number(document.getElementById("piutang-pay-amount").value); let method = document.getElementById("piutang-method").value;
    let targetOrderId = document.getElementById("piutang-target-order").value;
    
    if(payAmount <= 0) return alert("Jumlah tidak valid"); 
    if(payAmount > window.piutangTargetMember.piutang) return alert("Jumlah yang dimasukkan melebihi total piutang pelanggan!");
    
    let cashAmt = method === "Tunai" ? payAmount : 0;
    let payload = { payId: "BYR-" + Date.now(), timestamp: window.getWibDate(), customerName: window.piutangTargetMember.name, customerPhone: window.piutangTargetMember.phone, amountPaid: payAmount, paymentMethod: method, cashAmount: cashAmt, cashier: window.currentCashier, outlet: window.currentOutlet, syncStatus: "Pending", shiftId: window.currentShiftId, originalOrderId: targetOrderId };
    
    window.db.transaction(["bayar_piutang"], "readwrite").objectStore("bayar_piutang").add(payload);
    
    window.piutangTargetMember.piutang -= payAmount;
    window.saveMemberToDB(window.piutangTargetMember.phone, window.piutangTargetMember.name, window.piutangTargetMember.wallet, window.piutangTargetMember.bottlesBorrowed, window.piutangTargetMember.piutang, window.piutangTargetMember.firstOutlet, window.piutangTargetMember.recentOutlets);
    if (window.activeCustomerProfile && window.activeCustomerProfile.phone === window.piutangTargetMember.phone) { window.activeCustomerProfile = window.piutangTargetMember; window.updatePromoBanner(window.activeCustomerProfile); }
    
    let remainingPay = payAmount;
    window.db.transaction(["orders"], "readonly").objectStore("orders").getAll().onsuccess = (e) => {
        let orders = e.target.result.filter(o => o.customerPhone === window.piutangTargetMember.phone && (o.debtAmount || 0) > 0);
        orders.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)); 
        
        let tx2 = window.db.transaction(["orders"], "readwrite");
        let store2 = tx2.objectStore("orders");
        
        for (let o of orders) {
            if (remainingPay <= 0) break;
            if (targetOrderId !== "" && o.orderId !== targetOrderId) continue; 
            
            let currentDebt = o.debtAmount || 0;
            let payHere = Math.min(currentDebt, remainingPay);
            remainingPay -= payHere;
            
            o.debtAmount = currentDebt - payHere;
            if (o.debtAmount === 0 && String(o.paymentMethod).includes("Piutang")) {
                o.paymentMethod = String(o.paymentMethod).replace("Piutang", "Lunas ("+method+")");
            } else if (o.debtAmount > 0 && String(o.paymentMethod).includes("Piutang")) {
                if (!String(o.paymentMethod).includes("Sebagian")) { o.paymentMethod = String(o.paymentMethod).replace("Piutang", "Piutang (Sebagian)"); }
            }
            o.syncStatus = "Pending"; 
            store2.put(o);
        }
    };

    document.getElementById("piutang-modal").classList.add("hidden"); alert("Pembayaran Piutang Berhasil Dicatat!"); window.runBackgroundSync();
}

window.finalizeOrder = async function(shouldPrint) {
    const cash = Number(document.getElementById("pay-cash").value) || 0; const qris = Number(document.getElementById("pay-qris").value) || 0;
    const transfer = Number(document.getElementById("pay-transfer").value) || 0; const free = Number(document.getElementById("pay-free").value) || 0;
    const debtAmount = Number(document.getElementById("pay-piutang").value) || 0;
    const rentBottleQty = Number(document.getElementById("rent-bottle-qty").value) || 0;
    
    const totalAccounted = cash + qris + transfer + free + debtAmount; const remaining = window.cartGrandTotal - totalAccounted; 

    let custPhoneRaw = document.getElementById("cust-phone").value.trim(); let custPhone = custPhoneRaw || "-";
    const custName = document.getElementById("cust-name").value.trim() || "Walk-in";

    if (remaining !== 0) return alert("⚠️ PEMBAYARAN DITOLAK:\nTotal pembayaran (termasuk hutang) harus persis sama dengan Total Akhir.");
    if (debtAmount > 0 && (!custPhone || custPhone === "-")) return alert("⚠️ TRANSAKSI DITOLAK:\nAnda WAJIB memasukkan nomor WhatsApp pelanggan untuk mencatat Piutang.");
    if (rentBottleQty > 0 && (!custPhone || custPhone === "-")) return alert("⚠️ TRANSAKSI DITOLAK:\nAnda WAJIB memasukkan nomor WhatsApp pelanggan untuk mencatat Peminjaman Galon.");

    let hasRedemptions = false;
    document.querySelectorAll(".redeem-input").forEach(input => { if (Number(input.value) > 0) hasRedemptions = true; });
    if (hasRedemptions && debtAmount > 0) return alert("⚠️ TRANSAKSI DITOLAK:\nPelanggan tidak bisa menukar Poin Gratis jika pembayaran menggunakan Piutang.");

    let payMethods = []; if(cash > 0) payMethods.push("Tunai"); if(qris > 0) payMethods.push("QRIS"); if(transfer > 0) payMethods.push("Trf.Bank"); if(free > 0) payMethods.push("Gratis"); if(debtAmount > 0) payMethods.push("Piutang");
    const payString = payMethods.length > 0 ? payMethods.join("+") : "Belum Bayar";

    let status = "Completed"; 
    window.currentCart.forEach(i => i.redeemed = 0);
    document.querySelectorAll(".redeem-input").forEach(input => {
        let itemId = input.getAttribute("data-item"); let qty = Number(input.value) || 0;
        let cartItem = window.currentCart.find(i => i.itemId === itemId); if (cartItem) cartItem.redeemed = qty;
    });

    let loyaltyChanges = {}; let freeItemsRedeemed = [];
    window.currentCart.forEach(item => {
        if (item.redeemed > 0) { freeItemsRedeemed.push({ name: item.name, qty: item.redeemed }); }
        if (item.loyaltyThreshold > 0) {
            let earned = item.qty - (item.redeemed || 0); 
            if (earned > 0 || (item.redeemed || 0) > 0) {
                if(!loyaltyChanges[item.name]) loyaltyChanges[item.name] = { earned: 0, redeemed: 0, threshold: item.loyaltyThreshold };
                loyaltyChanges[item.name].earned += earned; loyaltyChanges[item.name].redeemed += (item.redeemed || 0);
            }
        }
    });

    let updatedWallet = {}; let newPiutang = (window.activeCustomerProfile ? window.activeCustomerProfile.piutang || 0 : 0) + debtAmount;
    if (window.loyaltyEnabled && window.activeCustomerProfile) {
        updatedWallet = JSON.parse(JSON.stringify(window.activeCustomerProfile.wallet || {})); 
        for(let itemName in loyaltyChanges) {
            if(!updatedWallet[itemName]) updatedWallet[itemName] = {points:0, free:0};
            
            updatedWallet[itemName].free -= loyaltyChanges[itemName].redeemed;
            if (debtAmount === 0) {
                updatedWallet[itemName].points += loyaltyChanges[itemName].earned;
                if(loyaltyChanges[itemName].threshold > 0) {
                    let newFree = Math.floor(updatedWallet[itemName].points / loyaltyChanges[itemName].threshold);
                    updatedWallet[itemName].points = updatedWallet[itemName].points % loyaltyChanges[itemName].threshold; 
                    updatedWallet[itemName].free += newFree;
                }
            }
        }
        window.activeCustomerProfile.piutang = newPiutang;
        window.saveMemberToDB(window.activeCustomerProfile.phone, window.activeCustomerProfile.name, updatedWallet, window.activeCustomerProfile.bottlesBorrowed + rentBottleQty, newPiutang, window.activeCustomerProfile.firstOutlet, window.activeCustomerProfile.recentOutlets);
    } else if (custPhone !== "-") {
        let fOut = window.activeCustomerProfile ? window.activeCustomerProfile.firstOutlet : window.currentOutlet; let rOut = window.activeCustomerProfile ? window.activeCustomerProfile.recentOutlets : window.currentOutlet;
        window.saveMemberToDB(custPhone, custName, {}, rentBottleQty, debtAmount, fOut, rOut);
    }

    const orderPayload = {
        orderId: "ORD-" + Date.now(), timestamp: window.getWibDate(), cashier: window.currentCashier, shiftId: window.currentShiftId,
        customerName: custName, customerPhone: custPhone, orderStatus: status, items: window.currentCart, subtotal: window.cartSubtotal, discounts: free, grandTotal: window.cartGrandTotal,
        paymentMethod: payString, cashAmount: cash, qrisAmount: qris, transferAmount: transfer, freeAmount: free, rentBottleQty: rentBottleQty, debtAmount: debtAmount,
        loyaltyChanges: loyaltyChanges, freeItemsRedeemed: freeItemsRedeemed, outlet: window.currentOutlet, syncStatus: "Pending" 
    };

    const txMenu = window.db.transaction(["menu"], "readwrite"); const storeMenu = txMenu.objectStore("menu");
    window.currentCart.forEach(cartItem => { storeMenu.get(cartItem.itemId).onsuccess = (ev) => { const menuItem = ev.target.result; if (menuItem && menuItem.trackStock) { menuItem.currentStock = Math.max(0, menuItem.currentStock - cartItem.qty); storeMenu.put(menuItem); } }; });

    window.db.transaction(["orders"], "readwrite").objectStore("orders").add(orderPayload);
    
    if (shouldPrint) {
        const payloadBytes = await window.buildEscPosReceipt(orderPayload.orderId, orderPayload, (cash+qris+transfer+free), debtAmount, payString, updatedWallet);
        await window.printViaBluetooth(payloadBytes);
    }
    
    window.closeReview(); window.lockMenu(); window.renderProductGrid(); window.runBackgroundSync();
}

window.getDynamicSettings = async function() { return new Promise(res => { let req = window.db.transaction(["settings"], "readonly").objectStore("settings").getAll(); req.onsuccess = e => { let s = {}; e.target.result.forEach(row => s[row.key] = row.value); res(s); }; }); }

window.formatLine = function(leftText, rightText, isBig) {
    const maxChars = isBig ? 16 : 32;
    const totalLen = leftText.length + rightText.length;
    if (totalLen <= maxChars) {
        const spaces = maxChars - totalLen;
        return leftText + " ".repeat(spaces) + rightText + "\n";
    } else {
        const rightSpaces = maxChars - rightText.length;
        return leftText + "\n" + " ".repeat(Math.max(0, rightSpaces)) + rightText + "\n";
    }
}

window.buildEscPosReceipt = async function(orderId, order, deposit, debt, payMethod, updatedWallet) {
    const settings = await window.getDynamicSettings();
    const h1 = settings["Header_1"] || "PURE WATER"; 
    const h2 = settings["Header_2"] || ""; 
    let h3 = settings["Header_3"] || ""; if (settings["Header_3_" + order.outlet]) h3 = settings["Header_3_" + order.outlet]; 
    const f1 = settings["Footer_1"] || "TERIMA KASIH"; 
    const f2 = settings["Footer_2"] || ""; 
    let f3 = settings["Footer_3"] || ""; if (settings["Footer_3_" + order.outlet]) f3 = settings["Footer_3_" + order.outlet]; 

    const dateStr = window.formatDateReadable(order.timestamp);
    let receipt = "";
    
    const initCmd = "\x1B\x40"; 
    const centerAlign = "\x1B\x61\x01";
    const leftAlign = "\x1B\x61\x00";
    const boldOn = "\x1B\x45\x01";
    const boldOff = "\x1B\x45\x00";
    const bigText = "\x1B\x21\x11";
    const normalText = "\x1B\x21\x00";

    receipt += initCmd;
    receipt += centerAlign + boldOn + bigText + h1 + "\n" + normalText + boldOff;
    if(h2) receipt += h2 + "\n";
    if(h3) receipt += h3 + "\n";
    receipt += dateStr + "\n";
    receipt += leftAlign + "-".repeat(32) + "\n";
    receipt += `Nota: ${orderId}\nNama: ${order.customerName}\nKasir: ${order.cashier}\n`;
    receipt += "-".repeat(32) + "\n";

    order.items.forEach(item => { 
        const lineTotal = (item.qty * item.originalPrice).toLocaleString('id-ID'); 
        receipt += window.formatLine(`${item.qty}x ${item.name}`, lineTotal, false); 
    });

    receipt += "-".repeat(32) + "\n";
    receipt += window.formatLine("Subtotal:", "Rp " + order.subtotal.toLocaleString('id-ID'), false);
    
    if ((order.discounts || 0) > 0 || (order.freeAmount || 0) > 0) {
        let hemat = (order.discounts || 0) + (order.freeAmount || 0);
        receipt += "\n" + centerAlign + boldOn + "*".repeat(32) + "\n";
        receipt += `🎉 ANDA HEMAT Rp ${hemat.toLocaleString('id-ID')} 🎉\n`;
        receipt += "*".repeat(32) + "\n" + normalText + boldOff + leftAlign;
    }

    receipt += boldOn + window.formatLine("TOTAL:", "Rp " + order.grandTotal.toLocaleString('id-ID'), false) + boldOff;
    receipt += window.formatLine(`Tercatat (${payMethod}):`, "Rp " + deposit.toLocaleString('id-ID'), false);
    if (debt > 0) { receipt += boldOn + window.formatLine("PIUTANG:", "Rp " + debt.toLocaleString('id-ID'), false) + boldOff; }
    
    if (window.loyaltyEnabled && order.customerPhone && order.customerPhone !== "-") {
        receipt += "\n" + centerAlign + "-- INFO POIN --\n" + leftAlign;
        let loyaltyItems = window.globalMenuData.filter(m => m.loyaltyThreshold > 0);
        loyaltyItems.forEach(item => { 
            let data = updatedWallet[item.name] || {points: 0, free: 0}; 
            receipt += window.formatLine(item.name, `Poin:${data.points} | Free:${data.free}`, false); 
        });
    }

    receipt += "\n" + centerAlign + boldOn + f1 + "\n" + normalText + boldOff;
    if(f2) receipt += f2 + "\n";
    if(f3) receipt += f3 + "\n";
    receipt += "\n\n\n\n\n"; 

    return new TextEncoder().encode(receipt);
}

window.printShiftReport = async function() {
    if (!window.currentShiftData) return alert("Data shift belum siap.");
    const payloadBytes = await window.buildEscPosShiftReport(window.currentShiftData);
    await window.printViaBluetooth(payloadBytes);
}

window.buildEscPosShiftReport = async function(data) {
    const settings = await window.getDynamicSettings();
    const h1 = settings["Header_1"] || "PURE WATER";
    const dateStr = window.formatDateReadable(new Date());
    
    const initCmd = "\x1B\x40"; 
    const centerAlign = "\x1B\x61\x01";
    const leftAlign = "\x1B\x61\x00";
    const boldOn = "\x1B\x45\x01";
    const boldOff = "\x1B\x45\x00";
    const normalText = "\x1B\x21\x00";

    let receipt = initCmd;
    receipt += centerAlign + boldOn + h1 + "\nLAPORAN SHIFT\n" + normalText + boldOff;
    receipt += dateStr + "\n";
    receipt += leftAlign + "-".repeat(32) + "\n";
    receipt += `Shift: ${window.currentShiftId}\nKasir: ${window.currentCashier}\nMasuk: ${window.formatDateReadable(window.currentLoginTime)}\nKeluar: ${window.formatDateReadable(new Date())}\n`;
    receipt += "-".repeat(32) + "\n";
    
    receipt += boldOn + "RINGKASAN PENJUALAN\n" + boldOff;
    receipt += window.formatLine("Total Nota:", String(data.totalOrders), false);
    receipt += window.formatLine("Total Omset:", "Rp " + data.totalOmset.toLocaleString('id-ID'), false);
    receipt += "-".repeat(32) + "\n";
    
    receipt += boldOn + "PEMASUKAN\n" + boldOff;
    receipt += window.formatLine("Tunai:", "Rp " + data.totalCash.toLocaleString('id-ID'), false);
    receipt += window.formatLine("QRIS:", "Rp " + data.totalQris.toLocaleString('id-ID'), false);
    receipt += window.formatLine("Transfer:", "Rp " + data.totalTransfer.toLocaleString('id-ID'), false);
    receipt += window.formatLine("Piutang Dibayar:", "Rp " + data.piutangPaid.toLocaleString('id-ID'), false);
    receipt += "-".repeat(32) + "\n";
    
    receipt += boldOn + "PENGELUARAN / HUTANG\n" + boldOff;
    receipt += window.formatLine("Keluar Laci:", "Rp " + data.totalExpenses.toLocaleString('id-ID'), false);
    receipt += window.formatLine("Piutang Baru:", "Rp " + data.piutangGiven.toLocaleString('id-ID'), false);
    receipt += window.formatLine("Diskon/Gratis:", "Rp " + data.totalFree.toLocaleString('id-ID'), false);
    receipt += "-".repeat(32) + "\n";
    
    receipt += boldOn + window.formatLine("UANG LACI (NET):", "Rp " + data.net.toLocaleString('id-ID'), false) + boldOff;
    receipt += "-".repeat(32) + "\n";
    
    receipt += boldOn + "ITEM TERJUAL\n" + boldOff;
    for (const [name, qty] of Object.entries(data.foodSummary)) {
        receipt += window.formatLine(name, String(qty), false);
    }
    
    receipt += "\n\n\n\n\n"; 
    return new TextEncoder().encode(receipt);
}

window.openInboundModal = function() {
    let select = document.getElementById("inbound-tank-target"); select.innerHTML = ""; let tanks = window.globalMenuData.filter(m => (m.category === "Tandon" || m.subCategory === "Raw Water") && (m.availableAt === "ALL" || m.availableAt.includes(window.currentOutlet)));
    tanks.forEach(t => { select.innerHTML += `<option value="${t.name}">💧 ${t.name}</option>`; });
    if (tanks.length === 0) { select.innerHTML = `<option value="Tangki Air RO">💧 Tangki Air RO</option><option value="Tangki Air Standar">💧 Tangki Air Standar</option>`; }
    document.getElementById("inbound-qty").value = ""; document.getElementById("inbound-notes").value = ""; document.getElementById("inbound-modal").classList.remove("hidden");
}
window.submitInbound = function() {
    const qty = Number(document.getElementById("inbound-qty").value); const targetTank = document.getElementById("inbound-tank-target").value; const notes = document.getElementById("inbound-notes").value.trim() || "-";
    if (qty <= 0) return alert("Masukkan jumlah liter air yang benar.");
    const payload = { logId: "INB-" + Date.now(), timestamp: window.getWibDate(), cashier: window.currentCashier, shiftId: window.currentShiftId, itemName: targetTank, qty: qty, notes: notes, outlet: window.currentOutlet, syncStatus: "Pending" };
    window.db.transaction(["stock_inbound"], "readwrite").objectStore("stock_inbound").add(payload); document.getElementById("inbound-modal").classList.add("hidden"); alert(`Berhasil mencatat kedatangan ${qty} Liter ke ${targetTank}.`); window.runBackgroundSync();
}

window.openCuciModal = function() {
    let select = document.getElementById("cuci-tank"); select.innerHTML = ""; let tanks = window.globalMenuData.filter(m => (m.category === "Tandon" || m.subCategory === "Raw Water") && (m.availableAt === "ALL" || m.availableAt.includes(window.currentOutlet)));
    tanks.forEach(t => { select.innerHTML += `<option value="${t.name}">💧 ${t.name}</option>`; });
    if (tanks.length === 0) { select.innerHTML = `<option value="Tangki Air RO">💧 Tangki Air RO</option><option value="Tangki Air Standar">💧 Tangki Air Standar</option>`; }
    document.getElementById("cuci-qty").value = ""; document.getElementById("cuci-notes").value = ""; document.getElementById("cuci-modal").classList.remove("hidden");
}
window.submitCuciTandon = function() {
    let tank = document.getElementById("cuci-tank").value; let qty = Number(document.getElementById("cuci-qty").value); let notes = document.getElementById("cuci-notes").value.trim() || "-";
    if (qty <= 0) return alert("Masukkan estimasi air terbuang dengan benar.");
    let payload = { logId: "CUC-" + Date.now(), timestamp: window.getWibDate(), cashier: window.currentCashier, shiftId: window.currentShiftId, outlet: window.currentOutlet, itemName: tank, qty: qty, notes: notes, syncStatus: "Pending" };
    window.db.transaction(["cuci_tandon"], "readwrite").objectStore("cuci_tandon").add(payload); document.getElementById("cuci-modal").classList.add("hidden"); alert("Laporan Cuci Tandon berhasil disimpan. Menunggu validasi Admin."); window.runBackgroundSync();
}

window.openLaporModal = function() {
    let select = document.getElementById("lapor-tank"); select.innerHTML = ""; let tanks = window.globalMenuData.filter(m => (m.category === "Tandon" || m.subCategory === "Raw Water") && (m.availableAt === "ALL" || m.availableAt.includes(window.currentOutlet)));
    tanks.forEach(t => { select.innerHTML += `<option value="${t.name}">⚠️ ${t.name}</option>`; });
    if (tanks.length === 0) { select.innerHTML = `<option value="Tangki Air RO">⚠️ Tangki Air RO</option><option value="Tangki Air Standar">⚠️ Tangki Air Standar</option>`; }
    document.getElementById("lapor-qty").value = ""; document.getElementById("lapor-notes").value = ""; document.getElementById("lapor-modal").classList.remove("hidden");
}
window.submitLaporMasalah = function() {
    let tank = document.getElementById("lapor-tank").value; let qty = Number(document.getElementById("lapor-qty").value); let notes = document.getElementById("lapor-notes").value.trim();
    if (qty <= 0 || notes === "") return alert("Harap masukkan estimasi air hilang dan kronologi kejadian dengan lengkap.");
    let payload = { logId: "LPR-" + Date.now(), timestamp: window.getWibDate(), cashier: window.currentCashier, shiftId: window.currentShiftId, outlet: window.currentOutlet, itemName: tank, qty: qty, notes: notes, syncStatus: "Pending" };
    window.db.transaction(["lapor_masalah"], "readwrite").objectStore("lapor_masalah").add(payload); document.getElementById("lapor-modal").classList.add("hidden"); alert("Laporan Masalah (Bocor) berhasil dikirim. Menunggu validasi Admin."); window.runBackgroundSync();
}

window.openExpenseModal = function() {
    document.getElementById("expense-modal").classList.remove("hidden"); 
}
window.saveExpense = function() {
    const amount = Number(document.getElementById("exp-amount").value); const category = document.getElementById("exp-category").value.trim();
    if (amount <= 0 || !category) return alert("Harap masukkan jumlah dan kategori yang benar.");
    window.db.transaction(["expense_categories"], "readwrite").objectStore("expense_categories").put({ name: category });
    const payload = { expenseId: "EXP-" + Date.now(), timestamp: window.getWibDate(), cashier: window.currentCashier, shiftId: window.currentShiftId, category: category, description: document.getElementById("exp-desc").value || "-", amount: amount, status: "Active", outlet: window.currentOutlet, syncStatus: "Pending" };
    window.db.transaction(["expenses"], "readwrite").objectStore("expenses").add(payload);
    document.getElementById("expense-modal").classList.add("hidden"); document.getElementById("exp-amount").value = ""; document.getElementById("exp-category").value = ""; document.getElementById("exp-desc").value = ""; alert("Pengeluaran Berhasil Dicatat!"); window.runBackgroundSync();
}

window.openHistoryModal = function() { document.getElementById("history-modal").classList.remove("hidden"); window.renderHistoryList('orders'); }
window.renderHistoryList = function(type) {
    const container = document.getElementById("history-container"); container.innerHTML = "";
    if (type === 'orders') {
        window.db.transaction(["orders"], "readonly").objectStore("orders").getAll().onsuccess = (e) => {
            const shiftOrders = e.target.result.filter(o => o.outlet === window.currentOutlet).reverse().slice(0, 100); 
            if(shiftOrders.length === 0) return container.innerHTML = `<div style="padding:20px; text-align:center;">Belum ada order di cabang ini.</div>`;
            shiftOrders.forEach(o => {
                let badge = o.orderStatus === "Voided" ? `<span class="status-badge status-voided">Dibatalkan</span>` : o.orderStatus === "Void Pending" ? `<span class="status-badge status-pending">Menunggu Admin</span>` : `<span class="status-badge status-paid">${o.orderStatus}</span>`; 
                let piutangBadge = (o.debtAmount || 0) > 0 ? `<br><span style="font-size:12px; color:#c0392b; font-weight:bold;">⚠️ Piutang: Rp ${(o.debtAmount).toLocaleString('id-ID')}</span>` : '';
                let btnVoid = (o.orderStatus !== "Voided" && o.orderStatus !== "Void Pending") ? `<button onclick="window.requestVoid('orders', '${o.orderId}')" style="background:#e74c3c; color:white; border:none; padding:6px 12px; border-radius:4px; cursor:pointer; font-weight:bold;">Batal</button>` : '';
                let btnPrint = `<button onclick="window.reprintOrder('${o.orderId}')" style="background:#2980b9; color:white; border:none; padding:6px 12px; border-radius:4px; cursor:pointer; font-weight:bold;">🖨️ Cetak</button>`;
                let btnDetail = `<button onclick="window.showOrderDetail('${o.orderId}')" style="background:#f39c12; color:white; border:none; padding:6px 12px; border-radius:4px; cursor:pointer; font-weight:bold;">👁️ Detail</button>`;
                
                container.innerHTML += `<div class="history-row"><div><strong>${o.customerName}</strong><br><small style="color:#7f8c8d;">${window.formatDateReadable(o.timestamp)} | Rp ${o.grandTotal.toLocaleString('id-ID')}</small>${piutangBadge}</div><div style="display:flex; align-items:center; gap:8px;">${badge} ${btnDetail} ${btnPrint} ${btnVoid}</div></div>`;
            });
        };
    } else if (type === 'expenses') {
        window.db.transaction(["expenses"], "readonly").objectStore("expenses").getAll().onsuccess = (e) => {
            const shiftExpenses = e.target.result.filter(exp => exp.outlet === window.currentOutlet).reverse().slice(0, 100);
            if(shiftExpenses.length === 0) return container.innerHTML = `<div style="padding:20px; text-align:center;">Belum ada pengeluaran dicatat.</div>`;
            shiftExpenses.forEach(exp => {
                let badge = exp.status === "Voided" ? `<span class="status-badge status-voided">Dibatalkan</span>` : exp.status === "Void Pending" ? `<span class="status-badge status-pending">Menunggu Admin</span>` : `<span class="status-badge status-paid">Aktif</span>`;
                let btn = (exp.status !== "Voided" && exp.status !== "Void Pending") ? `<button onclick="window.requestVoid('expenses', '${exp.expenseId}')" style="background:#e74c3c; color:white; border:none; padding:5px 10px; border-radius:4px; cursor:pointer;">Batal/Void</button>` : '';
                container.innerHTML += `<div class="history-row"><div><strong>${exp.category}</strong><br><small style="color:#7f8c8d;">${window.formatDateReadable(exp.timestamp)} | Rp ${exp.amount.toLocaleString('id-ID')}</small><br><small>${exp.description}</small></div><div style="display:flex; align-items:center; gap:10px;">${badge} ${btn}</div></div>`;
            });
        };
    } else if (type === 'shifts') {
        window.db.transaction(["shift_reports"], "readonly").objectStore("shift_reports").getAll().onsuccess = (e) => {
            const shifts = e.target.result.filter(s => s.outlet === window.currentOutlet).reverse().slice(0, 50);
            if(shifts.length === 0) return container.innerHTML = `<div style="padding:20px; text-align:center;">Belum ada histori shift di cabang ini.</div>`;
            shifts.forEach(s => {
                let pGiven = (s.piutangGiven || 0) > 0 ? `<br><small style="color:#c0392b;">Piutang KLR: Rp ${(s.piutangGiven).toLocaleString('id-ID')}</small>` : '';
                let pPaid = (s.piutangPaid || 0) > 0 ? `<br><small style="color:#8e44ad;">Piutang MSK: Rp ${(s.piutangPaid).toLocaleString('id-ID')}</small>` : '';
                
                let viewBtn = `<button onclick="window.viewHistoricalShift('${s.shiftId}')" style="background:#2980b9; color:white; border:none; padding:6px 12px; border-radius:4px; cursor:pointer; font-weight:bold; margin-top:5px;">👁️ Detail Shift</button>`;
                
                container.innerHTML += `<div class="history-row" style="align-items:flex-start;"><div><strong>Shift: ${s.shiftId}</strong><br><small style="color:#7f8c8d;">Kasir: ${s.cashier} | Keluar: ${window.formatDateReadable(s.logoutTime)}</small>${pGiven}${pPaid}<br>${viewBtn}</div><div style="text-align:right;"><strong>Omset: Rp ${s.totalOmset.toLocaleString('id-ID')}</strong><br><small style="color:#27ae60;">Uang Laci: Rp ${s.netCash.toLocaleString('id-ID')}</small></div></div>`;
            });
        };
    }
}

window.viewHistoricalShift = function(shiftId) {
    window.db.transaction(["local_shift_history"], "readonly").objectStore("local_shift_history").get(shiftId).onsuccess = (e) => {
        const data = e.target.result;
        if(!data) return alert("Data shift tidak ditemukan di perangkat ini.");
        
        document.getElementById("sr-orders").innerText = data.totalOrders; document.getElementById("sr-customers").innerText = data.totalCustomers; document.getElementById("sr-omset").innerText = `Rp ${data.totalOmset.toLocaleString('id-ID')}`;
        document.getElementById("sr-cash").innerText = `Rp ${data.totalCash.toLocaleString('id-ID')}`; document.getElementById("sr-qris").innerText = `Rp ${data.totalQris.toLocaleString('id-ID')}`; document.getElementById("sr-transfer").innerText = `Rp ${data.totalTransfer.toLocaleString('id-ID')}`;
        document.getElementById("sr-free").innerText = `Rp ${data.totalFree.toLocaleString('id-ID')}`; document.getElementById("sr-expense").innerText = `Rp ${data.totalExpenses.toLocaleString('id-ID')}`;
        document.getElementById("sr-piutang-given").innerText = `Rp ${(data.piutangGiven||0).toLocaleString('id-ID')}`; document.getElementById("sr-piutang-paid").innerText = `Rp ${(data.piutangPaid||0).toLocaleString('id-ID')}`;
        document.getElementById("sr-net").innerText = `Rp ${data.netCash.toLocaleString('id-ID')}`; 
        
        let itemsHtml = ""; for (const [name, qty] of Object.entries(data.foodSummary||{})) { itemsHtml += `<div style="display:flex; justify-content:space-between; padding:3px 0;"><span>${name}</span><strong>${qty}</strong></div>`; }
        let itemsContainer = document.getElementById("sr-items-list"); if(itemsContainer) itemsContainer.innerHTML = itemsHtml || "Tidak ada data item.";
        
        let meterContainer = document.getElementById("meter-water-container"); if(meterContainer) meterContainer.classList.add("hidden");
        let btnEndShift = document.getElementById("btn-end-shift"); if(btnEndShift) btnEndShift.classList.add("hidden");
        
        let btnPrintHist = document.getElementById("btn-print-history");
        if (btnPrintHist) {
            btnPrintHist.classList.remove("hidden");
            btnPrintHist.onclick = async function() {
                const payloadBytes = await window.buildEscPosShiftReport(data);
                await window.printViaBluetooth(payloadBytes);
            };
        }
        document.getElementById("shift-report-modal").classList.remove("hidden");
    };
}

window.showOrderDetail = function(orderId) {
    window.db.transaction(["orders"], "readonly").objectStore("orders").get(orderId).onsuccess = (e) => {
        const o = e.target.result; if (!o) return alert("Detail tidak ditemukan.");
        let html = `<strong>Nota:</strong> ${o.orderId}<br><strong>Waktu:</strong> ${window.formatDateReadable(o.timestamp)}<br><strong>Pelanggan:</strong> ${o.customerName} (${o.customerPhone})<br><strong>Metode Bayar:</strong> ${o.paymentMethod}<br><hr style="border-top:1px dashed #ccc; margin:10px 0;">`;
        if (o.items && o.items.length > 0) { o.items.forEach(i => { html += `<div style="display:flex; justify-content:space-between;"><span>${i.qty}x ${i.name}</span><span>Rp ${(i.qty * i.originalPrice).toLocaleString('id-ID')}</span></div>`; });
        } else { html += `<div style="color:#7f8c8d; font-style:italic;">Detail item tidak tersedia. Subtotal: Rp ${o.subtotal.toLocaleString('id-ID')}</div>`; }
        html += `<hr style="border-top:1px dashed #ccc; margin:10px 0;"><div style="display:flex; justify-content:space-between;"><span><strong>Diskon / Gratis:</strong></span><span style="color:#27ae60;">-Rp ${(o.discounts || o.freeAmount || 0).toLocaleString('id-ID')}</span></div><div style="display:flex; justify-content:space-between; font-size:16px;"><span><strong>Total Akhir:</strong></span><span><strong>Rp ${o.grandTotal.toLocaleString('id-ID')}</strong></span></div>`;
        if ((o.debtAmount || 0) > 0) { html += `<div style="display:flex; justify-content:space-between; color:#c0392b; margin-top:5px;"><span><strong>Hutang:</strong></span><span><strong>Rp ${o.debtAmount.toLocaleString('id-ID')}</strong></span></div>`; }
        document.getElementById("order-detail-container").innerHTML = html; document.getElementById("order-detail-modal").classList.remove("hidden");
    };
}

window.reprintOrder = async function(orderId) {
    const order = await new Promise(res => window.db.transaction(["orders"], "readonly").objectStore("orders").get(orderId).onsuccess = e => res(e.target.result));
    if (!order) return alert("Order tidak ditemukan di memori tablet lokal.");
    const deposit = (order.cashAmount || 0) + (order.qrisAmount || 0) + (order.transferAmount || 0) + (order.freeAmount || 0);
    const payloadBytes = await window.buildEscPosReceipt(order.orderId, order, deposit, (order.debtAmount || 0), order.paymentMethod, {});
    await window.printViaBluetooth(payloadBytes);
}

window.requestVoid = function(type, id) { window.currentVoidTarget = { type, id }; document.getElementById("admin-void-pin").value = ""; document.getElementById("admin-void-modal").classList.remove("hidden"); }

window.submitRemoteVoid = function() {
    const type = window.currentVoidTarget.type; const id = window.currentVoidTarget.id; const storeName = type === 'orders' ? "orders" : "expenses";
    window.db.transaction([storeName], "readwrite").objectStore(storeName).get(id).onsuccess = (e) => {
        const item = e.target.result; if (type === 'orders') item.orderStatus = "Void Pending"; else item.status = "Void Pending";
        window.db.transaction([storeName], "readwrite").objectStore(storeName).put(item); window.renderHistoryList(type); 
    };
    window.db.transaction(["void_requests"], "readwrite").objectStore("void_requests").add({ id: id, type: type, status: "Void Pending", authName: "Menunggu" });
    document.getElementById("admin-void-modal").classList.add("hidden"); window.runBackgroundSync(); alert("Request Pembatalan dikirim ke Admin.");
}

window.confirmAdminVoid = async function() {
    const pinInput = document.getElementById("admin-void-pin").value.trim(); 
    if (!pinInput) return alert("Harap masukkan PIN Admin.");
    
    document.getElementById("btn-insta-void").disabled = true;
    
    try {
        const hashedPinInput = await window.hashPIN(pinInput);
        const settings = await window.getDynamicSettings(); const masterPinHashed = String(settings["Master_PIN"]).trim(); 
        const isMaster = (hashedPinInput === masterPinHashed);
        
        window.db.transaction(["staff"], "readonly").objectStore("staff").getAll().onsuccess = (e) => {
            const staffList = e.target.result;
            const staff = staffList.find(s => String(s.pin).trim() === hashedPinInput);
            const isAdmin = (staff && staff.role.toLowerCase() === 'admin');
            
            if (isMaster || isAdmin) {
                const authName = isMaster ? "Master Admin" : staff.name; const type = window.currentVoidTarget.type; const id = window.currentVoidTarget.id; const storeName = type === 'orders' ? "orders" : "expenses";
                window.db.transaction([storeName], "readwrite").objectStore(storeName).get(id).onsuccess = (ev) => {
                    const item = ev.target.result;
                    if (type === 'orders') { item.orderStatus = "Voided"; item.voidAuth = authName; if(item.items) item.items.forEach(i => i.qty = Number(i.qty)); window.applyVoidAftermath(item); } 
                    else { item.status = "Voided"; item.voidAuth = authName; }
                    item.syncStatus = "Pending"; window.db.transaction([storeName], "readwrite").objectStore(storeName).put(item); window.renderHistoryList(type);
                };
                window.db.transaction(["void_requests"], "readwrite").objectStore("void_requests").add({ id: id, type: type, status: "Voided", authName: authName });
                document.getElementById("admin-void-modal").classList.add("hidden"); window.runBackgroundSync(); alert("Transaksi langsung Dibatalkan oleh: " + authName);
            } else { alert("PIN Salah atau Anda tidak memiliki akses Admin."); }
        };
    } finally { document.getElementById("btn-insta-void").disabled = false; }
}

window.processServerUpdates = function(authStatuses) {
    const tx = window.db.transaction(["orders", "expenses"], "readwrite"); 
    const ordStore = tx.objectStore("orders"); const expStore = tx.objectStore("expenses"); 
    let uiNeedsRefresh = false;

    ordStore.getAll().onsuccess = (e) => {
        e.target.result.forEach(order => {
            const remote = authStatuses.orders[order.orderId];
            if (remote) {
                let changed = false;
                if (remote.status === "Voided" && order.orderStatus !== "Voided") { order.orderStatus = "Voided"; changed = true; window.applyVoidAftermath(order); } 
                else if (remote.status !== "Void Pending" && remote.status !== "Voided" && order.orderStatus === "Void Pending") { order.orderStatus = remote.status; changed = true; }
                
                if (remote.paymentMethod && order.paymentMethod !== remote.paymentMethod) { order.paymentMethod = remote.paymentMethod; changed = true; }
                if (remote.debtAmount !== undefined && order.debtAmount !== remote.debtAmount) { order.debtAmount = remote.debtAmount; changed = true; }
                
                if(changed) { ordStore.put(order); uiNeedsRefresh = true; }
            }
        });
        if (uiNeedsRefresh && !document.getElementById("history-modal").classList.contains("hidden")) window.renderHistoryList('orders');
    };
    expStore.getAll().onsuccess = (e) => {
        e.target.result.forEach(exp => {
            const remote = authStatuses.expenses[exp.expenseId];
            if (remote) {
                if (remote.status === "Voided" && exp.status !== "Voided") { exp.status = "Voided"; expStore.put(exp); uiNeedsRefresh = true; } 
                else if (remote.status !== "Void Pending" && remote.status !== "Voided" && exp.status === "Void Pending") { exp.status = remote.status; expStore.put(exp); uiNeedsRefresh = true; }
            }
        });
        if (uiNeedsRefresh && !document.getElementById("history-modal").classList.contains("hidden")) window.renderHistoryList('expenses');
    };
}

window.applyVoidAftermath = function(order) {
    const tx = window.db.transaction(["menu", "members"], "readwrite"); const menuStore = tx.objectStore("menu"); const memberStore = tx.objectStore("members");

    if (order.items) {
        order.items.forEach(item => {
            menuStore.openCursor().onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) { 
                    if (cursor.value.name === item.name && cursor.value.trackStock) { const updated = cursor.value; updated.currentStock += item.qty; cursor.update(updated); } 
                    cursor.continue(); 
                }
            };
        });
    }

    if (order.customerPhone && order.customerPhone !== "Walk-in" && order.customerPhone !== "-") {
        memberStore.get(order.customerPhone).onsuccess = (e) => { 
            const mem = e.target.result; 
            if (mem) { 
                mem.spent = Math.max(0, (mem.spent || 0) - order.grandTotal); 
                mem.bottlesBorrowed = Math.max(0, (mem.bottlesBorrowed || 0) - (order.rentBottleQty || 0));
                mem.piutang = Math.max(0, (mem.piutang || 0) - (order.debtAmount || 0));
                
                if (order.loyaltyChanges && mem.wallet) {
                    for(let itemName in order.loyaltyChanges) {
                        let c = order.loyaltyChanges[itemName];
                        if(!mem.wallet[itemName]) mem.wallet[itemName] = {points:0, free:0};
                        mem.wallet[itemName].points -= c.earned; mem.wallet[itemName].free += c.redeemed;
                        while (mem.wallet[itemName].points < 0 && mem.wallet[itemName].free > 0) { mem.wallet[itemName].points += c.threshold; mem.wallet[itemName].free -= 1; }
                        if(mem.wallet[itemName].free < 0) mem.wallet[itemName].free = 0; if(mem.wallet[itemName].points < 0) mem.wallet[itemName].points = 0;
                    }
                }
                memberStore.put(mem); 
            } 
        };
    }
    tx.oncomplete = () => { window.renderProductGrid(); };
    let payloadItems = []; if (order.items) order.items.forEach(i => payloadItems.push({name: i.name, qty: i.qty}));
    if (navigator.onLine) fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "executeVoidAftermath", data: { orderId: order.orderId, customerPhone: order.customerPhone, amount: order.grandTotal, itemsToReturn: payloadItems, rentBottleQty: order.rentBottleQty, debtAmount: order.debtAmount, loyaltyChanges: order.loyaltyChanges, cashAmount: order.cashAmount, outlet: order.outlet } }) });
}

window.calculateLiveDrawer = function(callback) {
    let liveDrawer = (window.outletStocks && window.outletStocks[window.currentOutlet] && window.outletStocks[window.currentOutlet]["Saldo_Laci"]) ? window.outletStocks[window.currentOutlet]["Saldo_Laci"] : 0; 
    
    let tx = window.db.transaction(["orders", "cash_drops", "expenses", "bayar_piutang"], "readonly");
    let ordersReq = tx.objectStore("orders").getAll(); let dropReq = tx.objectStore("cash_drops").getAll(); 
    let expReq = tx.objectStore("expenses").getAll(); let bpReq = tx.objectStore("bayar_piutang").getAll();
    
    tx.oncomplete = () => {
        ordersReq.result.forEach(o => { if (o.syncStatus === "Pending" && o.orderStatus !== "Voided" && o.orderStatus !== "Void Pending") liveDrawer += (o.cashAmount || 0); });
        dropReq.result.forEach(d => { if (d.syncStatus === "Pending") liveDrawer -= (d.toAdmin + d.toBank); });
        expReq.result.forEach(e => { if (e.syncStatus === "Pending" && e.status === "Active") liveDrawer -= (e.amount || 0); });
        bpReq.result.forEach(bp => { if (bp.syncStatus === "Pending") liveDrawer += (bp.cashAmount || 0); });
        callback(liveDrawer);
    };
}

window.openCashDrop = function(forLogout = false) {
    window.isLoggingOut = forLogout; document.getElementById("cash-drop-title").innerText = window.isLoggingOut ? "🔒 Tutup Shift & Setor Laci" : "🏦 Simpan / Tarik Uang Laci";
    document.getElementById("btn-drop-cancel").innerText = window.isLoggingOut ? "Batal Logout" : "Batal"; document.getElementById("btn-drop-confirm").innerText = window.isLoggingOut ? "Konfirmasi & Logout" : "Simpan Data";
    document.getElementById("drop-amount").value = ""; document.getElementById("drop-destination").value = "Admin"; document.getElementById("drop-notes").value = "";
    
    window.calculateLiveDrawer((liveAmount) => { document.getElementById("live-drawer-display").innerText = `Rp ${liveAmount.toLocaleString('id-ID')}`; document.getElementById("cash-drop-modal").classList.remove("hidden"); });
}

window.submitCashDrop = function() {
    const pullAmount = Number(document.getElementById("drop-amount").value) || 0;
    if (pullAmount < 0) return alert("⚠️ ERROR: Nominal uang tidak valid.");
    if (pullAmount === 0 && !window.isLoggingOut) return alert("⚠️ ERROR: Harap masukkan nominal uang yang diambil dari laci.");
    
    const destination = document.getElementById("drop-destination").value; const customNotes = document.getElementById("drop-notes").value || (window.isLoggingOut ? "Tutup Shift" : "Tarik Uang Tengah Shift");
    let adminAmt = 0; let bankAmt = 0; if (destination === "Bank") bankAmt = pullAmount; else adminAmt = pullAmount;
    const finalNotes = `[Ke ${destination}] ${customNotes}`;
    
    window.calculateLiveDrawer((liveAmount) => {
        const leftInDrawer = liveAmount - pullAmount;
        const payload = { dropId: "DRP-" + Date.now(), timestamp: window.getWibDate(), cashier: window.currentCashier, shiftId: window.currentShiftId, toAdmin: adminAmt, toBank: bankAmt, leftInDrawer: leftInDrawer, notes: finalNotes, outlet: window.currentOutlet, syncStatus: "Pending" };
        window.db.transaction(["cash_drops"], "readwrite").objectStore("cash_drops").add(payload);
        document.getElementById("cash-drop-modal").classList.add("hidden"); window.runBackgroundSync();
        if (window.isLoggingOut) { window.executeFinalLogout(leftInDrawer); } else { alert(`Setor Uang Berhasil!\nTujuan: ${destination}\nSisa Tunai di Laci: Rp ${leftInDrawer.toLocaleString('id-ID')}`); }
    });
}

window.openCurrentShiftReport = function() {
    let tCust = 0; let tOrders = 0; let tOmset = 0; let tCash = 0; let tQris = 0; let tTransfer = 0; let tFree = 0; let tExpense = 0; let tPiutangGiven = 0; let tPiutangPaidCash = 0; let foodSummary = {};
    document.getElementById("meter-water").value = "";
    
    let meterContainer = document.getElementById("meter-water-container"); if(meterContainer) meterContainer.classList.remove("hidden");
    let btnEndShift = document.getElementById("btn-end-shift"); if(btnEndShift) btnEndShift.classList.remove("hidden");
    let btnPrintHist = document.getElementById("btn-print-history"); if (btnPrintHist) btnPrintHist.classList.add("hidden");
    let itemsContainer = document.getElementById("sr-items-list"); if(itemsContainer) itemsContainer.innerHTML = "";
    
    window.db.transaction(["orders", "expenses", "bayar_piutang"], "readonly").objectStore("orders").getAll().onsuccess = (e) => {
        const validOrders = e.target.result.filter(o => o.shiftId === window.currentShiftId && o.orderStatus !== "Voided" && o.orderStatus !== "Void Pending");
        validOrders.forEach(o => {
            tOrders++; if(o.customerPhone && o.customerPhone !== "-") tCust++; tOmset += o.grandTotal;
            tCash += (o.cashAmount || 0); tQris += (o.qrisAmount || 0); tTransfer += (o.transferAmount || 0); tFree += (o.freeAmount || 0); 
            tPiutangGiven += (o.debtAmount || 0);
            if (o.items) o.items.forEach(i => { if(!foodSummary[i.name]) foodSummary[i.name] = 0; foodSummary[i.name] += i.qty; });
        });
        
        window.db.transaction(["expenses"], "readonly").objectStore("expenses").getAll().onsuccess = (ex) => {
            const shiftExpenses = ex.target.result.filter(exp => exp.shiftId === window.currentShiftId && exp.status === "Active"); shiftExpenses.forEach(exp => { tExpense += (exp.amount || 0); });
            
            window.db.transaction(["bayar_piutang"], "readonly").objectStore("bayar_piutang").getAll().onsuccess = (bpRes) => {
                const shiftPiutangs = bpRes.target.result.filter(bp => bp.shiftId === window.currentShiftId); shiftPiutangs.forEach(bp => { tPiutangPaidCash += (bp.cashAmount || 0); });
                
                window.calculateLiveDrawer((liveDrawer) => {
                    document.getElementById("sr-orders").innerText = tOrders; document.getElementById("sr-customers").innerText = tCust; document.getElementById("sr-omset").innerText = `Rp ${tOmset.toLocaleString('id-ID')}`;
                    document.getElementById("sr-cash").innerText = `Rp ${tCash.toLocaleString('id-ID')}`; document.getElementById("sr-qris").innerText = `Rp ${tQris.toLocaleString('id-ID')}`; document.getElementById("sr-transfer").innerText = `Rp ${tTransfer.toLocaleString('id-ID')}`;
                    document.getElementById("sr-free").innerText = `Rp ${tFree.toLocaleString('id-ID')}`; document.getElementById("sr-expense").innerText = `Rp ${tExpense.toLocaleString('id-ID')}`;
                    document.getElementById("sr-piutang-given").innerText = `Rp ${tPiutangGiven.toLocaleString('id-ID')}`; document.getElementById("sr-piutang-paid").innerText = `Rp ${tPiutangPaidCash.toLocaleString('id-ID')}`;
                    document.getElementById("sr-net").innerText = `Rp ${liveDrawer.toLocaleString('id-ID')}`; document.getElementById("shift-report-modal").classList.remove("hidden");
                    
                    window.currentShiftData = { shiftId: window.currentShiftId, loginTime: window.currentLoginTime, totalCustomers: tCust, totalOrders: tOrders, totalOmset: tOmset, totalCash: tCash, totalQris: tQris, totalTransfer: tTransfer, totalFree: tFree, totalExpenses: tExpense, netCash: liveDrawer, foodSummary: foodSummary, piutangGiven: tPiutangGiven, piutangPaid: tPiutangPaidCash, logoutTime: window.getWibDate() };
                });
            };
        };
    };
}
window.openShiftReport = window.openCurrentShiftReport; // Fallback alias

window.initiateLogoutSequence = function() { 
    const meterW = document.getElementById("meter-water").value;
    if (meterW === "") return alert("⚠️ ERROR: Wajib mengisi Angka Meteran Air sebelum mengakhiri Shift.");
    window.currentShiftData.meterWater = Number(meterW);
    document.getElementById("shift-report-modal").classList.add("hidden"); window.openCashDrop(true); 
}

window.executeFinalLogout = async function(netCash) { 
    const data = window.currentShiftData;
    const shiftPayload = {
        shiftId: window.currentShiftId, timestamp: window.getWibDate(), cashier: window.currentCashier, loginTime: window.currentLoginTime, logoutTime: window.getWibDate(), 
        totalCustomers: data.totalCustomers, totalOrders: data.totalOrders, totalOmset: data.totalOmset, totalCash: data.totalCash, totalQris: data.totalQris, totalTransfer: data.totalTransfer, totalFree: data.totalFree,
        totalExpenses: data.totalExpenses, netCash: netCash, foodSummary: data.foodSummary, meterWater: data.meterWater, outlet: window.currentOutlet, syncStatus: "Pending", piutangGiven: data.piutangGiven, piutangPaid: data.piutangPaid
    };

    window.db.transaction(["local_shift_history"], "readwrite").objectStore("local_shift_history").add(shiftPayload);
    window.db.transaction(["shift_reports"], "readwrite").objectStore("shift_reports").add(shiftPayload);
    window.db.transaction(["active_shifts"], "readwrite").objectStore("active_shifts").delete(window.currentPin); 
    
    if (navigator.onLine) {
        if(document.getElementById("network-text")) document.getElementById("network-text").innerText = `Mengirim Laporan Shift...`;
        try {
            let r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "syncShiftReport", data: shiftPayload }) });
            if ((await r.json()).status === "Success") { window.db.transaction(["shift_reports"], "readwrite").objectStore("shift_reports").delete(shiftPayload.shiftId); }
        } catch(e) {}
    }
    window.location.reload(); 
}

window.lockScreen = function() { window.location.reload(); }

window.runBackgroundSync = async function() {
    if (!navigator.onLine || window.isSyncing) return;
    window.isSyncing = true; 
    try {
        if (!window.db) { await window.initDB(); }
        await window.checkAutoCloseShifts();
        
        let tx = window.db.transaction(["orders", "cash_drops", "shift_reports", "expenses", "void_requests", "unsynced_members", "stock_inbound", "cuci_tandon", "lapor_masalah", "bayar_piutang"], "readonly");
        
        let orders = await new Promise(res => tx.objectStore("orders").getAll().onsuccess = e => res(e.target.result));
        for (const order of orders) {
            if (order.syncStatus === "Pending") {
                order.syncStatus = "Syncing"; window.db.transaction(["orders"], "readwrite").objectStore("orders").put(order);
                try { let r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "syncOrder", data: order }) }); if ((await r.json()).status === "Success") { order.syncStatus = "Synced"; window.db.transaction(["orders"], "readwrite").objectStore("orders").put(order); } else { order.syncStatus = "Pending"; window.db.transaction(["orders"], "readwrite").objectStore("orders").put(order); } } catch(e) { order.syncStatus = "Pending"; window.db.transaction(["orders"], "readwrite").objectStore("orders").put(order); }
            }
        }

        let piutangs = await new Promise(res => tx.objectStore("bayar_piutang").getAll().onsuccess = e => res(e.target.result));
        for (const bp of piutangs) {
            if (bp.syncStatus === "Pending") { try { let r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "syncBayarPiutang", data: bp }) }); if ((await r.json()).status === "Success") { window.db.transaction(["bayar_piutang"], "readwrite").objectStore("bayar_piutang").delete(bp.payId); } } catch(e) {} }
        }
        
        let drops = await new Promise(res => tx.objectStore("cash_drops").getAll().onsuccess = e => res(e.target.result));
        for (const drop of drops) {
            if (drop.syncStatus === "Pending") { try { let r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "syncCashDrop", data: drop }) }); if ((await r.json()).status === "Success") { drop.syncStatus = "Synced"; window.db.transaction(["cash_drops"], "readwrite").objectStore("cash_drops").put(drop); } } catch(e) {} }
        }
        
        let reports = await new Promise(res => tx.objectStore("shift_reports").getAll().onsuccess = e => res(e.target.result));
        for (const report of reports) {
            if (report.syncStatus === "Pending") { try { let r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "syncShiftReport", data: report }) }); if ((await r.json()).status === "Success") { window.db.transaction(["shift_reports"], "readwrite").objectStore("shift_reports").delete(report.shiftId); } } catch(e) {} }
        }

        let expenses = await new Promise(res => tx.objectStore("expenses").getAll().onsuccess = e => res(e.target.result));
        for (const exp of expenses) {
            if (exp.syncStatus === "Pending") { try { let r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "syncExpense", data: exp }) }); if ((await r.json()).status === "Success") { exp.syncStatus = "Synced"; window.db.transaction(["expenses"], "readwrite").objectStore("expenses").put(exp); } } catch(e) {} }
        }

        let voids = await new Promise(res => tx.objectStore("void_requests").getAll().onsuccess = e => res(e.target.result));
        for (const req of voids) {
            try {
                const actionType = req.type === 'orders' ? "requestOrderVoid" : "requestExpenseVoid"; const payload = req.type === 'orders' ? { orderId: req.id, status: req.status, authName: req.authName } : { expenseId: req.id, status: req.status, authName: req.authName };
                let r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action: actionType, ...payload }) }); if ((await r.json()).status === "Success") { window.db.transaction(["void_requests"], "readwrite").objectStore("void_requests").delete(req.id); }
            } catch(e) {}
        }

        let members = await new Promise(res => tx.objectStore("unsynced_members").getAll().onsuccess = e => res(e.target.result));
        for (const mem of members) {
            try { let r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "syncMember", data: mem }) }); if ((await r.json()).status === "Success") { window.db.transaction(["unsynced_members"], "readwrite").objectStore("unsynced_members").delete(mem.phone); } } catch(e) {}
        }

        let inbounds = await new Promise(res => tx.objectStore("stock_inbound").getAll().onsuccess = e => res(e.target.result));
        for (const inb of inbounds) {
            if (inb.syncStatus === "Pending") { try { let r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "syncInbound", data: inb }) }); if ((await r.json()).status === "Success") { window.db.transaction(["stock_inbound"], "readwrite").objectStore("stock_inbound").delete(inb.logId); } } catch(e) {} }
        }

        let cuciLogs = await new Promise(res => tx.objectStore("cuci_tandon").getAll().onsuccess = e => res(e.target.result));
        for (const log of cuciLogs) {
            if (log.syncStatus === "Pending") { try { let r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "syncCuciTandon", data: log }) }); if ((await r.json()).status === "Success") { window.db.transaction(["cuci_tandon"], "readwrite").objectStore("cuci_tandon").delete(log.logId); } } catch(e) {} }
        }

        let laporLogs = await new Promise(res => tx.objectStore("lapor_masalah").getAll().onsuccess = e => res(e.target.result));
        for (const log of laporLogs) {
            if (log.syncStatus === "Pending") { try { let r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "syncLaporMasalah", data: log }) }); if ((await r.json()).status === "Success") { window.db.transaction(["lapor_masalah"], "readwrite").objectStore("lapor_masalah").delete(log.logId); } } catch(e) {} }
        }

    } catch (e) {
        if (e.name === 'InvalidStateError') { await window.initDB(); }
    } finally { window.isSyncing = false; }
}

window.onload = async () => { 
    document.getElementById("cust-phone").addEventListener("input", window.handleAutocomplete);
    document.getElementById("cust-name").addEventListener("input", window.handleAutocomplete);
    document.getElementById("cust-phone").addEventListener("click", window.handleAutocomplete);
    document.getElementById("cust-name").addEventListener("click", window.handleAutocomplete);
    document.getElementById("cust-phone").addEventListener("focus", window.handleAutocomplete);
    document.getElementById("cust-name").addEventListener("focus", window.handleAutocomplete);

    document.addEventListener('click', (e) => { 
        if(!e.target.closest('.autocomplete-wrapper') && e.target.id !== 'cust-phone' && e.target.id !== 'cust-name') { 
            const resBox = document.getElementById('autocomplete-results');
            if(resBox) resBox.classList.add('hidden'); 
        } 
        if(e.target.id !== 'exp-category') {
            const catBox = document.getElementById('cat-autocomplete-results');
            if(catBox) catBox.classList.add('hidden');
        }
    });

    await window.initDB(); 
    await window.checkAutoCloseShifts(); 
    await window.syncMasterData(); 
    window.setInterval(window.runBackgroundSync, 15000); 
    window.setInterval(window.checkAutoCloseShifts, 3600000); 
};
