const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));
const { exec } = require('child_process');

function findLockfile() {
    const localAppData = process.env.LOCALAPPDATA;
    const lockfilePath = path.join(localAppData, 'Riot Games', 'Riot Client', 'Config', 'lockfile');
    if (fs.existsSync(lockfilePath)) {
        const content = fs.readFileSync(lockfilePath, 'utf8');
        const [name, pid, port, password, protocol] = content.split(':');
        return { port, password, protocol };
    }
    return null;
}

function getLocalClient() {
    const lockfile = findLockfile();
    if (!lockfile) return null;
    return axios.create({
        baseURL: `${lockfile.protocol}://127.0.0.1:${lockfile.port}`,
        headers: {
            'Authorization': `Basic ${Buffer.from(`riot:${lockfile.password}`).toString('base64')}`,
            'Content-Type': 'application/json'
        },
        httpsAgent: new https.Agent({ rejectUnauthorized: false })
    });
}

// Global tokens
let authData = {
    accessToken: null,
    entitlementsToken: null,
    puuid: null,
    shard: null,
    version: 'release-08.07-shipping-21-2437340' // Fallback
};

async function refreshAuth() {
    const client = getLocalClient();
    if (!client) throw new Error('Client not found');

    // Get Tokens
    const entRes = await client.get('/entitlements/v1/token');
    authData.accessToken = entRes.data.accessToken;
    authData.entitlementsToken = entRes.data.token;

    // Get PUUID via userinfo
    const userRes = await axios.get('https://auth.riotgames.com/userinfo', {
        headers: { 'Authorization': `Bearer ${authData.accessToken}` }
    });
    authData.puuid = userRes.data.sub;

    // Get Shard/Region
    try {
        const sessionRes = await client.get('/product-session/v1/external-sessions');
        const valSession = Object.values(sessionRes.data).find(s => s.productId === 'valorant');
        if (valSession) {
            const shardArg = valSession.launchConfiguration.arguments.find(a => a.startsWith('-ares-deployment='));
            if (shardArg) authData.shard = shardArg.split('=')[1];
        }
    } catch (e) {}

    if (!authData.shard) {
        const chatRes = await client.get('/chat/v1/session');
        authData.shard = chatRes.data.region.replace(/[0-9]/g, '');
    }

    // Get Version
    try {
        const verRes = await axios.get('https://valorant-api.com/v1/version');
        authData.version = verRes.data.data.riotClientVersion;
    } catch (e) {}

    return authData;
}

function getRemoteHeaders() {
    return {
        'Authorization': `Bearer ${authData.accessToken}`,
        'X-Riot-Entitlements-JWT': authData.entitlementsToken,
        'X-Riot-ClientVersion': authData.version,
        'X-Riot-ClientPlatform': 'ew0KCSJwbGF0Zm9ybVR5cGUiOiAiUEMiLA0KCSJwbGF0Zm9ybU9TIjogIldpbmRvd3MiLA0KCSJwbGF0Zm9ybU9TVmVyc2lvbiI6ICIxMC4wLjE5MDQyLjEuNzY4LjY0Yml0IiwNCgkicGxhdGZvcm1DaGlwc2V0IjogIlVua25vd24iDQp9',
        'Content-Type': 'application/json'
    };
}

// Status Endpoint
app.get('/api/status', async (req, res) => {
    try {
        const data = await refreshAuth();
        res.json({ connected: true, puuid: data.puuid, shard: data.shard });
    } catch (error) {
        res.json({ connected: false, message: error.message });
    }
});

// Update Presence & Loadout (Card, Title, Level)
app.post('/api/update-presence', async (req, res) => {
    const updates = req.body;
    console.log('Received updates:', updates);
    
    try {
        const client = getLocalClient();
        if (!client) throw new Error('Valorant client not found. Is the game running?');
        
        await refreshAuth();

        // 1. Update Local Presence (for friends)
        const presences = await client.get('/chat/v4/presences');
        const selfPresence = presences.data.presences.find(p => p.puuid === authData.puuid);
        
        if (selfPresence) {
            let decodedPrivate = JSON.parse(Buffer.from(selfPresence.private, 'base64').toString('utf8'));
            
            if (!decodedPrivate.playerPresenceData) decodedPrivate.playerPresenceData = {};
            
            const tier = (updates.competitiveTier !== undefined && updates.competitiveTier !== null) ? parseInt(updates.competitiveTier) : (decodedPrivate.playerPresenceData.competitiveTier || decodedPrivate.competitiveTier || 0);
            const pos = (updates.leaderboardPosition !== undefined && updates.leaderboardPosition !== "") ? parseInt(updates.leaderboardPosition) : (decodedPrivate.playerPresenceData.leaderboardPosition || decodedPrivate.leaderboardPosition || 0);

            // Update playerPresenceData fields (Competitive only)
            decodedPrivate.playerPresenceData.competitiveTier = String(tier);
            decodedPrivate.playerPresenceData.leaderboardPosition = String(pos);

            if (updates.playerCardId) decodedPrivate.playerPresenceData.playerCardId = updates.playerCardId;
            if (updates.playerTitleId) decodedPrivate.playerPresenceData.playerTitleId = updates.playerTitleId;
            if (updates.preferredLevelBorderId) decodedPrivate.playerPresenceData.preferredLevelBorderId = updates.preferredLevelBorderId;

            // Sync root fields
            decodedPrivate.competitiveTier = tier;
            decodedPrivate.leaderboardPosition = pos;

            console.log('--- DEBUG: Presence Payload (Safe) ---');
            console.log(JSON.stringify(decodedPrivate, null, 2));

            try {
                await client.put('/chat/v2/me', {
                    state: selfPresence.state || "chat",
                    private: Buffer.from(JSON.stringify(decodedPrivate)).toString('base64'),
                    shared: { 
                        ...(selfPresence.shared || {}), 
                        product: "valorant", 
                        time: Date.now() + 60000 
                    }
                });
                console.log('Presence PUT success');
            } catch (err) {
                console.error('Presence PUT failed:', err.response?.data || err.message);
            }
        }

        // 2. Update Remote Loadout (Only if identity fields are provided)
        const hasIdentityUpdates = updates.playerCardId || updates.playerTitleId || updates.preferredLevelBorderId;
        
        if (hasIdentityUpdates) {
            const pdUrl = `https://pd.${authData.shard}.a.pvp.net`;
            let loadout;
            let apiVersion = 'v3';

            try {
                const res = await axios.get(`${pdUrl}/personalization/v3/players/${authData.puuid}/playerloadout`, { headers: getRemoteHeaders() });
                loadout = res.data;
            } catch (e) {
                apiVersion = 'v2';
                const res = await axios.get(`${pdUrl}/personalization/v2/players/${authData.puuid}/playerloadout`, { headers: getRemoteHeaders() });
                loadout = res.data;
            }

            if (loadout && loadout.Identity) {
                if (updates.playerCardId) loadout.Identity.PlayerCardID = updates.playerCardId;
                if (updates.playerTitleId) loadout.Identity.PlayerTitleID = updates.playerTitleId;
                if (updates.preferredLevelBorderId) loadout.Identity.PreferredLevelBorderID = updates.preferredLevelBorderId;

                console.log('--- DEBUG: Loadout Payload (Safe) ---');
                console.log(JSON.stringify(loadout.Identity, null, 2));

                try {
                    await axios.put(`${pdUrl}/personalization/${apiVersion}/players/${authData.puuid}/playerloadout`, loadout, { headers: getRemoteHeaders() });
                    console.log('Loadout PUT success');
                } catch (err) {
                    console.error('Loadout PUT failed:', err.response?.data || err.message);
                }
            }
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Update error:', error.response?.data || error.message);
        res.status(500).json({ error: error.message });
    }
});

// Equip Skin Endpoint
app.post('/api/equip-skin', async (req, res) => {
    const { skinId } = req.body;
    try {
        await refreshAuth();
        const pdUrl = `https://pd.${authData.shard}.a.pvp.net`;
        
        // Fetch all weapons to find the gun for this skin
        const weaponsRes = await axios.get('https://valorant-api.com/v1/weapons');
        const weapons = weaponsRes.data.data;
        const weapon = weapons.find(w => w.skins.some(s => s.uuid === skinId));
        if (!weapon) throw new Error('Weapon not found for this skin');

        const skinData = weapon.skins.find(s => s.uuid === skinId);
        
        // Fetch current loadout
        const loadoutRes = await axios.get(`${pdUrl}/personalization/v2/players/${authData.puuid}/playerloadout`, { headers: getRemoteHeaders() });
        let loadout = loadoutRes.data;

        // Find weapon in loadout and update
        const gunInLoadout = loadout.Guns.find(g => g.ID.toLowerCase() === weapon.uuid.toLowerCase());
        if (gunInLoadout) {
            gunInLoadout.SkinID = skinId;
            gunInLoadout.SkinLevelID = skinData.levels[0].uuid;
            gunInLoadout.ChromaID = skinData.chromas[0].uuid;
        }

        await axios.put(`${pdUrl}/personalization/v2/players/${authData.puuid}/playerloadout`, loadout, { headers: getRemoteHeaders() });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    const url = `http://localhost:${PORT}`;
    console.log(`Server running at ${url}`);
    console.log('Opening browser...');
    
    // Auto-open browser
    const start = process.platform == 'darwin' ? 'open' : process.platform == 'win32' ? 'start' : 'xdg-open';
    exec(`${start} ${url}`);
});
