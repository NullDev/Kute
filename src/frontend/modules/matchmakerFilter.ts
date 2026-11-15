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

const DEFAULT_MODES = new Set(MODE_FILTER.filter((mode) => mode !== "Parkour"));

export const MAP_FILTER = [
    "Burg", "Littletown", "Sandstorm", "Subzero", "Undergrowth", "Freight", "Lostworld", "Citadel", "Oasis", "Kanji",
    "Industry", "Lumber", "Evacuation", "Site", "SkyTemple", "Lagoon", "Tropicano", "Habitat", "Atomic", "Old_Burg",
    "Throwback", "Clockwork", "Bazaar", "Erupt", "HQ", "Lush", "Vivo", "Slide Moonlight", "Eterno Simulator", "Eterno Jump",
    "Frontier", "Piazza", "Barnyard",
];

export const normalizeMap = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/g, "");

const DEFAULT_MAPS = new Set(MAP_FILTER.map(normalizeMap));
const URL_UNSAFE = /[\s&#?/%\\]/;

export interface MatchmakerFilter {
    regions: string[];
    modes: string[];
    maps: string[];
    preferredMaps: string[];
    preferredModes: string[];
    minPlayers: number;
    maxPlayers: number;
    minTime: number;
    sortByPlayers: boolean;
    serverBrowser: boolean;
    animation: boolean;
    searchAfterMatch: boolean;
    collectRewards: boolean;
    keepSearching: boolean;
    skipRecent: number;
}

export const DEFAULT_FILTER: MatchmakerFilter = {
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
    collectRewards: true,
    keepSearching: false,
    skipRecent: 1,
};

export const MAX_SKIP_RECENT = 10;

export function rememberLobby(recent: string[], id: string | null): string[]{
    const known = recent.filter((entry) => typeof entry === "string" && entry !== id);
    return (id ? [id, ...known] : known).slice(0, MAX_SKIP_RECENT);
}

export function skippedLobbies(recent: string[], count: number, rejected: string[]): Set<string>{
    return new Set([...recent.slice(0, Math.max(0, count)), ...rejected]);
}

export interface Lobby {
    id: string;
    region: string;
    server: string;
    players: number;
    limit: number;
    map: string;
    mode: string;
    timeLeft: number;
    passes: boolean;
}

function allowedModes(filter: MatchmakerFilter): Set<string> | null{
    if (filter.modes.length > 0) return new Set(filter.modes);
    return filter.maps.length > 0 ? null : DEFAULT_MODES;
}

export function readLobbies(games: any[], filter: MatchmakerFilter, skip: ReadonlySet<string> = new Set()): Lobby[]{
    const maps = filter.maps.length > 0 ? new Set(filter.maps.map(normalizeMap)) : DEFAULT_MAPS;
    const modes = allowedModes(filter);
    return games.map((game) => {
        const id = String(game[0]);
        const details = game[4] ?? {};
        const official = details.c === 0 || details.oc === 1;
        const map = String(details.i ?? "");
        const lobby: Lobby = {
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
            (lobby.timeLeft > 0 ? lobby.timeLeft >= filter.minTime : details.g === PARKOUR) &&
            !skip.has(id);
        return lobby;
    });
}
