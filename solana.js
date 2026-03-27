// Direct Solana RPC access — reads GibMeme tournament accounts via Helius
const { Connection, PublicKey } = require("@solana/web3.js");
const BN = require("bn.js");
const bs58 = require("bs58");

const PROGRAM_ID = new PublicKey("4zAxB3Q6VVV8msirodwkjCfaeZumKitkcvR7pUveSqSR");
const BOARD = new PublicKey(process.env.GIB_BOARD || "BYYdh3UjeKF1Gfjb4vy2JJhjTUoQxKZ62mP9z5YA9Aou");

let connection;

function getConnection() {
  if (!connection) {
    const apiKey = process.env.HELIUS_API_KEY;
    if (!apiKey) throw new Error("HELIUS_API_KEY not set");
    connection = new Connection(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, "confirmed");
  }
  return connection;
}

// ── Byte helpers (matching front-end's bytesTo16/32/64) ─────────────

function bytesTo16(bytes) {
  return bytes[0] | (bytes[1] << 8);
}

function bytesTo32(bytes) {
  return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
}

function bytesTo64(bytes) {
  return new BN(Buffer.from(bytes), "le");
}

// ── PDA derivation ──────────────────────────────────────────────────

function tournamentPDA(index) {
  const indexBuf = new BN(index).toArrayLike(Buffer, "le", 4);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("tournament"), BOARD.toBytes(), indexBuf],
    PROGRAM_ID
  );
}

// ── Parse tournament account data (ported from humanParseTournament) ─

function parseTournament(data, tournamentAddress) {
  const buf = [...data];
  buf.splice(0, 8); // anchor discriminator

  const clase = buf.splice(0, 1)[0];
  const state = buf.splice(0, 1)[0];

  buf.splice(0, 8); // storeHash
  buf.splice(0, 8); // boardHash

  const index = bytesTo32(buf.splice(0, 4));
  const round = bytesTo16(buf.splice(0, 2));
  buf.splice(0, 2); // liveSpaces
  const registeredPlayers = bytesTo16(buf.splice(0, 2));
  buf.splice(0, 2); // alivePlayers
  const pot = Number(bytesTo64(buf.splice(0, 8)).toString());
  const createdTime = bytesTo32(buf.splice(0, 4));
  buf.splice(0, 2); // processing
  buf.splice(0, 2); // claimed

  // TournamentRules (140 or 220 bytes depending on class)
  const rulesSize = clase === 8 ? 220 : 140;
  const rulesData = buf.splice(0, rulesSize);

  // Parse rules manually
  buf.splice(0, 0); // fee (u64) — skip, we parse what we need
  // TournamentRules layout:
  // fee: u64 (8), feeCurrency: pubkey (32), maxPlayers: u16 (2), minPlayers: u16 (2),
  // roundsDates: [u8;39] (39), cardsPerDeck: u8 (1), startingDay: u32 (4),
  // timeBetweenRounds: u16 (2), executedRoundAt: u32 (4),
  // tournamentIdentifier: [u8;16] (16), prizes: [u8;30] (30)
  let rOff = 0;
  rOff += 8; // fee
  rOff += 32; // feeCurrency
  rOff += 2; // maxPlayers
  rOff += 2; // minPlayers
  rOff += 39; // roundsDates
  const cardsPerDeck = rulesData[rOff] || 5;
  rOff += 1; // cardsPerDeck
  rOff += 4; // startingDay
  rOff += 2; // timeBetweenRounds
  rOff += 4; // executedRoundAt

  // tournamentIdentifier: 16 bytes
  const idBytes = rulesData.slice(rOff, rOff + 16);
  rOff += 16;

  // Decode tournament name
  const idClean = [...idBytes];
  while (idClean.length && idClean[idClean.length - 1] === 0) idClean.pop();
  let tournamentName = null;
  try {
    tournamentName = new TextDecoder().decode(new Uint8Array(idClean));
  } catch (e) { /* ignore */ }

  // prizes: 30 bytes — encoded as Anchor Prizes type
  // Layout: 4 bytes vec length prefix, then Prize structs (13 bytes each: u32 + u64 + u8)
  const prizesRaw = rulesData.slice(rOff, rOff + 30);
  const prizes = decodePrizes(prizesRaw);

  // Parse parts (player entries)
  const SPACE = clase === 6 ? 175 : 127;
  const parts = [];
  while (buf.length >= SPACE) {
    const pa = buf.splice(0, SPACE);
    const available = !!pa[0];
    if (!available) continue;

    const active = pa[2];
    const joinType = pa[3];
    let off = 4;
    const userBytes = pa.slice(off, off + 32);
    const user = bs58.encode(Buffer.from(userBytes));
    off += 32;
    off += 4; // extra
    off += 55; // cards (default)
    const bet = Number(bytesTo64(pa.slice(off, off + 8)).toString());
    off += 8;
    const paid = Number(bytesTo64(pa.slice(off, off + 8)).toString());
    off += 8;
    const lastRound = pa[off];

    parts.push({ user, active, lastRound, joinType, bet, paid });
  }

  const ended = state >= 4;

  return {
    index,
    tournament: tournamentAddress,
    tournamentName,
    state,
    round,
    registeredPlayers,
    pot,
    createdTime,
    prizes,
    parts,
    ended,
    id: idBytes,
    clase,
  };
}

// ── Decode prizes from 30-byte buffer ───────────────────────────────
// Anchor Vec<Prize> encoding: 4-byte LE length prefix, then Prize structs
// Prize = { halfCurrencyHash: u32, amount: u64, flag: u8 } = 13 bytes

function decodePrizes(raw) {
  if (!raw || raw.length < 4) return [];
  const count = bytesTo32(raw.slice(0, 4));
  const prizes = [];
  let off = 4;
  for (let i = 0; i < count && off + 13 <= raw.length; i++) {
    const halfCurrencyHash = bytesTo32(raw.slice(off, off + 4));
    off += 4;
    const amount = Number(bytesTo64(raw.slice(off, off + 8)).toString());
    off += 8;
    const flag = raw[off];
    off += 1;
    prizes.push({ halfCurrencyHash, amount, flag });
  }
  return prizes;
}

// ── Get user positions from tournament parts ────────────────────────
// myPositions maps round number → count of entries at that position
// Each entry contributes ONE position at their lastRound

function getUserPositions(parts, wallet) {
  const positions = {};
  for (const part of parts) {
    if (part.user !== wallet) continue;
    // active states: 1=alive, 2=dead, 11=claimedAlive, 12=claimedDead
    // lastRound = the round they reached (their elimination/winning round)
    const round = part.lastRound;
    if (round > 0) {
      positions[round] = (positions[round] || 0) + 1;
    }
  }
  return positions;
}

// ── Read board to get upToTournament ────────────────────────────────

async function getBoardInfo() {
  const conn = getConnection();
  const info = await conn.getAccountInfo(BOARD);
  if (!info) throw new Error("Board account not found");
  const data = [...info.data];
  data.splice(0, 8); // discriminator
  data.splice(0, 1); // class
  data.splice(0, 32); // creator
  data.splice(0, 32); // store
  data.splice(0, 2); // slot
  data.splice(0, 8); // universeHash
  data.splice(0, 8); // boardHash
  const executingTournament = bytesTo32(data.splice(0, 4));
  const activeTournament = bytesTo32(data.splice(0, 4));
  const upToTournament = bytesTo32(data.splice(0, 4));
  return { executingTournament, activeTournament, upToTournament };
}

// ── Fetch a single tournament by index ──────────────────────────────

async function fetchTournament(index) {
  const conn = getConnection();
  const [pda] = tournamentPDA(index);
  const info = await conn.getAccountInfo(pda);
  if (!info) return null;
  return parseTournament(info.data, pda.toBase58());
}

// ── Fetch wallet rewards across all tournaments ─────────────────────

async function fetchWalletRewards(wallet, startIndex, count = 10) {
  const tournaments = [];
  const conn = getConnection();

  // Fetch tournaments in batches using getMultipleAccountsInfo
  const pdas = [];
  for (let i = startIndex; i > Math.max(0, startIndex - count); i--) {
    pdas.push({ index: i, pda: tournamentPDA(i)[0] });
  }

  const accounts = await conn.getMultipleAccountsInfo(pdas.map((p) => p.pda));

  for (let i = 0; i < accounts.length; i++) {
    if (!accounts[i]) continue;
    try {
      const parsed = parseTournament(accounts[i].data, pdas[i].pda.toBase58());
      const myPositions = getUserPositions(parsed.parts, wallet);
      // Count flies: players eliminated in round 1 (lastRound <= 1)
      const fliesCount = parsed.parts.filter(p => p.lastRound <= 1).length;
      if (Object.keys(myPositions).length > 0) {
        tournaments.push({
          ...parsed,
          myPositions,
          fliesCount,
          parts: undefined, // don't send all parts to client
        });
      }
    } catch (e) {
      console.error(`Error parsing tournament ${pdas[i].index}:`, e.message);
    }
  }

  return tournaments;
}

module.exports = {
  getConnection,
  getBoardInfo,
  fetchTournament,
  fetchWalletRewards,
  getUserPositions,
  parseTournament,
  tournamentPDA,
  PROGRAM_ID,
  BOARD,
};
