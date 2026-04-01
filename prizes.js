// Prize calculation logic ported from GlobalGibMeme (gibmeme.js)

// Token map from front-end (halfCurrencyHash → token info)
const TOKEN_MAP = {
  0:          { mint: null, symbol: "SOL", decimals: 9 },
  1025640761: { mint: "2MwjFE1zbXyNKw6VjzGWa3BhPtFcs8htuX2xwRAtbonk", symbol: "CHONKY", decimals: 5 },
  3060408161: { mint: "SKRbvo6Gf7GondiT3BbTfuRDPqLWei4j2Qy2NPGZhW3", symbol: "SKR", decimals: 6 },
  641443857:  { mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", symbol: "WIF", decimals: 6 },
  173147864:  { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", symbol: "BONK", decimals: 5 },
  836488067:  { mint: "H7ed7UgcLp3ax4X1CQ5WuWDn6d1pprfMMYiv5ejwLWWU", symbol: "CHONKY", decimals: 5 },
  2146078117: { mint: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr", symbol: "POPCAT", decimals: 9 },
  1880961862: { mint: "SENDdRQtYMWaQrBroBrJ2Q53fgVuq95CV9UPGEvpCxa", symbol: "SEND", decimals: 6 },
  2161872254: { mint: "METAewgxyPbgwsseH8T16a39CQ5VyVxZi9zXiDPY18m", symbol: "MPLX", decimals: 6 },
  646306111:  { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", symbol: "USDC", decimals: 6 },
  2103134759: { mint: "5UUH9RTDiSpq6HKS6bp4NdU9PNJpXRXuiw6ShBTBhgH2", symbol: "TROLL", decimals: 9 },
};

const roundsCache = {};

function calculateRoundsAndRemainings(amountOfPlayers) {
  if (roundsCache[amountOfPlayers]) return roundsCache[amountOfPlayers].slice();
  if (amountOfPlayers === 78) {
    return [78, 39, 20, 10, 5, 3, 2, 1].reverse();
  }

  if (!Number.isInteger(amountOfPlayers) || amountOfPlayers < 0)
    throw new Error("n must be a positive integer");

  const seq = [amountOfPlayers];
  let x = amountOfPlayers;
  let round = 1;

  while (x > 1) {
    let passes = 0;
    if (round <= 3) {
      if (x % 2 === 1) passes = 1;
    } else {
      const half = Math.ceil(x / 2);
      let p2 = 1;
      while (p2 < half) p2 <<= 1;
      passes = 2 * p2 - x;
    }
    x = (x + passes) / 2;
    seq.push(x);
    round++;
  }

  seq.reverse();
  roundsCache[amountOfPlayers] = seq;
  return seq.slice();
}

function calculatePrizeDistribution(roundDist, totalCents, weightsOpt, index) {
  totalCents = Math.floor(totalCents);
  roundDist = [...roundDist].reverse();

  if (!weightsOpt) {
    weightsOpt = [1];
    for (let i = 1; i < roundDist.length - 1; i++) {
      if (i === roundDist.length - 3 && i > 1) {
        weightsOpt.push(weightsOpt[i - 2] * 1.75 * 1.33);
      } else if (i === roundDist.length - 2 && i > 1) {
        weightsOpt.push(weightsOpt[i - 2] * 1.75 * 1.1);
      } else {
        weightsOpt.push(weightsOpt[i - 1] * 1.75);
      }
    }
  }

  if (!Array.isArray(roundDist) || roundDist.length < 2) return [];
  if (!Number.isFinite(totalCents) || totalCents < 0 || Math.abs(totalCents - Math.floor(totalCents)) > 1e-9) return [];

  for (let i = 0; i < roundDist.length - 1; i++) {
    if (!(Number.isFinite(roundDist[i]) && Number.isFinite(roundDist[i + 1]))) return [];
    if (roundDist[i + 1] > roundDist[i]) return [];
  }

  const last = roundDist.length - 1;
  if (last === 0) return [0];

  const totalCentsI = BigInt(Math.round(totalCents));

  const remaining = roundDist.map((_, i) =>
    i < last ? BigInt(roundDist[i] - roundDist[i + 1]) : 1n
  );

  const payableLen = last;
  let weights;
  if (weightsOpt != null) {
    if (!Array.isArray(weightsOpt) || weightsOpt.length !== payableLen) return [];
    for (let i = 1; i < weightsOpt.length; i++) {
      if (!(weightsOpt[i] >= weightsOpt[i - 1])) return [];
    }
    weights = weightsOpt.slice();
  } else {
    weights = Array.from({ length: payableLen }, (_, k) => k + 1);
  }

  let denom = 0;
  for (let j = 0, i = 1; i <= last; j++, i++) {
    denom += Number(remaining[i]) * weights[j];
  }
  if (!(denom > 0)) return Array(roundDist.length).fill(0);

  const scale = totalCents / denom;
  const perCentsI = Array(roundDist.length).fill(0n);
  for (let j = 0, i = 1; i <= last; j++, i++) {
    const raw = weights[j] * scale;
    const cents = Math.max(0, Math.floor(raw));
    perCentsI[i] = BigInt(cents);
  }

  for (let i = 2; i <= last; i++) {
    if (perCentsI[i] < perCentsI[i - 1]) perCentsI[i] = perCentsI[i - 1];
  }

  let allocated = 0n;
  for (let i = 1; i <= last; i++) {
    allocated += perCentsI[i] * remaining[i];
  }
  let remainder = totalCentsI - allocated;

  if (remainder < 0n) {
    const abs = -remainder;
    const lastBI = BigInt(last);
    const sePasa = (abs + lastBI - 1n) / lastBI;
    allocated = 0n;
    for (let i = 1; i <= last; i++) {
      allocated += perCentsI[i] * remaining[i] - sePasa;
    }
    remainder = totalCentsI - allocated;
    if (remainder < 0n) return [];
  }

  for (let i = last; i >= 1; i--) {
    const cost = remaining[i];
    if (cost <= 0n) continue;
    const blocks = remainder / cost;
    if (blocks > 0n) {
      perCentsI[i] += blocks;
      remainder -= blocks * cost;
    }
  }

  const perPlayerCents = Array(roundDist.length).fill(0);
  for (let i = 1; i <= last; i++) {
    perPlayerCents[i] = Number(perCentsI[i]);
  }

  const totalCheck = totalPayoutCents(perPlayerCents, roundDist);
  if (totalCheck > totalCents) {
    const dif = totalCheck - totalCents;
    perPlayerCents[last] -= dif;
  }

  return perPlayerCents.slice(1).reverse();
}

function totalPayoutCents(perPlayerCents, roundDist) {
  let total = 0;
  const last = roundDist.length - 1;
  for (let i = 1; i <= last; i++) {
    const payees = i < last ? roundDist[i] - roundDist[i + 1] : 1;
    total += perPlayerCents[i] * payees;
  }
  return total;
}

function computeUserPrizes(tournament) {
  const { positions, prizes, players, id } = tournament;
  if (!positions || !prizes || !players) return [];

  const roundsDesc = calculateRoundsAndRemainings(players);

  const prizesPerRounds = prizes.map((prize) => {
    const totalValue = prize.amount;
    return calculatePrizeDistribution(
      roundsDesc,
      totalValue * 1_000_000_000,
      undefined,
      id
    ).map((x) => x / 1_000_000_000);
  });

  const moneys = prizesPerRounds.map(() => 0);
  positions.forEach((pos) => {
    const round = Number(pos.round);
    for (const [idx, schedule] of prizesPerRounds.entries()) {
      const index = schedule.length - (round - 1);
      moneys[idx] += Math.floor(schedule[index] || 0) * pos.amount;
    }
  });

  return moneys.map((amount, i) => {
    const hash = prizes[i].halfCurrencyHash;
    const token = TOKEN_MAP[hash] || TOKEN_MAP[0];
    const decimals = token.decimals;
    const symbol = token.symbol;
    const parsed = amount / 10 ** decimals;
    return { amount, parsed, symbol, decimals, halfCurrencyHash: hash };
  });
}

function thousandify(n, decimals = 3) {
  if (n < 0.001 && n > -0.001 && n) {
    if (n >= 1 || n < 0) return String(n);
    const [base, exp] = n.toExponential().split("e-");
    const zeros = parseInt(exp);
    const digits = base.replace(".", "").replace(/^0+/, "").slice(0, 3);
    const superscripts = {
      0: "\u2070", 1: "\u00B9", 2: "\u00B2", 3: "\u00B3",
      4: "\u2074", 5: "\u2075", 6: "\u2076", 7: "\u2077",
      8: "\u2078", 9: "\u2079",
    };
    const zeroSuperscript = String(zeros - 1).split("").map((d) => superscripts[d]).join("");
    return `0.0${zeroSuperscript}${digits}`;
  }
  if (n > 0.01) n = Math.round(n * 10 ** decimals) / 10 ** decimals;
  let resp = n.toLocaleString("en-US", { minimumFractionDigits: decimals });
  while (resp.includes(".") && resp.at(-1) === "0") {
    resp = resp.substring(0, resp.length - 1);
  }
  if (resp.at(-1) === ".") resp = resp.substring(0, resp.length - 1);
  return resp;
}

module.exports = {
  TOKEN_MAP,
  calculateRoundsAndRemainings,
  calculatePrizeDistribution,
  computeUserPrizes,
  thousandify,
};
