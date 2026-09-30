const fs = require('fs');
const path = require('path');
const { fetchFaceit } = require('./render-card');

const usersFile = path.join(__dirname, 'users.json');
const INTERVAL_MS = 15000;
const STATS_TTL_MS = 1800000;
const RETRY_AFTER_FAILURE_MS = 60000;

const PREMIER_TIERS = [
    { min: 30000, name: '30K+', color: 0xffd700 },
    { min: 25000, name: '25K+', color: 0xff4444 },
    { min: 20000, name: '20K+', color: 0xff8888 },
    { min: 15000, name: '15K+', color: 0xcc44cc },
    { min: 10000, name: '10K+', color: 0x6666ff },
    { min: 5000, name: '5K+', color: 0x88ccff },
    { min: 1000, name: '1K+', color: 0x808080 }
];

function faceitColor(level) {
    if (level >= 10) return 0xfe1f00;
    if (level >= 8) return 0xff6309;
    if (level >= 4) return 0xffc800;
    if (level >= 2) return 0x1ce400;
    return 0xeeeeee;
}

const FACEIT_TIERS = Array.from({ length: 10 }, (_, i) => ({
    level: i + 1,
    name: `LVL ${i + 1}`,
    color: faceitColor(i + 1)
}));

const statsCache = new Map();
const reportedErrors = new Set();

function reportOnce(key, message, error) {
    if (reportedErrors.has(key)) return;
    reportedErrors.add(key);
    console.error(message, error || '');
}

function loadUsers() {
    try { return JSON.parse(fs.readFileSync(usersFile, 'utf8')); } catch { return {}; }
}

async function fetchStats(steamId, faceitApiKey) {
    const cached = statsCache.get(steamId);
    if (cached && Date.now() - cached.at < STATS_TTL_MS) return cached;

    let premier = null;
    let leetifyFaceit = null;
    let ok = false;
    try {
        const res = await fetch(`https://api-public.cs-prod.leetify.com/v3/profile?steam64_id=${steamId}`);
        if (res.ok) {
            const data = await res.json();
            premier = data.ranks?.premier ?? null;
            leetifyFaceit = data.ranks?.faceit ?? null;
            ok = true;
        }
    } catch {}

    if (!ok && cached) {
        const kept = { ...cached, at: Date.now() - STATS_TTL_MS + RETRY_AFTER_FAILURE_MS };
        statsCache.set(steamId, kept);
        return kept;
    }

    const faceitInfo = await fetchFaceit(steamId, faceitApiKey);
    const stats = {
        at: ok ? Date.now() : Date.now() - STATS_TTL_MS + RETRY_AFTER_FAILURE_MS,
        premier,
        faceit: faceitInfo?.level ?? leetifyFaceit
    };
    statsCache.set(steamId, stats);
    return stats;
}

function premierTierFor(rating) {
    if (!rating) return null;
    return PREMIER_TIERS.find(t => rating >= t.min) || null;
}

function faceitTierFor(level) {
    if (!level) return null;
    return FACEIT_TIERS.find(t => t.level === level) || null;
}

async function ensureRole(guild, tier) {
    let role = guild.roles.cache.find(r => r.name === tier.name);
    if (!role) {
        return guild.roles.create({ name: tier.name, colors: { primaryColor: tier.color }, reason: 'CS rank role' });
    }
    if (role.colors.primaryColor !== tier.color && role.editable) {
        await role.setColors({ primaryColor: tier.color }, 'CS rank role color');
    }
    return role;
}

async function syncGroup(guild, member, tiers, wanted, label) {
    if (!wanted) return;
    const names = new Set(tiers.map(t => t.name));

    if (!member.roles.cache.some(r => r.name === wanted.name)) {
        try {
            const role = await ensureRole(guild, wanted);
            if (!role.editable) {
                reportOnce(`${guild.id}:${role.id}:hierarchy`, `[roles] ${guild.name}: role "${role.name}" is above the bot's highest role, move the bot's role higher`);
                return;
            }
            await member.roles.add(role, 'CS rank sync');
        } catch (error) {
            reportOnce(`${guild.id}:${wanted.name}:${error.code || error.message}`, `[roles] ${guild.name}: could not give "${wanted.name}" to ${label}:`, error.message);
            return;
        }
    }

    const stale = member.roles.cache.filter(r => names.has(r.name) && r.name !== wanted.name);
    for (const role of stale.values()) {
        try {
            if (!role.editable) {
                reportOnce(`${guild.id}:${role.id}:hierarchy`, `[roles] ${guild.name}: role "${role.name}" is above the bot's highest role, move the bot's role higher`);
                continue;
            }
            await member.roles.remove(role, 'CS rank sync');
        } catch (error) {
            reportOnce(`${guild.id}:${role.name}:${error.code || error.message}`, `[roles] ${guild.name}: could not remove "${role.name}" from ${label}:`, error.message);
        }
    }
}

async function syncUserRoles(client, discordId, user, stats) {
    const premierTier = premierTierFor(stats.premier);
    const faceitTier = faceitTierFor(stats.faceit);
    const label = user.name || discordId;

    for (const guild of client.guilds.cache.values()) {
        const member = await guild.members.fetch(discordId).catch(() => null);
        if (!member) continue;
        await syncGroup(guild, member, PREMIER_TIERS, premierTier, label);
        await syncGroup(guild, member, FACEIT_TIERS, faceitTier, label);
    }
}

async function runCycle(client, faceitApiKey) {
    const users = loadUsers();
    for (const [discordId, user] of Object.entries(users)) {
        if (!user?.steamId) continue;
        const stats = await fetchStats(user.steamId, faceitApiKey);
        await syncUserRoles(client, discordId, user, stats);
    }
}

async function applyStats(client, steamId, { premier, faceit }) {
    statsCache.set(steamId, { at: Date.now(), premier, faceit });
    const users = loadUsers();
    for (const [discordId, user] of Object.entries(users)) {
        if (user?.steamId !== steamId) continue;
        await syncUserRoles(client, discordId, user, { premier, faceit });
    }
}

let running = false;

function startRoleSync(client, faceitApiKey) {
    setInterval(async () => {
        if (running) return;
        running = true;
        try {
            await runCycle(client, faceitApiKey);
        } catch (error) {
            console.error('[roles] cycle error:', error);
        } finally {
            running = false;
        }
    }, INTERVAL_MS);
}

module.exports = { startRoleSync, applyStats };
