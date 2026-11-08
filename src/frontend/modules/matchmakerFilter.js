// the pure half of the matchmaker: tables and the lobby filter, so bun can test them against a real game list

// index = gamemode id in the game list (game[4].g). 30 to 36 as krunker's host game window lists them (kcc faaffbf,
// 2026-10-30), chaos snipers and bighead ffa sat at 30 and 31 before that
export const GAMEMODES = [
    "Free for All", "Team Deathmatch", "Hardpoint", "Capture the Flag", "Parkour", "Hide & Seek", "Infected", "Race",
    "Last Man Standing", "Simon Says", "Gun Game", "Prop Hunt", "Boss Hunt", "Classic FFA", "Deposit", "Stalker",
    "King of the Hill", "One in the Chamber", "Trade", "Kill Confirmed", "Defuse", "Sharp Shooter", "Traitor", "Raid",
    "Blitz", "Domination", "Squad Deathmatch", "Kranked FFA", "Team Defender", "Deposit FFA", "Carrier", "All or Nothing",
    "Mag Dump", "Chaos Snipers", "Bighead FFA", "Zombies", "Impulsed",
];

const PARKOUR = 4;

export const MODE_FILTER = [
    "Free for All", "Team Deathmatch", "Hardpoint", "Capture the Flag", "Parkour", "Gun Game", "Classic FFA", "Deposit",
    "Kill Confirmed", "Sharp Shooter", "Domination", "Kranked FFA", "Team Defender", "Deposit FFA", "Chaos Snipers",
    "Bighead FFA",
];

// nothing picked: these without parkour, so a search never lands in a parkour, raid or event room
const DEFAULT_MODES = new Set(MODE_FILTER.filter((mode) => mode !== "Parkour"));

// official maps. none picked means all of these, keeps community maps out
export const MAP_FILTER = [
    "Burg", "Littletown", "Sandstorm", "Subzero", "Undergrowth", "Freight", "Lostworld", "Citadel", "Oasis", "Kanji",
    "Industry", "Lumber", "Evacuation", "Site", "SkyTemple", "Lagoon", "Tropicano", "Habitat", "Atomic", "Old_Burg",
    "Throwback", "Clockwork", "Bazaar", "Erupt", "HQ", "Lush", "Vivo", "Slide Moonlight", "Eterno Simulator", "Eterno Jump",
    "Frontier", "Piazza", "Barnyard",
];

/**
 * game list writes map ids its own way ("slide_moonlight"), so compare normalized
 *
 * @param {string} name
 * @return {string}
 */
export const normalizeMap = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

const DEFAULT_MAPS = new Set(MAP_FILTER.map(normalizeMap));
// the id goes into the join url as is
const URL_UNSAFE = /[\s&#?/%\\]/;

/**
 * @typedef {object} MatchmakerFilter
 * @property {string[]} regions game id prefixes
 * @property {string[]} modes
 * @property {string[]} maps
 * @property {string[]} preferredMaps tried first in this order, before ping and players
 * @property {string[]} preferredModes like preferredMaps, ranks above them
 * @property {number} minPlayers
 * @property {number} maxPlayers
 * @property {number} minTime seconds left in the round
 * @property {boolean} sortByPlayers most players first instead of lowest ping
 * @property {boolean} serverBrowser open the server browser when nothing matches
 * @property {boolean} animation show the search popup
 * @property {boolean} searchAfterMatch search again when the end screen shows
 */

/** @type {MatchmakerFilter} */
export const DEFAULT_FILTER = {
    regions: [],
    modes: [],
    maps: [],
    preferredMaps: [],
    preferredModes: [],
    minPlayers: 1,
    maxPlayers: 6,
    minTime: 120,
    sortByPlayers: false,
    serverBrowser: true,
    animation: true,
    searchAfterMatch: false,
};

/**
 * @typedef {object} Lobby
 * @property {string} id
 * @property {string} region id prefix
 * @property {string} server region server id, pings are keyed by it
 * @property {number} players
 * @property {number} limit
 * @property {string} map
 * @property {string} mode
 * @property {number} timeLeft seconds, 0 = no round timer
 * @property {boolean} passes
 */

/**
 * picked maps take any mode on them, bastion only ever runs raids
 *
 * @param {MatchmakerFilter} filter
 * @return {Set<string>|null} null = any
 */
function allowedModes(filter){
    if (filter.modes.length > 0) return new Set(filter.modes);
    return filter.maps.length > 0 ? null : DEFAULT_MODES;
}

/**
 * @param {any[]} games raw game list entries
 * @param {MatchmakerFilter} filter
 * @return {Lobby[]}
 */
export function readLobbies(games, filter){
    const maps = filter.maps.length > 0 ? new Set(filter.maps.map(normalizeMap)) : DEFAULT_MAPS;
    const modes = allowedModes(filter);
    return games.map((game) => {
        const id = String(game[0]);
        const details = game[4] ?? {};
        // c 1 = custom game, oc 1 = custom game run by krunker (parkour, raids, events)
        const official = details.c === 0 || details.oc === 1;
        const map = String(details.i ?? "");
        /** @type {Lobby} */
        const lobby = {
            id,
            region: id.split(":")[0],
            server: String(game[1]),
            players: Number(game[2]),
            limit: Number(game[3]),
            map,
            mode: GAMEMODES[details.g] ?? `Mode ${details.g}`,
            timeLeft: Number(game[5]),
            passes: false,
        };
        lobby.passes =
            official &&
            !URL_UNSAFE.test(id) &&
            (filter.regions.length === 0 || filter.regions.includes(lobby.region)) &&
            (modes === null || modes.has(lobby.mode)) &&
            maps.has(normalizeMap(map)) &&
            lobby.players >= filter.minPlayers &&
            lobby.players <= filter.maxPlayers &&
            lobby.players < lobby.limit &&
            // 0 means no round timer, not "0 seconds left". only parkour runs without one
            (lobby.timeLeft > 0 ? lobby.timeLeft >= filter.minTime : details.g === PARKOUR) &&
            !globalThis.location?.href.includes(id);
        return lobby;
    });
}
