export const OFFICIAL_MAPS = [
    "Burg", "Littletown", "Sandstorm", "Subzero", "Undergrowth", "Shipment", "Freight", "Lostworld", "Citadel", "Oasis",
    "Kanji", "Industry", "Lumber", "Evacuation", "Site", "SkyTemple", "Lagoon", "Bureau", "Tortuga", "Tropicano",
    "Krunk_Plaza", "Arena", "Habitat", "Atomic", "Old_Burg", "Throwback", "Stockade", "Facility", "Clockwork", "Laboratory",
    "Shipyard", "Soul Sanctum", "Bazaar", "Erupt", "HQ", "Khepri", "Lush", "Vivo", "Slide Moonlight", "Eterno Simulator",
    "Stalk Factory", "Eterno Jump", "Frontier", "Bastion", "Piazza", "Barnyard",
];

const MAPS_URL = "https://gapi.svc.krunker.io/maps";

export const mapImageUrl = (id: number): string => `https://assets.krunker.io/img/maps/map_${id}.png`;

export const mapLabel = (name: string): string => name.split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");

let live: Promise<[number, string][]> | null = null;

export function officialMaps(): Promise<[number, string][]>{
    live ??= fetch(MAPS_URL, { signal: AbortSignal.timeout(4000) })
        .then((response) => response.json())
        .then((body) => {
            const entries: [number, string][] = [];
            for (const entry of Array.isArray(body?.data) ? body.data : []){
                if (Number.isInteger(entry?.id) && entry.id >= 0 && typeof entry?.name === "string") entries.push([entry.id, entry.name]);
            }
            if (entries.length === 0) throw new Error("empty map list");
            return entries;
        })
        .catch(() => {
            live = null;
            return OFFICIAL_MAPS.map((name, id) => ([id, name] as [number, string]));
        });
    return live;
}
