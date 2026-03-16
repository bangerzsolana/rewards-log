const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { computeUserPrizes, thousandify } = require("./prizes");
const fetch = require("node-fetch");

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Helius-sync base URL (the existing 3Land backend)
const HELIUS_BASE = process.env.HELIUS_BASE_URL || "https://api.3land.fun";

// GIB config
const GIB_BOARD = process.env.GIB_BOARD || "";
const GIB_STORE = process.env.GIB_STORE || "";

// ── helpers ──────────────────────────────────────────────────────────

async function fetchFromHelius(path, body) {
  const res = await fetch(`${HELIUS_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Helius ${path} returned ${res.status}`);
  return res.json();
}

// ── Auto-migrate on startup ─────────────────────────────────────────

async function autoMigrate() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS reward_totals (
        id SERIAL PRIMARY KEY,
        wallet TEXT NOT NULL,
        half_currency_hash BIGINT NOT NULL,
        amount NUMERIC NOT NULL DEFAULT 0,
        amount_parsed DOUBLE PRECISION NOT NULL DEFAULT 0,
        token_symbol TEXT,
        token_decimals INTEGER,
        token_mint TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(wallet, half_currency_hash)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS tournament_rewards (
        id SERIAL PRIMARY KEY,
        wallet TEXT NOT NULL,
        tournament TEXT NOT NULL,
        tournament_name TEXT,
        players INTEGER NOT NULL DEFAULT 0,
        ended BOOLEAN NOT NULL DEFAULT FALSE,
        positions JSONB NOT NULL DEFAULT '[]',
        prizes JSONB NOT NULL DEFAULT '[]',
        computed_prizes JSONB NOT NULL DEFAULT '[]',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(wallet, tournament)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS wallet_sync (
        wallet TEXT PRIMARY KEY,
        totals_synced_at TIMESTAMPTZ,
        tournaments_synced_at TIMESTAMPTZ
      )
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_reward_totals_wallet ON reward_totals(wallet)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_tournament_rewards_wallet ON tournament_rewards(wallet)");
    console.log("Auto-migration complete.");
  } catch (err) {
    console.error("Auto-migration failed:", err.message);
  } finally {
    client.release();
  }
}

// ── Sync logic (per wallet, on demand) ──────────────────────────────

const TOTALS_TTL_MS = 15 * 60 * 1000; // 15 min
const TOURNAMENTS_TTL_MS = 5 * 60 * 1000; // 5 min

async function shouldSyncTotals(wallet) {
  const { rows } = await pool.query(
    "SELECT totals_synced_at FROM wallet_sync WHERE wallet = $1",
    [wallet]
  );
  if (!rows.length) return true;
  const syncedAt = rows[0].totals_synced_at;
  if (!syncedAt) return true;
  return Date.now() - new Date(syncedAt).getTime() > TOTALS_TTL_MS;
}

async function syncTotals(wallet) {
  const data = await fetchFromHelius("/helius-sync/accounts/gib/rewards/total", { wallet });
  const prizesAmount = data?.data?.prizesAmount || {};

  for (const [hash, amount] of Object.entries(prizesAmount)) {
    // We store the raw data — token metadata enrichment happens at read time
    // or can be populated by a separate job
    await pool.query(
      `INSERT INTO reward_totals (wallet, half_currency_hash, amount, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (wallet, half_currency_hash)
       DO UPDATE SET amount = $3, updated_at = NOW()`,
      [wallet, Number(hash), amount]
    );
  }

  await pool.query(
    `INSERT INTO wallet_sync (wallet, totals_synced_at)
     VALUES ($1, NOW())
     ON CONFLICT (wallet)
     DO UPDATE SET totals_synced_at = NOW()`,
    [wallet]
  );
}

async function shouldSyncTournaments(wallet) {
  const { rows } = await pool.query(
    "SELECT tournaments_synced_at FROM wallet_sync WHERE wallet = $1",
    [wallet]
  );
  if (!rows.length) return true;
  const syncedAt = rows[0].tournaments_synced_at;
  if (!syncedAt) return true;
  return Date.now() - new Date(syncedAt).getTime() > TOURNAMENTS_TTL_MS;
}

async function syncTournaments(wallet) {
  // 1. Get tournament list
  const tourData = await fetchFromHelius("/helius-sync/accounts/gib/tournaments", {
    wallet: null,
    board: GIB_BOARD,
    store: GIB_STORE,
    network: "mainnet",
    time: 300,
  });

  const tournaments = tourData?.data || [];
  if (!tournaments.length) return;

  // 2. Get rewards for all tournaments for this wallet
  const tournamentAddresses = tournaments.map((t) => t.tournament);
  const rewardsData = await fetchFromHelius("/helius-sync/accounts/gib/rewards/history", {
    tournaments: tournamentAddresses,
    wallet,
    wallets: wallet,
  });

  const rewards = rewardsData?.rewards || {};

  // 3. Store each tournament's rewards
  for (const t of tournaments) {
    const tReward = rewards[t.tournament];
    if (!tReward || !Object.keys(tReward.myPositions || {}).length) continue;

    const positions = Object.keys(tReward.myPositions).map((round) => ({
      round,
      amount: tReward.myPositions[round],
    }));

    // Decode tournament name from ID bytes
    let tournamentName = null;
    if (tReward.id) {
      try {
        const idBytes = Array.isArray(tReward.id) ? tReward.id : [];
        while (idBytes.length && idBytes[idBytes.length - 1] === 0) idBytes.pop();
        if (idBytes.length) {
          tournamentName = new TextDecoder().decode(new Uint8Array(idBytes));
        }
      } catch (e) { /* ignore decode errors */ }
    }

    // Compute prizes server-side
    let computedPrizes = [];
    try {
      computedPrizes = computeUserPrizes({
        positions,
        prizes: tReward.prizes || t.prizes || [],
        players: tReward.players || t.players || 1000,
        id: tReward.id,
      });
    } catch (e) {
      console.error("Prize calc error for", t.tournament, e.message);
    }

    await pool.query(
      `INSERT INTO tournament_rewards (wallet, tournament, tournament_name, players, ended, positions, prizes, computed_prizes, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
       ON CONFLICT (wallet, tournament)
       DO UPDATE SET tournament_name = $3, players = $4, ended = $5, positions = $6, prizes = $7, computed_prizes = $8, updated_at = NOW()`,
      [
        wallet,
        t.tournament,
        tournamentName,
        tReward.players || t.players || 0,
        !!tReward.ended,
        JSON.stringify(positions),
        JSON.stringify(tReward.prizes || t.prizes || []),
        JSON.stringify(computedPrizes),
      ]
    );
  }

  await pool.query(
    `INSERT INTO wallet_sync (wallet, tournaments_synced_at)
     VALUES ($1, NOW())
     ON CONFLICT (wallet)
     DO UPDATE SET tournaments_synced_at = NOW()`,
    [wallet]
  );
}

// ── API Routes ──────────────────────────────────────────────────────

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", service: "rewards-log" });
});

// Get totals for a wallet (triggers sync if stale)
app.get("/api/rewards/totals/:wallet", async (req, res) => {
  try {
    const { wallet } = req.params;
    if (!wallet) return res.status(400).json({ error: "wallet required" });

    if (await shouldSyncTotals(wallet)) {
      await syncTotals(wallet);
    }

    const { rows } = await pool.query(
      "SELECT half_currency_hash, amount, amount_parsed, token_symbol, token_decimals, token_mint FROM reward_totals WHERE wallet = $1",
      [wallet]
    );

    res.json({ wallet, totals: rows });
  } catch (err) {
    console.error("GET /api/rewards/totals error:", err.message);
    res.status(500).json({ error: "sync failed" });
  }
});

// Get tournament rewards for a wallet (triggers sync if stale)
app.get("/api/rewards/tournaments/:wallet", async (req, res) => {
  try {
    const { wallet } = req.params;
    if (!wallet) return res.status(400).json({ error: "wallet required" });

    const page = parseInt(req.query.page) || 0;
    const limit = parseInt(req.query.limit) || 20;
    const offset = page * limit;

    if (await shouldSyncTournaments(wallet)) {
      await syncTournaments(wallet);
    }

    const { rows } = await pool.query(
      `SELECT tournament, tournament_name, players, ended, positions, prizes, computed_prizes, updated_at
       FROM tournament_rewards
       WHERE wallet = $1
       ORDER BY updated_at DESC
       LIMIT $2 OFFSET $3`,
      [wallet, limit, offset]
    );

    const { rows: countRows } = await pool.query(
      "SELECT COUNT(*) as total FROM tournament_rewards WHERE wallet = $1",
      [wallet]
    );

    res.json({
      wallet,
      tournaments: rows,
      total: parseInt(countRows[0].total),
      page,
      limit,
    });
  } catch (err) {
    console.error("GET /api/rewards/tournaments error:", err.message);
    res.status(500).json({ error: "sync failed" });
  }
});

// Force re-sync a wallet (manual trigger)
app.post("/api/rewards/sync/:wallet", async (req, res) => {
  try {
    const { wallet } = req.params;
    if (!wallet) return res.status(400).json({ error: "wallet required" });

    await Promise.all([syncTotals(wallet), syncTournaments(wallet)]);
    res.json({ wallet, synced: true });
  } catch (err) {
    console.error("POST /api/rewards/sync error:", err.message);
    res.status(500).json({ error: "sync failed" });
  }
});

// ── Start ───────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

autoMigrate().then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Rewards Log API running on port ${PORT}`);
  });
});
