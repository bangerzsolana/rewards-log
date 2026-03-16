const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Wallet-level reward totals per token
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

    // Per-tournament rewards for each wallet
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

    // Track when each wallet was last synced
    await client.query(`
      CREATE TABLE IF NOT EXISTS wallet_sync (
        wallet TEXT PRIMARY KEY,
        totals_synced_at TIMESTAMPTZ,
        tournaments_synced_at TIMESTAMPTZ
      )
    `);

    await client.query("CREATE INDEX IF NOT EXISTS idx_reward_totals_wallet ON reward_totals(wallet)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_tournament_rewards_wallet ON tournament_rewards(wallet)");

    await client.query("COMMIT");
    console.log("Migration complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
