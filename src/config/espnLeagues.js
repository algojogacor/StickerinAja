// ESPN league definitions — league codes, names, and search aliases.

const ESPN_LEAGUES = {
  epl: {
    name: "Premier League",
    code: "eng.1",
    aliases: ["epl", "premierleague", "premier", "english"],
  },
  laliga: {
    name: "La Liga",
    code: "esp.1",
    aliases: ["laliga", "spanyol", "spanish", "la liga"],
  },
  seriea: {
    name: "Serie A",
    code: "ita.1",
    aliases: ["seriea", "italia", "italian", "serie a"],
  },
  bundesliga: {
    name: "Bundesliga",
    code: "ger.1",
    aliases: ["bundesliga", "jerman", "german", "bundes"],
  },
  ligue1: {
    name: "Ligue 1",
    code: "fra.1",
    aliases: ["ligue1", "prancis", "french", "ligue 1"],
  },
  ucl: {
    name: "UEFA Champions League",
    code: "uefa.champions",
    aliases: ["ucl", "championsleague", "champions", "liga champion"],
  },
  uel: {
    name: "UEFA Europa League",
    code: "uefa.europa",
    aliases: ["uel", "europaleague", "europa", "europa league"],
  },
  uecl: {
    name: "UEFA Conference League",
    code: "uefa.europa.conf",
    aliases: ["uecl", "conferenceleague", "conference", "conference league"],
  },
  worldcup: {
    name: "FIFA World Cup",
    code: "fifa.world",
    aliases: ["worldcup", "pialadunia", "world cup", "pildun"],
  },
};

// Build a lookup map: alias name → league entry
function buildLeagueLookup() {
  const map = new Map();
  for (const [key, league] of Object.entries(ESPN_LEAGUES)) {
    map.set(key.toLowerCase(), league);
    for (const alias of league.aliases) {
      map.set(alias.toLowerCase(), league);
    }
  }
  return map;
}

const LEAGUE_LOOKUP = buildLeagueLookup();

/** Find league by alias string (case-insensitive). */
function findLeague(query) {
  if (!query) return null;
  return LEAGUE_LOOKUP.get(query.toLowerCase()) || null;
}

/** Get all league definitions. */
function getAllLeagues() {
  return Object.entries(ESPN_LEAGUES).map(([key, val]) => ({ key, ...val }));
}

const REGULATION_MINUTES = 90;
const HALF_TIME_MINUTES = 15;
const ESTIMATED_STOPPAGE_MINUTES = 7;
const ESTIMATED_TOTAL_MINUTES =
  REGULATION_MINUTES + HALF_TIME_MINUTES + ESTIMATED_STOPPAGE_MINUTES;
const MONITOR_START_AFTER_MINUTES = 100;
const MAX_MONITOR_DURATION_MINUTES = 240;

const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const FETCH_TIMEOUT_MS = 15000;
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 2000;

const CACHE_TTL_LIVE = 45_000;      // 45s for live match manual commands
const CACHE_TTL_SCHEDULED = 30 * 60_000; // 30min for far-ahead schedules

module.exports = {
  ESPN_LEAGUES,
  LEAGUE_LOOKUP,
  findLeague,
  getAllLeagues,
  REGULATION_MINUTES,
  HALF_TIME_MINUTES,
  ESTIMATED_STOPPAGE_MINUTES,
  ESTIMATED_TOTAL_MINUTES,
  MONITOR_START_AFTER_MINUTES,
  MAX_MONITOR_DURATION_MINUTES,
  ESPN_BASE,
  FETCH_TIMEOUT_MS,
  MAX_RETRIES,
  RETRY_BASE_MS,
  CACHE_TTL_LIVE,
  CACHE_TTL_SCHEDULED,
};
