const path = require("path");
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { computeUserPrizes, thousandify } = require("./prizes");
const { getBoardInfo, fetchWalletRewards } = require("./solana");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Auto-migrate on startup ─────────────────────────────────────────

async function autoMigrate() {
  let client;
  try {
    client = await pool.connect();
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
        tournament_index INTEGER,
        players INTEGER NOT NULL DEFAULT 0,
        total_rounds INTEGER NOT NULL DEFAULT 0,
        last_round INTEGER NOT NULL DEFAULT 0,
        ended BOOLEAN NOT NULL DEFAULT FALSE,
        positions JSONB NOT NULL DEFAULT '{}',
        prizes JSONB NOT NULL DEFAULT '[]',
        computed_prizes JSONB NOT NULL DEFAULT '[]',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(wallet, tournament)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS wallet_sync (
        wallet TEXT PRIMARY KEY,
        last_tournament_index INTEGER DEFAULT 0,
        synced_at TIMESTAMPTZ
      )
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_reward_totals_wallet ON reward_totals(wallet)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_tournament_rewards_wallet ON tournament_rewards(wallet)");
    console.log("Auto-migration complete.");
  } catch (err) {
    console.error("Auto-migration failed:", err.message);
  } finally {
    if (client) client.release();
  }
}

// ── Known token map (halfCurrencyHash → metadata) ───────────────────
// These are the tokens seen in the rewards screenshot
const TOKEN_MAP = {
  0: { symbol: "SOL", decimals: 9, mint: null },
  // Add more as we discover them from on-chain data
};

// ── Sync logic ──────────────────────────────────────────────────────

const SYNC_TTL_MS = 5 * 60 * 1000; // 5 min
const SYNC_TIMEOUT_MS = 30 * 1000; // 30 sec max for sync
const syncingWallets = new Set(); // prevent concurrent syncs

async function shouldSync(wallet) {
  if (syncingWallets.has(wallet)) return false; // already syncing
  const { rows } = await pool.query(
    "SELECT synced_at FROM wallet_sync WHERE wallet = $1",
    [wallet]
  );
  if (!rows.length) return true;
  if (!rows[0].synced_at) return true;
  return Date.now() - new Date(rows[0].synced_at).getTime() > SYNC_TTL_MS;
}

async function syncWallet(wallet) {
  if (syncingWallets.has(wallet)) return;
  syncingWallets.add(wallet);
  try {
  await Promise.race([
    _doSync(wallet),
    new Promise((_, reject) => setTimeout(() => reject(new Error("Sync timeout")), SYNC_TIMEOUT_MS)),
  ]);
  } finally {
    syncingWallets.delete(wallet);
  }
}

async function _doSync(wallet) {
  console.log(`Syncing wallet ${wallet}...`);

  // Get the latest tournament index from the board
  const boardInfo = await getBoardInfo();
  const upTo = boardInfo.upToTournament;
  console.log(`Board upToTournament: ${upTo}`);

  // Check where we left off for this wallet
  const { rows: syncRows } = await pool.query(
    "SELECT last_tournament_index FROM wallet_sync WHERE wallet = $1",
    [wallet]
  );
  const lastSynced = syncRows[0]?.last_tournament_index || 0;

  // Fetch in batches of 10, from newest to last synced
  const BATCH = 10;
  const allTournaments = [];
  for (let start = upTo; start > lastSynced && start > 0; start -= BATCH) {
    try {
      const batch = await fetchWalletRewards(wallet, start, BATCH);
      allTournaments.push(...batch);
    } catch (e) {
      console.error(`Batch error at index ${start}:`, e.message);
    }
  }

  console.log(`Found ${allTournaments.length} tournaments with rewards for ${wallet}`);

  // Store each tournament
  const totals = {}; // halfCurrencyHash → total amount
  for (const t of allTournaments) {
    const positions = t.myPositions;
    const posArray = Object.entries(positions).map(([round, amount]) => ({ round, amount }));

    // Compute prizes
    let computedPrizes = [];
    try {
      computedPrizes = computeUserPrizes({
        positions: posArray,
        prizes: t.prizes,
        players: t.registeredPlayers,
        id: t.index,
      });
    } catch (e) {
      console.error(`Prize calc error for tournament ${t.index}:`, e.message);
    }

    // Accumulate totals by token symbol
    for (const cp of computedPrizes) {
      const key = cp.symbol || "SOL";
      if (!totals[key]) totals[key] = { amount: 0, symbol: key, decimals: cp.decimals, halfCurrencyHash: cp.halfCurrencyHash || 0 };
      totals[key].amount += cp.parsed;
    }

    // Get user's best lastRound from positions
    const userLastRound = Math.max(...Object.keys(positions).map(Number), 0);

    await pool.query(
      `INSERT INTO tournament_rewards (wallet, tournament, tournament_name, tournament_index, players, total_rounds, last_round, ended, positions, prizes, computed_prizes, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
       ON CONFLICT (wallet, tournament)
       DO UPDATE SET tournament_name = $3, tournament_index = $4, players = $5, total_rounds = $6, last_round = $7, ended = $8, positions = $9, prizes = $10, computed_prizes = $11, updated_at = NOW()`,
      [
        wallet,
        t.tournament,
        t.tournamentName,
        t.index,
        t.registeredPlayers,
        t.round,
        userLastRound,
        t.ended,
        JSON.stringify(positions),
        JSON.stringify(t.prizes),
        JSON.stringify(computedPrizes),
      ]
    );
  }

  // Clear old totals and write fresh — use a transaction so /totals never reads an empty table mid-sync
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM reward_totals WHERE wallet = $1", [wallet]);
    for (const [symbol, data] of Object.entries(totals)) {
      await client.query(
        `INSERT INTO reward_totals (wallet, half_currency_hash, amount, amount_parsed, token_symbol, token_decimals, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [wallet, data.halfCurrencyHash, data.amount, data.amount, symbol, data.decimals]
      );
    }
    await client.query(
      `INSERT INTO wallet_sync (wallet, last_tournament_index, synced_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (wallet)
       DO UPDATE SET last_tournament_index = GREATEST(wallet_sync.last_tournament_index, $2), synced_at = NOW()`,
      [wallet, upTo]
    );
    await client.query("COMMIT");
  } catch (txErr) {
    await client.query("ROLLBACK");
    throw txErr;
  } finally {
    client.release();
  }

  console.log(`Sync complete for ${wallet}`);
}

// ── API Routes ──────────────────────────────────────────────────────

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "rewards-log" });
});

// Get totals for a wallet (reads from DB only — sync is triggered by /tournaments)
app.get("/api/rewards/totals/:wallet", async (req, res) => {
  try {
    const { wallet } = req.params;
    if (!wallet) return res.status(400).json({ error: "wallet required" });

    const { rows } = await pool.query(
      "SELECT half_currency_hash, amount, amount_parsed, token_symbol, token_decimals FROM reward_totals WHERE wallet = $1",
      [wallet]
    );

    res.json({ wallet, totals: rows });
  } catch (err) {
    console.error("GET /api/rewards/totals error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get tournament rewards for a wallet
app.get("/api/rewards/tournaments/:wallet", async (req, res) => {
  try {
    const { wallet } = req.params;
    if (!wallet) return res.status(400).json({ error: "wallet required" });

    const page = parseInt(req.query.page) || 0;
    const limit = parseInt(req.query.limit) || 20;
    const offset = page * limit;

    // Trigger sync in background — don't block the response
    if (await shouldSync(wallet)) {
      syncWallet(wallet).catch(err => console.error("Background sync error:", err.message));
    }

    const { rows } = await pool.query(
      `SELECT tournament, tournament_name, tournament_index, players, total_rounds, last_round, ended, positions, prizes, computed_prizes, updated_at
       FROM tournament_rewards
       WHERE wallet = $1
       ORDER BY tournament_index DESC
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
    res.status(500).json({ error: err.message });
  }
});

// Force re-sync
app.post("/api/rewards/sync/:wallet", async (req, res) => {
  try {
    const { wallet } = req.params;
    // Clear sync state to force full re-sync
    await pool.query("DELETE FROM wallet_sync WHERE wallet = $1", [wallet]);
    await pool.query("DELETE FROM reward_totals WHERE wallet = $1", [wallet]);
    await pool.query("DELETE FROM tournament_rewards WHERE wallet = $1", [wallet]);
    await syncWallet(wallet);
    res.json({ wallet, synced: true });
  } catch (err) {
    console.error("POST /api/rewards/sync error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Debug: board info
app.get("/api/debug/board", async (req, res) => {
  try {
    const info = await getBoardInfo();
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug: raw tournament data for a specific index
app.get("/api/debug/tournament/:index", async (req, res) => {
  try {
    const { fetchTournament } = require("./solana");
    const t = await fetchTournament(parseInt(req.params.index));
    if (!t) return res.status(404).json({ error: "tournament not found" });
    res.json(t);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug: raw tournament data + wallet positions
app.get("/api/debug/tournament/:index/:wallet", async (req, res) => {
  try {
    const { fetchTournament, getUserPositions } = require("./solana");
    const { computeUserPrizes } = require("./prizes");
    const t = await fetchTournament(parseInt(req.params.index));
    if (!t) return res.status(404).json({ error: "tournament not found" });
    const positions = getUserPositions(t.parts, req.params.wallet);
    const posArray = Object.entries(positions).map(([round, amount]) => ({ round, amount }));
    const computed = computeUserPrizes({
      positions: posArray,
      prizes: t.prizes,
      players: t.registeredPlayers,
      id: t.index,
    });
    // Include matching parts for this wallet
    const userParts = t.parts.filter(p => p.user === req.params.wallet);
    res.json({ ...t, parts: userParts, myPositions: positions, computedPrizes: computed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ───────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

autoMigrate()
  .catch((err) => console.error("Migration error (server starting anyway):", err.message))
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Rewards Log API running on port ${PORT}`);
    });
  });
