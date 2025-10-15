import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } from 'discord.js';
import fetch from 'node-fetch';

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const APPLICATION_ID = process.env.APPLICATION_ID;
const GUILD_ID = process.env.GUILD_ID || null;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Register slash command
const commands = [
  new SlashCommandBuilder()
    .setName('player')
    .setDescription('Show live NHL player stats')
    .addStringOption(opt => opt.setName('name').setDescription('Player name').setRequired(true))
    .toJSON()
];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
(async () => {
  try {
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(APPLICATION_ID, GUILD_ID), { body: commands });
      console.log('Registered guild commands');
    } else {
      await rest.put(Routes.applicationCommands(APPLICATION_ID), { body: commands });
      console.log('Registered global commands (may take up to 1 hour)');
    }
  } catch (err) {
    console.error('Error registering commands', err);
  }
})();

// Search player ID
async function searchPlayerId(name) {
  const q = encodeURIComponent(name);
  const url = `https://search.d3.nhle.com/api/v1/search/player?culture=en-us&limit=5&q=${q}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const json = await r.json();
  const players = json?.players || json?.data || json;
  if (!players || players.length === 0) return null;
  return players[0]?.id || null;
}

// Get player landing
async function getPlayerLanding(playerId) {
  const url = `https://api-web.nhle.com/v1/player/${playerId}/landing`;
  const r = await fetch(url);
  if (!r.ok) return null;
  return r.json();
}

// Get boxscore
async function getBoxscore(gameId) {
  const url = `https://api-web.nhle.com/v1/gamecenter/${gameId}/boxscore`;
  const r = await fetch(url);
  if (!r.ok) return null;
  return r.json();
}

// Format stats
function formatPlayerStatsFromBoxscore(boxscoreJson, playerId) {
  try {
    const teams = [...(boxscoreJson?.teams?.home?.players ? Object.values(boxscoreJson.teams.home.players) : []),
                   ...(boxscoreJson?.teams?.away?.players ? Object.values(boxscoreJson.teams.away.players) : [])];
    const p = teams.find(x => String(x.person?.id) === String(playerId));
    if (!p) return null;
    const stats = p.stats?.skaterStats || p.stats?.goalieStats || p.stats || {};
    const name = p.person?.fullName || 'Player';
    const lines = [`**${name}**`];
    if (stats.goals !== undefined) lines.push(`Goals: ${stats.goals}  Assists: ${stats.assists}  Points: ${ (stats.goals||0) + (stats.assists||0) }`);
    if (stats.shots !== undefined) lines.push(`Shots: ${stats.shots}`);
    if (stats.timeOnIce !== undefined) lines.push(`TOI: ${stats.timeOnIce}`);
    if (stats.saves !== undefined) lines.push(`Saves: ${stats.saves}  GA: ${stats.goalsAgainst || 'N/A'}`);
    return lines.join('\n');
  } catch (e) {
    console.error('format error', e);
    return null;
  }
}

// Bot command
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (interaction.commandName !== 'player') return;

  const name = interaction.options.getString('name', true);
  await interaction.deferReply();

  const playerId = await searchPlayerId(name);
  if (!playerId) {
    await interaction.editReply(`Could not find player **${name}**.`);
    return;
  }

  const landing = await getPlayerLanding(playerId);
  const currentGameId = landing?.player?.currentGameId || landing?.player?.gameId || landing?.liveGame?.gamePk;

  if (!currentGameId) {
    const text = `Player found but not in a live game.`;
    await interaction.editReply(text);
    return;
  }

  let boxscore = await getBoxscore(currentGameId);
  let summary = formatPlayerStatsFromBoxscore(boxscore, playerId) || 'No stat entry yet.';
  const msg = await interaction.editReply({ content: `Live stats (game ${currentGameId}) — updating every 60s:\n\n${summary}` });

  const intervalMs = 60_000;
  const maxUpdates = 120;
  let updates = 0;

  const timer = setInterval(async () => {
    try {
      updates++;
      if (updates > maxUpdates) { clearInterval(timer); return; }
      const newBox = await getBoxscore(currentGameId);
      const newSummary = formatPlayerStatsFromBoxscore(newBox, playerId) || 'No stat entry yet.';
      if (newSummary !== summary) {
        summary = newSummary;
        await interaction.editReply({ content: `Live stats (game ${currentGameId}) — updating every 60s:\n\n${summary}` });
      }
      if (!newBox) clearInterval(timer);
    } catch (e) {
      console.error('update error', e);
      clearInterval(timer);
    }
  }, intervalMs);
});

client.login(DISCORD_TOKEN);
