const API_URL = "https://script.google.com/macros/s/AKfycbxFbXjkE3N2Q8T0oJ9gHOKSKFSefg3T01ezUcFuyNUNfGXh-lC700oKo57qwakeJ-Y/exec"; 
const DB_NAME = "PureWater_POS";
const DB_VERSION = 2; 
let db;

// MULTI-SESSION ARCHITECTURE
let posSessions = [
    { cart: [], customer: null },
    { cart: [], customer: null },
    { cart: [], customer: null }
];
let activeSessionIndex = 0;
let currentCart = posSessions[0].cart;
let activeCustomerProfile = posSessions[0].customer;

let currentCashier = ""; let currentPin = ""; let currentShiftId = ""; let currentLoginTime = ""; let currentOutlet = "";
let globalMenuData = []; let currentCategory = ""; 
window.masterDrawerBalance = 0; let isLoggingOut = false;
let currentVoidTarget = { type: null, id: null };
let isMenuLocked = true; let isSyncing = false; 
window.loyaltyEnabled = false; 
let deferredPrompt;

// PWA Install Prompt
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); deferredPrompt = e;
    const installBtn = document.getElementById('btn-install');
    if(installBtn) installBtn.classList.remove('hidden');
});
function installPWA() {
    if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then((choiceResult) => {
            if (choiceResult.outcome === 'accepted') document.getElementById('btn-install').classList.add('hidden');
            deferredPrompt = null;
        });
    }
}

// Database Init
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
        };
        request.onsuccess = (e) => { db = e.target.result; resolve(db); };
    });
}

// Login Logic
function attemptLogin() {
    const pin = document.getElementById("cashier-pin").value;
    db.transaction(["staff"], "readonly").objectStore("staff").get(pin).onsuccess = (e) => {
        const staff = e.target.result;
        if (staff) {
            db.transaction(["active_shifts"], "readonly").objectStore("active_shifts").get(pin).onsuccess = (shiftReq) => {
                const activeShift = shiftReq.target.result;
                currentCashier = staff.name; currentPin = staff.pin;
                
                const dropdownSelection = document.getElementById("login-outlet").value;
                if (dropdownSelection === "AUTO") {
                    currentOutlet = staff.defaultOutlet || document.getElementById("login-outlet").options[1].value; 
                } else {
                    currentOutlet = dropdownSelection; 
                }

                if (activeShift) { 
                    currentShiftId = activeShift.shiftId; 
                    currentLoginTime = activeShift.loginTime; 
                    currentOutlet = activeShift.outlet || currentOutlet; 
                } else {
                    currentShiftId = "SHF-" + Date.now(); currentLoginTime = new Date().toISOString();
                    db.transaction(["active_shifts"], "readwrite").objectStore("active_shifts").put({
                        pin: pin, shiftId: currentShiftId, loginTime: currentLoginTime, outlet: currentOutlet
                    });
                }
                document.getElementById("login-screen").classList.add("hidden"); document.getElementById("pos-screen").classList.remove("hidden");
                document.getElementById("display-cashier").innerText = currentCashier;
                document.getElementById("display-outlet").innerText = currentOutlet;
                syncMasterData(); lockMenu(); 
            };
        } else { alert("PIN Salah!"); }
    };
}

// UI Locks & Multi-Session Tab Switching
window.switchCart = function(index) {
    posSessions[activeSessionIndex].customer = activeCustomerProfile;
    
    activeSessionIndex = index;
    currentCart = posSessions[activeSessionIndex].cart;
    activeCustomerProfile = posSessions[activeSessionIndex].customer;
    
    document.querySelectorAll(".cart-tab").forEach((btn, i) => {
        if (i === index) {
            btn.classList.add("active");
            btn.style.background = "#2c3e50";
            btn.style.color = "white";
            btn.style.borderTop = "3px solid #3498db";
        } else {
            btn.classList.remove("active");
            btn.style.background = "#34495e";
            btn.style.color = "#bdc3c7";
            btn.style.borderTop = "none";
        }
    });
    
    renderCart();
    
    if (activeCustomerProfile) {
        document.getElementById("cust-name").value = activeCustomerProfile.name;
        document.getElementById("cust-phone").value = activeCustomerProfile.phone || "";
        document.getElementById("active-cust-name").innerText = activeCustomerProfile.name;
        document.getElementById("active-cust-phone").innerText = activeCustomerProfile.phone !== "-" ? `(${activeCustomerProfile.phone})` : "";
        
        document.getElementById("customer-input-section").classList.add("hidden");
        document.getElementById("active-customer-banner").classList.remove("hidden");
        isMenuLocked = false; 
        document.getElementById("glass-overlay").style.opacity = "0"; 
        document.getElementById("glass-overlay").style.pointerEvents = "none";
        
        updatePromoBanner(activeCustomerProfile);
    } else {
        document.getElementById("customer-input-section").classList.remove("hidden");
        document.getElementById("active-customer-banner").classList.add("hidden");
        document.getElementById("glass-overlay").style.opacity = "1"; document.getElementById("glass-overlay").style.pointerEvents = "auto";
        document.getElementById("cust-phone").value = ""; document.getElementById("cust-name").value = ""; 
        const promoBanner = document.getElementById("promo-indicator-banner");
        if(promoBanner) promoBanner.classList.add("hidden");
        isMenuLocked = true;
    }
}

function updatePromoBanner(member) {
    const promoBanner = document.getElementById("promo-indicator-banner");
    if (!window.loyaltyEnabled || !promoBanner) {
        if(promoBanner) promoBanner.classList.add("hidden"); 
        return;
    }

    let pointSummary = [];
    let wallet = member ? (member.wallet || {}) : {};
    
    let loyaltyItems = globalMenuData.filter(m => m.loyaltyThreshold > 0);
    loyaltyItems.forEach(item => {
        let w = wallet[item.name] || { points: 0, free: 0 };
        pointSummary.push(`💧 <strong>${item.name}</strong>: ${w.points}/${item.loyaltyThreshold} Poin${w.free > 0 ? ` <span style="color:#27ae60;">(🎁 ${w.free} Gratis)</span>` : ''}`);
    });

    for (let itemName in wallet) {
        if (!loyaltyItems.find(i => i.name === itemName)) {
             let w = wallet[itemName];
             pointSummary.push(`💧 <strong>${itemName}</strong>: ${w.points} Poin${w.free > 0 ? ` <span style="color:#27ae60;">(🎁 ${w.free} Gratis)</span>` : ''}`);
        }
    }
    
    if (pointSummary.length > 0) {
        promoBanner.innerHTML = `🌟 <strong>Info Saldo Poin:</strong><br>` + pointSummary.join('<br>');
        promoBanner.classList.remove("hidden");
    } else {
        promoBanner.innerHTML = `🌟 Promo Loyalty tidak ada barang aktif.`;
        promoBanner.classList.remove("hidden");
    }
}

function lockMenu() {
    isMenuLocked = true; activeCustomerProfile = null; 
    posSessions[activeSessionIndex].customer = null;
    posSessions[activeSessionIndex].cart = [];
    currentCart = posSessions[activeSessionIndex].cart;
    
    document.getElementById("customer-input-section").classList.remove("hidden");
    document.getElementById("active-customer-banner").classList.add("hidden");
    document.getElementById("glass-overlay").style.opacity = "1"; document.getElementById("glass-overlay").style.pointerEvents = "auto";
    document.getElementById("cust-phone").value = ""; document.getElementById("cust-name").value = ""; 
    renderCart();
    const promoBanner = document.getElementById("promo-indicator-banner");
    if(promoBanner) promoBanner.classList.add("hidden");
}

function unlockMenu(isGuest) {
    let phone = "-"; let name = "Walk-in";
    const promoBanner = document.getElementById("promo-indicator-banner");

    if (isGuest) { 
        document.getElementById("cust-phone").value = ""; document.getElementById("cust-name").value = "Walk-in"; activeCustomerProfile = null; 
        document.getElementById("active-cust-name").innerText = name;
        document.getElementById("active-cust-phone").innerText = "";
        document.getElementById("customer-input-section").classList.add("hidden");
        document.getElementById("active-customer-banner").classList.remove("hidden");
        if(promoBanner) promoBanner.classList.add("hidden");
        isMenuLocked = false; document.getElementById("glass-overlay").style.opacity = "0"; setTimeout(() => { document.getElementById("glass-overlay").style.pointerEvents = "none"; }, 300);
    } else {
        phone = document.getElementById("cust-phone").value.trim();
        name = document.getElementById("cust-name").value.trim() || "Pelanggan";
        if (phone.length < 5) return alert("Harap masukkan Nomor WhatsApp yang valid terlebih dahulu.");

        let searchPhone = phone.replace(/\D/g, '');
        if (searchPhone.startsWith('62')) searchPhone = '0' + searchPhone.substring(2);
        if (searchPhone.length > 0 && !searchPhone.startsWith('0')) searchPhone = '0' + searchPhone;

        const tx = db.transaction(["members"], "readonly");
        tx.objectStore("members").get(searchPhone).onsuccess = (ev) => {
            const member = ev.target.result;
            if (member) {
                activeCustomerProfile = member;
                name = member.name;
                document.getElementById("cust-name").value = name;
                updatePromoBanner(member);
            } else {
                activeCustomerProfile = { phone: searchPhone, name: name, wallet: {}, bottlesBorrowed: 0 };
                updatePromoBanner(activeCustomerProfile); 
            }

            document.getElementById("active-cust-name").innerText = name;
            document.getElementById("active-cust-phone").innerText = `(${searchPhone})`;
            document.getElementById("customer-input-section").classList.add("hidden");
            document.getElementById("active-customer-banner").classList.remove("hidden");
            isMenuLocked = false; document.getElementById("glass-overlay").style.opacity = "0"; setTimeout(() => { document.getElementById("glass-overlay").style.pointerEvents = "none"; }, 300);
        };
    }
}

// Core Sync Engine
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
            window.masterDrawerBalance = result.masterDrawerBalance || 0; 
            const tx = db.transaction(["staff", "menu", "settings", "members", "expense_categories"], "readwrite");
            
            const staffStore = tx.objectStore("staff"); staffStore.clear(); result.data.staff.forEach(s => staffStore.add(s));
            const menuStore = tx.objectStore("menu"); menuStore.clear(); result.data.menu.forEach(m => menuStore.add(m));
            const memStore = tx.objectStore("members"); memStore.clear(); result.data.members.forEach(m => memStore.add(m));
            const expCatStore = tx.objectStore("expense_categories"); expCatStore.clear(); 
            if(result.data.expenseCategories) result.data.expenseCategories.forEach(c => expCatStore.add({name: c}));
            const settingsStore = tx.objectStore("settings"); settingsStore.clear(); 
            for (const [key, value] of Object.entries(result.data.settings)) { settingsStore.add({ key: key, value: value }); }
            if (result.data.authStatuses) processVoidApprovals(result.data.authStatuses);

            globalMenuData = result.data.menu; 
            window.loyaltyEnabled = String(result.data.settings["Enable_Loyalty"]).toUpperCase() === "TRUE";
            
            const rawOutlets = result.data.settings["Outlet_List"] || "Pusat";
            const outletArray = rawOutlets.split(",").map(s => s.trim());
            const selectBox = document.getElementById("login-outlet");
            if(selectBox) {
                selectBox.innerHTML = `<option value="AUTO">🏠 Sesuai Cabang Asal</option>` + outletArray.map(o => `<option value="${o}">${o}</option>`).join("");
            }

            if(document.getElementById("network-text")) document.getElementById("network-text").innerText = "Online & Sinkron";
            if(document.getElementById("network-dot")) document.getElementById("network-dot").style.backgroundColor = "#2ecc71";
            if (!document.getElementById("pos-screen").classList.contains("hidden")) { loadMenuUI(); }
        } else { throw new Error(result.message); }
    } catch (e) { 
        if(document.getElementById("network-text")) document.getElementById("network-text").innerText = "Gagal Sinkron"; 
        if(document.getElementById("network-dot")) document.getElementById("network-dot").style.backgroundColor = "#e74c3c";
    }
}

// Customers Handling
function handleAutocomplete(e) {
    const val = e.target.value.toLowerCase().trim(); const resBox = document.getElementById("autocomplete-results");
    
    db.transaction(["members"], "readonly").objectStore("members").getAll().onsuccess = (ev) => {
        const members = ev.target.result; let matches = members;
        if (val.length > 0) matches = members.filter(m => String(m.phone).toLowerCase().includes(val) || String(m.name).toLowerCase().includes(val));
        matches.sort((a, b) => (b.spent || 0) - (a.spent || 0));

        if (matches.length > 0) {
            resBox.innerHTML = matches.map(m => {
                let wStr = JSON.stringify(m.wallet || {}).replace(/"/g, '&quot;');
                let nameStr = m.name.replace(/'/g, "\\'");
                
                return `<div class="autocomplete-item" onclick="selectMember('${m.phone}', '${nameStr}', '${wStr}', ${m.bottlesBorrowed || 0})">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <div class="autocomplete-name">${m.name}</div>
                        <div class="autocomplete-phone" style="font-size:14px; color:#7f8c8d;">${m.phone}</div>
                    </div>
                </div>`;
            }).join("");
            resBox.classList.remove("hidden");
        } else { resBox.classList.add("hidden"); }
    };
}

document.getElementById("cust-phone").addEventListener("input", handleAutocomplete);document.getElementById("cust-name").addEventListener("input", handleAutocomplete);document.getElementById("cust-phone").addEventListener("click", handleAutocomplete);document.getElementById("cust-name").addEventListener("click", handleAutocomplete);document.getElementById("cust-phone").addEventListener("focus", handleAutocomplete);document.getElementById("cust-name").addEventListener("focus", handleAutocomplete);document.addEventListener('click', (e) => { 
    if(!e.target.closest('.autocomplete-wrapper') && e.target.id !== 'cust-phone' && e.target.id !== 'cust-name') { document.getElementById('autocomplete-results').classList.add('hidden'); }
});

window.selectMember = function(phone, name, walletStr, dbBottlesBorrowed) {
    document.getElementById("cust-phone").value = phone; 
    document.getElementById("cust-name").value = name; 
    document.getElementById("autocomplete-results").classList.add("hidden");
};

function saveMemberToDB(phone, name) {
    if(!phone || phone === "-") return; 
    db.transaction(["members"], "readonly").objectStore("members").get(phone).onsuccess = (e) => {
        let mem = e.target.result || { phone: phone, name: name, wallet: {}, spent: 0, bottlesBorrowed: 0 }; mem.name = name;
        db.transaction(["members"], "readwrite").objectStore("members").put(mem);
        db.transaction(["unsynced_members"], "readwrite").objectStore("unsynced_members").put(mem);
    };
}

// Menu & Cart
function loadMenuUI() {
    const visibleItems = globalMenuData.filter(i => !i.hideOnPos); 
    const categories = [...new Set(visibleItems.map(i => i.category))]; 
    if(categories.length > 0) currentCategory = categories[0];
    
    const catContainer = document.getElementById("category-container"); catContainer.innerHTML = "";
    categories.forEach(cat => {
        const btn = document.createElement("button"); btn.className = `cat-btn ${cat === currentCategory ? "active" : ""}`; btn.innerText = cat;
        btn.onclick = () => { currentCategory = cat; document.querySelectorAll(".cat-btn").forEach(b => b.classList.remove("active")); btn.classList.add("active"); renderProductGrid(); };
        catContainer.appendChild(btn);
    });
    renderProductGrid();
}
function renderProductGrid() {
    const grid = document.getElementById("product-grid"); grid.innerHTML = "";
    
    const filteredMenu = globalMenuData.filter(i => {
        if (i.hideOnPos) return false; 
        if (i.category !== currentCategory) return false;
        
        const availableList = (i.availableAt || "ALL").toUpperCase();
        if (availableList === "ALL" || availableList === "") return true;
        return availableList.includes(currentOutlet.toUpperCase());
    });

    filteredMenu.forEach(item => {
        const card = document.createElement("div"); card.className = "product-card";
        card.innerHTML = `<div><h4 style="margin-top:0;">${item.name}</h4></div> <div class="price-badge">Rp ${item.price.toLocaleString('id-ID')}</div>`;
        card.onclick = () => { if(isMenuLocked) return; addToCart(item, 1); };
        grid.appendChild(card);
    });
}

function addToCart(item, qty) {
    const existing = currentCart.find(i => i.itemId === item.itemId);
    if (existing) { existing.qty += qty; } else { currentCart.push({ ...item, qty: qty, originalPrice: item.price, autoDeduct: item.autoDeduct, loyaltyThreshold: item.loyaltyThreshold, redeemed: 0 }); }
    renderCart();
}

window.updateCartQty = function(itemId, delta) {
    const item = currentCart.find(i => i.itemId === itemId);
    if (item) {
        item.qty += delta;
        if (item.qty <= 0) { currentCart = currentCart.filter(i => i.itemId !== itemId); }
        renderCart();
    }
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
    
    // Multi-Session: Update Cart Indicators
    posSessions.forEach((session, i) => {
        let qty = session.cart.reduce((sum, item) => sum + item.qty, 0);
        let btn = document.getElementById(`tab-btn-${i}`);
        let isActive = i === activeSessionIndex;
        if (qty > 0) {
            btn.innerHTML = `🛒 Antrean ${i+1} <span style="background:#e74c3c; color:white; border-radius:12px; padding:2px 6px; font-size:11px; margin-left:5px;">${qty}</span>`;
        } else {
            btn.innerHTML = `🛒 Antrean ${i+1}`;
        }
    });
}

function clearCart() { lockMenu(); }

// Checkout Flow & DYNAMIC Redemptions
function reviewOrder() {
    if (currentCart.length === 0) return alert("Keranjang masih kosong!");
    
    window.cartGrandTotal = window.cartSubtotal;
    
    const redeemContainer = document.getElementById("redemption-items");
    redeemContainer.innerHTML = "";
    let hasRedeemable = false;

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
                            <div style="display:flex; align-items:center; gap:8px;">
                                <label style="font-size:12px;">Pakai:</label>
                                <input type="number" class="redeem-input" data-item="${item.itemId}" data-price="${item.price}" max="${maxRedeemable}" min="0" value="0" style="width:60px; padding:8px; text-align:center; font-size:16px; border:2px solid #bdc3c7; border-radius:6px;" onclick="this.select()" oninput="recalcRedemptions()">
                            </div>
                        </div>
                    `;
                }
            }
        });
    }

    if (hasRedeemable) {
        document.getElementById("redemption-section").classList.remove("hidden");
    } else {
        document.getElementById("redemption-section").classList.add("hidden");
    }

    document.getElementById("pay-qris").value = 0; 
    document.getElementById("pay-transfer").value = 0; 
    document.getElementById("pay-free").value = 0; 
    let bottleRentBox = document.getElementById("rent-bottle-qty"); if(bottleRentBox) bottleRentBox.value = 0;
    
    document.getElementById("review-subtotal").innerText = `Rp ${window.cartSubtotal.toLocaleString('id-ID')}`;
    document.getElementById("review-grandtotal").innerText = `Rp ${window.cartGrandTotal.toLocaleString('id-ID')}`;
    
    document.getElementById("pay-cash").value = window.cartGrandTotal;
    calculateRemaining(); document.getElementById("review-modal").classList.remove("hidden");
}

window.recalcRedemptions = function() {
    let totalDiscount = 0;
    document.querySelectorAll(".redeem-input").forEach(input => {
        let qty = Number(input.value) || 0;
        let max = Number(input.getAttribute("max"));
        if(qty > max) { qty = max; input.value = max; }
        if(qty < 0) { qty = 0; input.value = 0; }
        let price = Number(input.getAttribute("data-price"));
        totalDiscount += (qty * price);
    });
    
    document.getElementById("pay-free").value = totalDiscount; 
    window.cartGrandTotal = Math.max(0, window.cartSubtotal - totalDiscount);
    document.getElementById("review-grandtotal").innerText = `Rp ${window.cartGrandTotal.toLocaleString('id-ID')}`;
    
    autoBalanceCash();
}

window.autoBalanceCash = function() {
    const q = Number(document.getElementById("pay-qris").value) || 0;
    const t = Number(document.getElementById("pay-transfer").value) || 0;
    
    const totalAccounted = q + t;
    const remaining = Math.max(0, window.cartGrandTotal - totalAccounted);
    
    document.getElementById("pay-cash").value = remaining;
    calculateRemaining();
}

window.calculateRemaining = function() {
    const c = Number(document.getElementById("pay-cash").value) || 0; 
    const q = Number(document.getElementById("pay-qris").value) || 0;
    const t = Number(document.getElementById("pay-transfer").value) || 0; 

    const totalAccounted = c + q + t; 
    const remaining = Math.max(0, window.cartGrandTotal - totalAccounted);
    document.getElementById("review-remaining").innerText = `Rp ${remaining.toLocaleString('id-ID')}`;
}

function closeReview() { document.getElementById("review-modal").classList.add("hidden"); }

async function finalizeOrder(shouldPrint) {
    const cash = Number(document.getElementById("pay-cash").value) || 0; const qris = Number(document.getElementById("pay-qris").value) || 0;
    const transfer = Number(document.getElementById("pay-transfer").value) || 0; const free = Number(document.getElementById("pay-free").value) || 0;
    const rentBottleQty = Number(document.getElementById("rent-bottle-qty").value) || 0;
    const totalAccounted = cash + qris + transfer; const remaining = window.cartGrandTotal - totalAccounted; 

    let custPhoneRaw = document.getElementById("cust-phone").value.trim(); let custPhone = custPhoneRaw || "-";
    const custName = document.getElementById("cust-name").value.trim() || "Walk-in";

    if (remaining > 0) return alert("⚠️ PEMBAYARAN DITOLAK:\nSisa Kurang Bayar harus Rp 0.");
    if (rentBottleQty > 0 && (!custPhone || custPhone === "-")) return alert("⚠️ PEMBAYARAN DITOLAK:\nAnda WAJIB memasukkan nomor WhatsApp pelanggan untuk mencatat Peminjaman Galon.");

    let payMethods = []; if(cash > 0) payMethods.push("Tunai"); if(qris > 0) payMethods.push("QRIS"); if(transfer > 0) payMethods.push("Trf.Bank"); if(free > 0) payMethods.push("Gratis");
    const payString = payMethods.length > 0 ? payMethods.join("+") : "Belum Bayar";
    if(custPhone !== "-") saveMemberToDB(custPhone, custName);

    let status = "Completed"; 
    
    currentCart.forEach(i => i.redeemed = 0);
    document.querySelectorAll(".redeem-input").forEach(input => {
        let itemId = input.getAttribute("data-item");
        let qty = Number(input.value) || 0;
        let cartItem = currentCart.find(i => i.itemId === itemId);
        if (cartItem) cartItem.redeemed = qty;
    });

    let loyaltyChanges = {};
    let freeItemsRedeemed = [];
    currentCart.forEach(item => {
        if (item.redeemed > 0) {
            freeItemsRedeemed.push({ name: item.name, qty: item.redeemed });
        }
        if (item.loyaltyThreshold > 0) {
            let earned = item.qty - (item.redeemed || 0); 
            if (earned > 0 || (item.redeemed || 0) > 0) {
                if(!loyaltyChanges[item.name]) loyaltyChanges[item.name] = { earned: 0, redeemed: 0, threshold: item.loyaltyThreshold };
                loyaltyChanges[item.name].earned += earned;
                loyaltyChanges[item.name].redeemed += (item.redeemed || 0);
            }
        }
    });

    let updatedWallet = {};
    if (window.loyaltyEnabled && activeCustomerProfile) {
        updatedWallet = JSON.parse(JSON.stringify(activeCustomerProfile.wallet || {})); 
        for(let itemName in loyaltyChanges) {
            if(!updatedWallet[itemName]) updatedWallet[itemName] = {points:0, free:0};
            let c = loyaltyChanges[itemName];
            updatedWallet[itemName].points += c.earned;
            updatedWallet[itemName].free -= c.redeemed;
            if(c.threshold > 0) {
                let newFree = Math.floor(updatedWallet[itemName].points / c.threshold);
                updatedWallet[itemName].points = updatedWallet[itemName].points % c.threshold;
                updatedWallet[itemName].free += newFree;
            }
        }
        
        db.transaction(["members"], "readwrite").objectStore("members").get(activeCustomerProfile.phone).onsuccess = (e) => {
            let mem = e.target.result; if (mem) { mem.wallet = updatedWallet; mem.bottlesBorrowed += rentBottleQty; db.transaction(["members"], "readwrite").objectStore("members").put(mem); }
        };
    }

    const orderPayload = {
        orderId: "ORD-" + Date.now(), timestamp: new Date().toISOString(), cashier: currentCashier, shiftId: currentShiftId,
        customerName: custName, customerPhone: custPhone, orderStatus: status, items: currentCart, subtotal: window.cartSubtotal, discounts: free, grandTotal: window.cartGrandTotal,
        paymentMethod: payString, cashAmount: cash, qrisAmount: qris, transferAmount: transfer, freeAmount: free, rentBottleQty: rentBottleQty, 
        loyaltyChanges: loyaltyChanges, freeItemsRedeemed: freeItemsRedeemed, outlet: currentOutlet, syncStatus: "Pending" 
    };

    const txMenu = db.transaction(["menu"], "readwrite"); const storeMenu = txMenu.objectStore("menu");
    currentCart.forEach(cartItem => {
        storeMenu.get(cartItem.itemId).onsuccess = (ev) => {
            const menuItem = ev.target.result; if (menuItem && menuItem.trackStock) { menuItem.currentStock = Math.max(0, menuItem.currentStock - cartItem.qty); storeMenu.put(menuItem); }
        };
    });

    db.transaction(["orders"], "readwrite").objectStore("orders").add(orderPayload);
    if (shouldPrint) { await buildPrintableReceipt(orderPayload.orderId, orderPayload, totalAccounted, 0, payString, updatedWallet); window.print(); }
    closeReview(); lockMenu(); renderProductGrid(); runBackgroundSync();
}

async function getDynamicSettings() { return new Promise(res => { let req = db.transaction(["settings"], "readonly").objectStore("settings").getAll(); req.onsuccess = e => { let s = {}; e.target.result.forEach(row => s[row.key] = row.value); res(s); }; }); }

async function buildPrintableReceipt(orderId, order, deposit, remaining, payMethod, updatedWallet) {
    const settings = await getDynamicSettings();
    const h1 = settings["Header_1"] || "PURE WATER"; 
    const h2 = settings["Header_2"] || ""; 
    let h3 = settings["Header_3"] || ""; if (settings["Header_3_" + order.outlet]) h3 = settings["Header_3_" + order.outlet]; 
    const f1 = settings["Footer_1"] || "TERIMA KASIH"; 
    const f2 = settings["Footer_2"] || ""; 
    let f3 = settings["Footer_3"] || ""; if (settings["Footer_3_" + order.outlet]) f3 = settings["Footer_3_" + order.outlet]; 

    const printArea = document.getElementById("printable-area"); const dateStr = new Date().toLocaleString('id-ID');
    
    let itemsHtml = "";
    order.items.forEach(item => { const lineTotal = item.qty * item.originalPrice; itemsHtml += `<div style="display:flex; justify-content:space-between; margin-bottom: 2px;"><span>${item.qty}x ${item.name}</span><span>${lineTotal.toLocaleString('id-ID')}</span></div>`; });
    
    let poinHtml = "";
    if (window.loyaltyEnabled && order.customerPhone && order.customerPhone !== "-") {
        let lines = [];
        let loyaltyItems = globalMenuData.filter(m => m.loyaltyThreshold > 0);
        loyaltyItems.forEach(item => {
            let data = updatedWallet[item.name] || {points: 0, free: 0};
            lines.push(`<strong>${item.name}</strong><br>Poin: ${data.points}/${item.loyaltyThreshold} | Gratis: ${data.free}`);
        });

        if (lines.length > 0) {
            poinHtml = `
            <div style="margin-top:10px; padding-top:5px; border-top:1px dashed #000; font-size:11px; text-align:center;">
                <strong>-- INFO POIN PURE --</strong><br>
                ${lines.join('<br>')}
            </div>`;
        }
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
            <div style="display:flex; justify-content:space-between; font-weight:bold; margin-top: 5px;"><span>STATUS:</span><span>LUNAS</span></div>
        </div>
        ${poinHtml}
        <div style="text-align:center; margin-top:15px; font-weight:bold; font-size: 12px;">${f1}</div>${f2 ? `<div style="text-align:center; margin-top:2px; font-size: 10px;">${f2}</div>` : ''}${f3 ? `<div style="text-align:center; margin-top:2px; font-size: 10px;">${f3}</div>` : ''}
    `;
}

// Inbound / Truck Logic
window.openInboundModal = function() {
    document.getElementById("inbound-qty").value = "";
    document.getElementById("inbound-notes").value = "";
    document.getElementById("inbound-modal").classList.remove("hidden");
}
window.submitInbound = function() {
    const qty = Number(document.getElementById("inbound-qty").value);
    const targetTank = document.getElementById("inbound-tank-target").value;
    const notes = document.getElementById("inbound-notes").value.trim() || "-";
    
    if (qty <= 0) return alert("Masukkan jumlah liter air yang benar.");

    const payload = {
        logId: "INB-" + Date.now(), timestamp: new Date().toISOString(), cashier: currentCashier, shiftId: currentShiftId,
        itemName: targetTank, qty: qty, notes: notes, outlet: currentOutlet, syncStatus: "Pending"
    };

    db.transaction(["stock_inbound"], "readwrite").objectStore("stock_inbound").add(payload);
    document.getElementById("inbound-modal").classList.add("hidden");
    alert(`Berhasil mencatat kedatangan ${qty} Liter ke ${targetTank}.`);
    runBackgroundSync();
}

// Expenses
function openExpenseModal() {
    document.getElementById("expense-modal").classList.remove("hidden");
    const list = document.getElementById("expense-category-list"); list.innerHTML = "";
    db.transaction(["expense_categories"], "readonly").objectStore("expense_categories").getAll().onsuccess = (e) => { e.target.result.forEach(cat => { const opt = document.createElement("option"); opt.value = cat.name; list.appendChild(opt); }); };
}
function saveExpense() {
    const amount = Number(document.getElementById("exp-amount").value); const category = document.getElementById("exp-category").value.trim();
    if (amount <= 0 || !category) return alert("Harap masukkan jumlah dan kategori yang benar.");
    db.transaction(["expense_categories"], "readwrite").objectStore("expense_categories").put({ name: category });

    const payload = { expenseId: "EXP-" + Date.now(), timestamp: new Date().toISOString(), cashier: currentCashier, shiftId: currentShiftId, category: category, description: document.getElementById("exp-desc").value || "-", amount: amount, status: "Active", outlet: currentOutlet, syncStatus: "Pending" };
    db.transaction(["expenses"], "readwrite").objectStore("expenses").add(payload);
    document.getElementById("expense-modal").classList.add("hidden"); document.getElementById("exp-amount").value = ""; document.getElementById("exp-category").value = ""; document.getElementById("exp-desc").value = ""; alert("Pengeluaran Berhasil Dicatat!"); runBackgroundSync();
}

// History & Voids
function openHistoryModal() { document.getElementById("history-modal").classList.remove("hidden"); renderHistoryList('orders'); }
function renderHistoryList(type) {
    const container = document.getElementById("history-container"); container.innerHTML = "";
    if (type === 'orders') {
        db.transaction(["orders"], "readonly").objectStore("orders").getAll().onsuccess = (e) => {
            const shiftOrders = e.target.result.filter(o => o.shiftId === currentShiftId).reverse(); 
            if(shiftOrders.length === 0) return container.innerHTML = `<div style="padding:20px; text-align:center;">Belum ada order di shift ini.</div>`;
            shiftOrders.forEach(o => {
                let badge = o.orderStatus === "Voided" ? `<span class="status-badge status-voided">Dibatalkan</span>` : o.orderStatus === "Void Pending" ? `<span class="status-badge status-pending">Menunggu Admin</span>` : `<span class="status-badge status-paid">${o.orderStatus}</span>`; 
                let btn = (o.orderStatus !== "Voided" && o.orderStatus !== "Void Pending") ? `<button onclick="requestVoid('orders', '${o.orderId}')" style="background:#e74c3c; color:white; border:none; padding:5px 10px; border-radius:4px; cursor:pointer;">Batal/Void</button>` : '';
                container.innerHTML += `<div class="history-row"><div><strong>${o.customerName}</strong><br><small style="color:#7f8c8d;">${new Date(o.timestamp).toLocaleTimeString()} | Rp ${o.grandTotal.toLocaleString('id-ID')}</small></div><div style="display:flex; align-items:center; gap:10px;">${badge} ${btn}</div></div>`;
            });
        };
    } else if (type === 'expenses') {
        db.transaction(["expenses"], "readonly").objectStore("expenses").getAll().onsuccess = (e) => {
            const shiftExpenses = e.target.result.filter(exp => exp.shiftId === currentShiftId).reverse();
            if(shiftExpenses.length === 0) return container.innerHTML = `<div style="padding:20px; text-align:center;">Belum ada pengeluaran dicatat.</div>`;
            shiftExpenses.forEach(exp => {
                let badge = exp.status === "Voided" ? `<span class="status-badge status-voided">Dibatalkan</span>` : exp.status === "Void Pending" ? `<span class="status-badge status-pending">Menunggu Admin</span>` : `<span class="status-badge status-paid">Aktif</span>`;
                let btn = (exp.status !== "Voided" && exp.status !== "Void Pending") ? `<button onclick="requestVoid('expenses', '${exp.expenseId}')" style="background:#e74c3c; color:white; border:none; padding:5px 10px; border-radius:4px; cursor:pointer;">Batal/Void</button>` : '';
                container.innerHTML += `<div class="history-row"><div><strong>${exp.category}</strong><br><small style="color:#7f8c8d;">${new Date(exp.timestamp).toLocaleTimeString()} | Rp ${exp.amount.toLocaleString('id-ID')}</small><br><small>${exp.description}</small></div><div style="display:flex; align-items:center; gap:10px;">${badge} ${btn}</div></div>`;
            });
        };
    } else if (type === 'shifts') {
        db.transaction(["local_shift_history"], "readonly").objectStore("local_shift_history").getAll().onsuccess = (e) => {
            const shifts = e.target.result.reverse();
            if(shifts.length === 0) return container.innerHTML = `<div style="padding:20px; text-align:center;">Belum ada histori shift di tablet ini.</div>`;
            shifts.forEach(s => {
                container.innerHTML += `<div class="history-row"><div><strong>Shift: ${s.shiftId}</strong><br><small style="color:#7f8c8d;">Kasir: ${s.cashier} | Keluar: ${new Date(s.logoutTime).toLocaleString('id-ID')}</small></div><div style="text-align:right;"><strong>Omset: Rp ${s.totalOmset.toLocaleString('id-ID')}</strong><br><small style="color:#27ae60;">Uang Tunai Laci: Rp ${s.netCash.toLocaleString('id-ID')}</small></div></div>`;
            });
        };
    }
}
function requestVoid(type, id) { currentVoidTarget = { type, id }; document.getElementById("admin-void-pin").value = ""; document.getElementById("admin-void-modal").classList.remove("hidden"); }
function submitRemoteVoid() {
    const type = currentVoidTarget.type; const id = currentVoidTarget.id; const storeName = type === 'orders' ? "orders" : "expenses";
    db.transaction([storeName], "readwrite").objectStore(storeName).get(id).onsuccess = (e) => {
        const item = e.target.result; if (type === 'orders') item.orderStatus = "Void Pending"; else item.status = "Void Pending";
        db.transaction([storeName], "readwrite").objectStore(storeName).put(item); renderHistoryList(type); 
    };
    db.transaction(["void_requests"], "readwrite").objectStore("void_requests").add({ id: id, type: type, status: "Void Pending", authName: "Menunggu" });
    document.getElementById("admin-void-modal").classList.add("hidden"); runBackgroundSync(); alert("Request Pembatalan dikirim ke Admin.");
}
async function confirmAdminVoid() {
    const pin = document.getElementById("admin-void-pin").value; if (!pin) return alert("Harap masukkan PIN Admin.");
    const settings = await getDynamicSettings(); const masterPin = String(settings["Master_PIN"]); const isMaster = (pin === masterPin);
    
    db.transaction(["staff"], "readonly").objectStore("staff").get(pin).onsuccess = (e) => {
        const staff = e.target.result; const isAdmin = (staff && staff.role.toLowerCase() === 'admin');
        if (isMaster || isAdmin) {
            const authName = isMaster ? "Master Admin" : staff.name; const type = currentVoidTarget.type; const id = currentVoidTarget.id; const storeName = type === 'orders' ? "orders" : "expenses";
            db.transaction([storeName], "readwrite").objectStore(storeName).get(id).onsuccess = (ev) => {
                const item = ev.target.result;
                if (type === 'orders') { item.orderStatus = "Voided"; item.voidAuth = authName; if(item.items) item.items.forEach(i => i.qty = Number(i.qty)); applyVoidAftermath(item); } 
                else { item.status = "Voided"; item.voidAuth = authName; }
                item.syncStatus = "Pending"; db.transaction([storeName], "readwrite").objectStore(storeName).put(item); renderHistoryList(type);
            };
            db.transaction(["void_requests"], "readwrite").objectStore("void_requests").add({ id: id, type: type, status: "Voided", authName: authName });
            document.getElementById("admin-void-modal").classList.add("hidden"); runBackgroundSync(); alert("Transaksi langsung Dibatalkan oleh: " + authName);
        } else { alert("PIN Salah atau Anda tidak memiliki akses Admin."); }
    };
}
function processVoidApprovals(authStatuses) {
    const tx = db.transaction(["orders", "expenses"], "readwrite"); const ordStore = tx.objectStore("orders"); const expStore = tx.objectStore("expenses"); let uiNeedsRefresh = false;
    ordStore.getAll().onsuccess = (e) => {
        e.target.result.forEach(order => {
            const remote = authStatuses.orders[order.orderId];
            if (remote) {
                if (remote.status === "Voided" && order.orderStatus !== "Voided") { order.orderStatus = "Voided"; ordStore.put(order); uiNeedsRefresh = true; applyVoidAftermath(order); } 
                else if (remote.status !== "Void Pending" && remote.status !== "Voided" && order.orderStatus === "Void Pending") { order.orderStatus = remote.status; ordStore.put(order); uiNeedsRefresh = true; }
            }
        });
        if (uiNeedsRefresh && !document.getElementById("history-modal").classList.contains("hidden")) renderHistoryList('orders');
    };
    expStore.getAll().onsuccess = (e) => {
        e.target.result.forEach(exp => {
            const remote = authStatuses.expenses[exp.expenseId];
            if (remote) {
                if (remote.status === "Voided" && exp.status !== "Voided") { exp.status = "Voided"; expStore.put(exp); uiNeedsRefresh = true; } 
                else if (remote.status !== "Void Pending" && remote.status !== "Voided" && exp.status === "Void Pending") { exp.status = remote.status; expStore.put(exp); uiNeedsRefresh = true; }
            }
        });
        if (uiNeedsRefresh && !document.getElementById("history-modal").classList.contains("hidden")) renderHistoryList('expenses');
    };
}
function applyVoidAftermath(order) {
    const tx = db.transaction(["menu", "members"], "readwrite"); const menuStore = tx.objectStore("menu"); const memberStore = tx.objectStore("members");

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
                
                if (order.loyaltyChanges && mem.wallet) {
                    for(let itemName in order.loyaltyChanges) {
                        let c = order.loyaltyChanges[itemName];
                        if(!mem.wallet[itemName]) mem.wallet[itemName] = {points:0, free:0};
                        
                        mem.wallet[itemName].points -= c.earned;
                        mem.wallet[itemName].free += c.redeemed;
                        
                        while (mem.wallet[itemName].points < 0 && mem.wallet[itemName].free > 0) {
                            mem.wallet[itemName].points += c.threshold;
                            mem.wallet[itemName].free -= 1;
                        }
                        if(mem.wallet[itemName].free < 0) mem.wallet[itemName].free = 0;
                        if(mem.wallet[itemName].points < 0) mem.wallet[itemName].points = 0;
                    }
                }
                memberStore.put(mem); 
            } 
        };
    }
    tx.oncomplete = () => { renderProductGrid(); };
    let payloadItems = []; if (order.items) order.items.forEach(i => payloadItems.push({name: i.name, qty: i.qty}));
    if (navigator.onLine) fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "executeVoidAftermath", data: { orderId: order.orderId, customerPhone: order.customerPhone, amount: order.grandTotal, itemsToReturn: payloadItems, rentBottleQty: order.rentBottleQty, loyaltyChanges: order.loyaltyChanges, outlet: order.outlet } }) });
}

// Cash Management
function calculateLiveDrawer(callback) {
    let liveDrawer = window.masterDrawerBalance || 0; 
    let tx = db.transaction(["orders", "cash_drops", "expenses"], "readonly");
    let ordersReq = tx.objectStore("orders").getAll(); let dropReq = tx.objectStore("cash_drops").getAll(); let expReq = tx.objectStore("expenses").getAll();
    tx.oncomplete = () => {
        ordersReq.result.forEach(o => { if (o.syncStatus === "Pending" && o.orderStatus !== "Voided" && o.orderStatus !== "Void Pending") liveDrawer += (o.cashAmount || 0); });
        dropReq.result.forEach(d => { if (d.syncStatus === "Pending") liveDrawer -= (d.toAdmin + d.toBank); });
        expReq.result.forEach(e => { if (e.syncStatus === "Pending" && e.status === "Active") liveDrawer -= (e.amount || 0); });
        callback(liveDrawer);
    };
}
function openCashDrop(forLogout = false) {
    isLoggingOut = forLogout; document.getElementById("cash-drop-title").innerText = isLoggingOut ? "🔒 Tutup Shift & Setor Laci" : "🏦 Simpan / Tarik Uang Laci";
    document.getElementById("btn-drop-cancel").innerText = isLoggingOut ? "Batal Logout" : "Batal"; document.getElementById("btn-drop-confirm").innerText = isLoggingOut ? "Konfirmasi & Logout" : "Simpan Data";
    document.getElementById("drop-amount").value = ""; document.getElementById("drop-destination").value = "Admin"; document.getElementById("drop-notes").value = "";
    
    calculateLiveDrawer((liveAmount) => { document.getElementById("live-drawer-display").innerText = `Rp ${liveAmount.toLocaleString('id-ID')}`; document.getElementById("cash-drop-modal").classList.remove("hidden"); });
}
function submitCashDrop() {
    const pullAmount = Number(document.getElementById("drop-amount").value) || 0;
    if (pullAmount < 0) return alert("⚠️ ERROR: Nominal uang tidak valid.");
    if (pullAmount === 0 && !isLoggingOut) return alert("⚠️ ERROR: Harap masukkan nominal uang yang diambil dari laci.");
    
    const destination = document.getElementById("drop-destination").value; const customNotes = document.getElementById("drop-notes").value || (isLoggingOut ? "Tutup Shift" : "Tarik Uang Tengah Shift");
    let adminAmt = 0; let bankAmt = 0; if (destination === "Bank") bankAmt = pullAmount; else adminAmt = pullAmount;
    const finalNotes = `[Ke ${destination}] ${customNotes}`;
    
    calculateLiveDrawer((liveAmount) => {
        const leftInDrawer = liveAmount - pullAmount;
        const payload = { dropId: "DRP-" + Date.now(), timestamp: new Date().toISOString(), cashier: currentCashier, shiftId: currentShiftId, toAdmin: adminAmt, toBank: bankAmt, leftInDrawer: leftInDrawer, notes: finalNotes, outlet: currentOutlet, syncStatus: "Pending" };
        db.transaction(["cash_drops"], "readwrite").objectStore("cash_drops").add(payload);
        document.getElementById("cash-drop-modal").classList.add("hidden"); runBackgroundSync();
        if (isLoggingOut) { executeFinalLogout(leftInDrawer); } else { alert(`Setor Uang Berhasil!\nTujuan: ${destination}\nSisa Tunai di Laci: Rp ${leftInDrawer.toLocaleString('id-ID')}`); }
    });
}

// Shift Reports
function openShiftReport() {
    let tCust = 0; let tOrders = 0; let tOmset = 0; let tCash = 0; let tQris = 0; let tTransfer = 0; let tFree = 0; let tExpense = 0; let foodSummary = {};
    document.getElementById("meter-water").value = "";
    
    db.transaction(["orders", "expenses"], "readonly").objectStore("orders").getAll().onsuccess = (e) => {
        const validOrders = e.target.result.filter(o => o.shiftId === currentShiftId && o.orderStatus !== "Voided" && o.orderStatus !== "Void Pending");
        validOrders.forEach(o => {
            tOrders++; if(o.customerPhone && o.customerPhone !== "-") tCust++; tOmset += o.grandTotal;
            tCash += (o.cashAmount || 0); tQris += (o.qrisAmount || 0); tTransfer += (o.transferAmount || 0); 
            tFree += (o.freeAmount || 0); 
            if (o.items) o.items.forEach(i => { if(!foodSummary[i.name]) foodSummary[i.name] = 0; foodSummary[i.name] += i.qty; });
        });
        
        db.transaction(["expenses"], "readonly").objectStore("expenses").getAll().onsuccess = (ex) => {
            const shiftExpenses = ex.target.result.filter(exp => exp.shiftId === currentShiftId && exp.status === "Active"); shiftExpenses.forEach(exp => { tExpense += (exp.amount || 0); });
            
            calculateLiveDrawer((liveDrawer) => {
                document.getElementById("sr-orders").innerText = tOrders; document.getElementById("sr-customers").innerText = tCust; document.getElementById("sr-omset").innerText = `Rp ${tOmset.toLocaleString('id-ID')}`;
                document.getElementById("sr-cash").innerText = `Rp ${tCash.toLocaleString('id-ID')}`; document.getElementById("sr-qris").innerText = `Rp ${tQris.toLocaleString('id-ID')}`; document.getElementById("sr-transfer").innerText = `Rp ${tTransfer.toLocaleString('id-ID')}`;
                document.getElementById("sr-free").innerText = `Rp ${tFree.toLocaleString('id-ID')}`;
                if(document.getElementById("sr-expense")) document.getElementById("sr-expense").innerText = `Rp ${tExpense.toLocaleString('id-ID')}`;
                document.getElementById("sr-net").innerText = `Rp ${liveDrawer.toLocaleString('id-ID')}`; document.getElementById("shift-report-modal").classList.remove("hidden");
                
                window.currentShiftData = { totalCustomers: tCust, totalOrders: tOrders, totalOmset: tOmset, totalCash: tCash, totalQris: tQris, totalTransfer: tTransfer, totalFree: tFree, totalExpenses: tExpense, net: liveDrawer, foodSummary };
            });
        };
    };
}
function initiateLogoutSequence() { 
    const meterW = document.getElementById("meter-water").value;
    if (meterW === "") return alert("⚠️ ERROR: Wajib mengisi Angka Meteran Air sebelum mengakhiri Shift.");
    window.currentShiftData.meterWater = Number(meterW);
    document.getElementById("shift-report-modal").classList.add("hidden"); openCashDrop(true); 
}
async function executeFinalLogout(netCash) { 
    const data = window.currentShiftData;
    const shiftPayload = {
        shiftId: currentShiftId, timestamp: new Date().toISOString(), cashier: currentCashier, loginTime: currentLoginTime, logoutTime: new Date().toISOString(), 
        totalCustomers: data.totalCustomers, totalOrders: data.totalOrders, totalOmset: data.totalOmset, totalCash: data.totalCash, totalQris: data.totalQris, totalTransfer: data.totalTransfer, totalFree: data.totalFree,
        totalExpenses: data.totalExpenses, netCash: netCash, foodSummary: data.foodSummary, meterWater: data.meterWater, outlet: currentOutlet, syncStatus: "Pending"
    };

    db.transaction(["local_shift_history"], "readwrite").objectStore("local_shift_history").add(shiftPayload);
    db.transaction(["shift_reports"], "readwrite").objectStore("shift_reports").add(shiftPayload);
    db.transaction(["active_shifts"], "readwrite").objectStore("active_shifts").delete(currentPin); 
    
    if (navigator.onLine) {
        if(document.getElementById("network-text")) document.getElementById("network-text").innerText = `Mengirim Laporan Shift...`;
        try {
            let r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "syncShiftReport", data: shiftPayload }) });
            if ((await r.json()).status === "Success") { db.transaction(["shift_reports"], "readwrite").objectStore("shift_reports").delete(shiftPayload.shiftId); }
        } catch(e) {}
    }
    window.location.reload(); 
}
function lockScreen() { window.location.reload(); }

// Background Sync Task
async function runBackgroundSync() {
    if (!navigator.onLine || isSyncing) return;
    isSyncing = true; 
    try {
        let tx = db.transaction(["orders", "cash_drops", "shift_reports", "expenses", "void_requests", "unsynced_members", "stock_inbound"], "readonly");
        
        let orders = await new Promise(res => tx.objectStore("orders").getAll().onsuccess = e => res(e.target.result));
        for (const order of orders) {
            if (order.syncStatus === "Pending") {
                order.syncStatus = "Syncing"; db.transaction(["orders"], "readwrite").objectStore("orders").put(order);
                try { let r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "syncOrder", data: order }) }); if ((await r.json()).status === "Success") { order.syncStatus = "Synced"; db.transaction(["orders"], "readwrite").objectStore("orders").put(order); } else { order.syncStatus = "Pending"; db.transaction(["orders"], "readwrite").objectStore("orders").put(order); } } catch(e) { order.syncStatus = "Pending"; db.transaction(["orders"], "readwrite").objectStore("orders").put(order); }
            }
        }
        
        let drops = await new Promise(res => tx.objectStore("cash_drops").getAll().onsuccess = e => res(e.target.result));
        for (const drop of drops) {
            if (drop.syncStatus === "Pending") { try { let r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "syncCashDrop", data: drop }) }); if ((await r.json()).status === "Success") { drop.syncStatus = "Synced"; db.transaction(["cash_drops"], "readwrite").objectStore("cash_drops").put(drop); } } catch(e) {} }
        }
        
        let reports = await new Promise(res => tx.objectStore("shift_reports").getAll().onsuccess = e => res(e.target.result));
        for (const report of reports) {
            if (report.syncStatus === "Pending") { try { let r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "syncShiftReport", data: report }) }); if ((await r.json()).status === "Success") { db.transaction(["shift_reports"], "readwrite").objectStore("shift_reports").delete(report.shiftId); } } catch(e) {} }
        }

        let expenses = await new Promise(res => tx.objectStore("expenses").getAll().onsuccess = e => res(e.target.result));
        for (const exp of expenses) {
            if (exp.syncStatus === "Pending") { try { let r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "syncExpense", data: exp }) }); if ((await r.json()).status === "Success") { exp.syncStatus = "Synced"; db.transaction(["expenses"], "readwrite").objectStore("expenses").put(exp); } } catch(e) {} }
        }

        let voids = await new Promise(res => tx.objectStore("void_requests").getAll().onsuccess = e => res(e.target.result));
        for (const req of voids) {
            try {
                const actionType = req.type === 'orders' ? "requestOrderVoid" : "requestExpenseVoid"; const payload = req.type === 'orders' ? { orderId: req.id, status: req.status, authName: req.authName } : { expenseId: req.id, status: req.status, authName: req.authName };
                let r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action: actionType, ...payload }) }); if ((await r.json()).status === "Success") { db.transaction(["void_requests"], "readwrite").objectStore("void_requests").delete(req.id); }
            } catch(e) {}
        }

        let members = await new Promise(res => tx.objectStore("unsynced_members").getAll().onsuccess = e => res(e.target.result));
        for (const mem of members) {
            try { let r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "syncMember", data: mem }) }); if ((await r.json()).status === "Success") { db.transaction(["unsynced_members"], "readwrite").objectStore("unsynced_members").delete(mem.phone); } } catch(e) {}
        }

        let inbounds = await new Promise(res => tx.objectStore("stock_inbound").getAll().onsuccess = e => res(e.target.result));
        for (const inb of inbounds) {
            if (inb.syncStatus === "Pending") {
                try { let r = await fetch(API_URL, { method: "POST", body: JSON.stringify({ action: "syncInbound", data: inb }) }); if ((await r.json()).status === "Success") { db.transaction(["stock_inbound"], "readwrite").objectStore("stock_inbound").delete(inb.logId); } } catch(e) {}
            }
        }
    } finally { isSyncing = false; }
}

window.onload = async () => { await initDB(); await syncMasterData(); window.setInterval(runBackgroundSync, 15000); };
