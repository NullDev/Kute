export interface FrameStats {
    frames: number;
    seconds: number;
    fps: number;
    meanMs: number;
    p50: number;
    p95: number;
    p99: number;
    p999: number;
    maxMs: number;
    hitches: number;
    hitchesPerSec: number;
    stallMs: number;
}

export class FrameRecorder {
    samples: Float32Array<ArrayBufferLike>;
    count: number;
    stored: number;
    last: number;
    first: number;

    constructor(capacity = 120000){
        this.samples = new Float32Array(capacity);
        this.count = 0;
        this.stored = 0;
        this.last = -1;
        this.first = -1;
    }

    frame(now: number): void{
        if (this.last >= 0){
            this.count++;
            if (this.stored < this.samples.length) this.samples[this.stored++] = now - this.last;
        }
        if (this.first < 0) this.first = now;
        this.last = now;
    }

    stats(refreshMs: number): FrameStats | null{
        if (this.stored === 0) return null;
        const sorted = this.samples.slice(0, this.stored).sort();
        const seconds = (this.last - this.first) / 1000;
        const percentile = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
        const p50 = percentile(0.5);
        const hitchMs = Math.max(4 * p50, refreshMs);

        let sum = 0;
        let hitches = 0;
        let stalled = 0;
        for (const gap of sorted){
            sum += gap;
            if (gap > hitchMs){
                hitches++;
                stalled += gap - p50;
            }
        }
        const storedSeconds = Math.max(0.001, sum / 1000);

        return {
            frames: this.count,
            seconds,
            fps: this.count / seconds,
            meanMs: sum / this.stored,
            p50,
            p95: percentile(0.95),
            p99: percentile(0.99),
            p999: percentile(0.999),
            maxMs: sorted[sorted.length - 1],
            hitches,
            hitchesPerSec: hitches / storedSeconds,
            stallMs: stalled / storedSeconds,
        };
    }
}

export class InputProbe {
    waits = new Float32Array(1 << 14);
    events = 0;
    packets = 0;
    onMove = (event: PointerEvent): void => {
        if (document.pointerLockElement === null) return;
        const coalesced = event.getCoalescedEvents();
        const oldest = coalesced.length > 0 ? coalesced[0].timeStamp : event.timeStamp;
        this.waits[this.events % this.waits.length] = performance.now() - oldest;
        this.events++;
        this.packets += Math.max(1, coalesced.length);
    };

    start(): void{
        this.events = 0;
        this.packets = 0;
        window.addEventListener("pointermove", this.onMove, { capture: true, passive: true });
    }

    stop(): { events: number; packets: number; p99: number | null; max: number | null; }{
        window.removeEventListener("pointermove", this.onMove, true);
        const stored = Math.min(this.events, this.waits.length);
        const sorted = this.waits.slice(0, stored).sort();
        return {
            events: this.events,
            packets: this.packets,
            p99: stored > 0 ? sorted[Math.min(stored - 1, Math.floor(stored * 0.99))] : null,
            max: stored > 0 ? sorted[stored - 1] : null,
        };
    }
}

export class TaskProbe {
    delays: number[] = [];
    timer = 0;
    sent = 0;
    channel = new MessageChannel();

    constructor(){
        this.channel.port1.onmessage = (event): void => {
            this.delays.push(performance.now() - event.data);
        };
    }

    start(): void{
        this.delays = [];
        this.sent = 0;
        let due = performance.now() + 10;
        this.timer = setInterval(() => {
            this.sent++;
            const now = performance.now();
            this.channel.port2.postMessage(Math.min(now, due));
            due = now + 10;
        }, 10);
    }

    stop(): { sent: number; ran: number; p99: number | null; max: number | null; }{
        clearInterval(this.timer);
        const sorted = [...this.delays].sort((a, b) => a - b);
        return {
            sent: this.sent,
            ran: sorted.length,
            p99: sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] : null,
            max: sorted.length ? sorted[sorted.length - 1] : null,
        };
    }
}
