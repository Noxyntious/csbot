const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { renderStatsCard } = require('./render-card');

function crc32(buf) {
    let c, crc = 0xffffffff;
    for (let n = 0; n < buf.length; n++) {
        c = (crc ^ buf[n]) & 0xff;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crc = (crc >>> 8) ^ c;
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
}

function fakeAvatar(size = 184) {
    const raw = Buffer.alloc((size * 3 + 1) * size);
    for (let y = 0; y < size; y++) {
        const row = y * (size * 3 + 1);
        for (let x = 0; x < size; x++) {
            raw[row + 1 + x * 3] = Math.round((x / size) * 255);
            raw[row + 2 + x * 3] = Math.round((y / size) * 255);
            raw[row + 3 + x * 3] = 160;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

const backgroundFile = path.join(__dirname, 'background.jpg');

function toArrayBuffer(img) {
    return img.buffer.slice(img.byteOffset, img.byteOffset + img.byteLength);
}

global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('GetMiniProfileBackground')) {
        const body = { response: { profile_background: { image_large: 'preview/background.jpg' } } };
        return { ok: true, status: 200, json: async () => body };
    }
    if (u.includes('preview/background.jpg')) {
        const img = fs.readFileSync(backgroundFile);
        return { ok: true, status: 200, arrayBuffer: async () => toArrayBuffer(img) };
    }
    if (u.includes('GetPlayerSummaries')) {
        const body = { response: { players: [{ personaname: 'Preview Player', avatarfull: 'https://preview.invalid/avatar.jpg' }] } };
        return { ok: true, status: 200, json: async () => body };
    }
    if (u.includes('steamcommunity.com/profiles')) {
        const xml = '<steamID><![CDATA[Preview Player]]></steamID><avatarFull><![CDATA[https://preview.invalid/avatar.jpg]]></avatarFull>';
        return { ok: true, status: 200, text: async () => xml };
    }
    if (u === 'https://preview.invalid/avatar.jpg') {
        const img = fakeAvatar();
        return { ok: true, status: 200, arrayBuffer: async () => toArrayBuffer(img) };
    }
    throw new Error(`preview blocked network request: ${u}`);
};

const player = {
    steam64_id: '76561198000000000',
    name: 'Preview Player',
    total_matches: 1234,
    winrate: 0.52,
    ranks: {
        premier: 21450,
        leetify: 1.23,
        wingman: 14,
        competitive: [
            { map_name: 'de_mirage', rank: 16 },
            { map_name: 'de_inferno', rank: 18 },
            { map_name: 'de_ancient', rank: 13 },
            { map_name: 'de_overpass', rank: 17 },
            { map_name: 'de_vertigo', rank: 9 }
        ]
    },
    rating: { aim: 72.4, utility: 31.8, positioning: 58.9, t_leetify: 1.31, ct_leetify: 1.15 },
    stats: {
        accuracy_head: 24.6,
        reaction_time_ms: 542,
        spray_accuracy: 38.2,
        counter_strafing_good_shots_ratio: 81.7
    },
    recent_matches: [
        { outcome: 'win', map_name: 'de_mirage', score: [13, 9] },
        { outcome: 'loss', map_name: 'de_inferno', score: [7, 13] },
        { outcome: 'win', map_name: 'de_ancient', score: [13, 11] },
        { outcome: 'loss', map_name: 'de_overpass', score: [10, 13] },
        { outcome: 'win', map_name: 'de_vertigo', score: [13, 4] }
    ],
    bans: []
};

const faceit = { level: 9, elo: 2210 };
const out = path.join(__dirname, 'preview.png');

renderStatsCard(player, faceit, 'preview-key').then(buf => {
    fs.writeFileSync(out, buf);
    console.log(`wrote ${out}`);
    process.exit(0);
}).catch(error => {
    console.error(error);
    process.exit(1);
});
