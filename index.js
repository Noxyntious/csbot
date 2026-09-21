const { Client, GatewayIntentBits, ActivityType, Collection, REST, Routes, AttachmentBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const toml = require('toml');
const { renderStatsCard } = require('./render-card');

// User data storage
const usersFile = path.join(__dirname, 'users.json');
function loadUsers() {
    try { return JSON.parse(fs.readFileSync(usersFile, 'utf8')); } catch { return {}; }
}
function saveUsers(users) {
    fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
}
const commands = new Collection();

let config;
try {
    const configFile = fs.readFileSync('./config.toml', 'utf8');
    config = toml.parse(configFile);
} catch (error) {
    console.error('[!!!!!!] error loading config.toml:', error);
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
    ]
});

// Resolve a steam profile URL or vanity name to a SteamID64
async function resolveSteamId(input) {
    const trimmed = input.trim();

    // already a SteamID64
    if (/^76561\d{12}$/.test(trimmed)) {
        return trimmed;
    }

    // extract from a full steamcommunity.com profile URL
    const profilesMatch = trimmed.match(/steamcommunity\.com\/profiles\/(76561\d{12})/);
    if (profilesMatch) {
        return profilesMatch[1];
    }

    // extract vanity from steamcommunity.com/id/URL
    const idMatch = trimmed.match(/steamcommunity\.com\/id\/([^/]+)/);
    if (idMatch) {
        return await resolveVanityUrl(idMatch[1]);
    }

    // otherwise treat the whole input as a vanity name
    return await resolveVanityUrl(trimmed);
}

async function resolveVanityUrl(vanityName) {
    const steamApiKey = config.steam?.api_key;
    if (!steamApiKey || steamApiKey === 'YOUR_STEAM_API_KEY_HERE') {
        throw new Error('steam_api_key_not_configured');
    }

    const response = await fetch(
        `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v0001/?key=${steamApiKey}&vanityurl=${encodeURIComponent(vanityName)}`
    );

    if (!response.ok) {
        throw new Error('steam_api_error');
    }

    const data = await response.json();
    if (data.response?.success !== 1 || !data.response?.steamid) {
        throw new Error('vanity_not_found');
    }

    return data.response.steamid;
}

commands.set('setuser', {
    data: {
        name: 'setuser',
        description: 'Set your default Steam account for the stats command',
        integration_types: [0, 1],
        contexts: [0, 1, 2],
        options: [
            {
                name: 'player',
                description: 'SteamID64, vanity name, or Steam profile URL',
                type: 3,
                required: true
            }
        ]
    },
    async execute(interaction) {
        const input = interaction.options.getString('player');

        await interaction.deferReply();

        try {
            let steamId;
            try {
                steamId = await resolveSteamId(input);
            } catch (err) {
                if (err.message === 'steam_api_key_not_configured') {
                    return interaction.editReply('Steam API key not configured. Please set `steam.api_key` in config.toml, or use a SteamID64 directly.');
                }
                if (err.message === 'vanity_not_found') {
                    return interaction.editReply('Could not find a Steam user with that name/URL. Make sure the input is correct.');
                }
                throw err;
            }

            const response = await fetch(`https://api-public.cs-prod.leetify.com/v3/profile?steam64_id=${steamId}`);
            if (!response.ok) {
                return interaction.editReply(`API returned status ${response.status}. Could not find this player.`);
            }
            const player = await response.json();
            if (!player || player.privacy_mode === 'private') {
                return interaction.editReply('This player has a private Leetify profile.');
            }

            const users = loadUsers();
            users[interaction.user.id] = { steamId, name: player.name };
            saveUsers(users);

            await interaction.editReply(`Set your account to **${player.name}** (${steamId})`);
        } catch (error) {
            console.error('[setuser] error:', error);
            await interaction.editReply('An error occurred while setting your account.');
        }
    }
});

commands.set('stats', {
    data: {
        name: 'stats',
        description: 'Look up a CS2 player\'s stats on Leetify',
        integration_types: [0, 1],
        contexts: [0, 1, 2],
        options: [
            {
                name: 'player',
                description: 'SteamID64, vanity name, or Steam profile URL',
                type: 3,
                required: false
            }
        ]
    },
    async execute(interaction) {
        let input = interaction.options.getString('player');

        // If no player specified, check for saved user
        if (!input) {
            const users = loadUsers();
            const saved = users[interaction.user.id];
            if (!saved) {
                return interaction.reply('No player specified and no default set. Use `/setuser` first or provide a player.');
            }
            input = saved.steamId;
        }

        await interaction.deferReply();

        try {
            let steamId;
            try {
                steamId = await resolveSteamId(input);
            } catch (err) {
                if (err.message === 'steam_api_key_not_configured') {
                    return interaction.editReply('Steam API key not configured. Please set `steam.api_key` in config.toml, or use a SteamID64 directly.');
                }
                if (err.message === 'vanity_not_found') {
                    return interaction.editReply('Could not find a Steam user with that name/URL. Make sure the input is correct.');
                }
                throw err;
            }

            const response = await fetch(`https://api-public.cs-prod.leetify.com/v3/profile?steam64_id=${steamId}`);

            if (!response.ok) {
                return interaction.editReply(`API returned status ${response.status}. The player may not have a Leetify profile or their profile is private.`);
            }

            const player = await response.json();

            if (!player || player.privacy_mode === 'private') {
                return interaction.editReply('This player has a private Leetify profile.');
            }

            const cardBuffer = await renderStatsCard(player);
            const attachment = new AttachmentBuilder(cardBuffer, { name: 'stats.png' });

            await interaction.editReply({ files: [attachment] });
        } catch (error) {
            console.error('[stats] error fetching player data:', error);
            await interaction.editReply('An error occurred while fetching player data. Please try again later.');
        }
    }
});

commands.set('id', {
    data: {
        name: 'id',
        description: 'Convert between Steam ID formats',
        integration_types: [0, 1],
        contexts: [0, 1, 2],
        options: [
            {
                name: 'input',
                description: 'SteamID64, legacy SteamID, SteamID3, or vanity URL',
                type: 3,
                required: true
            }
        ]
    },
    async execute(interaction) {
        const input = interaction.options.getString('input').trim();

        await interaction.deferReply();

        try {
            let steamId64 = null;

            // Try to resolve to a SteamID64
            // Already a SteamID64
            if (/^76561\d{12}$/.test(input)) {
                steamId64 = input;
            }
            // SteamID3: [U:1:XXXXX]
            else if (input.match(/^\[U:\d+:\d+\]$/)) {
                const accountId = parseInt(input.split(':')[2]);
                steamId64 = (BigInt(accountId) + 76561197960265728n).toString();
            }
            // Legacy SteamID: STEAM_X:Y:Z
            else if (input.match(/^STEAM_\d:\d:\d+$/)) {
                const parts = input.split(':');
                const accountId = parseInt(parts[1]) * 2 + parseInt(parts[2]);
                steamId64 = (BigInt(accountId) + 76561197960265728n).toString();
            }
            // Steam profile URL with vanity
            else if (input.match(/steamcommunity\.com\/id\/([^/]+)/)) {
                const vanity = input.match(/steamcommunity\.com\/id\/([^/]+)/)[1];
                steamId64 = await resolveVanityUrl(vanity);
            }
            // Steam profile URL with ID
            else if (input.match(/steamcommunity\.com\/profiles\/(\d+)/)) {
                steamId64 = input.match(/steamcommunity\.com\/profiles\/(\d+)/)[1];
            }
            // Assume vanity URL
            else {
                try {
                    steamId64 = await resolveVanityUrl(input);
                } catch {
                    return interaction.editReply('Could not resolve that input to a Steam account.');
                }
            }

            // Fetch player name from Steam XML
            let name = 'Unknown';
            try {
                const res = await fetch(`https://steamcommunity.com/profiles/${steamId64}?xml=1`);
                const xml = await res.text();
                const nameMatch = xml.match(/<steamID><!\[CDATA\[(.*?)\]\]><\/steamID>/);
                if (nameMatch) name = nameMatch[1];
            } catch {}

            // Convert to all formats
            const accountId = BigInt(steamId64) - 76561197960265728n;
            const y = accountId / 2n;
            const x = accountId % 2n;
            const steamId = `STEAM_0:${x}:${y}`;
            const steamId3 = `[U:1:${accountId}]`;

            const reply = `# ${name}\n\n` +
                `SteamID64: \`${steamId64}\`\n` +
                `SteamID: \`${steamId}\`\n` +
                `SteamID3: \`${steamId3}\`\n` +
                `Profile: <https://steamcommunity.com/profiles/${steamId64}>`;

            await interaction.editReply(reply);
        } catch (error) {
            console.error('[id] error:', error);
            await interaction.editReply('An error occurred while looking up that ID.');
        }
    }
});


// stolen
async function registerCommands() {
    const commandsData = Array.from(commands.values()).map(cmd => cmd.data);
    const rest = new REST({ version: '10' }).setToken(config.bot.token);
    try {
        console.log('[...] registering slash commands...');
        await rest.put(
            Routes.applicationCommands(config.bot.client_id),
            { body: commandsData }
        );
        console.log('[+] successfully registered slash commands');
    } catch (error) {
        console.error('[!] error registering commands:', error);
    }
}

client.once('clientReady', async () => {
    console.log(`[+] logged in as ${client.user.tag}!`);
    await registerCommands();
    if (config.settings.activity) {
        const activityType = ActivityType[config.settings.activity_type] || ActivityType.Playing;
        client.user.setActivity(config.settings.activity, { type: activityType });
    }
    if (config.settings.status) {
        client.user.setStatus(config.settings.status);
    }
});

// stolen
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = commands.get(interaction.commandName);
    if (!command) return;

    try {
        await command.execute(interaction);
    } catch (error) {
        console.error(`[!] error executing command ${interaction.commandName}:`, error);
        const errorMessage = { content: 'There was an error executing this command.', ephemeral: true };
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp(errorMessage);
        } else {
            await interaction.reply(errorMessage);
        }
    }
});




// also nabbed from one of my other bots just to make it a little nicer
client.on('error', (error) => {
    console.error('[!] discord client error:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[!] unhandled rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('[!!!!!!] uncaught exception:', error);
    process.exit(1);
});

process.on('SIGINT', () => {
    console.log('[...] received SIGINT, shutting down gracefully...');
    client.destroy();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('[...] received SIGTERM, shutting down gracefully...');
    client.destroy();
    process.exit(0);
});

client.login(config.bot.token);
