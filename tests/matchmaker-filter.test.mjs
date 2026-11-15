import { describe, expect, test } from "bun:test";
import { DEFAULT_FILTER, GAMEMODES, readLobbies } from "../src/frontend/modules/matchmakerFilter.ts";
import list from "./fixtures/game-list.json";

// a cut of the live game list of 2026-11-08: official ffa and tdm rooms, community rooms, krunker's parkour, raid and
// zombies rooms (oc 1), the candy heist event (mode 37, c 0) and a trade room
const { games } = list;

/**
 * @param {Partial<import("../src/frontend/modules/matchmakerFilter.ts").MatchmakerFilter>} values
 * @return {import("../src/frontend/modules/matchmakerFilter.ts").MatchmakerFilter}
 */
const filter = (values = {}) => ({ ...DEFAULT_FILTER, ...values });

/**
 * @param {import("../src/frontend/modules/matchmakerFilter.ts").Lobby[]} lobbies
 * @return {string[]} ids of the lobbies that pass
 */
const passing = (lobbies) => lobbies.filter((lobby) => lobby.passes).map((lobby) => lobby.id);

describe("gamemode table", () => {
    test("the ids krunker's host game window lists", () => {
        expect(GAMEMODES[23]).toBe("Raid");
        expect(GAMEMODES[30]).toBe("Carrier");
        expect(GAMEMODES[33]).toBe("Chaos Snipers");
        expect(GAMEMODES[34]).toBe("Bighead FFA");
        expect(GAMEMODES[35]).toBe("Zombies");
        expect(GAMEMODES[36]).toBe("Impulsed");
        expect(GAMEMODES).toHaveLength(37);
    });

    test("an id beyond the table keeps its number", () => {
        const heist = readLobbies(games, filter()).find((lobby) => lobby.map === "Candy Heist");
        expect(heist?.mode).toBe("Mode 37");
    });
});

describe("default filter", () => {
    const lobbies = readLobbies(games, filter());

    test("joins official ffa and tdm rooms with time left and room for one more", () => {
        // NY:brdp2 is tdm at 7/8, above the default maximum of 6 players
        expect(passing(lobbies)).toEqual(["BRZ:4aqrd", "FRA:u4q3o", "SV:dyhkm", "DAL:04266"]);
    });

    test("never lands in krunker's raid, parkour, zombies or event rooms", () => {
        const skipped = lobbies.filter((lobby) => ["Raid", "Parkour", "Zombies", "Mode 37", "Trade"].includes(lobby.mode));
        expect(skipped.length).toBeGreaterThan(8);
        expect(skipped.every((lobby) => !lobby.passes)).toBe(true);
    });

    test("skips community rooms, full rooms and rounds about to end", () => {
        const byId = new Map(lobbies.map((lobby) => [lobby.id, lobby]));
        expect(byId.get("FRA:ja2w9")?.passes).toBe(false);
        expect(byId.get("NY:r2owv")?.passes).toBe(false);
        expect(byId.get("BRZ:n3lcf")?.passes).toBe(false);
    });
});

describe("picked modes and maps", () => {
    test("parkour picked: krunker's untimed parkour rooms pass, community parkour does not", () => {
        const ids = passing(readLobbies(games, filter({ modes: ["Parkour"], minPlayers: 0 })));
        expect(ids).toEqual(["TOK:jh61l", "SV:nh3t5", "BHN:gvv5g"]);
    });

    test("a timed room still needs the minimum time with parkour picked", () => {
        const ids = passing(readLobbies(games, filter({ modes: ["Parkour", "Free for All"], minPlayers: 0, minTime: 160 })));
        expect(ids).toContain("BRZ:4aqrd");
        expect(ids).not.toContain("SV:dyhkm");
    });

    test("maps picked without modes take any mode on them", () => {
        const ids = passing(readLobbies(games, filter({ maps: ["Bastion", "Eterno Jump"], minPlayers: 0 })));
        expect(ids).toEqual(["TOK:jh61l", "FRA:imu0y"]);
    });

    test("an untimed room outside parkour is not a lobby", () => {
        const ids = passing(readLobbies(games, filter({ maps: ["Khepri", "Facility"], minPlayers: 0 })));
        expect(ids).toEqual([]);
    });

    test("chaos snipers picked matches the game list by its new id", () => {
        const chaos = [["FRA:test1", "de-fra", 3, 8, { c: 0, g: 33, i: "Burg" }, 300], ["FRA:test2", "de-fra", 3, 8, { c: 0, g: 30, i: "Burg" }, 300]];
        const lobbies = readLobbies(chaos, filter({ modes: ["Chaos Snipers"] }));
        expect(lobbies.map((lobby) => [lobby.mode, lobby.passes])).toEqual([["Chaos Snipers", true], ["Carrier", false]]);
    });
});
