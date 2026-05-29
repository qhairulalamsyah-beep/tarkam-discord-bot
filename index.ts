/**
 * ═══════════════════════════════════════════════════════════════════
 *  TARKAM Discord Bot — Auto Tournament Updates
 *  Connected to Neon PostgreSQL (same DB as idolmeta.fun)
 *
 *  Features:
 *  - Slash commands: /leaderboard, /bracket, /skor, /profil, /jadwal, /stats
 *  - Auto-post match results when matches complete
 *  - Auto-update leaderboard messages
 *  - Reaction roles in #pilih-role
 * ═══════════════════════════════════════════════════════════════════
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

// ═══ COLORS ═══
const C = {
  gold: '#EFF923',
  male: '#2E9FFF',
  female: '#FF2D78',
  success: '#22C55E',
  info: '#5865F2',
  warning: '#F59E0B',
  danger: '#EF4444',
  neutral: '#99AAB5',
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

async function getRecentMatchResults(limit = 5) {
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
    WHERE m."completedAt" IS NOT NULL
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

async function getBracket(division: string) {
  const tournaments = await sql`
    SELECT t.id, t.name, t."weekNumber", t.division, t.status, t.format
    FROM "Tournament" t
    JOIN "Season" s ON t."seasonId" = s.id
    WHERE s.status = 'active' AND t.division = ${division}
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

  // Also get team members for context
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
    ).setRequired(false)),

  new SlashCommandBuilder()
    .setName('bracket')
    .setDescription('Lihat bracket turnamen minggu ini')
    .addStringOption(o => o.setName('divisi').setDescription('Pilih divisi').addChoices(
      { name: '♂ Cowo', value: 'male' },
      { name: '♀ Cewe', value: 'female' },
    ).setRequired(false)),

  new SlashCommandBuilder()
    .setName('skor')
    .setDescription('Lihat hasil pertandingan terbaru')
    .addIntegerOption(o => o.setName('jumlah').setDescription('Jumlah match (1-10)').setMinValue(1).setMaxValue(10)),

  new SlashCommandBuilder()
    .setName('profil')
    .setDescription('Lihat profil pemain')
    .addStringOption(o => o.setName('gamertag').setDescription('Gamertag pemain').setRequired(true)),

  new SlashCommandBuilder()
    .setName('jadwal')
    .setDescription('Lihat jadwal & status turnamen'),

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
//  EMBED BUILDERS
// ═══════════════════════════════════════════════════════════════

function buildLeaderboardEmbed(players: any[], division: string) {
  const isMale = division === 'male';
  const emoji = isMale ? '♂' : '♀';
  const label = isMale ? 'Cowo' : 'Cewe';
  const color = isMale ? C.male : C.female;

  const fields = players.map((p: any) => {
    const rank = Number(p.rank);
    const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`;
    return {
      name: `${medal} ${p.gamertag}`,
      value: `${p.points} pts · ${p.totalWins}W · ${p.totalMvp} MVP${p.streak > 1 ? ` · 🔥${p.streak}` : ''}`,
      inline: true,
    };
  });

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`🏆 Leaderboard ${emoji} ${label}`)
    .setDescription(`Top ${players.length} peringkat divisi ${label}`)
    .addFields(fields)
    .setFooter({ text: 'TARKAM — idolmeta.fun' })
    .setTimestamp();
}

function buildMatchResultEmbed(match: any) {
  const isMale = match.division === 'male';
  const color = isMale ? C.male : C.female;
  const divEmoji = isMale ? '♂' : '♀';
  const divLabel = isMale ? 'Cowo' : 'Cewe';

  const s1 = match.score1 ?? 0;
  const s2 = match.score2 ?? 0;
  const winner = s1 > s2 ? match.team1_name : match.team2_name;
  const isSweep = match.format === 'BO1'
    ? (s1 === 1 && s2 === 0) || (s1 === 0 && s2 === 1)
    : (s1 === 2 && s2 === 0) || (s1 === 0 && s2 === 2) || (s1 === 3 && s2 === 0) || (s1 === 0 && s2 === 3);

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`🎵 Match Result — W${match.weekNumber} ${divEmoji} ${divLabel}`)
    .setDescription(
      `**${match.team1_name}** ${s1} - ${s2} **${match.team2_name}**\n\n` +
      `🏆 Winner: **${winner}**${isSweep ? ' (Sweep!)' : ''}` +
      (match.mvp_tag ? `\n💎 MVP: **${match.mvp_tag}**` : '')
    )
    .setFooter({ text: 'TARKAM — idolmeta.fun' })
    .setTimestamp(new Date(match.completedAt));
}

function buildProfileEmbed(player: any) {
  const isMale = player.division === 'male';
  const color = isMale ? C.male : C.female;
  const divEmoji = isMale ? '♂' : '♀';

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`${player.gamertag}`)
    .setDescription(`${player.name} · ${divEmoji} ${isMale ? 'Cowo' : 'Cewe'}${player.city ? ` · 📍 ${player.city}` : ''}`)
    .addFields(
      { name: '⭐ Points', value: `${player.points}`, inline: true },
      { name: '🏆 Wins', value: `${player.totalWins}`, inline: true },
      { name: '💎 MVP', value: `${player.totalMvp}`, inline: true },
      { name: '🔥 Streak', value: `${player.streak}`, inline: true },
      { name: '🎮 Matches', value: `${player.matches}`, inline: true },
      { name: '🏅 Tier', value: player.tier || 'Unranked', inline: true },
    )
    .setFooter({ text: 'TARKAM — idolmeta.fun' })
    .setTimestamp();
}

function buildBracketEmbed(data: any) {
  const t = data.tournament;
  const isMale = t.division === 'male';
  const color = isMale ? C.male : C.female;
  const divEmoji = isMale ? '♂' : '♀';
  const matches = data.matches;

  const roundNames: Record<number, string> = { 1: 'Final', 2: 'Semi Final', 3: 'Quarter Final', 4: 'Round of 16', 5: 'Round of 32' };

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
    const lines = roundMatches.map((m: any) => {
      const s1 = m.score1 ?? '?';
      const s2 = m.score2 ?? '?';
      const statusIcon = m.completedAt ? '✅' : m.status === 'live' ? '🔴' : '⏳';
      const mvpTag = m.mvp_tag ? ` 💎${m.mvp_tag}` : '';
      return `${statusIcon} **${m.team1_name}** ${s1}-${s2} **${m.team2_name}**${mvpTag}`;
    });
    fields.push({
      name: `🎵 ${rName}`,
      value: lines.join('\n'),
      inline: false,
    });
  }

  if (fields.length === 0) {
    fields.push({ name: '📋 Belum ada match', value: 'Bracket belum tersedia untuk week ini', inline: false });
  }

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`🏁 Bracket W${t.weekNumber} ${divEmoji} ${isMale ? 'Cowo' : 'Cewe'}`)
    .addFields(fields)
    .setFooter({ text: 'TARKAM — idolmeta.fun' })
    .setTimestamp();
}

function buildJadwalEmbed(tournaments: any[]) {
  const fields = tournaments.map((t: any) => {
    const emoji = t.division === 'male' ? '♂' : '♀';
    const label = t.division === 'male' ? 'Cowo' : 'Cewe';

    const statusMap: Record<string, string> = {
      'setup': '⚙️ Setup',
      'registration': '🟢 PENDAFTARAN',
      'approval': '🔄 Approval',
      'team_generation': '🔀 Generate Tim',
      'bracket_generation': '🏁 Generate Bracket',
      'main_event': '🎵 LIVE!',
      'finalization': '📋 Finalisasi',
      'completed': '✅ Selesai',
    };
    const status = statusMap[t.status] || `❓ ${t.status}`;
    const prizeStr = t.prizePool ? ` · 💰 Rp ${(t.prizePool/1000).toFixed(0)}K` : '';

    return {
      name: `${emoji} ${label} — Week ${t.weekNumber}`,
      value: `Status: ${status}${prizeStr}`,
      inline: true,
    };
  });

  if (fields.length === 0) {
    fields.push({ name: '📋 Tidak ada turnamen aktif', value: 'Belum ada season berjalan', inline: false });
  }

  return new EmbedBuilder()
    .setColor(C.gold)
    .setTitle('📅 Jadwal Turnamen')
    .setDescription('Status turnamen season berjalan')
    .addFields(fields)
    .setFooter({ text: 'TARKAM — idolmeta.fun | Cek lengkap di idolmeta.fun' })
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
      await interaction.editReply('Belum ada data leaderboard untuk divisi ini.');
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
  try {
    const data = await getBracket(division);
    if (!data) {
      await interaction.editReply('Belum ada bracket untuk divisi ini.');
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
  try {
    const matches = await getRecentMatchResults(limit);
    if (!matches.length) {
      await interaction.editReply('Belum ada hasil pertandingan.');
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
      await interaction.editReply(`Pemain dengan gamertag "${gamertag}" tidak ditemukan.`);
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
  try {
    const tournaments = await getTournamentStatus();
    const embed = buildJadwalEmbed(tournaments);
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
    const embed = new EmbedBuilder()
      .setColor(C.gold)
      .setTitle('📊 Statistik TARKAM')
      .addFields(
        { name: '👥 Total Pemain', value: `${stats.totalPlayers}`, inline: true },
        { name: '🎵 Match Selesai', value: `${stats.totalMatches}`, inline: true },
        { name: '🏆 Season Aktif', value: `${stats.activeSeason}`, inline: true },
        { name: '🎮 Turnamen Aktif', value: `${stats.activeTournaments}`, inline: true },
      )
      .setFooter({ text: 'TARKAM — idolmeta.fun' })
      .setTimestamp();
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
      // First run — just record the latest, don't post
      lastMatchResultId = latest.id;
      return;
    }

    if (latest.id === lastMatchResultId) return; // No new matches

    // Get all new matches since last check
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
      const isMale = newMatches[0].division === 'male';
      const divEmoji = isMale ? '♂' : '♀';
      const divLabel = isMale ? 'Cowo' : 'Cewe';

      const embed = new EmbedBuilder()
        .setColor(C.gold)
        .setTitle(`🔔 ${newMatches.length} Match Baru Selesai! — W${newMatches[0].weekNumber} ${divEmoji} ${divLabel}`)
        .setDescription(
          newMatches.map((m: any) => {
            const s1 = m.score1 ?? 0;
            const s2 = m.score2 ?? 0;
            const winner = s1 > s2 ? m.team1_name : m.team2_name;
            return `✅ **${m.team1_name}** ${s1}-${s2} **${m.team2_name}** → Winner: **${winner}**`;
          }).join('\n')
        )
        .setFooter({ text: 'TARKAM — idolmeta.fun' })
        .setTimestamp();

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

      // Try to edit existing message, or post new one
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

      // Post new message
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

  // Find the bot's embed message
  const messages = await channel.messages.fetch({ limit: 10 });
  const botMsg = messages.find(m => m.author.id === client.user?.id && m.embeds.length > 0);

  if (botMsg) {
    // Add reactions if not already present
    const existingReactions = botMsg.reactions.cache.map(r => r.emoji.name);
    for (const emoji of Object.keys(REACTION_ROLES)) {
      if (!existingReactions.includes(emoji)) {
        await botMsg.react(emoji);
      }
    }
    console.log('✅ Reaction roles set up');
  } else {
    // Create the role selection embed
    const embed = new EmbedBuilder()
      .setColor(C.gold)
      .setTitle('🎭 Pilih Role Kamu!')
      .setDescription(
        'React dengan emoji di bawah untuk mendapat role:\n\n' +
        '🟢 — 🎮 Peserta Cowo\n' +
        '🔴 — 💃 Peserta Cewe\n' +
        '💎 — 💎 Supporter\n' +
        '🎵 — 🎵 Idol Meta Fan'
      )
      .setFooter({ text: 'TARKAM — idolmeta.fun' });

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

  // Fetch all channels to ensure cache is populated
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

// discord.js v14 uses 'ready' event
client.once(Events.ClientReady, async () => {
  console.log(`🤖 TARKAM Bot online: ${client.user?.tag}`);

  // Resolve channels
  await resolveChannels();

  // Register slash commands
  await registerCommands();

  // Setup reaction roles
  setupReactionRoles().catch(console.error);

  // Initialize state
  getLatestCompletedMatch().then(m => { if (m) lastMatchResultId = m.id; }).catch(console.error);

  // Initial leaderboard post
  updateLeaderboardMessages().catch(console.error);

  console.log('✅ Bot fully initialized!');
  console.log('📋 Slash commands: /leaderboard /bracket /skor /profil /jadwal /stats');

  // ═══ POLLING LOOPS ═══
  setInterval(checkNewMatchResults, 2 * 60 * 1000);
  console.log('⏰ Polling: match results (every 2 min)');

  setInterval(updateLeaderboardMessages, 30 * 60 * 1000);
  console.log('⏰ Polling: leaderboard update (every 30 min)');
});

// ═══ HANDLE SLASH COMMANDS ═══
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

// ═══ HANDLE REACTION ROLES ═══
client.on(Events.MessageReactionAdd, async (reaction: MessageReaction, user: User) => {
  if (user.bot) return;

  // Ensure partial reactions are fetched
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
