/**
 * ═══════════════════════════════════════════════════════════════════
 *  TARKAM Discord Bot — Clean Edition ✦
 *  Connected to Neon PostgreSQL (same DB as idolmeta.fun)
 *
 *  Features:
 *  - Slash commands: /leaderboard, /bracket, /skor, /profil, /jadwal, /stats
 *  - Auto-post match results when matches complete
 *  - Auto-update leaderboard messages
 *  - Reaction roles in #pilih-role
 *
 *  Design: Clean, Readable, Professional
 *  - Embed fields for structured data (columns, rows)
 *  - Monospace code blocks for tabular data (leaderboard)
 *  - Minimal decoration — let Discord's layout do the work
 *  - Subtle elegance: less noise, more clarity
 *  ═══════════════════════════════════════════════════════════════════
 */

import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  type TextChannel,
  type MessageReaction,
  type User,
  type Interaction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { neon } from '@neondatabase/serverless';

// ═══ CONFIG ═══
const BOT_TOKEN = process.env.BOT_TOKEN!;
const APP_ID = process.env.APP_ID || '1488261162205184051';
const GUILD_ID = process.env.GUILD_ID || '1510008183329132634';
const DATABASE_URL = process.env.DATABASE_URL!;
const PORT = parseInt(process.env.PORT || '3004', 10);

if (!BOT_TOKEN || !DATABASE_URL) {
  console.error('❌ BOT_TOKEN and DATABASE_URL are required');
  process.exit(1);
}

const sql = neon(DATABASE_URL, {
  fetchConnectionCache: true,
});

// Helper: query with timeout
async function queryWithTimeout<T>(promise: Promise<T>, timeoutMs = 10000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Query timeout after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

// ═══ COLOR PALETTE ═══
const C = {
  gold: '#F5C518',
  male: '#4A9EFF',
  female: '#FF4D8E',
  success: '#2ECC71',
  info: '#5865F2',
  danger: '#E74C3C',
  neutral: '#95A5A6',
};

// ═══ BRANDING ═══
const BRAND = {
  name: 'TARKAM',
  tagline: 'Idol Meta · Fan Made Edition',
  url: 'idolmeta.fun',
  footerIcon: 'https://idolmeta.fun/logo1.webp',
  get footerText() { return `${this.name} — ${this.url}`; },
  get footerTextFull() { return `${this.name} · ${this.tagline} — ${this.url}`; },
};

// ═══ CHANNEL MAP ═══ (will be resolved on ready)
const CHANNEL_MAP: Record<string, string> = {};

// ═══ STATE ═══
let lastMatchResultId: string | null = null;
const leaderboardMessageIds: Record<string, string> = {}; // division -> messageId

// ═══════════════════════════════════════════════════════════════
//  DATABASE QUERIES (matching actual Prisma schema)
// ═══════════════════════════════════════════════════════════════

async function getActiveTournaments() {
  return sql`
    SELECT t.id, t.name, t."weekNumber", t.division, t.status, t.format,
      s.number as season_number, s.status as season_status
    FROM "Tournament" t
    JOIN "Season" s ON t."seasonId" = s.id
    WHERE s.status = 'active'
    ORDER BY t.division, t."weekNumber"
  `;
}

async function getRecentMatchResults(limit = 5, division?: string, weekNumber?: number) {
  return queryWithTimeout(sql`
    SELECT m.id, m.round, m."matchNumber", m.bracket, m.format,
      m."score1", m."score2", m.status, m."completedAt",
      t1.name as team1_name, t2.name as team2_name,
      mvp.gamertag as mvp_tag,
      t.division, t."weekNumber"
    FROM "Match" m
    JOIN "Team" t1 ON m."team1Id" = t1.id
    JOIN "Team" t2 ON m."team2Id" = t2.id
    LEFT JOIN "Player" mvp ON m."mvpPlayerId" = mvp.id
    JOIN "Tournament" t ON m."tournamentId" = t.id
    JOIN "Season" s ON t."seasonId" = s.id
    WHERE m."completedAt" IS NOT NULL AND s.status = 'active'
      ${division ? sql`AND t.division = ${division}` : sql``}
      ${weekNumber ? sql`AND t."weekNumber" = ${weekNumber}` : sql``}
    ORDER BY m."completedAt" DESC
    LIMIT ${limit}
  `);
}

async function getLeaderboard(division: string, limit = 10) {
  return queryWithTimeout(sql`
    SELECT p.id, p.name, p.gamertag, p.division, p.tier, p.points,
      p."totalWins", p."totalMvp", p.streak, p."maxStreak", p.matches,
      RANK() OVER (ORDER BY p.points DESC, p."totalWins" DESC, p."totalMvp" DESC) as rank
    FROM "Player" p
    WHERE p.division = ${division} AND p."isActive" = true
    ORDER BY p.points DESC, p."totalWins" DESC, p."totalMvp" DESC
    LIMIT ${limit}
  `);
}

async function getPlayerByGamertag(gamertag: string) {
  const rows = await sql`
    SELECT p.id, p.name, p.gamertag, p.division, p.tier, p.avatar,
      p.points, p."totalWins", p."totalMvp", p.streak, p."maxStreak",
      p.matches, p.city, p."isActive"
    FROM "Player" p
    WHERE LOWER(p.gamertag) = LOWER(${gamertag})
    LIMIT 1
  `;
  return rows[0] || null;
}

async function getBracket(division: string, weekNumber?: number) {
  const tournaments = await sql`
    SELECT t.id, t.name, t."weekNumber", t.division, t.status, t.format
    FROM "Tournament" t
    JOIN "Season" s ON t."seasonId" = s.id
    WHERE s.status = 'active' AND t.division = ${division}
      ${weekNumber ? sql`AND t."weekNumber" = ${weekNumber}` : sql``}
    ORDER BY t."weekNumber" DESC
    LIMIT 1
  `;
  if (!tournaments.length) return null;
  const t = tournaments[0];

  const matches = await sql`
    SELECT m.id, m.round, m."matchNumber", m.bracket, m.format,
      m."score1", m."score2", m.status, m."completedAt",
      t1.name as team1_name, t2.name as team2_name,
      mvp.gamertag as mvp_tag,
      winner.name as winner_name
    FROM "Match" m
    JOIN "Team" t1 ON m."team1Id" = t1.id
    JOIN "Team" t2 ON m."team2Id" = t2.id
    LEFT JOIN "Player" mvp ON m."mvpPlayerId" = mvp.id
    LEFT JOIN "Team" winner ON m."winnerId" = winner.id
    WHERE m."tournamentId" = ${t.id}
    ORDER BY m.round DESC, m."matchNumber"
  `;

  const teams = await sql`
    SELECT tp."teamId", tp.tier, p.gamertag, p.tier as player_tier
    FROM "TeamPlayer" tp
    JOIN "Player" p ON tp."playerId" = p.id
    JOIN "Team" t ON tp."teamId" = t.id
    WHERE t."tournamentId" = ${t.id}
  `;

  return { tournament: t, matches, teams };
}

async function getTournamentStatus() {
  return sql`
    SELECT t.id, t.name, t."weekNumber", t.division, t.status, t.format,
      t."scheduledAt", t."prizePool",
      s.number as season_number
    FROM "Tournament" t
    JOIN "Season" s ON t."seasonId" = s.id
    WHERE s.status = 'active'
    ORDER BY t.division, t."weekNumber"
  `;
}

async function getLatestCompletedMatch() {
  const rows = await sql`
    SELECT m.id, m."completedAt"
    FROM "Match" m
    WHERE m."completedAt" IS NOT NULL
    ORDER BY m."completedAt" DESC
    LIMIT 1
  `;
  return rows[0] || null;
}

async function getStats() {
  const [players, matches, seasons, tournaments] = await Promise.all([
    sql`SELECT COUNT(*) as count FROM "Player" WHERE "isActive" = true`,
    sql`SELECT COUNT(*) as count FROM "Match" WHERE "completedAt" IS NOT NULL`,
    sql`SELECT number, status FROM "Season" WHERE status = 'active' LIMIT 1`,
    sql`SELECT COUNT(*) as count FROM "Tournament" t JOIN "Season" s ON t."seasonId" = s.id WHERE s.status = 'active'`,
  ]);
  return {
    totalPlayers: Number(players[0]?.count || 0),
    totalMatches: Number(matches[0]?.count || 0),
    activeSeason: seasons[0]?.number || '-',
    activeTournaments: Number(tournaments[0]?.count || 0),
  };
}

// ═══════════════════════════════════════════════════════════════
//  SLASH COMMANDS DEFINITION
// ═══════════════════════════════════════════════════════════════

const COMMANDS = [
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Lihat leaderboard peringkat')
    .addStringOption(o => o.setName('divisi').setDescription('Pilih divisi').addChoices(
      { name: '♂ Cowo', value: 'male' },
      { name: '♀ Cewe', value: 'female' },
    ).setRequired(false))
    .addIntegerOption(o => o.setName('week').setDescription('Week ke berapa (kosongkan = season ini)').setMinValue(1).setMaxValue(20)),

  new SlashCommandBuilder()
    .setName('bracket')
    .setDescription('Lihat bracket turnamen')
    .addStringOption(o => o.setName('divisi').setDescription('Pilih divisi').addChoices(
      { name: '♂ Cowo', value: 'male' },
      { name: '♀ Cewe', value: 'female' },
    ).setRequired(false))
    .addIntegerOption(o => o.setName('week').setDescription('Week ke berapa (kosongkan = week terbaru)').setMinValue(1).setMaxValue(20)),

  new SlashCommandBuilder()
    .setName('skor')
    .setDescription('Lihat hasil pertandingan terbaru')
    .addStringOption(o => o.setName('divisi').setDescription('Pilih divisi').addChoices(
      { name: '♂ Cowo', value: 'male' },
      { name: '♀ Cewe', value: 'female' },
    ).setRequired(false))
    .addIntegerOption(o => o.setName('week').setDescription('Week ke berapa (kosongkan = semua)').setMinValue(1).setMaxValue(20))
    .addIntegerOption(o => o.setName('jumlah').setDescription('Jumlah match (1-10)').setMinValue(1).setMaxValue(10)),

  new SlashCommandBuilder()
    .setName('profil')
    .setDescription('Lihat profil pemain')
    .addStringOption(o => o.setName('gamertag').setDescription('Gamertag pemain').setRequired(true)),

  new SlashCommandBuilder()
    .setName('jadwal')
    .setDescription('Lihat jadwal & status turnamen')
    .addIntegerOption(o => o.setName('week').setDescription('Week ke berapa (kosongkan = semua)').setMinValue(1).setMaxValue(20)),

  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Statistik TARKAM'),
].map(cmd => cmd.toJSON());

// ═══════════════════════════════════════════════════════════════
//  REGISTER SLASH COMMANDS
// ═══════════════════════════════════════════════════════════════

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  try {
    console.log('   Registering slash commands...');
    await rest.put(Routes.applicationGuildCommands(APP_ID, GUILD_ID), {
      body: COMMANDS,
    });
    console.log('✅ Slash commands registered');
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
  }
}

// ═══════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════

// Division config
function divConfig(division: string) {
  const isMale = division === 'male';
  return {
    isMale,
    emoji: isMale ? '♂' : '♀',
    label: isMale ? 'Cowo' : 'Cewe',
    color: isMale ? C.male : C.female,
  };
}

// Rank medal emoji
function rankMedal(rank: number): string {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `${rank}.`;
}

// Tier badge
function tierBadge(tier: string): string {
  const t = tier?.toUpperCase();
  if (t === 'S') return 'S-Tier';
  if (t === 'A') return 'A-Tier';
  return 'B-Tier';
}

// Win rate
function winRate(wins: number, matches: number): string {
  if (matches === 0) return '0%';
  return `${Math.round((wins / matches) * 100)}%`;
}

// Format number with dots (Indonesian style)
function fmtNum(n: number): string {
  return n.toLocaleString('id-ID');
}

// ═══════════════════════════════════════════════════════════════
//  LEADERBOARD EMBED — Clean Table Design
//  Uses monospace code block for spreadsheet-like readability
//  Fields for summary stats only
// ═══════════════════════════════════════════════════════════════

function buildLeaderboardEmbed(players: any[], division: string) {
  const div = divConfig(division);

  // Build monospace table in code block
  const lines = players.map((p: any) => {
    const rank = Number(p.rank);
    const medal = rankMedal(rank);
    const tag = p.gamertag.length > 14 ? p.gamertag.slice(0, 13) + '…' : p.gamertag;
    const pts = fmtNum(p.points).padStart(6);
    const w = `${p.totalWins}W`.padStart(3);
    const mvp = `${p.totalMvp}MVP`;
    const streak = p.streak > 1 ? ` S${p.streak}` : '';

    return ` ${medal}  ${tag.padEnd(15)} ${pts}  ${w}  ${mvp}${streak}`;
  });

  const table = '```\n' + lines.join('\n') + '\n```';

  // Summary fields
  const totalPts = players.reduce((s: number, p: any) => s + Number(p.points), 0);
  const avgPts = Math.round(totalPts / players.length);
  const topWins = players.reduce((s: number, p: any) => s + Number(p.totalWins), 0);
  const topMvp = players.reduce((s: number, p: any) => s + Number(p.totalMvp), 0);

  return new EmbedBuilder()
    .setColor(div.color)
    .setAuthor({
      name: `LEADERBOARD ${div.emoji} ${div.label.toUpperCase()}`,
      iconURL: BRAND.footerIcon,
    })
    .setDescription(table)
    .addFields(
      { name: 'Players', value: `${players.length}`, inline: true },
      { name: 'Avg Points', value: `${fmtNum(avgPts)}`, inline: true },
      { name: 'Total Wins', value: `${topWins}`, inline: true },
    )
    .setFooter({ text: BRAND.footerText, iconURL: BRAND.footerIcon })
    .setTimestamp();
}

// ═══════════════════════════════════════════════════════════════
//  MATCH RESULT EMBED — Inline Fields Design
//  Uses fields for team names and scores in a clean row layout
// ═══════════════════════════════════════════════════════════════

function buildMatchResultEmbed(match: any) {
  const div = divConfig(match.division);
  const s1 = match.score1 ?? 0;
  const s2 = match.score2 ?? 0;
  const isT1Winner = s1 > s2;
  const isT2Winner = s2 > s1;
  const winner = isT1Winner ? match.team1_name : match.team2_name;
  const isSweep = match.format === 'BO1'
    ? (s1 === 1 && s2 === 0) || (s1 === 0 && s2 === 1)
    : (s1 === 2 && s2 === 0) || (s1 === 0 && s2 === 2) || (s1 === 3 && s2 === 0) || (s1 === 0 && s2 === 3);

  const roundNames: Record<number, string> = { 1: 'Grand Final', 2: 'Semi Final', 3: 'Quarter Final', 4: 'Round of 16', 5: 'Round of 32' };
  const roundName = roundNames[match.round] || `Round ${match.round}`;
  const bracketLabel = match.bracket === 'winners' ? "Winner's Bracket" : match.bracket === 'losers' ? "Loser's Bracket" : '';

  const t1Display = isT1Winner ? `**${match.team1_name}**` : match.team1_name;
  const t2Display = isT2Winner ? `**${match.team2_name}**` : match.team2_name;
  const scoreDisplay = `**${s1} — ${s2}**`;

  const fields: any[] = [
    { name: 'Team 1', value: t1Display, inline: true },
    { name: 'Score', value: scoreDisplay, inline: true },
    { name: 'Team 2', value: t2Display, inline: true },
  ];

  // Result line in description
  const context = `${roundName}${bracketLabel ? ` · ${bracketLabel}` : ''} · ${match.format}`;
  const resultLine = `Winner: **${winner}**${isSweep ? ' _(Sweep!)_' : ''}`;
  const mvpLine = match.mvp_tag ? `\nMVP: **${match.mvp_tag}**` : '';

  return new EmbedBuilder()
    .setColor(div.color)
    .setAuthor({
      name: `MATCH RESULT — W${match.weekNumber} ${div.emoji} ${div.label.toUpperCase()}`,
      iconURL: BRAND.footerIcon,
    })
    .setDescription(`${context}\n${resultLine}${mvpLine}`)
    .addFields(fields)
    .setFooter({ text: BRAND.footerText, iconURL: BRAND.footerIcon })
    .setTimestamp(new Date(match.completedAt));
}

// ═══════════════════════════════════════════════════════════════
//  PROFILE EMBED — Player Card Design
//  Inline fields for stats organized in rows
// ═══════════════════════════════════════════════════════════════

function buildProfileEmbed(player: any) {
  const div = divConfig(player.division);
  const wr = winRate(player.totalWins, player.matches);

  const descParts: string[] = [
    tierBadge(player.tier) + ` · ${div.emoji} ${div.label}` + (player.city ? ` · ${player.city}` : ''),
    player.name,
  ];

  return new EmbedBuilder()
    .setColor(div.color)
    .setAuthor({
      name: `${player.gamertag}`,
      iconURL: BRAND.footerIcon,
    })
    .setDescription(descParts.join('\n'))
    .addFields(
      // Row 1: Points & Win Rate
      { name: 'Points', value: `**${fmtNum(player.points)}**`, inline: true },
      { name: 'Win Rate', value: `**${wr}**`, inline: true },
      { name: '\u200B', value: '\u200B', inline: true }, // spacer for 3-col alignment
      // Row 2: Wins & Matches
      { name: 'Wins', value: `**${player.totalWins}**`, inline: true },
      { name: 'Matches', value: `**${player.matches}**`, inline: true },
      { name: '\u200B', value: '\u200B', inline: true },
      // Row 3: MVP & Streak
      { name: 'MVP', value: `**${player.totalMvp}**`, inline: true },
      { name: 'Streak', value: `**${player.streak}** (max ${player.maxStreak})`, inline: true },
      { name: '\u200B', value: '\u200B', inline: true },
    )
    .setFooter({ text: BRAND.footerTextFull, iconURL: BRAND.footerIcon })
    .setTimestamp();
}

// ═══════════════════════════════════════════════════════════════
//  BRACKET EMBED — Field-per-Round Design
//  Each round gets its own field (full width) for clean layout
// ═══════════════════════════════════════════════════════════════

function buildBracketEmbed(data: any) {
  const t = data.tournament;
  const div = divConfig(t.division);
  const matches = data.matches;

  const roundNames: Record<number, string> = {
    1: 'Grand Final',
    2: 'Semi Final',
    3: 'Quarter Final',
    4: 'Round of 16',
    5: 'Round of 32',
  };

  // Group by round
  const byRound: Record<number, any[]> = {};
  for (const m of matches) {
    const r = m.round || 99;
    if (!byRound[r]) byRound[r] = [];
    byRound[r].push(m);
  }

  const fields: any[] = [];

  for (const [round, roundMatches] of Object.entries(byRound).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    const rName = roundNames[Number(round)] || `Round ${round}`;
    const bracketLabel = roundMatches[0]?.bracket === 'winners' ? "Winner's" : roundMatches[0]?.bracket === 'losers' ? "Loser's" : '';
    const fieldName = `${rName}${bracketLabel ? ` · ${bracketLabel}` : ''}`;

    const matchLines = roundMatches.map((m: any) => {
      const s1 = m.score1;
      const s2 = m.score2;

      // Completed match
      if (m.completedAt) {
        const isT1Win = typeof s1 === 'number' && typeof s2 === 'number' && s1 > s2;
        const isT2Win = typeof s1 === 'number' && typeof s2 === 'number' && s2 > s1;
        const t1 = isT1Win ? `**${m.team1_name}**` : m.team1_name;
        const t2 = isT2Win ? `**${m.team2_name}**` : m.team2_name;
        const mvpStr = m.mvp_tag ? `  MVP: ${m.mvp_tag}` : '';
        return `${t1}  **${s1} — ${s2}**  ${t2}${mvpStr}`;
      }

      // Live match
      if (m.status === 'live') {
        return `LIVE: ${m.team1_name}  vs  ${m.team2_name}`;
      }

      // Pending match
      return `${m.team1_name}  vs  ${m.team2_name}`;
    });

    fields.push({
      name: fieldName,
      value: matchLines.join('\n'),
      inline: false,
    });
  }

  // If no matches
  if (fields.length === 0) {
    fields.push({
      name: 'Bracket',
      value: 'Bracket belum tersedia untuk week ini',
      inline: false,
    });
  }

  // Status summary field
  const completedCount = matches.filter((m: any) => m.completedAt).length;
  const liveCount = matches.filter((m: any) => m.status === 'live').length;
  const pendingCount = matches.length - completedCount - liveCount;

  const statusParts: string[] = [];
  if (completedCount > 0) statusParts.push(`${completedCount} selesai`);
  if (liveCount > 0) statusParts.push(`${liveCount} live`);
  if (pendingCount > 0) statusParts.push(`${pendingCount} menunggu`);

  const statusLine = statusParts.join(' · ') || 'Belum ada match';
  fields.push({
    name: 'Status',
    value: `${statusLine} · ${matches.length} match total`,
    inline: false,
  });

  return new EmbedBuilder()
    .setColor(div.color)
    .setAuthor({
      name: `BRACKET W${t.weekNumber} ${div.emoji} ${div.label.toUpperCase()}`,
      iconURL: BRAND.footerIcon,
    })
    .addFields(fields)
    .setFooter({ text: BRAND.footerText, iconURL: BRAND.footerIcon })
    .setTimestamp();
}

// ═══════════════════════════════════════════════════════════════
//  JADWAL EMBED — Inline Fields Design
//  Each tournament as an inline field, male/female side by side
// ═══════════════════════════════════════════════════════════════

function buildJadwalEmbed(tournaments: any[], week?: number) {
  const statusMap: Record<string, string> = {
    'setup': 'Setup',
    'registration': 'Pendaftaran Dibuka!',
    'approval': 'Approval Peserta',
    'team_generation': 'Generate Tim',
    'bracket_generation': 'Generate Bracket',
    'main_event': 'LIVE',
    'finalization': 'Finalisasi',
    'completed': 'Selesai',
  };

  const fields: any[] = [];

  for (const t of tournaments) {
    const div = divConfig(t.division);
    const status = statusMap[t.status] || t.status;
    const prizeStr = t.prizePool ? `\nRp ${fmtNum(t.prizePool)}` : '';
    const isLive = t.status === 'main_event' || t.status === 'finalization';
    const isRegOpen = t.status === 'registration' || t.status === 'approval';
    const prefix = isLive ? '[LIVE] ' : isRegOpen ? '[OPEN] ' : '';

    fields.push({
      name: `${prefix}W${t.weekNumber} ${div.emoji} ${div.label}`,
      value: `${status}${prizeStr}`,
      inline: true,
    });
  }

  if (fields.length === 0) {
    fields.push({
      name: 'Jadwal',
      value: 'Belum ada turnamen aktif',
      inline: false,
    });
  }

  const title = week ? `JADWAL — W${week}` : 'JADWAL TURNAMEN';

  return new EmbedBuilder()
    .setColor(C.gold)
    .setAuthor({
      name: title,
      iconURL: BRAND.footerIcon,
    })
    .addFields(fields)
    .setFooter({ text: `${BRAND.footerText} · Cek lengkap di ${BRAND.url}`, iconURL: BRAND.footerIcon })
    .setTimestamp();
}

// ═══════════════════════════════════════════════════════════════
//  STATS EMBED — Inline Fields (3 per row)
//  Clean dashboard-style layout
// ═══════════════════════════════════════════════════════════════

function buildStatsEmbed(stats: any) {
  return new EmbedBuilder()
    .setColor(C.gold)
    .setAuthor({
      name: 'TARKAM STATISTIK',
      iconURL: BRAND.footerIcon,
    })
    .addFields(
      { name: 'Players', value: `**${fmtNum(stats.totalPlayers)}**`, inline: true },
      { name: 'Matches', value: `**${fmtNum(stats.totalMatches)}**`, inline: true },
      { name: 'Season', value: `**${stats.activeSeason}**`, inline: true },
      { name: 'Tournaments', value: `**${stats.activeTournaments}** aktif`, inline: true },
    )
    .setFooter({ text: `${BRAND.footerTextFull} · Real-time data`, iconURL: BRAND.footerIcon })
    .setTimestamp();
}

// ═══════════════════════════════════════════════════════════════
//  REACTION ROLES EMBED — Clean Design
// ═══════════════════════════════════════════════════════════════

function buildReactionRolesEmbed() {
  return new EmbedBuilder()
    .setColor(C.gold)
    .setAuthor({
      name: 'PILIH ROLE KAMU',
      iconURL: BRAND.footerIcon,
    })
    .setDescription(
      'React dengan emoji di bawah untuk mendapat role:\n\n' +
      '🟢  —  🎮 **Peserta Cowo**\n' +
      '🔴  —  💃 **Peserta Cewe**\n' +
      '💎  —  💎 **Supporter**\n' +
      '🎵  —  🎵 **Idol Meta Fan**'
    )
    .setFooter({ text: BRAND.footerText, iconURL: BRAND.footerIcon });
}

// ═══════════════════════════════════════════════════════════════
//  MATCH ANNOUNCEMENT EMBED — Clean List Design
//  One line per match with winner highlighted
// ═══════════════════════════════════════════════════════════════

function buildMatchAnnouncementEmbed(newMatches: any[]) {
  const div = divConfig(newMatches[0].division);
  const matchLines = newMatches.map((m: any) => {
    const s1 = m.score1 ?? 0;
    const s2 = m.score2 ?? 0;
    const winner = s1 > s2 ? m.team1_name : m.team2_name;
    return `**${m.team1_name}** \`${s1} — ${s2}\` **${m.team2_name}** → **${winner}**`;
  });

  return new EmbedBuilder()
    .setColor(C.gold)
    .setAuthor({
      name: `${newMatches.length} MATCH BARU — W${newMatches[0].weekNumber} ${div.emoji} ${div.label.toUpperCase()}`,
      iconURL: BRAND.footerIcon,
    })
    .setDescription(matchLines.join('\n'))
    .setFooter({ text: `${BRAND.footerText} · Detail di ${BRAND.url}`, iconURL: BRAND.footerIcon })
    .setTimestamp();
}

// ═══════════════════════════════════════════════════════════════
//  SLASH COMMAND HANDLERS
// ═══════════════════════════════════════════════════════════════

async function handleLeaderboard(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();
  const division = interaction.options.getString('divisi') || 'male';
  console.log(`  🔄 Fetching leaderboard for ${division}...`);
  try {
    const players = await getLeaderboard(division, 10);
    if (!players.length) {
      await interaction.editReply('📋 Belum ada data leaderboard untuk divisi ini.');
      return;
    }
    const embed = buildLeaderboardEmbed(players, division);
    await interaction.editReply({ embeds: [embed] });
    console.log(`  ✅ Leaderboard sent for ${division}`);
  } catch (err) {
    console.error(`  ❌ Leaderboard error:`, err);
    await interaction.editReply('❌ Gagal mengambil leaderboard. Coba lagi nanti.');
  }
}

async function handleBracket(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();
  const division = interaction.options.getString('divisi') || 'male';
  const week = interaction.options.getInteger('week') || undefined;
  try {
    const data = await getBracket(division, week);
    if (!data) {
      const div = divConfig(division);
      const weekStr = week ? ` W${week}` : '';
      await interaction.editReply(`📋 Belum ada bracket untuk ${div.emoji} ${div.label}${weekStr}.`);
      return;
    }
    const embed = buildBracketEmbed(data);
    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error(`  ❌ Bracket error:`, err);
    await interaction.editReply('❌ Gagal mengambil bracket. Coba lagi nanti.');
  }
}

async function handleSkor(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();
  const limit = interaction.options.getInteger('jumlah') || 5;
  const division = interaction.options.getString('divisi') || undefined;
  const week = interaction.options.getInteger('week') || undefined;
  try {
    const matches = await getRecentMatchResults(limit, division, week);
    if (!matches.length) {
      await interaction.editReply('📋 Belum ada hasil pertandingan.');
      return;
    }
    const embeds = matches.map((m: any) => buildMatchResultEmbed(m));
    await interaction.editReply({ embeds: embeds.slice(0, 5) }); // Discord max 5 embeds
  } catch (err) {
    console.error(`  ❌ Skor error:`, err);
    await interaction.editReply('❌ Gagal mengambil skor. Coba lagi nanti.');
  }
}

async function handleProfil(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();
  const gamertag = interaction.options.getString('gamertag')!;
  try {
    const player = await getPlayerByGamertag(gamertag);
    if (!player) {
      await interaction.editReply(`📋 Pemain **"${gamertag}"** tidak ditemukan.`);
      return;
    }
    const embed = buildProfileEmbed(player);
    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error(`  ❌ Profil error:`, err);
    await interaction.editReply('❌ Gagal mengambil profil. Coba lagi nanti.');
  }
}

async function handleJadwal(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();
  const week = interaction.options.getInteger('week') || undefined;
  try {
    let tournaments = await getTournamentStatus();
    if (week) {
      tournaments = tournaments.filter((t: any) => t.weekNumber === week);
    }
    const embed = buildJadwalEmbed(tournaments, week);
    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error(`  ❌ Jadwal error:`, err);
    await interaction.editReply('❌ Gagal mengambil jadwal. Coba lagi nanti.');
  }
}

async function handleStats(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply();
  try {
    const stats = await getStats();
    const embed = buildStatsEmbed(stats);
    await interaction.editReply({ embeds: [embed] });
  } catch (err) {
    console.error(`  ❌ Stats error:`, err);
    await interaction.editReply('❌ Gagal mengambil stats. Coba lagi nanti.');
  }
}

// ═══════════════════════════════════════════════════════════════
//  AUTO-POST: Match Results
// ═══════════════════════════════════════════════════════════════

async function checkNewMatchResults() {
  try {
    const latest = await getLatestCompletedMatch();
    if (!latest) return;

    if (lastMatchResultId === null) {
      lastMatchResultId = latest.id;
      return;
    }

    if (latest.id === lastMatchResultId) return;

    const newMatches = await sql`
      SELECT m.id, m.round, m."matchNumber", m.bracket, m.format,
        m."score1", m."score2", m.status, m."completedAt",
        t1.name as team1_name, t2.name as team2_name,
        mvp.gamertag as mvp_tag,
        t.division, t."weekNumber"
      FROM "Match" m
      JOIN "Team" t1 ON m."team1Id" = t1.id
      JOIN "Team" t2 ON m."team2Id" = t2.id
      LEFT JOIN "Player" mvp ON m."mvpPlayerId" = mvp.id
      JOIN "Tournament" t ON m."tournamentId" = t.id
      WHERE m."completedAt" IS NOT NULL AND m.id > ${lastMatchResultId}
      ORDER BY m."completedAt" ASC
    `;

    if (newMatches.length === 0) {
      lastMatchResultId = latest.id;
      return;
    }

    // Post each new match result
    const channelId = CHANNEL_MAP['live-results'];
    if (!channelId) { lastMatchResultId = latest.id; return; }

    const channel = client.channels.cache.get(channelId) as TextChannel | undefined;
    if (!channel) { lastMatchResultId = latest.id; return; }

    for (const match of newMatches) {
      const embed = buildMatchResultEmbed(match);
      await channel.send({ embeds: [embed] });
      console.log(`  📨 Posted match result: ${match.team1_name} vs ${match.team2_name}`);
    }

    // Also post in match-announcements
    const annChannelId = CHANNEL_MAP['match-announcements'];
    const annChannel = annChannelId ? client.channels.cache.get(annChannelId) as TextChannel | undefined : null;

    if (annChannel && newMatches.length > 0) {
      const embed = buildMatchAnnouncementEmbed(newMatches);
      await annChannel.send({ embeds: [embed] });
    }

    lastMatchResultId = latest.id;
  } catch (err) {
    console.error('❌ Error checking match results:', err);
  }
}

// ═══════════════════════════════════════════════════════════════
//  AUTO-POST: Leaderboard Updates (every 30 min)
// ═══════════════════════════════════════════════════════════════

async function updateLeaderboardMessages() {
  try {
    for (const division of ['male', 'female']) {
      const channelName = division === 'male' ? 'leaderboard-cowo' : 'leaderboard-cewe';
      const channelId = CHANNEL_MAP[channelName];
      if (!channelId) continue;

      const channel = client.channels.cache.get(channelId) as TextChannel | undefined;
      if (!channel) continue;

      const players = await getLeaderboard(division, 10);
      if (!players.length) continue;

      const embed = buildLeaderboardEmbed(players, division);

      const existingMsgId = leaderboardMessageIds[division];
      if (existingMsgId) {
        try {
          const msg = await channel.messages.fetch(existingMsgId);
          await msg.edit({ embeds: [embed] });
          console.log(`  📊 Updated leaderboard: ${division}`);
          continue;
        } catch {
          // Message deleted, post new one
        }
      }

      const msg = await channel.send({ embeds: [embed] });
      leaderboardMessageIds[division] = msg.id;
      console.log(`  📊 Posted leaderboard: ${division}`);
    }
  } catch (err) {
    console.error('❌ Error updating leaderboard:', err);
  }
}

// ═══════════════════════════════════════════════════════════════
//  REACTION ROLES
// ═══════════════════════════════════════════════════════════════

const REACTION_ROLES: Record<string, string> = {
  '🟢': '🎮 Peserta Cowo',
  '🔴': '💃 Peserta Cewe',
  '💎': '💎 Supporter',
  '🎵': '🎵 Idol Meta Fan',
};

async function setupReactionRoles() {
  const channelId = CHANNEL_MAP['pilih-role'];
  if (!channelId) return;

  const channel = client.channels.cache.get(channelId) as TextChannel | undefined;
  if (!channel) return;

  const messages = await channel.messages.fetch({ limit: 10 });
  const botMsg = messages.find(m => m.author.id === client.user?.id && m.embeds.length > 0);

  if (botMsg) {
    const existingReactions = botMsg.reactions.cache.map(r => r.emoji.name);
    for (const emoji of Object.keys(REACTION_ROLES)) {
      if (!existingReactions.includes(emoji)) {
        await botMsg.react(emoji);
      }
    }
    console.log('✅ Reaction roles set up');
  } else {
    const embed = buildReactionRolesEmbed();
    const msg = await channel.send({ embeds: [embed] });
    for (const emoji of Object.keys(REACTION_ROLES)) {
      await msg.react(emoji);
    }
    console.log('✅ Reaction roles message created');
  }
}

// ═══════════════════════════════════════════════════════════════
//  RESOLVE CHANNEL IDs
// ═══════════════════════════════════════════════════════════════

async function resolveChannels() {
  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;

  await guild.channels.fetch();

  const nameMap: Record<string, string> = {
    'match-announcements': 'match-announcements',
    'live-results': 'live-results',
    'bracket': 'bracket',
    'leaderboard-cowo': 'leaderboard-cowo',
    'leaderboard-cewe': 'leaderboard-cewe',
    'mvp-highlights': 'mvp-highlights',
    'pengumuman': 'pengumuman',
    'status-pendaftaran': 'status-pendaftaran',
    'pilih-role': 'pilih-role',
    'jadwal-turnamen': 'jadwal-turnamen',
  };

  for (const [key, name] of Object.entries(nameMap)) {
    const ch = guild.channels.cache.find(c => c.name.includes(name));
    if (ch) {
      CHANNEL_MAP[key] = ch.id;
    }
  }

  console.log('📂 Channels resolved:', Object.keys(CHANNEL_MAP).length, Object.keys(CHANNEL_MAP).join(', '));
}

// ═══════════════════════════════════════════════════════════════
//  MAIN CLIENT
// ═══════════════════════════════════════════════════════════════

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

client.once(Events.ClientReady, async () => {
  console.log(`✦ TARKAM Bot online: ${client.user?.tag}`);

  await resolveChannels();
  await registerCommands();
  setupReactionRoles().catch(console.error);
  getLatestCompletedMatch().then(m => { if (m) lastMatchResultId = m.id; }).catch(console.error);
  updateLeaderboardMessages().catch(console.error);

  console.log('✅ Bot fully initialized!');
  console.log('📋 Commands: /leaderboard /bracket /skor /profil /jadwal /stats');

  setInterval(checkNewMatchResults, 2 * 60 * 1000);
  console.log('⏰ Polling: match results (every 2 min)');

  setInterval(updateLeaderboardMessages, 30 * 60 * 1000);
  console.log('⏰ Polling: leaderboard update (every 30 min)');
});

client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand()) return;

  console.log(`📩 Command: /${interaction.commandName} from ${interaction.user.username}`);

  try {
    switch (interaction.commandName) {
      case 'leaderboard': await handleLeaderboard(interaction); break;
      case 'bracket': await handleBracket(interaction); break;
      case 'skor': await handleSkor(interaction); break;
      case 'profil': await handleProfil(interaction); break;
      case 'jadwal': await handleJadwal(interaction); break;
      case 'stats': await handleStats(interaction); break;
      default:
        await interaction.reply({ content: 'Command tidak dikenali.', flags: 64 });
    }
  } catch (err) {
    console.error(`❌ Command error /${interaction.commandName}:`, err);
    try {
      const reply = { content: '❌ Terjadi error. Coba lagi nanti.' };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(reply);
      } else {
        await interaction.reply({ ...reply, ephemeral: true });
      }
    } catch (replyErr) {
      console.error('Failed to send error reply:', replyErr);
    }
  }
});

client.on(Events.MessageReactionAdd, async (reaction: MessageReaction, user: User) => {
  if (user.bot) return;

  if (reaction.partial) {
    try { await reaction.fetch(); } catch { return; }
  }

  const emoji = reaction.emoji.name;
  const roleName = REACTION_ROLES[emoji];
  if (!roleName) return;

  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;

  try {
    const member = await guild.members.fetch(user.id);
    const role = guild.roles.cache.find(r => r.name === roleName);
    if (!role) {
      console.log(`  ⚠️ Role "${roleName}" not found in server`);
      return;
    }
    await member.roles.add(role);
    console.log(`  🎭 Added role "${roleName}" to ${user.username}`);
  } catch (err) {
    console.error(`  ⚠️ Could not add role:`, (err as Error).message);
  }
});

client.on(Events.MessageReactionRemove, async (reaction: MessageReaction, user: User) => {
  if (user.bot) return;

  if (reaction.partial) {
    try { await reaction.fetch(); } catch { return; }
  }

  const emoji = reaction.emoji.name;
  const roleName = REACTION_ROLES[emoji];
  if (!roleName) return;

  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) return;

  try {
    const member = await guild.members.fetch(user.id);
    const role = guild.roles.cache.find(r => r.name === roleName);
    if (!role) return;
    await member.roles.remove(role);
    console.log(`  🎭 Removed role "${roleName}" from ${user.username}`);
  } catch (err) {
    console.error(`  ⚠️ Could not remove role:`, (err as Error).message);
  }
});

// ═══ SIMPLE HEALTH CHECK SERVER ═══
import http from 'http';
const server = http.createServer((req: any, res: any) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    bot: client.user?.tag || 'connecting...',
    guild: GUILD_ID,
    channels: Object.keys(CHANNEL_MAP).length,
    uptime: process.uptime(),
  }));
});
server.listen(PORT, () => {
  console.log(`🏥 Health check running on port ${PORT}`);
});

// ═══ START ═══
console.log('🔌 Connecting to Discord...');
client.login(BOT_TOKEN);
