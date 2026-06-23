const API_URL = "https://script.google.com/macros/s/AKfycbz797WvLnGIpjpVwdhgoy5YbSJtklutmIXlqjhvZx6LU0fVDTImgJ341NIqB7Y58kp2/exec"; 
const DB_NAME = "PureWater_POS";
const DB_VERSION = 11; 
let db;

let posSessions = [{ cart: [], customer: null }, { cart: [], customer: null }, { cart: [], customer: null }];
let activeSessionIndex = 0; let currentCart = posSessions[0].cart; let activeCustomerProfile = posSessions[0].customer;
window.piutangTargetMember = null;

let currentCashier = ""; let currentPin = ""; let currentShiftId = ""; let currentLoginTime = ""; let currentOutlet = "";
let globalMenuData = []; let currentCategory = ""; 
window.outletStocks = {}; let isLoggingOut = false; let currentVoidTarget = { type: null, id: null };
let isMenuLocked = true; let isSyncing = false; window.loyaltyEnabled = false; 
let deferredPrompt;

let bluetoothDevice = null;
let printerCharacteristic = null;

async function hashPIN(pin) {
    const msgUint8 = new TextEncoder().encode(pin);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function getWibDate() {
    const d = new Date(); const utc = d.getTime() + (d.getTimezoneOffset() * 60000); const nd = new Date(utc + (3600000 * 7)); 
    const pad = n => n < 10 ? '0' + n : n;
    return `${nd.getFullYear()}-${pad(nd.getMonth()+1)}-${pad(nd.getDate())}T${pad(nd.getHours())}:${pad(nd.getMinutes())}:${pad(nd.getSeconds())}+07:00`;
}

window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); deferredPrompt = e;
    const installBtn = document.getElementById('btn-install'); const installBtnLogin = document.getElementById('btn-install-login');
    if(installBtn) installBtn.classList.remove('hidden'); if(installBtnLogin) installBtnLogin.classList.remove('hidden');
});

function installPWA() {
    if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then((choiceResult) => {
            if (choiceResult.outcome === 'accepted') {
                const installBtn = document.getElementById('btn-install'); const installBtnLogin = document.getElementById('btn-install-login');
                if(installBtn) installBtn.classList.add('hidden'); if(installBtnLogin) installBtnLogin.classList.add('hidden');
            }
            deferredPrompt = null;
        });
    }
}

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (event) => {
            db = event.target.result;
            if (!db.objectStoreNames.contains("staff")) db.createObjectStore("staff", { keyPath: "pin" });
            if (!db.objectStoreNames.contains("menu")) db.createObjectStore("menu", { keyPath: "itemId" });
            if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
            if (!db.objectStoreNames.contains("orders")) db.createObjectStore("orders", { keyPath: "orderId" });
            if (!db.objectStoreNames.contains("active_shifts")) db.createObjectStore("active_shifts", { keyPath: "pin" }); 
            if (!db.objectStoreNames.contains("cash_drops")) db.createObjectStore("cash_drops", { keyPath: "dropId" }); 
            if (!db.objectStoreNames.contains("shift_reports")) db.createObjectStore("shift_reports", { keyPath: "shiftId" }); 
            if (!db.objectStoreNames.contains("expenses")) db.createObjectStore("expenses", { keyPath: "expenseId" });
            if (!db.objectStoreNames.contains("members")) db.createObjectStore("members", { keyPath: "phone" });
            if (!db.objectStoreNames.contains("unsynced_members")) db.createObjectStore("unsynced_members", { keyPath: "phone" });
            if (!db.objectStoreNames.contains("expense_categories")) db.createObjectStore("expense_categories", { keyPath: "name" });
            if (!db.objectStoreNames.contains("void_requests")) db.createObjectStore("void_requests", { keyPath: "id" });
            if (!db.objectStoreNames.contains("local_shift_history")) db.createObjectStore("local_shift_history", { keyPath: "shiftId" });
            if (!db.objectStoreNames.contains("stock_inbound")) db.createObjectStore("stock_inbound", { keyPath: "logId" });
            if (!db.objectStoreNames.contains("cuci_tandon")) db.createObjectStore("cuci_tandon", { keyPath: "logId" });
            if (!db.objectStoreNames.contains("lapor_masalah")) db.createObjectStore("lapor_masalah", { keyPath: "logId" });
            if (!db.objectStoreNames.contains("bayar_piutang")) db.createObjectStore("bayar_piutang", { keyPath: "payId" });
        };
        request.onsuccess = (e) => { db = e.target.result; resolve(db); };
        request.onerror = (e) => reject(e);
    });
}

async function getStaffFromDB() {
    return new Promise(resolve => { db.transaction(["staff"], "readonly").objectStore("staff").getAll().onsuccess = e => resolve(e.target.result); });
}

async function checkAutoCloseShifts() {
    if (!db) return;
    const shifts = await new Promise(res => db.transaction(["active_shifts"], "readonly").objectStore("active_shifts").getAll().onsuccess = e => res(e.target.result));
    const now = Date.now();
    for (let shift of shifts) {
        const loginTime = new Date(shift.loginTime).getTime();
        if (now - loginTime > 12 * 60 * 60 * 1000) { await forceCloseShift(shift); }
    }
}

async function forceCloseShift(shift) {
    let tCust = 0, tOrders = 0, tOmset = 0, tCash = 0, tQris = 0, tTransfer = 0, tFree = 0, tExpense = 0, tPiutangGiven = 0, tPiutangPaidCash = 0;
    let foodSummary = {};
    
    const tx = db.transaction(["orders", "expenses", "bayar_piutang"], "readonly");
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
        shiftId: shift.shiftId, timestamp: getWibDate(), cashier: "SYSTEM (Auto-Close)", loginTime: shift.loginTime, logoutTime: getWibDate(), 
        totalCustomers: tCust, totalOrders: tOrders, totalOmset: tOmset, totalCash: tCash, totalQris: tQris, totalTransfer: tTransfer, totalFree: tFree,
        totalExpenses: tExpense, netCash: liveDrawer, foodSummary: foodSummary, meterWater: 0, outlet: shift.outlet, syncStatus: "Pending",
        piutangGiven: tPiutangGiven, piutangPaid: tPiutangPaidCash, autoClosed: true
    };

    const txWrite = db.transaction(["local_shift_history", "shift_reports", "active_shifts"], "readwrite");
    txWrite.objectStore("local_shift_history").add(shiftPayload);
    txWrite.objectStore("shift_reports").add(shiftPayload);
    txWrite.objectStore("active_shifts").delete(shift.pin);
}

async function attemptLogin() {
    const pinInput = document.getElementById("cashier-pin").value.trim();
    if (!pinInput) return alert("Masukkan PIN!");
    if (!db) return alert("Database sedang memuat, harap tunggu...");

    const loginBtn = document.getElementById("login-btn");
    loginBtn.disabled = true; loginBtn.innerText = "Memverifikasi...";

    try {
        const hashedPinInput = await hashPIN(pinInput);
        let staffList = await getStaffFromDB();
        let staff = staffList.find(s => s.pin === hashedPinInput);

        if (!staff) {
            loginBtn.innerText = "Sinkronisasi...";
            await syncMasterData();
            staffList = await getStaffFromDB();
            staff = staffList.find(s => s.pin === hashedPinInput);
        }

        if (staff) {
            db.transaction(["active_shifts"], "readonly").objectStore("active_shifts").get(staff.pin).onsuccess = async (shiftReq) => {
                const activeShift = shiftReq.target.result;
                currentCashier = staff.name; currentPin = staff.pin; 
                
                const dropdownSelection = document.getElementById("login-outlet").value;
                if (dropdownSelection === "AUTO") { currentOutlet = staff.defaultOutlet || document.getElementById("login-outlet").options[1].value; } 
                else { currentOutlet = dropdownSelection; }

                if (activeShift) { 
                    currentShiftId = activeShift.shiftId; currentLoginTime = activeShift.loginTime; currentOutlet = activeShift.outlet || currentOutlet; 
                } else {
                    currentShiftId = "SHF-" + Date.now(); currentLoginTime = getWibDate();
                    db.transaction(["active_shifts"], "readwrite").objectStore("active_shifts").put({ pin: staff.pin, shiftId: currentShiftId, loginTime: currentLoginTime, outlet: currentOutlet });
                }
                document.getElementById("login-screen").classList.add("hidden"); document.getElementById("pos-screen").classList.remove("hidden");
                document.getElementById("display-cashier").innerText = currentCashier; document.getElementById("display-outlet").innerText = currentOutlet;
                
                await checkAutoCloseShifts();
                if (navigator.onLine) { syncMasterData(); }
                lockMenu(); 
            };
        } else { alert("PIN Salah atau Data Kasir Tidak Ditemukan."); }
    } catch (err) { console.error("Login Error:", err); alert("Terjadi kesalahan sistem saat login.");
    } finally { loginBtn.disabled = false; loginBtn.innerText = "Masuk / Buka Shift"; }
}

async function connectBluetoothPrinter() {
    try {
        bluetoothDevice = await navigator.bluetooth.requestDevice({ filters: [{ services: [0x18F0] }], optionalServices: [0x18F0] });
        const server = await bluetoothDevice.gatt.connect(); const service = await server.getPrimaryService(0x18F0);
        printerCharacteristic = await service.getCharacteristic(0x2AF1);
        
        alert("Printer Thermal Berhasil Terhubung!");
        document.getElementById("btn-connect-printer").innerText = "🖨️ Printer Aktif"; document.getElementById("btn-connect-printer").style.background = "#27ae60"; document.getElementById("btn-connect-printer").style.borderColor = "#27ae60";
        
        bluetoothDevice.addEventListener('gattserverdisconnected', () => {
            alert("Koneksi Printer Terputus!");
            document.getElementById("btn-connect-printer").innerText = "🖨️ Konek Printer"; document.getElementById("btn-connect-printer").style.background = "#f39c12"; document.getElementById("btn-connect-printer").style.borderColor = "#f39c12";
            printerCharacteristic = null;
        });
    } catch (error) { console.error(error); alert("Gagal koneksi printer: " + error.message); }
}

async function printViaBluetooth(payloadUint8Array) {
    if (!printerCharacteristic) { alert("Printer belum terhubung! Silakan hubungkan dulu dengan tombol 'Konek Printer'."); return false; }
    try {
        const CHUNK_SIZE = 20; 
        for (let i = 0; i < payloadUint8Array.length; i += CHUNK_SIZE) {
            const chunk = payloadUint8Array.slice(i, i + CHUNK_SIZE);
            await printerCharacteristic.writeValue(chunk);
            await new Promise(r => setTimeout(r, 10)); 
        }
        return true;
    } catch (error) { console.error("Print Error:", error); alert("Print Gagal: " + error.message); return false; }
}

async function syncMasterData() {
    if (!navigator.onLine) {
        if(document.getElementById("network-text")) document.getElementById("network-text").innerText = "Mode Offline";
        if(document.getElementById("network-dot")) document.getElementById("network-dot").style.backgroundColor = "#e74c3c"; return;
    }
    
    try {
        if (!db) { await initDB(); }

        if(document.getElementById("network-text")) document.getElementById("network-text").innerText = "Sinkron PIN (Cepat)...";
        if(document.getElementById("network-dot")) document.getElementById("network-dot").style.backgroundColor = "#f39c12";

        const authResponse = await fetch(API_URL + "?type=auth_only", { mode: 'cors', redirect: 'follow' });
        const authContentType = authResponse.headers.get("content-type");
        if (authContentType && authContentType.includes("text/html")) throw new Error("Akses Ditolak Google pada Phase 1.");
        
        const authResult = await authResponse.json();
        if (authResult.status === "Success") {
            const tx = db.transaction(["staff", "settings"], "readwrite");
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
            const tx2 = db.transaction(["menu", "members", "expense_categories"], "readwrite");
            
            const menuStore = tx2.objectStore("menu"); menuStore.clear(); fullResult.data.menu.forEach(m => menuStore.put(m));
            const memStore = tx2.objectStore("members"); memStore.clear(); fullResult.data.members.forEach(m => memStore.put(m));
            const expCatStore = tx2.objectStore("expense_categories"); expCatStore.clear(); 
            if(fullResult.data.expenseCategories) fullResult.data.expenseCategories.forEach(c => expCatStore.put({name: c}));
            
            if (fullResult.data.authStatuses) processVoidApprovals(fullResult.data.authStatuses);
            globalMenuData = fullResult.data.menu; window.loyaltyEnabled = String(fullResult.data.settings["Enable_Loyalty"]).toUpperCase() === "TRUE";

            if(document.getElementById("network-text")) document.getElementById("network-text").innerText = "Online & Sinkron";
            if(document.getElementById("network-dot")) document.getElementById("network-dot").style.backgroundColor = "#2ecc71";
            if (!document.getElementById("pos-screen").classList.contains("hidden")) { loadMenuUI(); }
        }

    } catch (e) { 
        console.error("Sync Error:", e);
        if(document.getElementById("network-text")) document.getElementById("network-text").innerText = "Gagal Sinkron"; 
        if(document.getElementById("network-dot")) document.getElementById("network-dot").style.backgroundColor = "#e74c3c";
        if (e.name === 'InvalidStateError' || e.message.includes("closing")) { await initDB(); }
    }
}

function handleAutocomplete(e) {
    if (!db) return; 
    const val = e.target.value.toLowerCase().trim(); 
    const resBox = document.getElementById("autocomplete-results");

    db.transaction(["members"], "readonly").objectStore("members").getAll().onsuccess = (ev) => {
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
                let rOut = String(m.recentOutlets || "").replace(/'/g, "\\'").replace(/"/g, '&quot;');
                let safePhone = String(m.phone || "").replace(/'/g, "\\'").replace(/"/g, '&quot;');

                return `<div class="autocomplete-item" onclick="selectMember('${safePhone}', '${nameStr}', '${wStr}', ${m.bottlesBorrowed || 0}, ${m.piutang || 0}, '${fOut}', '${rOut}')">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <div class="autocomplete-name">${m.name}</div><div class="autocomplete-phone" style="font-size:14px; color:#7f8c8d;">${m.phone}</div>
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

// ⚡ NEW EXPENSE DROPDOWN ENGINE ⚡
window.handleCategoryAutocomplete = function() {
    if (!db) return;
    const val = document.getElementById("exp-category").value.toLowerCase().trim(); 
    const resBox = document.getElementById("cat-autocomplete-results");
    
    db.transaction(["expense_categories"], "readonly").objectStore("expense_categories").getAll().onsuccess = (ev) => {
        let categories = ev.target.result.map(c => c.name);
        
        if (categories.length === 0) {
            categories = ["Operasional", "Bahan Baku", "Gaji Kasir", "Listrik & Air", "Transportasi", "Lain-lain"];
        }

        let matches = categories;
        if (val.length > 0) { matches = categories.filter(c => c.toLowerCase().includes(val)); }

        if (matches.length > 0) {
            resBox.innerHTML = matches.map(c => {
                let safeName = c.replace(/'/g, "\\'").replace(/"/g, '&quot;');
                return `<div class="autocomplete-item" onclick="selectCategory('${safeName}')">
                    <div style="font-size:16px; font-weight:bold; color:#2c3e50;">${c}</div>
                </div>`;
            }).join("");
            resBox.classList.remove("hidden");
        } else { 
            resBox.classList.add("hidden"); 
        }
    };
};

window.selectCategory = function(name) {
    document.getElementById("exp-category").value = name;
    document.getElementById("cat-autocomplete-results").classList.add("hidden");
};

window.selectMember = function(phone, name, walletStr, dbBottlesBorrowed, dbPiutang, firstOutlet, recentOutlets) {
    document.getElementById("autocomplete-results").classList.add("hidden");
    let lockedQueue = isCustomerLocked(phone);
    if (lockedQueue) { return alert(`⚠️ PELANGGAN TERKUNCI:\nPelanggan ini sedang diproses di Antrean ${lockedQueue}. Selesaikan pesanan di sana terlebih dahulu.`); }

    document.getElementById("cust-phone").value = phone; document.getElementById("cust-name").value = name; 
    let wallet = {}; try { wallet = JSON.parse(walletStr.replace(/&quot;/g, '"')); } catch(e) {}
    activeCustomerProfile = { phone: phone, name: name, wallet: wallet, bottlesBorrowed: dbBottlesBorrowed, piutang: dbPiutang, firstOutlet: firstOutlet, recentOutlets: recentOutlets };
    updatePromoBanner(activeCustomerProfile);
};

function saveMemberToDB(phone, name, wallet, bottles, piutang, fOut, rOut) {
    if(!phone || phone === "-") return; 
    db.transaction(["members"], "readonly").objectStore("members").get(phone).onsuccess = (e) => {
        let mem = e.target.result || { phone: phone, name: name, wallet: {}, spent: 0, bottlesBorrowed: 0, piutang: 0, firstOutlet: fOut || currentOutlet, recentOutlets: rOut || currentOutlet }; 
        mem.name = name; if(wallet !== undefined) mem.wallet = wallet; if(bottles !== undefined) mem.bottlesBorrowed = bottles; if(piutang !== undefined) mem.piutang = piutang;
        if(fOut !== undefined) mem.firstOutlet = fOut; if(rOut !== undefined) mem.recentOutlets = rOut;
        db.transaction(["members"], "readwrite").objectStore("members").put(mem);
        db.transaction(["unsynced_members"], "readwrite").objectStore("unsynced_members").put(mem);
    };
}

function loadMenuUI() {
    const visibleItems = globalMenuData.filter(i => !i.hideOnPos); const categories = [...new Set(visibleItems.map(i => i.category))]; 
    if(categories.length > 0) currentCategory = categories[0];
    const catContainer = document.getElementById("category-container"); catContainer.innerHTML = "";
    categories.forEach(cat => {
        const btn = document.createElement("button"); btn.className = `cat-btn ${cat === currentCategory ? "active" : ""}`; btn.innerText = cat;
        btn.onclick = () => { currentCategory = cat; document.querySelectorAll(".cat-btn").forEach(b => b.classList.remove("active")); btn.classList.add("active"); renderProductGrid(); };
        catContainer.appendChild(btn);
    }); renderProductGrid();
}

function renderProductGrid() {
    const grid = document.getElementById("product-grid"); grid.innerHTML = "";
    const filteredMenu = globalMenuData.filter(i => {
        if (i.hideOnPos) return false; if (i.category !== currentCategory) return false;
        const availableList = (i.availableAt || "ALL").toUpperCase(); if (availableList === "ALL" || availableList === "") return true;
        return availableList.includes(currentOutlet.toUpperCase());
    });
    filteredMenu.forEach(item => {
        const card = document.createElement("div"); card.className = "product-card";
        card.innerHTML = `<div><h4 style="margin-top:0;">${item.name}</h4></div> <div class="price-badge">Rp ${item.price.toLocaleString('id-ID')}</div>`;
        card.onclick = () => { if(isMenuLocked) return; addToCart(item, 1); }; grid.appendChild(card);
    });
}

function addToCart(item, qty) {
    const existing = currentCart.find(i => i.itemId === item.itemId);
    if (existing) { existing.qty += qty; } else { currentCart.push({ ...item, qty: qty, originalPrice: item.price, autoDeduct: item.autoDeduct, loyaltyThreshold: item.loyaltyThreshold, redeemed: 0 }); }
    renderCart();
}

window.updateCartQty = function(itemId, delta) {
    const item = currentCart.find(i => i.itemId === itemId);
    if (item) { item.qty += delta; if (item.qty <= 0) { currentCart = currentCart.filter(i => i.itemId !== itemId); posSessions[activeSessionIndex].cart = currentCart; } renderCart(); }
}

function renderCart() {
    const container = document.getElementById("cart-items"); container.innerHTML = ""; let total = 0;
    currentCart.forEach(item => {
        const lineTotal = item.qty * item.price; total += lineTotal;
        container.innerHTML += `
        <div class="cart-item" style="display:flex; justify-content:space-between; align-items:center; padding:12px 0; border-bottom:1px dashed #ccc;">
            <div style="flex:1; font-weight:bold; font-size:14px;">${item.name}</div>
            <div style="display:flex; align-items:center; gap:8px; margin: 0 10px;">
                <button onclick="updateCartQty('${item.itemId}', -1)" style="width:30px; height:30px; background:#e74c3c; color:white; border:none; border-radius:6px; font-weight:bold; font-size:16px; cursor:pointer;">-</button>
                <span style="font-weight:bold; min-width:25px; text-align:center;">${item.qty}</span>
                <button onclick="updateCartQty('${item.itemId}', 1)" style="width:30px; height:30px; background:#2ecc71; color:white; border:none; border-radius:6px; font-weight:bold; font-size:16px; cursor:pointer;">+</button>
            </div>
            <div style="font-weight:bold; color:#2c3e50; min-width:80px; text-align:right;">Rp ${lineTotal.toLocaleString('id-ID')}</div>
        </div>`;
    });
    document.getElementById("cart-total").innerText = `Rp ${total.toLocaleString('id-ID')}`; window.cartSubtotal = total; window.cartGrandTotal = total; 
    
    posSessions.forEach((session, i) => {
        let qty = session.cart.reduce((sum, item) => sum + item.qty, 0); let btn = document.getElementById(`tab-btn-${i}`);
        if (qty > 0) { btn.innerHTML = `🛒 Antrean ${i+1} <span style="background:#e74c3c; color:white; border-radius:12px; padding:2px 6px; font-size:11px; margin-left:5px;">${qty}</span>`; } 
        else { btn.innerHTML = `🛒 Antrean ${i+1}`; }
    });
}

function clearCart() { lockMenu(); }

function reviewOrder() {
    if (currentCart.length === 0) return alert("Keranjang masih kosong!");
    window.cartGrandTotal = window.cartSubtotal;
    const redeemContainer = document.getElementById("redemption-items"); redeemContainer.innerHTML = ""; let hasRedeemable = false;

    if (window.loyaltyEnabled && activeCustomerProfile) {
        let wallet = activeCustomerProfile.wallet || {};
        currentCart.forEach(item => {
            if (item.loyaltyThreshold > 0 && wallet[item.name] && wallet[item.name].free > 0) {
                let maxRedeemable = Math.min(wallet[item.name].free, item.qty);
                if (maxRedeemable > 0) {
                    hasRedeemable = true;
                    redeemContainer.innerHTML += `
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; padding-bottom:8px; border-bottom:1px dashed #bce8f1;">
                            <span style="font-size:14px; font-weight:bold; color:#2c3e50;">${item.name} <br><small style="font-weight:normal; color:#7f8c8d;">(Tersedia: ${wallet[item.name].free}, Dibeli: ${item.qty})</small></span>
                            <div style="display:flex; align-items:center; gap:8px;"><label style="font-size:12px;">Pakai:</label><input type="number" class="redeem-input" data-item="${item.itemId}" data-price="${item.price}" max="${maxRedeemable}" min="0" value="0" style="width:60px; padding:8px; text-align:center; font-size:16px; border:2px solid #bdc3c7; border-radius:6px;" onclick="this.select()" oninput="recalcRedemptions()"></div>
                        </div>`;
                }
            }
        });
    }

    if (hasRedeemable) { document.getElementById("redemption-section").classList.remove("hidden"); } else { document.getElementById("redemption-section").classList.add("hidden"); }

    document.getElementById("pay-qris").value = 0; document.getElementById("pay-transfer").value = 0; document.getElementById("pay-free").value = 0; document.getElementById("pay-piutang").value = 0;
    let bottleRentBox = document.getElementById("rent-bottle-qty"); if(bottleRentBox) bottleRentBox.value = 0;
    
    document.getElementById("review-subtotal").innerText = `Rp ${window.cartSubtotal.toLocaleString('id-ID')}`; document.getElementById("review-grandtotal").innerText = `Rp ${window.cartGrandTotal.toLocaleString('id-ID')}`;
    document.getElementById("pay-cash").value = window.cartGrandTotal; calculateRemaining(); document.getElementById("review-modal").classList.remove("hidden");
}

window.recalcRedemptions = function() {
    let totalDiscount = 0;
    document.querySelectorAll(".redeem-input").forEach(input => {
        let qty = Number(input.value) || 0; let max = Number(input.getAttribute("max"));
        if(qty > max) { qty = max; input.value = max; } if(qty < 0) { qty = 0; input.value = 0; }
        let price = Number(input.getAttribute("data-price")); totalDiscount += (qty * price);
    });
    document.getElementById("pay-free").value = totalDiscount; autoBalanceCash();
}

window.autoBalancePiutang = function() {
    const c = Number(document.getElementById("pay-cash").value) || 0; const q = Number(document.getElementById("pay-qris").value) || 0; const t = Number(document.getElementById("pay-transfer").value) || 0; const f = Number(document.getElementById("pay-free").value) || 0;
    const totalAccounted = c + q + t + f; const remaining = Math.max(0, window.cartGrandTotal - totalAccounted);
    document.getElementById("pay-piutang").value = remaining; calculateRemaining();
}

// ⚡ FIXED: This now allows typing a Piutang amount to instantly shrink the Cash value ⚡
window.autoBalanceCash = function() {
    const q = Number(document.getElementById("pay-qris").value) || 0; const t = Number(document.getElementById("pay-transfer").value) || 0; const f = Number(document.getElementById("pay-free").value) || 0; const p = Number(document.getElementById("pay-piutang").value) || 0;
    const totalAccounted = q + t + f + p; const remaining = Math.max(0, window.cartGrandTotal - totalAccounted);
    document.getElementById("pay-cash").value = remaining; calculateRemaining();
}

window.calculateRemaining = function() {
    const c = Number(document.getElementById("pay-cash").value) || 0; const q = Number(document.getElementById("pay-qris").value) || 0; const t = Number(document.getElementById("pay-transfer").value) || 0; const f = Number(document.getElementById("pay-free").value) || 0; const p = Number(document.getElementById("pay-piutang").value) || 0;
    const totalAccounted = c + q + t + f + p; const remaining = window.cartGrandTotal - totalAccounted;
    document.getElementById("review-remaining").innerText = `Rp ${remaining.toLocaleString('id-ID')}`;
}

function closeReview() { document.getElementById("review-modal").classList.add("hidden"); }

window.switchCart = function(index) {
    posSessions[activeSessionIndex].customer = activeCustomerProfile; activeSessionIndex = index; currentCart = posSessions[activeSessionIndex].cart; activeCustomerProfile = posSessions[activeSessionIndex].customer;
    document.querySelectorAll(".cart-tab").forEach((btn, i) => {
        if (i === index) { btn.classList.add("active"); btn.style.background = "#2c3e50"; btn.style.color = "white"; btn.style.borderTop = "3px solid #3498db"; } 
        else { btn.classList.remove("active"); btn.style.background = "#34495e"; btn.style.color = "#bdc3c7"; btn.style.borderTop = "none"; }
    });
    renderCart();
    
    if (activeCustomerProfile) {
        document.getElementById("cust-name").value = activeCustomerProfile.name; document.getElementById("cust-phone").value = activeCustomerProfile.phone || "";
        document.getElementById("active-cust-name").innerText = activeCustomerProfile.name; document.getElementById("active-cust-phone").innerText = activeCustomerProfile.phone !== "-" ? `(${activeCustomerProfile.phone})` : "";
        document.getElementById("customer-input-section").classList.add("hidden"); document.getElementById("active-customer-banner").classList.remove("hidden");
        isMenuLocked = false; document.getElementById("glass-overlay").style.opacity = "0"; document.getElementById("glass-overlay").style.pointerEvents = "none";
        updatePromoBanner(activeCustomerProfile);
    } else {
        document.getElementById("customer-input-section").classList.remove("hidden"); document.getElementById("active-customer-banner").classList.add("hidden");
        document.getElementById("glass-overlay").style.opacity = "1"; document.getElementById("glass-overlay").style.pointerEvents = "auto";
        document.getElementById("cust-phone").value = ""; document.getElementById("cust-name").value = ""; 
        const promoBanner = document.getElementById("promo-indicator-banner"); if(promoBanner) promoBanner.classList.add("hidden");
        const piutangBanner = document.getElementById("piutang-indicator-banner"); if(piutangBanner) piutangBanner.classList.add("hidden");
        isMenuLocked = true;
    }
}

function isCustomerLocked(phone) {
    if (!phone || phone === "-") return false;
    for (let i = 0; i < posSessions.length; i++) { if (i !== activeSessionIndex && posSessions[i].customer && posSessions[i].customer.phone === phone) { return i + 1; } }
    return false;
}

function updatePromoBanner(member) {
    const promoBanner = document.getElementById("promo-indicator-banner");
    const piutangBanner = document.getElementById("piutang-indicator-banner");

    if (member && member.piutang > 0) {
        piutangBanner.innerHTML = `<span>⚠️ <strong>Total Piutang:</strong> Rp ${member.piutang.toLocaleString('id-ID')}</span> <button onclick="openPiutangModal()" style="padding:5px 10px; background:#c0392b; color:white; border:none; border-radius:4px; font-weight:bold; cursor:pointer;">Lunasi Piutang</button>`;
        piutangBanner.classList.remove("hidden");
    } else { if(piutangBanner) piutangBanner.classList.add("hidden"); }

    if (!window.loyaltyEnabled || !promoBanner) { if(promoBanner) promoBanner.classList.add("hidden"); return; }

    let pointSummary = []; let wallet = member ? (member.wallet || {}) : {};
    let loyaltyItems = globalMenuData.filter(m => m.loyaltyThreshold > 0);
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

function lockMenu() {
    isMenuLocked = true; activeCustomerProfile = null; posSessions[activeSessionIndex].customer = null; posSessions[activeSessionIndex].cart = []; currentCart = posSessions[activeSessionIndex].cart;
    document.getElementById("customer-input-section").classList.remove("hidden"); document.getElementById("active-customer-banner").classList.add("hidden");
    document.getElementById("glass-overlay").style.opacity = "1"; document.getElementById("glass-overlay").style.pointerEvents = "auto";
    document.getElementById("cust-phone").value = ""; document.getElementById("cust-name").value = ""; 
    renderCart();
    const promoBanner = document.getElementById("promo-indicator-banner"); if(promoBanner) promoBanner.classList.add("hidden");
    const piutangBanner = document.getElementById("piutang-indicator-banner"); if(piutangBanner) piutangBanner.classList.add("hidden");
}

function unlockMenu(isGuest) {
    let phone = "-"; let name = "Walk-in";
    const promoBanner = document.getElementById("promo-indicator-banner"); const piutangBanner = document.getElementById("piutang-indicator-banner");

    if (isGuest) { 
        document.getElementById("cust-phone").value = ""; document.getElementById("cust-name").value = "Walk-in"; activeCustomerProfile = null; 
        document.getElementById("active-cust-name").innerText = name; document.getElementById("active-cust-phone").innerText = "";
        document.getElementById("customer-input-section").classList.add("hidden"); document.getElementById("active-customer-banner").classList.remove("hidden");
        if(promoBanner) promoBanner.classList.add("hidden"); if(piutangBanner) piutangBanner.classList.add("hidden");
        isMenuLocked = false; document.getElementById("glass-overlay").style.opacity = "0"; setTimeout(() => { document.getElementById("glass-overlay").style.pointerEvents = "none"; }, 300);
    } else {
        phone = document.getElementById("cust-phone").value.trim(); name = document.getElementById("cust-name").value.trim() || "Pelanggan";
        if (phone.length < 5) return alert("Harap masukkan Nomor WhatsApp yang valid terlebih dahulu.");

        let searchPhone = phone.replace(/\D/g, ''); if (searchPhone.startsWith('62')) searchPhone = '0' + searchPhone.substring(2);
        if (searchPhone.length > 0 && !searchPhone.startsWith('0')) searchPhone = '0' + searchPhone;

        let lockedQueue = isCustomerLocked(searchPhone);
        if (lockedQueue) { return alert(`⚠️ PELANGGAN TERKUNCI:\nPelanggan ini sedang diproses di Antrean ${lockedQueue}. Selesaikan pesanan di sana terlebih dahulu.`); }

        const tx = db.transaction(["members"], "readonly");
        tx.objectStore("members").get(searchPhone).onsuccess = (ev) => {
            const member = ev.target.result;
            if (member) { activeCustomerProfile = member; name = member.name; document.getElementById("cust-name").value = name; updatePromoBanner(member); } 
            else { activeCustomerProfile = { phone: searchPhone, name: name, wallet: {}, bottlesBorrowed: 0, piutang: 0, firstOutlet: currentOutlet, recentOutlets: currentOutlet }; updatePromoBanner(activeCustomerProfile); }

            document.getElementById("active-cust-name").innerText = name; document.getElementById("active-cust-phone").innerText = `(${searchPhone})`;
            document.getElementById("customer-input-section").classList.add("hidden"); document.getElementById("active-customer-banner").classList.remove("hidden");
            isMenuLocked = false; document.getElementById("glass-overlay").style.opacity = "0"; setTimeout(() => { document.getElementById("glass-overlay").style.pointerEvents = "none"; }, 300);
        };
    }
}

window.openBukuPiutang = function() {
    document.getElementById('buku-piutang-modal').classList.remove('hidden');
    document.getElementById('search-piutang').value = "";
    renderPiutangList();
}

window.renderPiutangList = function() {
    const filter = document.getElementById('search-piutang').value.toLowerCase().trim();
    const container = document.getElementById("piutang-list-container"); container.innerHTML = "";
    
    db.transaction(["members"], "readonly").objectStore("members").getAll().onsuccess = (e) => {
        let members = e.target.result.filter(m => m.piutang > 0);
        if (filter) members = members.filter(m => m.name.toLowerCase().includes(filter) || m.phone.includes(filter));
        
        if (members.length === 0) { container.innerHTML = `<div style="padding:20px; text-align:center; color:#7f8c8d;">Tidak ada data piutang ditemukan.</div>`; return; }
        
        members.forEach(m => {
            container.innerHTML += `
                <div class="history-row">
                    <div>
                        <strong style="color:#2c3e50;">${m.name}</strong> <span style="font-size:12px; color:#7f8c8d;">(${m.phone})</span><br>
                        <strong style="color:#c0392b; font-size:16px;">Rp ${m.piutang.toLocaleString('id-ID')}</strong>
                    </div>
                    <div>
                        <button onclick="triggerBayarPiutang('${m.phone}')" style="background:#27ae60; color:white; border:none; padding:8px 15px; border-radius:6px; font-weight:bold; cursor:pointer;">Lunasi Piutang</button>
                    </div>
                </div>`;
        });
    };
}

window.triggerBayarPiutang = function(phone) {
    db.transaction(["members"], "readonly").objectStore("members").get(phone).onsuccess = (e) => {
        const m = e.target.result; if(m) openPiutangModal(m);
    };
}

window.openPiutangModal = function(memberOverride) {
    window.piutangTargetMember = memberOverride || activeCustomerProfile;
    if(!window.piutangTargetMember || window.piutangTargetMember.piutang <= 0) return;
    
    document.getElementById("piutang-target-name").innerText = window.piutangTargetMember.name;
    document.getElementById("piutang-target-amount").innerText = "Rp " + window.piutangTargetMember.piutang.toLocaleString('id-ID');
    document.getElementById("piutang-pay-amount").value = window.piutangTargetMember.piutang;
    
    const orderSelect = document.getElementById("piutang-target-order"); orderSelect.innerHTML = `<option value="">-- Lunasi Saldo Global --</option>`;
    db.transaction(["orders"], "readonly").objectStore("orders").getAll().onsuccess = (e) => {
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
    
    let payload = { payId: "BYR-" + Date.now(), timestamp: getWibDate(), customerName: window.piutangTargetMember.name, customerPhone: window.piutangTargetMember.phone, amountPaid: payAmount, paymentMethod: method, cashAmount: cashAmt, cashier: currentCashier, outlet: currentOutlet, syncStatus: "Pending", shiftId: currentShiftId, originalOrderId: targetOrderId };
    db.transaction(["bayar_piutang"], "readwrite").objectStore("bayar_piutang").add(payload);
    
    window.piutangTargetMember.piutang -= payAmount;
    saveMemberToDB(window.piutangTargetMember.phone, window.piutangTargetMember.name, window.piutangTargetMember.wallet, window.piutangTargetMember.bottlesBorrowed, window.piutangTargetMember.piutang, window.piutangTargetMember.firstOutlet, window.piutangTargetMember.recentOutlets);
    
    if (activeCustomerProfile && activeCustomerProfile.phone === window.piutangTargetMember.phone) { activeCustomerProfile = window.piutangTargetMember; updatePromoBanner(activeCustomerProfile); }
    
    if (targetOrderId !== "") {
        db.transaction(["orders"], "readwrite").objectStore("orders").get(targetOrderId).onsuccess = (e) => {
            let o = e.target.result;
            if(o) {
                o.debtAmount = Math.max(0, (o.debtAmount || 0) - payAmount);
                if (o.debtAmount === 0 && String(o.paymentMethod).includes("Piutang")) {
                    o.paymentMethod = String(o.paymentMethod).replace("Piutang", "Lunas ("+method+")");
                } else if (o.debtAmount > 0 && String(o.paymentMethod) === "Piutang") {
                    o.paymentMethod = "Piutang (Sebagian)";
                }
                o.syncStatus = "Pending"; db.transaction(["orders"], "readwrite").objectStore("orders").put(o);
            }
        };
    }

    document.getElementById("piutang-modal").classList.add("hidden"); alert("Pembayaran Piutang Berhasil Dicatat!"); runBackgroundSync();
}

async function finalizeOrder(shouldPrint) {
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

    let payMethods = []; if(cash > 0) payMethods.push("Tunai"); if(qris > 0) payMethods.push("QRIS"); if(transfer > 0) payMethods.push("Trf.Bank"); if(free > 0) payMethods.push("Gratis"); if(debtAmount > 0) payMethods.push("Piutang");
    const payString = payMethods.length > 0 ? payMethods.join("+") : "Belum Bayar";

    let status = "Completed"; 
    currentCart.forEach(i => i.redeemed = 0);
    document.querySelectorAll(".redeem-input").forEach(input => {
        let itemId = input.getAttribute("data-item"); let qty = Number(input.value) || 0;
        let cartItem = currentCart.find(i => i.itemId === itemId); if (cartItem) cartItem.redeemed = qty;
    });

    let loyaltyChanges = {}; let freeItemsRedeemed = [];
    currentCart.forEach(item => {
        if (item.redeemed > 0) { freeItemsRedeemed.push({ name: item.name, qty: item.redeemed }); }
        if (item.loyaltyThreshold > 0) {
            let earned = item.qty - (item.redeemed || 0); 
            if (earned > 0 || (item.redeemed || 0) > 0) {
                if(!loyaltyChanges[item.name]) loyaltyChanges[item.name] = { earned: 0, redeemed: 0, threshold: item.loyaltyThreshold };
                loyaltyChanges[item.name].earned += earned; loyaltyChanges[item.name].redeemed += (item.redeemed || 0);
            }
        }
    });

    let updatedWallet = {}; let newPiutang = (activeCustomerProfile ? activeCustomerProfile.piutang || 0 : 0) + debtAmount;
    if (window.loyaltyEnabled && activeCustomerProfile) {
        updatedWallet = JSON.parse(JSON.stringify(activeCustomerProfile.wallet || {})); 
        for(let itemName in loyaltyChanges) {
            if(!updatedWallet[itemName]) updatedWallet[itemName] = {points:0, free:0};
            let c = loyaltyChanges[itemName]; updatedWallet[itemName].points += c.earned; updatedWallet[itemName].free -= c.redeemed;
            if(c.threshold > 0) {
                let newFree = Math.floor(updatedWallet[itemName].points / c.threshold);
                updatedWallet[itemName].points = updatedWallet[itemName].points % c.threshold; updatedWallet[itemName].free += newFree;
            }
        }
        activeCustomerProfile.piutang = newPiutang;
        saveMemberToDB(activeCustomerProfile.phone, activeCustomerProfile.name, updatedWallet, activeCustomerProfile.bottlesBorrowed + rentBottleQty, newPiutang, activeCustomerProfile.firstOutlet, activeCustomerProfile.recentOutlets);
    } else if (custPhone !== "-") {
        let fOut = activeCustomerProfile ? activeCustomerProfile.firstOutlet : currentOutlet; let rOut = activeCustomerProfile ? activeCustomerProfile.recentOutlets : currentOutlet;
        saveMemberToDB(custPhone, custName, {}, rentBottleQty, debtAmount, fOut, rOut);
    }

    const orderPayload = {
        orderId: "ORD-" + Date.now(), timestamp: getWibDate(), cashier: currentCashier, shiftId: currentShiftId,
        customerName: custName, customerPhone: custPhone, orderStatus: status, items: currentCart, subtotal: window.cartSubtotal, discounts: free, grandTotal: window.cartGrandTotal,
        paymentMethod: payString, cashAmount: cash, qrisAmount: qris, transferAmount: transfer, freeAmount: free, rentBottleQty: rentBottleQty, debtAmount: debtAmount,
        loyaltyChanges: loyaltyChanges, freeItemsRedeemed: freeItemsRedeemed, outlet: currentOutlet, syncStatus: "Pending" 
    };

    const txMenu = db.transaction(["menu"], "readwrite"); const storeMenu = txMenu.objectStore("menu");
    currentCart.forEach(cartItem => { storeMenu.get(cartItem.itemId).onsuccess = (ev) => { const menuItem = ev.target.result; if (menuItem && menuItem.trackStock) { menuItem.currentStock = Math.max(0, menuItem.currentStock - cartItem.qty); storeMenu.put(menuItem); } }; });

    db.transaction(["orders"], "readwrite").objectStore("orders").add(orderPayload);
    
    if (shouldPrint) {
        const payloadBytes = await buildEscPosReceipt(orderPayload.orderId, orderPayload, (cash+qris+transfer+free), debtAmount, payString, updatedWallet);
        await printViaBluetooth(payloadBytes);
    }
    
    closeReview(); lockMenu(); renderProductGrid(); runBackgroundSync();
}

function openExpenseModal() {
    document.getElementById("expense-modal").classList.remove("hidden");
}

function saveExpense() {
    const amount = Number(document.getElementById("exp-amount").value); const category = document.getElementById("exp-category").value.trim();
    if (amount <= 0 || !category) return alert("Harap masukkan jumlah dan kategori yang benar.");
    db.transaction(["expense_categories"], "readwrite").objectStore("expense_categories").put({ name: category });
    const payload = { expenseId: "EXP-" + Date.now(), timestamp: getWibDate(), cashier: currentCashier, shiftId: currentShiftId, category: category, description: document.getElementById("exp-desc").value || "-", amount: amount, status: "Active", outlet: currentOutlet, syncStatus: "Pending" };
    db.transaction(["expenses"], "readwrite").objectStore("expenses").add(payload);
    document.getElementById("expense-modal").classList.add("hidden"); document.getElementById("exp-amount").value = ""; document.getElementById("exp-category").value = ""; document.getElementById("exp-desc").value = ""; alert("Pengeluaran Berhasil Dicatat!"); runBackgroundSync();
}

// ⚡ UNIVERSAL EVENT LISTENER FOR BOTH AUTOCOMPLETES (Close on outside click) ⚡
window.onload = async () => { 
    document.getElementById("cust-phone").addEventListener("input", handleAutocomplete);
    document.getElementById("cust-name").addEventListener("input", handleAutocomplete);
    document.getElementById("cust-phone").addEventListener("click", handleAutocomplete);
    document.getElementById("cust-name").addEventListener("click", handleAutocomplete);
    document.getElementById("cust-phone").addEventListener("focus", handleAutocomplete);
    document.getElementById("cust-name").addEventListener("focus", handleAutocomplete);

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

    await initDB(); 
    await checkAutoCloseShifts(); 
    await syncMasterData(); 
    window.setInterval(runBackgroundSync, 15000); 
    window.setInterval(checkAutoCloseShifts, 3600000); 
};
