// PUT YOUR SCRIPT.GOOGLE.COM MACROS URL HERE
const API_URL = "https://script.google.com/macros/s/AKfycbxeaTG6ZbW_9v9u9PE5kRPbOLpwWeVh7HGITFAugSwqdVsgjgTZZC8GbvXPyvlZSDL1/exec"; 
const DB_NAME = "PureWater_POS";
const DB_VERSION = 5; 
let db;

// MULTI-SESSION ARCHITECTURE
let posSessions = [{ cart: [], customer: null }, { cart: [], customer: null }, { cart: [], customer: null }];
let activeSessionIndex = 0; let currentCart = posSessions[0].cart; let activeCustomerProfile = posSessions[0].customer;

let currentCashier = ""; let currentPin = ""; let currentShiftId = ""; let currentLoginTime = ""; let currentOutlet = "";
let globalMenuData = []; let currentCategory = ""; 
window.outletStocks = {}; let isLoggingOut = false; let currentVoidTarget = { type: null, id: null };
let isMenuLocked = true; let isSyncing = false; window.loyaltyEnabled = false; 
let deferredPrompt;

// GMT+7 (WIB) Timestamp Generator
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
    });
}

function attemptLogin() {
    const pin = document.getElementById("cashier-pin").value;
    db.transaction(["staff"], "readonly").objectStore("staff").get(pin).onsuccess = (e) => {
        const staff = e.target.result;
        if (staff) {
            db.transaction(["active_shifts"], "readonly").objectStore("active_shifts").get(pin).onsuccess = (shiftReq) => {
                const activeShift = shiftReq.target.result;
                currentCashier = staff.name; currentPin = staff.pin;
                
                const dropdownSelection = document.getElementById("login-outlet").value;
                if (dropdownSelection === "AUTO") { currentOutlet = staff.defaultOutlet || document.getElementById("login-outlet").options[1].value; } 
                else { currentOutlet = dropdownSelection; }

                if (activeShift) { 
                    currentShiftId = activeShift.shiftId; currentLoginTime = activeShift.loginTime; currentOutlet = activeShift.outlet || currentOutlet; 
                } else {
                    currentShiftId = "SHF-" + Date.now(); currentLoginTime = getWibDate();
                    db.transaction(["active_shifts"], "readwrite").objectStore("active_shifts").put({ pin: pin, shiftId: currentShiftId, loginTime: currentLoginTime, outlet: currentOutlet });
                }
                document.getElementById("login-screen").classList.add("hidden"); document.getElementById("pos-screen").classList.remove("hidden");
                document.getElementById("display-cashier").innerText = currentCashier; document.getElementById("display-outlet").innerText = currentOutlet;
                syncMasterData(); lockMenu(); 
            };
        } else { alert("PIN Salah!"); }
    };
}

window.switchCart = function(index) {
    posSessions[activeSessionIndex].customer = activeCustomerProfile;
    activeSessionIndex = index; currentCart = posSessions[activeSessionIndex].cart; activeCustomerProfile = posSessions[activeSessionIndex].customer;
    
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
    } else {
        if(piutangBanner) piutangBanner.classList.add("hidden");
    }

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
        if (lockedQueue) { return alert(`⚠️ PELANGGAN TERKUNCI:\nPelanggan ini sedang diproses di Antrean ${lockedQueue}. Selesaikan atau batalkan pesanan di sana terlebih dahulu untuk mencegah konflik poin.`); }

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

async function manualPushSync() {
    if (!navigator.onLine) return alert("Anda sedang offline!");
    document.getElementById("network-text").innerText = "Mengirim Data..."; document.getElementById("network-dot").style.backgroundColor = "#f39c12";
    await runBackgroundSync(); document.getElementById("network-text").innerText = "Menarik Data..."; await syncMasterData(); alert("Sinkronisasi Database Berhasil!");
}

async function syncMasterData() {
    if (!navigator.onLine) {
        if(document.getElementById("network-text")) document.getElementById("network-text").innerText = "Mode Offline";
        if(document.getElementById("network-dot")) document.getElementById("network-dot").style.backgroundColor = "#e74c3c"; return;
    }
    if(document.getElementById("network-text")) document.getElementById("network-text").innerText = "Sinkronisasi...";
    if(document.getElementById("network-dot")) document.getElementById("network-dot").style.backgroundColor = "#f39c12";

    try {
        const response = await fetch(API_URL); const result = await response.json();
        if (result.status === "Success") {
            window.outletStocks = result.data.outletStocks; 
            const tx = db.transaction(["staff", "menu", "settings", "members", "expense_categories"], "readwrite");
            
            const staffStore = tx.objectStore("staff"); staffStore.clear(); result.data.staff.forEach(s => staffStore.add(s));
            const menuStore = tx.objectStore("menu"); menuStore.clear(); result.data.menu.forEach(m => menuStore.add(m));
            const memStore = tx.objectStore("members"); memStore.clear(); result.data.members.forEach(m => memStore.add(m));
            const expCatStore = tx.objectStore("expense_categories"); expCatStore.clear(); 
            if(result.data.expenseCategories) result.data.expenseCategories.forEach(c => expCatStore.add({name: c}));
            const settingsStore = tx.objectStore("settings"); settingsStore.clear(); 
            for (const [key, value] of Object.entries(result.data.settings)) { settingsStore.add({ key: key, value: value }); }
            if (result.data.authStatuses) processVoidApprovals(result.data.authStatuses);

            globalMenuData = result.data.menu; window.loyaltyEnabled = String(result.data.settings["Enable_Loyalty"]).toUpperCase() === "TRUE";
            const rawOutlets = result.data.settings["Outlet_List"] || "Pusat"; const outletArray = rawOutlets.split(",").map(s => s.trim()); const selectBox = document.getElementById("login-outlet");
            if(selectBox) { selectBox.innerHTML = `<option value="AUTO">🏠 Sesuai Cabang Asal</option>` + outletArray.map(o => `<option value="${o}">${o}</option>`).join(""); }

            if(document.getElementById("network-text")) document.getElementById("network-text").innerText = "Online & Sinkron";
            if(document.getElementById("network-dot")) document.getElementById("network-dot").style.backgroundColor = "#2ecc71";
            if (!document.getElementById("pos-screen").classList.contains("hidden")) { loadMenuUI(); }
        } else { throw new Error(result.message); }
    } catch (e) { 
        if(document.getElementById("network-text")) document.getElementById("network-text").innerText = "Gagal Sinkron"; 
        if(document.getElementById("network-dot")) document.getElementById("network-dot").style.backgroundColor = "#e74c3c";
    }
}

function handleAutocomplete(e) {
    const val = e.target.value.toLowerCase().trim(); const resBox = document.getElementById("autocomplete-results");
    
    db.transaction(["members"], "readonly").objectStore("members").getAll().onsuccess = (ev) => {
        const members = ev.target.result; let matches = members;
        if (val.length > 0) matches = members.filter(m => String(m.phone).toLowerCase().includes(val) || String(m.name).toLowerCase().includes(val));
        matches.sort((a, b) => (b.spent || 0) - (a.spent || 0));

        if (matches.length > 0) {
            resBox.innerHTML = matches.map(m => {
                let wStr = JSON.stringify(m.wallet || {}).replace(/"/g, '&quot;'); let nameStr = m.name.replace(/'/g, "\\'");
                let fOut = m.firstOutlet || ""; let rOut = m.recentOutlets || "";
                return `<div class="autocomplete-item" onclick="selectMember('${m.phone}', '${nameStr}', '${wStr}', ${m.bottlesBorrowed || 0}, ${m.piutang || 0}, '${fOut}', '${rOut}')">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <div class="autocomplete-name">${m.name}</div><div class="autocomplete-phone" style="font-size:14px; color:#7f8c8d;">${m.phone}</div>
                    </div>
                </div>`;
            }).join("");
            resBox.classList.remove("hidden");
        } else { resBox.classList.add("hidden"); }
    };
}
document.getElementById("cust-phone").addEventListener("input", handleAutocomplete);document.getElementById("cust-name").addEventListener("input", handleAutocomplete);document.getElementById("cust-phone").addEventListener("click", handleAutocomplete);document.getElementById("cust-name").addEventListener("click", handleAutocomplete);document.getElementById("cust-phone").addEventListener("focus", handleAutocomplete);document.getElementById("cust-name").addEventListener("focus", handleAutocomplete);document.addEventListener('click', (e) => { if(!e.target.closest('.autocomplete-wrapper') && e.target.id !== 'cust-phone' && e.target.id !== 'cust-name') { document.getElementById('autocomplete-results').classList.add('hidden'); } });

window.selectMember = function(phone, name, walletStr, dbBottlesBorrowed, dbPiutang, firstOutlet, recentOutlets) {
    document.getElementById("autocomplete-results").classList.add("hidden");
    let lockedQueue = isCustomerLocked(phone);
    if (lockedQueue) { return alert(`⚠️ PELANGGAN TERKUNCI:\nPelanggan ini sedang diproses di Antrean ${lockedQueue}. Selesaikan atau batalkan pesanan di sana terlebih dahulu untuk mencegah konflik poin.`); }

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

    document.getElementById("pay-qris").value = 0; document.getElementById("pay-transfer").value = 0; document.getElementById("pay-free").value = 0; 
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

window.autoBalanceCash = function() {
    const q = Number(document.getElementById("pay-qris").value) || 0; const t = Number(document.getElementById("pay-transfer").value) || 0; const f = Number(document.getElementById("pay-free").value) || 0;
    const totalAccounted = q + t + f; const remaining = Math.max(0, window.cartGrandTotal - totalAccounted);
    document.getElementById("pay-cash").value = remaining; calculateRemaining();
}

window.calculateRemaining = function() {
    const c = Number(document.getElementById("pay-cash").value) || 0; const q = Number(document.getElementById("pay-qris").value) || 0;
    const t = Number(document.getElementById("pay-transfer").value) || 0; const f = Number(document.getElementById("pay-free").value) || 0;

    const totalAccounted = c + q + t + f; const remaining = Math.max(0, window.cartGrandTotal - totalAccounted);
    document.getElementById("review-remaining").innerText = `Rp ${remaining.toLocaleString('id-ID')}`;
    
    const btnPiutang = document.getElementById("btn-piutang");
    if (remaining > 0 && activeCustomerProfile && activeCustomerProfile.phone && activeCustomerProfile.phone !== "-") { btnPiutang.classList.remove("hidden"); } 
    else { btnPiutang.classList.add("hidden"); }
}

function closeReview() { document.getElementById("review-modal").classList.add("hidden"); }

window.openPiutangModal = function() {
    if(!activeCustomerProfile || activeCustomerProfile.piutang <= 0) return;
    document.getElementById("piutang-target-name").innerText = activeCustomerProfile.name;
    document.getElementById("piutang-target-amount").innerText = "Rp " + activeCustomerProfile.piutang.toLocaleString('id-ID');
    document.getElementById("piutang-pay-amount").value = activeCustomerProfile.piutang;
    document.getElementById("piutang-modal").classList.remove("hidden");
}

window.submitPiutang = function() {
    let payAmount = Number(document.getElementById("piutang-pay-amount").value); let method = document.getElementById("piutang-method").value;
    if(payAmount <= 0) return alert("Jumlah tidak valid"); if(payAmount > activeCustomerProfile.piutang) return alert("Jumlah yang dimasukkan melebihi total piutang pelanggan!");
    
    let cashAmt = method === "Tunai" ? payAmount : 0;
    let payload = { payId: "BYR-" + Date.now(), timestamp: getWibDate(), customerName: activeCustomerProfile.name, customerPhone: activeCustomerProfile.phone, amountPaid: payAmount, paymentMethod: method, cashAmount: cashAmt, cashier: currentCashier, outlet: currentOutlet, syncStatus: "Pending" };
    db.transaction(["bayar_piutang"], "readwrite").objectStore("bayar_piutang").add(payload);
    
    activeCustomerProfile.piutang -= payAmount;
    saveMemberToDB(activeCustomerProfile.phone, activeCustomerProfile.name, activeCustomerProfile.wallet, activeCustomerProfile.bottlesBorrowed, activeCustomerProfile.piutang, activeCustomerProfile.firstOutlet, activeCustomerProfile.recentOutlets);
    updatePromoBanner(activeCustomerProfile);
    document.getElementById("piutang-modal").classList.add("hidden"); alert("Pembayaran Piutang Berhasil Dicatat!"); runBackgroundSync();
}

async function finalizeOrder(shouldPrint, isDebt) {
    const cash = Number(document.getElementById("pay-cash").value) || 0; const qris = Number(document.getElementById("pay-qris").value) || 0;
    const transfer = Number(document.getElementById("pay-transfer").value) || 0; const free = Number(document.getElementById("pay-free").value) || 0;
    const rentBottleQty = Number(document.getElementById("rent-bottle-qty").value) || 0;
    
    const totalAccounted = cash + qris + transfer + free; const remaining = window.cartGrandTotal - totalAccounted; 

    let custPhoneRaw = document.getElementById("cust-phone").value.trim(); let custPhone = custPhoneRaw || "-";
    const custName = document.getElementById("cust-name").value.trim() || "Walk-in";

    if (remaining < 0) return alert("⚠️ PEMBAYARAN DITOLAK:\nPembayaran berlebih. Pastikan Sisa Kurang Bayar Rp 0.");
    if (remaining > 0 && !isDebt) return alert("⚠️ PEMBAYARAN DITOLAK:\nSisa Kurang Bayar harus Rp 0. Jika ini hutang, klik tombol 'Catat Sisa sbg Piutang'.");

    let debtAmount = isDebt ? remaining : 0;
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
    if (shouldPrint) { await buildPrintableReceipt(orderPayload.orderId, orderPayload, totalAccounted, debtAmount, payString, updatedWallet); window.print(); }
    closeReview(); lockMenu(); renderProductGrid(); runBackgroundSync();
}

async function getDynamicSettings() { return new Promise(res => { let req = db.transaction(["settings"], "readonly").objectStore("settings").getAll(); req.onsuccess = e => { let s = {}; e.target.result.forEach(row => s[row.key] = row.value); res(s); }; }); }

async function buildPrintableReceipt(orderId, order, deposit, debt, payMethod, updatedWallet) {
    const settings = await getDynamicSettings();
    const h1 = settings["Header_1"] || "PURE WATER"; const h2 = settings["Header_2"] || ""; let h3 = settings["Header_3"] || ""; if (settings["Header_3_" + order.outlet]) h3 = settings["Header_3_" + order.outlet]; 
    const f1 = settings["Footer_1"] || "TERIMA KASIH"; const f2 = settings["Footer_2"] || ""; let f3 = settings["Footer_3"] || ""; if (settings["Footer_3_" + order.outlet]) f3 = settings["Footer_3_" + order.outlet]; 

    const printArea = document.getElementById("printable-area"); const dateStr = new Date(order.timestamp).toLocaleString('id-ID');
    
    let itemsHtml = "";
    order.items.forEach(item => { const lineTotal = item.qty * item.originalPrice; itemsHtml += `<div style="display:flex; justify-content:space-between; margin-bottom: 2px;"><span>${item.qty}x ${item.name}</span><span>${lineTotal.toLocaleString('id-ID')}</span></div>`; });
    
    let poinHtml = "";
    if (window.loyaltyEnabled && order.customerPhone && order.customerPhone !== "-") {
        let lines = []; let loyaltyItems = globalMenuData.filter(m => m.loyaltyThreshold > 0);
        loyaltyItems.forEach(item => { let data = updatedWallet[item.name] || {points: 0, free: 0}; lines.push(`<strong>${item.name}</strong><br>Poin: ${data.points}/${item.loyaltyThreshold} | Gratis: ${data.free}`); });
        if (lines.length > 0) { poinHtml = `<div style="margin-top:10px; padding-top:5px; border-top:1px dashed #000; font-size:11px; text-align:center;"><strong>-- INFO POIN PURE --</strong><br>${lines.join('<br>')}</div>`; }
    }

    printArea.innerHTML = `
        <div style="text-align:center; margin-bottom:10px;"><h2 style="margin:0;">${h1}</h2>${h2 ? `<div style="font-size:10px;">${h2}</div>` : ''}${h3 ? `<div style="font-size:10px;">${h3}</div>` : ''}<div style="font-size:10px; margin-top:5px;">${dateStr}</div></div>
        <div style="border-top:1px dashed #000; border-bottom:1px dashed #000; padding:5px 0; margin-bottom:5px; font-size: 11px;"><div>Nota: ${orderId}</div><div>Pelanggan: ${order.customerName}</div><div>Kasir: ${currentCashier}</div></div>
        ${itemsHtml}
        <div style="border-top:1px dashed #000; margin-top:10px; padding-top:5px;">
            <div style="display:flex; justify-content:space-between; font-size:11px;"><span>Subtotal:</span><span>Rp ${order.subtotal.toLocaleString('id-ID')}</span></div>
            <div style="display:flex; justify-content:space-between; font-weight:bold; font-size:14px; margin-top:5px; border-bottom: 1px solid #000; padding-bottom: 5px;"><span>TOTAL:</span><span>Rp ${order.grandTotal.toLocaleString('id-ID')}</span></div>
        </div>
        <div style="margin-top:5px; font-size:11px;">
            <div style="display:flex; justify-content:space-between;"><span>Tercatat (${payMethod}):</span><span>Rp ${deposit.toLocaleString('id-ID')}</span></div>
            ${debt > 0 ? `<div style="display:flex; justify-content:space-between; color:#c0392b; margin-top:2px;"><span>PIUTANG:</span><span>Rp ${debt.toLocaleString('id-ID')}</span></div>` : ''}
            <div style="display:flex; justify-content:space-between; font-weight:bold; margin-top: 5px;"><span>STATUS:</span><span>${debt > 0 ? 'HUTANG' : 'LUNAS'}</span></div>
        </div>
        ${poinHtml}
        <div style="text-align:center; margin-top:15px; font-weight:bold; font-size: 12px;">${f1}</div>${f2 ? `<div style="text-align:center; margin-top:2px; font-size: 10px;">${f2}</div>` : ''}${f3 ? `<div style="text-align:center; margin-top:2px; font-size: 10px;">${f3}</div>` : ''}
    `;
}

window.openInboundModal = function() {
    let select = document.getElementById("inbound-tank-target"); select.innerHTML = ""; let tanks = globalMenuData.filter(m => m.category === "Tandon" || m.subCategory === "Raw Water");
    tanks.forEach(t => { select.innerHTML += `<option value="${t.name}">💧 ${t.name}</option>`; });
    if (tanks.length === 0) { select.innerHTML = `<option value="Tangki Air RO">💧 Tangki Air RO</option><option value="Tangki Air Standar">💧 Tangki Air Standar</option>`; }
    document.getElementById("inbound-qty").value = ""; document.getElementById("inbound-notes").value = ""; document.getElementById("inbound-modal").classList.remove("hidden");
}
window.submitInbound = function() {
    const qty = Number(document.getElementById("inbound-qty").value); const targetTank = document.getElementById("inbound-tank-target").value; const notes = document.getElementById("inbound-notes").value.trim() || "-";
    if (qty <= 0) return alert("Masukkan jumlah liter air yang benar.");
    const payload = { logId: "INB-" + Date.now(), timestamp: getWibDate(), cashier: currentCashier, shiftId: currentShiftId, itemName: targetTank, qty: qty, notes: notes, outlet: currentOutlet, syncStatus: "Pending" };
    db.transaction(["stock_inbound"], "readwrite").objectStore("stock_inbound").add(payload); document.getElementById("inbound-modal").classList.add("hidden"); alert(`Berhasil mencatat kedatangan ${qty} Liter ke ${targetTank}.`); runBackgroundSync();
}

window.openCuciModal = function() {
    let select = document.getElementById("cuci-tank"); select.innerHTML = ""; let tanks = globalMenuData.filter(m => m.category === "Tandon" || m.subCategory === "Raw Water");
    tanks.forEach(t => { select.innerHTML += `<option value="${t.name}">💧 ${t.name}</option>`; });
    if (tanks.length === 0) { select.innerHTML = `<option value="Tangki Air RO">💧 Tangki Air RO</option><option value="Tangki Air Standar">💧 Tangki Air Standar</option>`; }
    document.getElementById("cuci-qty").value = ""; document.getElementById("cuci-notes").value = ""; document.getElementById("cuci-modal").classList.remove("hidden");
}
window.submitCuciTandon = function() {
    let tank = document.getElementById("cuci-tank").value; let qty = Number(document.getElementById("cuci-qty").value); let notes = document.getElementById("cuci-notes").value.trim() || "-";
    if (qty <= 0) return alert("Masukkan estimasi air terbuang dengan benar.");
    let payload = { logId: "CUC-" +
