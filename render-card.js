const puppeteer = require('puppeteer');
const fs = require('fs');

function loadFontBase64(filename) {
    const ext = filename.split('.').pop();
    const mime = { ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff' }[ext];
    const buf = fs.readFileSync(require('path').join(__dirname, 'fonts', filename));
    return `data:${mime};base64,${buf.toString('base64')}`;
}

async function fetchSteamInfoOnce(steam64Id) {
    const res = await fetch(`https://steamcommunity.com/profiles/${steam64Id}?xml=1&_=${Date.now()}`);
    if (!res.ok) throw new Error(`steam profile status ${res.status}`);
    const xml = await res.text();
    const nameMatch = xml.match(/<steamID><!\[CDATA\[(.*?)\]\]><\/steamID>/);
    const avatarMatch = xml.match(/<avatarFull><!\[CDATA\[(.*?)\]\]><\/avatarFull>/);
    let avatar = null;
    if (avatarMatch) {
        const imgRes = await fetch(avatarMatch[1]);
        if (!imgRes.ok) throw new Error(`avatar status ${imgRes.status}`);
        const buf = Buffer.from(await imgRes.arrayBuffer());
        avatar = `data:image/jpeg;base64,${buf.toString('base64')}`;
    }
    return { name: nameMatch ? nameMatch[1] : null, avatar };
}

async function fetchSteamInfo(steam64Id) {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await fetchSteamInfoOnce(steam64Id);
        } catch {
            await new Promise(r => setTimeout(r, 500));
        }
    }
    return { name: null, avatar: null };
}

async function fetchBackground(steam64Id, steamApiKey) {
    if (!steamApiKey) return null;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const res = await fetch(`https://api.steampowered.com/IPlayerService/GetMiniProfileBackground/v1/?key=${steamApiKey}&steamid=${steam64Id}`);
            if (!res.ok) throw new Error(`background status ${res.status}`);
            const data = await res.json();
            const image = data.response?.profile_background?.image_large;
            if (!image) return null;
            const imgRes = await fetch(`https://cdn.akamai.steamstatic.com/steamcommunity/public/images/${image}`);
            if (!imgRes.ok) throw new Error(`background image status ${imgRes.status}`);
            const buf = Buffer.from(await imgRes.arrayBuffer());
            return `data:image/jpeg;base64,${buf.toString('base64')}`;
        } catch {
            await new Promise(r => setTimeout(r, 500));
        }
    }
    return null;
}

async function fetchFaceit(steam64Id, apiKey) {
    if (!apiKey) return null;
    for (const game of ['cs2', 'csgo']) {
        try {
            const res = await fetch(`https://open.faceit.com/data/v4/players?game=${game}&game_player_id=${steam64Id}`, {
                headers: { Authorization: `Bearer ${apiKey}` }
            });
            if (!res.ok) continue;
            const data = await res.json();
            const g = data.games && data.games[game];
            if (g && g.skill_level) return { level: g.skill_level, elo: g.faceit_elo };
        } catch {}
    }
    return null;
}

async function renderStatsCard(player, faceitLookup, steamApiKey) {
    const [steamInfo, faceitInfo, background] = await Promise.all([
        fetchSteamInfo(player.steam64_id),
        faceitLookup,
        fetchBackground(player.steam64_id, steamApiKey)
    ]);
    const faceit = faceitInfo || (player.ranks && player.ranks.faceit ? { level: player.ranks.faceit, elo: null } : null);

    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 900, height: 420, deviceScaleFactor: 1 });

        const ranks = player.ranks || {};
        const rating = player.rating || {};
        const stats = player.stats || {};
        const bans = player.bans || [];
        const recent = player.recent_matches || [];

        const rankNames = {
            'de_nuke': 'Nuke', 'de_cache': 'Cache', 'de_dust2': 'Dust2',
            'cs_office': 'Office', 'de_anubis': 'Anubis', 'de_mirage': 'Mirage',
            'de_ancient': 'Ancient', 'de_inferno': 'Inferno', 'de_vertigo': 'Vertigo',
            'de_mills': 'Mills', 'de_train': 'Train', 'cs_agency': 'Agency',
            'de_overpass': 'Overpass'
        };

        const mmRanks = [
            'Silver 1','Silver 2','Silver 3','Silver 4','Silver Elite','SEM',
            'Gold Nova 1','Gold Nova 2','Gold Nova 3','Gold Nova M',
            'MG1','MG2','MGE','DMG',
            'LE','LEM','Supreme','Global Elite'
        ];

        let compRanksHtml = '';
        const rankEntries = [];
        if (ranks.wingman && ranks.wingman > 0) {
            const wmName = mmRanks[ranks.wingman - 1] || `Rank ${ranks.wingman}`;
            rankEntries.push(`<div class="comp-rank"><span class="rank-map wingman">Wingman</span><span class="rank-val">${wmName}</span></div>`);
        }
        if (ranks.competitive && ranks.competitive.length > 0) {
            const valid = ranks.competitive.filter(r => r.rank > 0).sort((a, b) => b.rank - a.rank);
            valid.forEach(r => {
                const name = rankNames[r.map_name] || r.map_name.replace('de_', '').replace('cs_', '');
                const rankName = mmRanks[r.rank - 1] || `Rank ${r.rank}`;
                rankEntries.push(`<div class="comp-rank"><span class="rank-map">${name}</span><span class="rank-val">${rankName}</span></div>`);
            });
        }
        compRanksHtml = rankEntries.join('');

        let recentHtml = '';
        if (recent.length > 0) {
            recentHtml = recent.slice(0, 5).map(m => {
                const cls = m.outcome === 'win' ? 'win' : 'loss';
                const mapName = (m.map_name || '').replace('de_', '').replace('cs_', '');
                const capitalized = mapName.charAt(0).toUpperCase() + mapName.slice(1);
                return `<div class="match ${cls}">
                    <span class="match-left"><span class="match-result">${m.outcome === 'win' ? 'W' : 'L'}</span><span class="match-map">${capitalized}</span></span>
                    <span class="match-score">${m.score[0]}-${m.score[1]}</span>
                </div>`;
            }).join('');
        }

        let bansHtml = '';
        if (bans.length > 0) {
            bansHtml = `<div class="bans">${bans.map(b => `<span class="ban-tag">${b.platform}</span>`).join('')}</div>`;
        }

        function premierColor(rating) {
            if (rating == null) return '#555';
            if (rating >= 30000) return '#ffd700';
            if (rating >= 25000) return '#ff4444';
            if (rating >= 20000) return '#ff8888';
            if (rating >= 15000) return '#cc44cc';
            if (rating >= 10000) return '#6666ff';
            if (rating >= 5000) return '#88ccff';
            return '#808080';
        }

        function statBar(value, worst, best) {
            if (value == null || isNaN(value)) return '<div class="bar"></div>';
            const t = Math.max(0, Math.min(1, (value - worst) / (best - worst)));
            return `<div class="bar"><div class="bar-fill" style="width: ${(t * 100).toFixed(1)}%; background: hsl(${(120 * (1 - t)).toFixed(0)}, 85%, 45%)"></div></div>`;
        }

        function faceitColor(level) {
            if (level >= 10) return '#fe1f00';
            if (level >= 8) return '#ff6309';
            if (level >= 4) return '#ffc800';
            if (level >= 2) return '#1ce400';
            return '#eeeeee';
        }

        function mmRankColor(rank) {
            if (rank <= 6) return { bg: '#1a1a1a', color: '#808080' };
            if (rank <= 10) return { bg: '#2a2210', color: '#BC451D' };
            if (rank <= 13) return { bg: '#101a2a', color: '#88ccff' };
            if (rank <= 15) return { bg: '#1a102a', color: '#cc44cc' };
            if (rank <= 17) return { bg: '#2a1020', color: '#ff8888' };
            return { bg: '#2a2210', color: '#ffd700' };
        }

        const avatarSrc = steamInfo.avatar || '';

        const html = `<!DOCTYPE html>
<html>
<head>
<style>
    @font-face { font-family: 'visitor2'; src: url('${loadFontBase64('visitor2.ttf')}') format('truetype'); font-weight: 400; font-style: normal; }
    @font-face { font-family: 'mittel'; src: url('${loadFontBase64('mittel.otf')}') format('opentype'); font-weight: 400; font-style: normal; }
    @font-face { font-family: 'munro'; src: url('${loadFontBase64('munro_small.woff')}') format('woff'); font-weight: normal; font-style: normal; }
    @font-face { font-family: 'vga'; src: url('${loadFontBase64('vga.ttf')}') format('truetype'); font-weight: normal; font-style: normal; }
    
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    body {
        width: 900px;
        height: 420px;
        background: #000000;
        font-family: 'visitor2', 'vga', monospace;
        color: #ffffff;
        overflow: hidden;
    }

    .card {
        display: flex;
        width: 100%;
        height: 100%;
        border: 2px solid #BC451D;
    }

    .left {
        width: 260px;
        height: 100%;
        background: #000000;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 12px 16px;
        gap: 4px;
        border-right: 2px solid #BC451D;
    }

    .left.has-bg {
        background-color: #000000;
        background-size: cover;
        background-position: center;
    }

    .left.has-bg > * {
        text-shadow: 0 0 6px #000000, 0 0 3px #000000, 1px 1px 0 #000000;
    }

    .left.has-bg .steam-id,
    .left.has-bg .matches-count,
    .left.has-bg .footer {
        color: #b8b8b8;
    }

    .avatar {
        width: 90px;
        height: 90px;
        border: 2px solid #BC451D;
        image-rendering: pixelated;
    }

    .player-name {
        font-size: 42px;
        font-weight: normal;
        text-align: center;
        color: #BC451D;
        letter-spacing: 2px;
        text-transform: uppercase;
        max-width: 230px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .steam-id {
        font-size: 22px;
        color: #676767;
        font-family: 'munro', monospace;
    }

    .win-rate {
        font-size: 30px;
        font-weight: normal;
        color: #ffffff;
        line-height: 1;
    }

    .sub-rating {
        font-size: 30px;
    }

    .win-rate-label {
        font-size: 22px;
        color: #BC451D;
        text-transform: uppercase;
        letter-spacing: 3px;
    }

    .matches-count {
        font-size: 24px;
        color: #676767;
        margin-top: 2px;
    }

    .premier-rank {
        font-size: 72px;
        font-weight: normal;
        color: #ffffff;
        line-height: 1;
    }

    .premier-label {
        font-size: 20px;
        color: #BC451D;
        text-transform: uppercase;
        letter-spacing: 2px;
    }

    .faceit-rank {
        font-size: 28px;
        line-height: 1;
        margin-top: 6px;
    }

    .faceit-elo { font-size: 20px; }

    .right {
        flex: 1;
        height: 100%;
        padding: 16px 20px;
        display: flex;
        gap: 16px;
    }

    .right-left {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 8px;
        justify-content: space-between;
    }

    .right-right {
        width: 220px;
        display: flex;
        flex-direction: column;
        gap: 8px;
    }

    .section-title {
        font-size: 22px;
        text-transform: uppercase;
        letter-spacing: 3px;
        color: #BC451D;
        margin-bottom: 2px;
        text-align: right;
    }

    .ratings-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 6px;
        flex: 1;
    }

    .rating-box {
        border: 1px solid #676767;
        padding: 10px 12px;
        flex: 1;
        display: flex;
        flex-direction: column;
        justify-content: center;
    }

    .rating-label {
        font-size: 20px;
        color: #676767;
        text-transform: uppercase;
        letter-spacing: 2px;
        margin-bottom: 2px;
    }

    .rating-value {
        font-size: 60px;
        font-weight: normal;
    }

    .bar {
        height: 8px;
        background: #1a1a1a;
        margin-top: 6px;
    }

    .bar-fill { height: 100%; }

    .detailed-stats {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 6px;
        flex: 1;
    }

    .stat-box {
        border: 1px solid #676767;
        padding: 8px 10px;
        flex: 1;
        display: flex;
        flex-direction: column;
        justify-content: center;
    }

    .stat-label {
        font-size: 18px;
        color: #676767;
        text-transform: uppercase;
        letter-spacing: 2px;
        margin-bottom: 1px;
    }

    .stat-value {
        font-size: 42px;
        font-weight: normal;
        color: #ffffff;
    }

    .bottom-row {
        display: flex;
        gap: 16px;
        margin-top: auto;
    }

    .right-right .matches-list {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 2px;
    }

    .match {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 20px;
        padding: 2px 0;
        gap: 12px;
    }

    .match-result {
        width: 24px;
        height: 24px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 18px;
        border: 1px solid;
    }

    .match.win .match-result { border-color: #BC451D; color: #BC451D; }
    .match.loss .match-result { border-color: #676767; color: #676767; }
    .match-left { display: flex; align-items: center; gap: 8px; }
    .match-map { color: #ffffff; min-width: 50px; }
    .match-score { color: #676767; }

    .comp-ranks {
        display: flex;
        flex-direction: column;
        gap: 2px;
        width: 100%;
    }

    .comp-rank {
        display: flex;
        justify-content: space-between;
        align-items: center;
        font-size: 20px;
        padding: 2px 0;
        gap: 12px;
        border-bottom: 1px solid #1a1a1a;
    }

    .rank-map { color: #676767; }
    .rank-map.wingman { color: #BC451D; }
    .rank-val {
        padding: 1px 6px;
        font-size: 20px;
        white-space: nowrap;
        flex-shrink: 0;
    }

    .bans {
        display: flex;
        gap: 4px;
        margin-top: 4px;
    }

    .ban-tag {
        border: 1px solid #BC451D;
        color: #BC451D;
        font-size: 18px;
        padding: 2px 6px;
        text-transform: uppercase;
        letter-spacing: 1px;
    }

    .footer {
        font-size: 18px;
        color: #676767;
        text-align: left;
        letter-spacing: 2px;
        text-transform: uppercase;
    }
</style>
</head>
<body>
<div class="card">
    <div class="left${background ? ' has-bg' : ''}"${background ? ` style="background-image: linear-gradient(rgba(0, 0, 0, 0.78), rgba(0, 0, 0, 0.78)), url('${background}')"` : ''}>
        ${avatarSrc ? `<img class="avatar" src="${avatarSrc}" />` : ''}
        <div class="player-name">${steamInfo.name || player.name || 'Unknown'}</div>
        <div class="steam-id">${player.steam64_id}</div>
        <div class="premier-rank" style="color: ${premierColor(ranks.premier)}">${ranks.premier ? ranks.premier.toLocaleString() : 'N/A'}</div>
        <div class="premier-label">Premier Rating</div>
        ${faceit ? `<div class="faceit-rank" style="color: ${faceitColor(faceit.level)}">LVL ${faceit.level}${faceit.elo ? ` <span class="faceit-elo">${faceit.elo}</span>` : ''}</div>` : ''}
        <div class="win-rate"><span>${ranks.leetify != null ? ranks.leetify.toFixed(2) : 'N/A'}</span> <span class="sub-rating" style="color: #ffd700">${rating.t_leetify != null ? rating.t_leetify.toFixed(2) : 'N/A'}</span> <span class="sub-rating" style="color: #7272ff">${rating.ct_leetify != null ? rating.ct_leetify.toFixed(2) : 'N/A'}</span></div>
        <div class="win-rate-label">Leetify Rating</div>
        <div class="matches-count">${player.total_matches || 0} matches played</div>
        ${bansHtml}
        <div class="footer">Data from Leetify</div>
    </div>
    <div class="right">
        <div class="right-left">
            <div class="ratings-grid">
                <div class="rating-box">
                    <div class="rating-label">Win Rate</div>
                    <div class="rating-value">${player.winrate != null ? (player.winrate * 100).toFixed(1) + '%' : 'N/A'}</div>
                    ${statBar(player.winrate != null ? player.winrate * 100 : null, 15, 85)}
                </div>
                <div class="rating-box">
                    <div class="rating-label">Aim</div>
                    <div class="rating-value" style="color: #ffffff">${rating.aim != null ? rating.aim.toFixed(1) : 'N/A'}</div>
                    ${statBar(rating.aim, 0, 100)}
                </div>
                <div class="rating-box">
                    <div class="rating-label">Utility</div>
                    <div class="rating-value" style="color: #ffffff">${rating.utility != null ? rating.utility.toFixed(1) : 'N/A'}</div>
                    ${statBar(rating.utility, 0, 100)}
                </div>
                <div class="rating-box">
                    <div class="rating-label">Positioning</div>
                    <div class="rating-value" style="color: #ffffff">${rating.positioning != null ? rating.positioning.toFixed(1) : 'N/A'}</div>
                    ${statBar(rating.positioning, 0, 100)}
                </div>
            </div>
            <div class="detailed-stats">
                <div class="stat-box">
                    <div class="stat-label">HS %</div>
                    <div class="stat-value">${stats.accuracy_head != null ? stats.accuracy_head.toFixed(1) + '%' : 'N/A'}</div>
                    ${statBar(stats.accuracy_head, 0, 50)}
                </div>
                <div class="stat-box">
                    <div class="stat-label">Time to damage</div>
                    <div class="stat-value">${stats.reaction_time_ms ? stats.reaction_time_ms.toFixed(0) + 'ms' : 'N/A'}</div>
                    ${statBar(stats.reaction_time_ms || null, 900, 350)}
                </div>
                <div class="stat-box">
                    <div class="stat-label">Spray Acc</div>
                    <div class="stat-value">${stats.spray_accuracy != null ? stats.spray_accuracy.toFixed(1) + '%' : 'N/A'}</div>
                    ${statBar(stats.spray_accuracy, 0, 60)}
                </div>
                <div class="stat-box">
                    <div class="stat-label">Counter-Strafe</div>
                    <div class="stat-value">${stats.counter_strafing_good_shots_ratio != null ? stats.counter_strafing_good_shots_ratio.toFixed(1) + '%' : 'N/A'}</div>
                    ${statBar(stats.counter_strafing_good_shots_ratio, 30, 100)}
                </div>
            </div>
        </div>
        <div class="right-right">
            <div class="matches-list">
                <div class="section-title">Recent Matches</div>
                ${recentHtml || '<span style="color:#676767;font-size:22px;">No recent matches</span>'}
            </div>
            ${compRanksHtml ? `
            <div class="comp-ranks">
                <div class="section-title">Ranks</div>
                ${compRanksHtml}
            </div>` : ''}
        </div>
    </div>
</div>
</body>
</html>`;

        await page.setContent(html, { waitUntil: 'networkidle0' });
        await page.evaluate(() => Promise.all(
            Array.from(document.images).map(img => img.decode().catch(() => {}))
        ));

        const cardBuffer = await page.screenshot({
            type: 'png',
            clip: { x: 0, y: 0, width: 900, height: 420 }
        });

        return Buffer.from(cardBuffer);
    } finally {
        await browser.close();
    }
}

module.exports = { renderStatsCard, fetchFaceit };
