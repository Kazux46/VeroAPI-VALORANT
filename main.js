const API_BASE = '/api';
const VAL_API = 'https://valorant-api.com/v1';

let selectedRank = null;
let selectedSkin = null;
let tiers = [], titles = [], cards = [], weapons = [], borders = [];
let reapplyInterval = null;

async function init() {
    setupTabSwitching();
    setupEventListeners();
    checkStatus();
    setInterval(checkStatus, 10000);
    await fetchData();
    loadPersistentData();
}

function loadPersistentData() {
    const savedRank = localStorage.getItem('selectedRank');
    if (savedRank) {
        selectedRank = parseInt(savedRank);
        // We'll highlight the card after they load in fetchData
    }
    
    const autoReapply = localStorage.getItem('autoReapply') === 'true';
    if (autoReapply) {
        document.getElementById('auto-reapply').checked = true;
        console.log('Restoring Auto-reapply');
        reapplyInterval = setInterval(() => applyChanges(false), 20000);
    }
}

function setupEventListeners() {
    document.getElementById('authorize-btn').onclick = checkStatus;
    document.getElementById('apply-rank-btn').onclick = () => applyChanges(true);
    document.getElementById('apply-customize-btn').onclick = () => applyChanges(true);
    document.getElementById('equip-skin-btn').onclick = equipSkin;
    
    document.getElementById('weapon-select').onchange = (e) => {
        const weaponId = e.target.value;
        renderSkins(weaponId);
    };

    document.getElementById('auto-reapply').onchange = (e) => {
        localStorage.setItem('autoReapply', e.target.checked);
        if (e.target.checked) {
            console.log('Auto-reapply enabled');
            reapplyInterval = setInterval(() => applyChanges(false), 20000);
        } else {
            console.log('Auto-reapply disabled');
            clearInterval(reapplyInterval);
            reapplyInterval = null;
        }
    };
}

function setupTabSwitching() {
    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.onclick = () => {
            const tabId = btn.getAttribute('data-tab');
            document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
            document.getElementById(`tab-${tabId}`).classList.add('active');
        };
    });
}

async function fetchData() {
    try {
        const [tiersRes, titlesRes, cardsRes, weaponsRes, bordersRes] = await Promise.all([
            fetch(`${VAL_API}/competitivetiers`),
            fetch(`${VAL_API}/playertitles`),
            fetch(`${VAL_API}/playercards`),
            fetch(`${VAL_API}/weapons`),
            fetch(`${VAL_API}/levelborders`)
        ]);

        const tiersJson = await tiersRes.json();
        tiers = tiersJson.data[tiersJson.data.length - 1].tiers.filter(t => t.tier > 0 && t.largeIcon);
        renderRankGrid();

        titles = (await titlesRes.json()).data;
        renderSelect('player-title-select', titles, 'displayName', 'uuid');

        cards = (await cardsRes.json()).data;
        renderSelect('player-card-select', cards, 'displayName', 'uuid');

        weapons = (await weaponsRes.json()).data;
        renderSelect('weapon-select', weapons, 'displayName', 'uuid');

        borders = (await bordersRes.json()).data;
        renderSelect('level-border-select', borders, 'startingLevel', 'uuid', 'Level ');

    } catch (error) {
        console.error('Fetch error:', error);
    }
}

function renderSelect(id, items, textKey, valKey, prefix = '') {
    const select = document.getElementById(id);
    if (!select) return;
    select.innerHTML = `<option value="">Choose ${id.split('-')[1]}...</option>`;
    items.forEach(item => {
        if (item[textKey] === undefined) return;
        const opt = document.createElement('option');
        opt.value = item[valKey];
        opt.innerText = prefix + item[textKey];
        select.appendChild(opt);
    });
}

function renderRankGrid() {
    const grid = document.getElementById('rank-grid');
    grid.innerHTML = '';
    tiers.forEach(tier => {
        const card = document.createElement('div');
        card.className = 'rank-card';
        card.innerHTML = `<img src="${tier.largeIcon}" alt="${tier.tierName}"><span>${tier.tierName}</span>`;
        card.onclick = () => {
            selectedRank = tier.tier;
            localStorage.setItem('selectedRank', selectedRank);
            document.querySelectorAll('#rank-grid .rank-card').forEach(el => el.classList.remove('selected'));
            card.classList.add('selected');
            document.getElementById('apply-rank-btn').disabled = false;
        };
        if (selectedRank === tier.tier) {
            card.classList.add('selected');
            document.getElementById('apply-rank-btn').disabled = false;
        }
        grid.appendChild(card);
    });
}

function renderSkins(weaponId) {
    const grid = document.getElementById('skins-grid');
    grid.innerHTML = '';
    const weapon = weapons.find(w => w.uuid === weaponId);
    if (!weapon) return;

    weapon.skins.forEach(skin => {
        const card = document.createElement('div');
        card.className = 'rank-card';
        card.innerHTML = `<img src="${skin.displayIcon || weapon.displayIcon}" alt="${skin.displayName}"><span>${skin.displayName}</span>`;
        card.onclick = () => {
            selectedSkin = skin.uuid;
            document.querySelectorAll('#skins-grid .rank-card').forEach(el => el.classList.remove('selected'));
            card.classList.add('selected');
            document.getElementById('equip-skin-btn').disabled = false;
        };
        grid.appendChild(card);
    });
}

async function checkStatus() {
    const authBtn = document.getElementById('authorize-btn');
    const badge = document.getElementById('connection-status');
    try {
        const response = await fetch(`${API_BASE}/status`);
        const data = await response.json();
        if (data.connected) {
            badge.className = 'status-badge connected';
            badge.innerHTML = '<span class="pulse"></span> AUTHORIZED';
            authBtn.innerText = 'RE-AUTHORIZE';
        } else {
            badge.className = 'status-badge disconnected';
            badge.innerHTML = '<span class="pulse"></span> UNAUTHORIZED';
            authBtn.innerText = 'AUTHORIZE';
        }
    } catch (e) {
        badge.className = 'status-badge disconnected';
        badge.innerHTML = '<span class="pulse"></span> ERROR';
    }
}

async function applyChanges(showAlert = true) {
    const payload = {
        competitiveTier: selectedRank,
        leaderboardPosition: document.getElementById('leaderboard-pos').value,
        playerTitleId: document.getElementById('player-title-select').value,
        playerCardId: document.getElementById('player-card-select').value,
        preferredLevelBorderId: document.getElementById('level-border-select').value
    };

    try {
        const res = await fetch(`${API_BASE}/update-presence`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (data.success) {
            if (showAlert) alert('Success! Change will be visible in the friends list.');
            else console.log('Auto-reapply success');
        } else if (showAlert) {
            alert('Error: ' + data.error);
        }
    } catch (e) {
        if (showAlert) alert('Failed to connect.');
    }
}

async function equipSkin() {
    const btn = this;
    btn.disabled = true;
    try {
        const res = await fetch(`${API_BASE}/equip-skin`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ skinId: selectedSkin })
        });
        const data = await res.json();
        if (data.success) alert('Skin equipped! Restart Valorant to see changes.');
        else alert('Error: ' + data.error);
    } catch (e) { alert('Failed to equip skin.'); }
    btn.disabled = false;
}

init();
