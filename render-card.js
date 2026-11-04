const path = require('path');
const { createCanvas, GlobalFonts, loadImage } = require('@napi-rs/canvas');

const CARD_WIDTH = 900;
const CARD_HEIGHT = 420;

const ORANGE = '#BC451D';
const TIE = '#8F4A2A';
const GRAY = '#676767';
const LIGHT_GRAY = '#b8b8b8';
const WHITE = '#ffffff';

// Register the fonts once. @napi-rs/canvas rasterises everything natively,
// so we no longer need a browser to lay out/render the card.
for (const [file, alias] of [
    ['visitor2.ttf', 'visitor2'],
    ['munro_small.woff', 'munro']
]) {
    try {
        GlobalFonts.registerFromPath(path.join(__dirname, 'fonts', file), alias);
    } catch (error) {
        console.error(`[card] could not register font ${file}:`, error.message);
    }
}

// hhea metrics, matching what the browser uses for line box layout.
const FONT_METRICS = {
    visitor2: { ascent: 544 / 1000, descent: 156 / 1000 },
    munro: { ascent: 1854 / 2048, descent: 434 / 2048 }
};

async function fetchProfileSummary(steam64Id, steamApiKey) {
    if (steamApiKey) {
        const res = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${steamApiKey}&steamids=${steam64Id}`);
        if (!res.ok) throw new Error(`steam summary status ${res.status}`);
        const data = await res.json();
        const profile = data.response?.players?.[0];
        return { name: profile?.personaname || null, avatarUrl: profile?.avatarfull || null };
    }
    const res = await fetch(`https://steamcommunity.com/profiles/${steam64Id}?xml=1&_=${Date.now()}`);
    if (!res.ok) throw new Error(`steam profile status ${res.status}`);
    const xml = await res.text();
    const nameMatch = xml.match(/<steamID><!\[CDATA\[(.*?)\]\]><\/steamID>/);
    const avatarMatch = xml.match(/<avatarFull><!\[CDATA\[(.*?)\]\]><\/avatarFull>/);
    return { name: nameMatch ? nameMatch[1] : null, avatarUrl: avatarMatch ? avatarMatch[1] : null };
}

async function fetchSteamInfoOnce(steam64Id, steamApiKey) {
    const { name, avatarUrl } = await fetchProfileSummary(steam64Id, steamApiKey);
    let avatar = null;
    if (avatarUrl) {
        const imgRes = await fetch(avatarUrl);
        if (!imgRes.ok) throw new Error(`avatar status ${imgRes.status}`);
        const buf = Buffer.from(await imgRes.arrayBuffer());
        avatar = `data:image/jpeg;base64,${buf.toString('base64')}`;
    }
    return { name, avatar };
}

async function fetchSteamInfo(steam64Id, steamApiKey) {
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            return await fetchSteamInfoOnce(steam64Id, steamApiKey);
        } catch (error) {
            lastError = error;
            await new Promise(r => setTimeout(r, 500));
        }
    }
    console.error('[card] could not load steam profile info:', lastError.message);
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

function faceitColor(level) {
    if (level >= 10) return '#fe1f00';
    if (level >= 8) return '#ff6309';
    if (level >= 4) return '#ffc800';
    if (level >= 2) return '#1ce400';
    return '#eeeeee';
}

function statColor(t) {
    const hue = Math.round(120 * (1 - t));
    return `hsl(${hue}, 85%, 45%)`;
}

function setFont(ctx, size, family, spacing) {
    ctx.font = `${size}px ${family}`;
    ctx.letterSpacing = `${spacing || 0}px`;
}

function measure(ctx, text, size, family = 'visitor2', spacing = 0) {
    setFont(ctx, size, family, spacing);
    return ctx.measureText(text).width;
}

// Baseline position inside a CSS line box, using the font's hhea metrics.
function baselineOffset(top, size, lineHeight, family = 'visitor2') {
    const metrics = FONT_METRICS[family] || FONT_METRICS.visitor2;
    const ascent = metrics.ascent * size;
    const descent = metrics.descent * size;
    return top + (lineHeight - (ascent + descent)) / 2 + ascent;
}

function paintText(ctx, text, x, baseline, { size, family = 'visitor2', color = WHITE, spacing = 0, shadow = false }) {
    setFont(ctx, size, family, spacing);
    ctx.textBaseline = 'alphabetic';

    if (shadow) {
        // .left.has-bg > * { text-shadow: 0 0 6px #000, 0 0 3px #000, 1px 1px 0 #000 }
        ctx.fillStyle = '#000000';
        ctx.shadowColor = '#000000';
        for (const layer of [{ blur: 6, dx: 0, dy: 0 }, { blur: 3, dx: 0, dy: 0 }, { blur: 0, dx: 1, dy: 1 }]) {
            ctx.shadowBlur = layer.blur;
            ctx.shadowOffsetX = layer.dx;
            ctx.shadowOffsetY = layer.dy;
            ctx.fillText(text, x, baseline);
        }
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
    }

    ctx.fillStyle = color;
    ctx.fillText(text, x, baseline);
}

function drawTextLeft(ctx, text, x, baseline, opts) {
    paintText(ctx, text, x, baseline, opts);
}

function drawTextCenter(ctx, text, centerX, baseline, opts) {
    const width = measure(ctx, text, opts.size, opts.family, opts.spacing);
    paintText(ctx, text, centerX - width / 2, baseline, opts);
}

function drawTextRight(ctx, text, rightX, baseline, opts) {
    const width = measure(ctx, text, opts.size, opts.family, opts.spacing);
    paintText(ctx, text, rightX - width, baseline, opts);
}

function fitEllipsis(ctx, text, maxWidth, opts) {
    if (measure(ctx, text, opts.size, opts.family, opts.spacing) <= maxWidth) return text;
    const ellipsis = '\u2026';
    for (let i = text.length - 1; i >= 0; i--) {
        const candidate = text.slice(0, i) + ellipsis;
        if (measure(ctx, candidate, opts.size, opts.family, opts.spacing) <= maxWidth) return candidate;
    }
    return ellipsis;
}

function strokeRect(ctx, x, y, w, h, color, width = 1) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, width);
    ctx.fillRect(x, y + h - width, w, width);
    ctx.fillRect(x, y, width, h);
    ctx.fillRect(x + w - width, y, width, h);
}

function drawBar(ctx, x, y, width, value, worst, best) {
    // Browser layout often lands on a half pixel; it snaps the 8px bar to a pixel row.
    const barY = Math.round(y);
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(x, barY, width, 8);
    if (value == null || isNaN(value)) return;
    const t = Math.max(0, Math.min(1, (value - worst) / (best - worst)));
    ctx.fillStyle = statColor(t);
    ctx.fillRect(x, barY, width * t, 8);
}

function drawCover(ctx, image, x, y, w, h) {
    const scale = Math.max(w / image.width, h / image.height);
    const drawW = image.width * scale;
    const drawH = image.height * scale;
    ctx.drawImage(image, x + (w - drawW) / 2, y + (h - drawH) / 2, drawW, drawH);
}

function decodeDataUri(uri) {
    if (!uri || !uri.startsWith('data:')) return null;
    const comma = uri.indexOf(',');
    if (comma === -1) return null;
    return Buffer.from(uri.slice(comma + 1), 'base64');
}

function buildRankEntries(ranks) {
    const rankNames = {
        'de_nuke': 'Nuke', 'de_cache': 'Cache', 'de_dust2': 'Dust2',
        'cs_office': 'Office', 'de_anubis': 'Anubis', 'de_mirage': 'Mirage',
        'de_ancient': 'Ancient', 'de_inferno': 'Inferno', 'de_vertigo': 'Vertigo',
        'de_mills': 'Mills', 'de_train': 'Train', 'cs_agency': 'Agency',
        'de_overpass': 'Overpass'
    };

    const mmRanks = [
        'Silver 1', 'Silver 2', 'Silver 3', 'Silver 4', 'Silver Elite', 'SEM',
        'Gold Nova 1', 'Gold Nova 2', 'Gold Nova 3', 'Gold Nova M',
        'MG1', 'MG2', 'MGE', 'DMG',
        'LE', 'LEM', 'Supreme', 'Global Elite'
    ];

    const entries = [];
    if (ranks.wingman && ranks.wingman > 0) {
        entries.push({
            map: 'Wingman',
            value: mmRanks[ranks.wingman - 1] || `Rank ${ranks.wingman}`,
            wingman: true
        });
    }
    if (ranks.competitive && ranks.competitive.length > 0) {
        ranks.competitive.filter(r => r.rank > 0).sort((a, b) => b.rank - a.rank).forEach(r => {
            const mapName = rankNames[r.map_name] || r.map_name.replace('de_', '').replace('cs_', '');
            entries.push({
                map: mapName,
                value: mmRanks[r.rank - 1] || `Rank ${r.rank}`
            });
        });
    }
    return entries;
}

function drawLeftPanel(ctx, player, steamInfo, faceit, avatarImage, hasBackground) {
    const ranks = player.ranks || {};
    const rating = player.rating || {};
    const bans = player.bans || [];
    const textShadow = hasBackground;
    const gray = hasBackground ? LIGHT_GRAY : GRAY;

    const items = [];
    if (steamInfo.avatar) items.push({ type: 'avatar', height: 90 });
    items.push({ type: 'name', height: 29.4 });
    items.push({ type: 'steam', height: 15.4 });
    items.push({ type: 'premier', height: 72 });
    items.push({ type: 'premierLabel', height: 14 });

    if (faceit) items.push({ type: 'faceit', height: 28, marginTop: 6 });

    items.push({ type: 'winRate', height: 30 });
    items.push({ type: 'winRateLabel', height: 15.4 });
    items.push({ type: 'matches', height: 16.8, marginTop: 2 });
    if (bans.length > 0) items.push({ type: 'bans', height: 18.6, marginTop: 4 });
    items.push({ type: 'footer', height: 12.6 });

    const stackHeight = items.reduce((sum, item) => sum + item.height + (item.marginTop || 0), 0)
        + 4 * (items.length - 1);
    let y = 14 + (392 - stackHeight) / 2;
    const centerX = 131;

    for (const item of items) {
        y += item.marginTop || 0;

        switch (item.type) {
            case 'avatar': {
                const x = centerX - 45;
                const avatarY = Math.round(y);
                ctx.fillStyle = ORANGE;
                ctx.fillRect(x, avatarY, 90, 90);
                if (avatarImage) {
                    const previousSmoothing = ctx.imageSmoothingEnabled;
                    ctx.imageSmoothingEnabled = false;
                    ctx.drawImage(avatarImage, x + 2, avatarY + 2, 86, 86);
                    ctx.imageSmoothingEnabled = previousSmoothing;
                }
                break;
            }
            case 'name': {
                const opts = { size: 42, spacing: 2, color: ORANGE, shadow: textShadow };
                const name = (steamInfo.name || player.name || 'Unknown').toUpperCase();
                const baseline = baselineOffset(y, 42, 29.4);
                // Firefox starts an over-wide centred line at the left edge before
                // applying text-overflow: ellipsis rather than overflowing both sides.
                if (measure(ctx, name, 42, 'visitor2', 2) > 230) {
                    drawTextLeft(ctx, fitEllipsis(ctx, name, 230, opts), 16, baseline, opts);
                } else {
                    drawTextCenter(ctx, name, centerX, baseline, opts);
                }
                break;
            }
            case 'steam':
                drawTextCenter(ctx, `${player.steam64_id}`, centerX, baselineOffset(y, 22, 15.4, 'munro'), {
                    size: 22, family: 'munro', color: gray, shadow: textShadow
                });
                break;
            case 'premier':
                drawTextCenter(ctx, ranks.premier ? ranks.premier.toLocaleString() : 'N/A', centerX, baselineOffset(y, 72, 72), {
                    size: 72, color: premierColor(ranks.premier), shadow: textShadow
                });
                break;
            case 'premierLabel':
                drawTextCenter(ctx, 'PREMIER RATING', centerX, baselineOffset(y, 20, 14), {
                    size: 20, spacing: 2, color: ORANGE, shadow: textShadow
                });
                break;
            case 'faceit': {
                const color = faceitColor(faceit.level);
                const parts = [
                    { text: 'LVL ', size: 28, color },
                    { text: `${faceit.level}`, size: 28, color }
                ];
                if (faceit.elo) {
                    // The space between the level and the elo span belongs to the
                    // 28px parent, while the elo span itself is 20px.
                    parts.push({ text: ' ', size: 28, color });
                    parts.push({ text: `${faceit.elo}`, size: 20, color });
                }
                drawPartsCenter(ctx, parts, centerX, baselineOffset(y, 28, 28), { shadow: textShadow });
                break;
            }
            case 'winRate': {
                const parts = [
                    { text: ranks.leetify != null ? ranks.leetify.toFixed(2) : 'N/A', size: 30, color: WHITE },
                    { text: ' ', size: 30, color: WHITE },
                    { text: rating.t_leetify != null ? rating.t_leetify.toFixed(2) : 'N/A', size: 30, color: '#ffd700' },
                    { text: ' ', size: 30, color: WHITE },
                    { text: rating.ct_leetify != null ? rating.ct_leetify.toFixed(2) : 'N/A', size: 30, color: '#7272ff' }
                ];
                drawPartsCenter(ctx, parts, centerX, baselineOffset(y, 30, 30), { shadow: textShadow });
                break;
            }
            case 'winRateLabel':
                drawTextCenter(ctx, 'LEETIFY RATING', centerX, baselineOffset(y, 22, 15.4), {
                    size: 22, spacing: 3, color: ORANGE, shadow: textShadow
                });
                break;
            case 'matches':
                drawTextCenter(ctx, `${player.total_matches || 0} matches played`, centerX, baselineOffset(y, 24, 16.8), {
                    size: 24, color: gray, shadow: textShadow
                });
                break;
            case 'bans': {
                const tagOpts = { size: 18, spacing: 1, color: ORANGE, shadow: textShadow };
                const tags = bans.map(b => String(b.platform || '').toUpperCase());
                const widths = tags.map(text => measure(ctx, text, 18, 'visitor2', 1) + 14);
                const totalWidth = widths.reduce((a, b) => a + b, 0) + 4 * Math.max(0, tags.length - 1);
                let x = centerX - totalWidth / 2;
                const baseline = baselineOffset(y + 3, 18, 12.6);
                for (let i = 0; i < tags.length; i++) {
                    strokeRect(ctx, x, y, widths[i], 18.6, ORANGE, 1);
                    drawTextLeft(ctx, tags[i], x + 7, baseline, tagOpts);
                    x += widths[i] + 4;
                }
                break;
            }
            case 'footer':
                drawTextCenter(ctx, 'DATA FROM LEETIFY', centerX, baselineOffset(y, 18, 12.6), {
                    size: 18, spacing: 2, color: gray, shadow: textShadow
                });
                break;
        }

        y += item.height + 4;
    }
}

function drawPartsCenter(ctx, parts, centerX, baseline, { shadow = false } = {}) {
    let totalWidth = 0;
    for (const part of parts) {
        totalWidth += measure(ctx, part.text, part.size, 'visitor2', part.spacing || 0);
    }
    let x = centerX - totalWidth / 2;
    for (const part of parts) {
        paintText(ctx, part.text, x, baseline, {
            size: part.size,
            color: part.color,
            spacing: part.spacing || 0,
            shadow
        });
        x += measure(ctx, part.text, part.size, 'visitor2', part.spacing || 0);
    }
}

function drawRatingBox(ctx, x, y, label, value, bar) {
    strokeRect(ctx, x, y, 177, 94, GRAY, 1);

    drawTextLeft(ctx, label.toUpperCase(), x + 13, baselineOffset(y + 11, 20, 14), {
        size: 20, spacing: 2, color: GRAY
    });
    drawTextLeft(ctx, value, x + 13, baselineOffset(y + 27, 60, 42), {
        size: 60, color: WHITE
    });
    drawBar(ctx, x + 13, y + 75, 151, bar.value, bar.worst, bar.best);
}

function drawStatBox(ctx, x, y, label, value, bar) {
    strokeRect(ctx, x, y, 177, 88, GRAY, 1);

    drawTextLeft(ctx, label.toUpperCase(), x + 11, baselineOffset(y + 15.5, 18, 12.6), {
        size: 18, spacing: 2, color: GRAY
    });
    drawTextLeft(ctx, value, x + 11, baselineOffset(y + 29.1, 42, 29.4), {
        size: 42, color: WHITE
    });
    drawBar(ctx, x + 11, y + 64.5, 155, bar.value, bar.worst, bar.best);
}

function drawRecentMatches(ctx, recent) {
    drawTextRight(ctx, 'RECENT MATCHES', 878, baselineOffset(18, 22, 15.4), {
        size: 22, spacing: 3, color: ORANGE
    });

    if (recent.length === 0) {
        drawTextLeft(ctx, 'No recent matches', 658, baselineOffset(37.4, 22, 15.4), {
            size: 22, color: GRAY
        });
        return;
    }

    recent.slice(0, 5).forEach((match, index) => {
        const y = 37.4 + index * 30;
        const outcome = String(match.outcome || '').toLowerCase();
        const win = outcome === 'win';
        const tie = outcome === 'tie' || outcome === 'draw'
            || (!win && outcome !== 'loss' && Array.isArray(match.score) && match.score[0] === match.score[1]);
        const resultColor = tie ? TIE : win ? ORANGE : GRAY;

        strokeRect(ctx, 658, Math.round(y + 2), 24, 24, resultColor, 1);
        drawTextCenter(ctx, tie ? 'T' : win ? 'W' : 'L', 670, baselineOffset(y + 7.7, 18, 12.6), {
            size: 18, color: resultColor
        });

        const rawMap = (match.map_name || '').replace('de_', '').replace('cs_', '');
        const mapName = rawMap.charAt(0).toUpperCase() + rawMap.slice(1);
        const baseline = baselineOffset(y + 7, 20, 14);
        drawTextLeft(ctx, mapName, 690, baseline, { size: 20, color: WHITE });

        const score = Array.isArray(match.score) ? `${match.score[0]}-${match.score[1]}` : '';
        drawTextRight(ctx, score, 878, baseline, { size: 20, color: GRAY });
    });
}

function matchesListMinHeight(recentCount) {
    // title (line-height 15.4 + margin-bottom 2) + gap 2 + each 28px match + gap 2
    if (recentCount === 0) return 34.8;
    return 17.4 + 30 * Math.min(recentCount, 5);
}

function drawRanks(ctx, entries, recentCount) {
    if (entries.length === 0) return;

    const blockHeight = 17.4 + 23 * entries.length;
    // The matches list is flex:1, but its automatic minimum height stops it from
    // shrinking. Once the ranks are too tall, the ranks block overflows below the
    // card instead of sliding up over the matches list.
    const matchesHeight = Math.max(matchesListMinHeight(recentCount), 384 - 8 - blockHeight);
    const blockY = 18 + matchesHeight + 8;

    drawTextRight(ctx, 'RANKS', 878, baselineOffset(blockY, 22, 15.4), {
        size: 22, spacing: 3, color: ORANGE
    });

    entries.forEach((entry, index) => {
        const y = blockY + 19.4 + index * 23;
        // The 16px-tall rank value box (line-height 14 + 1px vertical padding)
        // is vertically centred in the 16px content box.
        const baseline = baselineOffset(y + 3, 20, 14);

        drawTextLeft(ctx, entry.map, 658, baseline, {
            size: 20,
            color: entry.wingman ? ORANGE : GRAY
        });
        drawTextRight(ctx, entry.value, 872, baseline, { size: 20, color: WHITE });
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(658, y + 20, 220, 1);
    });
}

async function renderStatsCard(player, faceitLookup, steamApiKey) {
    const [steamInfo, faceitInfo, background] = await Promise.all([
        fetchSteamInfo(player.steam64_id, steamApiKey),
        faceitLookup,
        fetchBackground(player.steam64_id, steamApiKey)
    ]);
    const faceit = faceitInfo || (player.ranks && player.ranks.faceit ? { level: player.ranks.faceit, elo: null } : null);

    const [avatarImage, backgroundImage] = await Promise.all([
        steamInfo.avatar ? loadImage(decodeDataUri(steamInfo.avatar)).catch(() => null) : null,
        background ? loadImage(decodeDataUri(background)).catch(() => null) : null
    ]);

    const canvas = createCanvas(CARD_WIDTH, CARD_HEIGHT);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

    // Left panel background (Steam mini-profile background, darkened by 78%).
    if (backgroundImage) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(2, 2, 260, 416);
        ctx.clip();
        ctx.imageSmoothingQuality = 'high';
        drawCover(ctx, backgroundImage, 2, 2, 260, 416);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.78)';
        ctx.fillRect(2, 2, 260, 416);
        ctx.restore();
    }

    drawLeftPanel(ctx, player, steamInfo, faceit, avatarImage, !!background);

    // Ratings grid.
    const rating = player.rating || {};
    const stats = player.stats || {};

    const ratingBoxes = [
        {
            label: 'Win Rate',
            value: player.winrate != null ? (player.winrate * 100).toFixed(1) + '%' : 'N/A',
            bar: { value: player.winrate != null ? player.winrate * 100 : null, worst: 15, best: 85 }
        },
        {
            label: 'Aim',
            value: rating.aim != null ? rating.aim.toFixed(1) : 'N/A',
            bar: { value: rating.aim, worst: 0, best: 100 }
        },
        {
            label: 'Utility',
            value: rating.utility != null ? rating.utility.toFixed(1) : 'N/A',
            bar: { value: rating.utility, worst: 0, best: 100 }
        },
        {
            label: 'Positioning',
            value: rating.positioning != null ? rating.positioning.toFixed(1) : 'N/A',
            bar: { value: rating.positioning, worst: 0, best: 100 }
        }
    ];
    const ratingPositions = [
        { x: 282, y: 18 }, { x: 465, y: 18 },
        { x: 282, y: 118 }, { x: 465, y: 118 }
    ];
    ratingBoxes.forEach((box, index) => {
        drawRatingBox(ctx, ratingPositions[index].x, ratingPositions[index].y, box.label, box.value, box.bar);
    });

    // Detailed stats grid.
    const statBoxes = [
        {
            label: 'HS %',
            value: stats.accuracy_head != null ? stats.accuracy_head.toFixed(1) + '%' : 'N/A',
            bar: { value: stats.accuracy_head, worst: 0, best: 50 }
        },
        {
            label: 'Time to damage',
            value: stats.reaction_time_ms ? stats.reaction_time_ms.toFixed(0) + 'ms' : 'N/A',
            bar: { value: stats.reaction_time_ms || null, worst: 900, best: 350 }
        },
        {
            label: 'Spray Acc',
            value: stats.spray_accuracy != null ? stats.spray_accuracy.toFixed(1) + '%' : 'N/A',
            bar: { value: stats.spray_accuracy, worst: 0, best: 60 }
        },
        {
            label: 'Counter-Strafe',
            value: stats.counter_strafing_good_shots_ratio != null ? stats.counter_strafing_good_shots_ratio.toFixed(1) + '%' : 'N/A',
            bar: { value: stats.counter_strafing_good_shots_ratio, worst: 30, best: 100 }
        }
    ];
    const statPositions = [
        { x: 282, y: 220 }, { x: 465, y: 220 },
        { x: 282, y: 314 }, { x: 465, y: 314 }
    ];
    statBoxes.forEach((box, index) => {
        drawStatBox(ctx, statPositions[index].x, statPositions[index].y, box.label, box.value, box.bar);
    });

    // Recent matches and competitive ranks.
    const recentMatches = player.recent_matches || [];
    drawRecentMatches(ctx, recentMatches);
    drawRanks(ctx, buildRankEntries(player.ranks || {}), recentMatches.length);

    // Card border, drawn last so it sits above the backgrounds.
    ctx.fillStyle = ORANGE;
    ctx.fillRect(0, 0, CARD_WIDTH, 2);
    ctx.fillRect(0, CARD_HEIGHT - 2, CARD_WIDTH, 2);
    ctx.fillRect(0, 0, 2, CARD_HEIGHT);
    ctx.fillRect(CARD_WIDTH - 2, 0, 2, CARD_HEIGHT);
    ctx.fillRect(260, 2, 2, CARD_HEIGHT - 4);

    return canvas.toBuffer('image/png');
}

module.exports = { renderStatsCard, fetchFaceit };
