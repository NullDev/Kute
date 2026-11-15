import { describe, expect, test } from "bun:test";
import { COOLDOWN_MS, FIRST_RETRY_MS, MAX_RETRY_MS, cooldownMs, nextRetryMs, retryAfterMs } from "../src/frontend/modules/matchmakerPacing.ts";

describe("retry-after header", () => {
    test("seconds", () => {
        expect(retryAfterMs("120", 0)).toBe(120000);
        expect(retryAfterMs("0", 0)).toBe(0);
    });

    test("a date counts from now and never goes negative", () => {
        const now = Date.parse("2026-11-15T12:00:00Z");
        expect(retryAfterMs("Sun, 15 Nov 2026 12:02:00 GMT", now)).toBe(120000);
        expect(retryAfterMs("Sun, 15 Nov 2026 11:00:00 GMT", now)).toBe(0);
    });

    test("missing or unreadable", () => {
        expect(retryAfterMs(null, 0)).toBeNull();
        expect(retryAfterMs("", 0)).toBeNull();
        expect(retryAfterMs("soon", 0)).toBeNull();
        expect(retryAfterMs("-5", 0)).toBeNull();
    });
});

describe("cooldown", () => {
    test("only a rate limit or a server error pauses the searches", () => {
        expect(cooldownMs(429, null)).toBe(COOLDOWN_MS);
        expect(cooldownMs(503, null)).toBe(COOLDOWN_MS);
        expect(cooldownMs(0, null)).toBe(0);
        expect(cooldownMs(404, null)).toBe(0);
        expect(cooldownMs(600, null)).toBe(0);
    });

    test("the server can ask for more than the minimum, never for less", () => {
        expect(cooldownMs(429, 300000)).toBe(300000);
        expect(cooldownMs(429, 1000)).toBe(COOLDOWN_MS);
    });
});

describe("retry delay", () => {
    test("grows from the first delay up to the cap", () => {
        let delay = nextRetryMs(0);
        expect(delay).toBe(FIRST_RETRY_MS);
        for (let i = 0; i < 20; i++){
            const next = nextRetryMs(delay);
            expect(next).toBeGreaterThanOrEqual(delay);
            delay = next;
        }
        expect(delay).toBe(MAX_RETRY_MS);
    });
});
