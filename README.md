# 🤖 TARKAM Discord Bot

Discord bot for TARKAM — Dance Tournament Platform (idolmeta.fun)

## Features
- `/leaderboard` — Lihat leaderboard peringkat
- `/bracket` — Lihat bracket turnamen
- `/skor` — Lihat hasil pertandingan terbaru
- `/profil` — Lihat profil pemain
- `/jadwal` — Lihat jadwal & status turnamen
- `/stats` — Statistik TARKAM
- Auto-post match results to #live-results
- Auto-update leaderboard messages
- Reaction roles in #pilih-role

## Deploy on Render
1. Connect this repo to Render
2. Set environment variables: `BOT_TOKEN`, `APP_ID`, `GUILD_ID`, `DATABASE_URL`
3. Build command: `bun install`
4. Start command: `bun index.ts`

## Environment Variables
| Key | Description |
|-----|-------------|
| `BOT_TOKEN` | Discord bot token |
| `APP_ID` | Discord application ID |
| `GUILD_ID` | Discord server ID |
| `DATABASE_URL` | PostgreSQL connection string |
