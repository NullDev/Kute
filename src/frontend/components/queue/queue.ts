((): void => {
    interface QueueInfo {
        token: string;
        region: string;
        allRegions: boolean;
        sound: string;
        fallbackSound: string;
        volume?: () => number;
        maps: Record<string, { url: string, number: number }>;
    }

    const { info } = window as unknown as Window & { info: QueueInfo };

    function must<T = HTMLElement>(selector: string): T{
        const element = document.querySelector(selector);
        if (!element) throw new Error(`queue window: ${selector} is missing`);
        return element as T;
    }

    const MAPS = info.maps;
    const REGION_NAMES = { na: "North America", eu: "Europe", as: "Asia" } as Record<string, string>;
    const ACCEPT_SECONDS = 60;

    const queueStatus = must("#queueStatus");
    const statusArea = must("#statusArea");
    const queueTimerDisplay = must("#queueTimerDisplay");
    const regionSelectors = must("#regionCheckboxes");
    const matchPopupOverlay = must("#matchPopupOverlay");
    const countdownTimer = must("#countDownTimer");
    const foundRegion = must("#foundRegion");
    const mapSelectorButton = must("#mapSelectorButton");
    const mapSelectorOverlay = must("#mapSelectorOverlay");
    const closeMapSelectorButton = must("#closeMapSelector");
    const mapGrid = must("#mapGrid");
    const queueButton = must("#queueButton") as HTMLButtonElement;
    const closeButton = must("#closeButton");

    let isQueued = false;
    let isConnecting = false;
    let queueStartTime = 0;
    let queueInterval = 0;
    let countdownInterval = 0;
    let queueConnection: WebSocket | null = null;
    let audioContext: AudioContext | null = null;
    let notificationBuffer: AudioBuffer | null = null;
    let currentSource: AudioBufferSourceNode | null = null;
    const selectedMaps: Set<number> = new Set();

    const storage = window.opener?.localStorage ?? window.localStorage;

    function saveSettings(): void{
        const regions = Array.from(regionSelectors.querySelectorAll("input:checked"), (checkbox) => checkbox.id);
        storage.setItem("queue_selectedRegions", JSON.stringify(regions));
        storage.setItem("queue_newSelectedMaps", JSON.stringify(Array.from(selectedMaps)));
    }

    function loadSettings(): void{
        try {
            for (const regionId of JSON.parse(storage.getItem("queue_selectedRegions") ?? "[]")){
                const checkbox = document.getElementById(regionId) as HTMLInputElement | null;
                if (checkbox) checkbox.checked = true;
            }
            const savedMaps = storage.getItem("queue_newSelectedMaps");
            for (const number of savedMaps ? JSON.parse(savedMaps) : Object.values(MAPS).map((map) => map.number)) selectedMaps.add(Number(number));
        }
        catch {
            for (const map of Object.values(MAPS)) selectedMaps.add(map.number);
        }
    }

    function formatTime(seconds: number): string{
        const pad = (value: number): string => String(Math.floor(value)).padStart(2, "0");
        return `${pad(seconds / 3600)}:${pad((seconds % 3600) / 60)}:${pad(seconds % 60)}`;
    }

    function showStatus(active: boolean, text: string): void{
        queueStatus.textContent = text;
        queueStatus.classList.toggle("active", active);
        statusArea.classList.toggle("active", active);
    }

    function showIdle(text = "Ready"): void{
        isQueued = false;
        isConnecting = false;
        clearInterval(queueInterval);
        queueButton.textContent = "Start Queue";
        queueButton.classList.remove("in-queue");
        queueButton.disabled = false;
        queueTimerDisplay.textContent = "00:00:00";
        showStatus(false, text);
    }

    async function initializeAudio(): Promise<void>{
        audioContext = new AudioContext();
        if (audioContext.state === "suspended") await audioContext.resume();
        const decode = (base64: string): Promise<AudioBuffer> => (audioContext as AudioContext).decodeAudioData(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)).buffer);
        try {
            notificationBuffer = await decode(info.sound);
        }
        catch {
            notificationBuffer = await decode(info.fallbackSound ?? info.sound);
        }
    }

    function stopNotificationSound(): void{
        if (!currentSource) return;
        currentSource.stop();
        currentSource.disconnect();
        currentSource = null;
    }

    function playNotificationSound(): void{
        if (!notificationBuffer || audioContext?.state !== "running") return;
        stopNotificationSound();
        let volume = 1;
        try {
            volume = info.volume?.() ?? 1;
        }
        catch {}
        if (!(volume > 0)) return;
        const gain = audioContext.createGain();
        gain.gain.value = volume;
        gain.connect(audioContext.destination);
        const source = audioContext.createBufferSource();
        source.buffer = notificationBuffer;
        source.connect(gain);
        source.start(0);
        currentSource = source;
        source.onended = (): void => {
            if (currentSource === source) currentSource = null;
            source.disconnect();
            gain.disconnect();
        };
    }

    function showCooldown(milliseconds: number): void{
        const endTime = Date.now() + milliseconds;
        const update = (): void => {
            const remaining = Math.ceil((endTime - Date.now()) / 1000);
            if (remaining <= 0){
                showStatus(false, "Ready");
                queueButton.disabled = false;
                return;
            }
            showStatus(false, `Cooldown: ${formatTime(remaining)}`);
            queueButton.disabled = true;
            setTimeout(update, 1000);
        };
        update();
    }

    function matchFound(map: string, region: string): void{
        playNotificationSound();
        matchPopupOverlay.classList.add("active");

        const mapName = Object.entries(MAPS).find(([, data]) => data.number === Number.parseInt(map, 10))?.[0] ?? "unknown";
        const regionName = REGION_NAMES[region.slice(2)] ?? region.slice(2);
        foundRegion.textContent = `${regionName}, ${mapName}`;

        const startTime = Date.now();
        clearInterval(countdownInterval);
        countdownInterval = setInterval(() => {
            const remaining = Math.max(0, ACCEPT_SECONDS - Math.floor((Date.now() - startTime) / 1000));
            countdownTimer.textContent = formatTime(remaining);
            if (remaining <= 0){
                clearInterval(countdownInterval);
                matchPopupOverlay.classList.remove("active");
            }
        }, 1000);

        showIdle();
    }

    function startQueue(): void{
        const regions = Array.from(regionSelectors.querySelectorAll("input:checked") as NodeListOf<HTMLInputElement>, (input) => input.value);
        if (regions.length === 0 || selectedMaps.size === 0){
            showIdle(regions.length === 0 ? "Select at least one region" : "Select at least one map");
            return;
        }

        const url = `wss://gamefrontend.svc.krunker.io/v1/matchmaking/queue?token=${info.token}&maps=${Array.from(selectedMaps).join(",")}&regions=${regions.join(",")}`;
        let connection: WebSocket;
        try {
            connection = new WebSocket(url);
        }
        catch {
            showIdle("Connection failed");
            return;
        }
        queueConnection = connection;

        connection.onerror = (): void => showIdle("Connection error");
        connection.onclose = (): void => {
            if (isQueued || isConnecting) showIdle();
        };
        connection.onopen = (): void => {
            isQueued = true;
            isConnecting = false;
            queueStartTime = Date.now();
            queueButton.textContent = "Leave Queue";
            queueButton.classList.add("in-queue");
            queueButton.disabled = false;
            showStatus(true, "In queue");
            queueTimerDisplay.textContent = formatTime(0);
            queueInterval = setInterval(() => {
                queueTimerDisplay.textContent = formatTime((Date.now() - queueStartTime) / 1000);
            }, 1000);
        };
        connection.onmessage = (event): void => {
            const data = JSON.parse(event.data);
            if (data.type === "QUEUE_STATUS" && data.payload?.status === "MATCHED"){
                const found = data.payload.assignment.extensions;
                matchFound(String(found.map).trim(), String(found.region));
            }
            else if (data.type === "ERROR" && data.payload?.code === "COOLDOWN"){
                showIdle();
                connection.close();
                showCooldown(Number(data.payload.payload.cooldown));
            }
            else if (data.type === "INTERNAL_ERROR"){
                showIdle();
                connection.close();
            }
        };
    }

    function toggleMapSelection(mapNumber: number): void{
        const selected = !selectedMaps.has(mapNumber);
        if (selected) selectedMaps.add(mapNumber);
        else selectedMaps.delete(mapNumber);
        mapGrid.querySelector(`.map-item[data-map="${mapNumber}"]`)?.classList.toggle("selected", selected);

        if (isQueued) queueConnection?.close();
        saveSettings();
    }

    function buildMapGrid(): void{
        mapGrid.replaceChildren();
        for (const [mapName, data] of Object.entries(MAPS)){
            const item = document.createElement("div");
            item.className = "map-item";
            item.dataset.map = String(data.number);
            item.classList.toggle("selected", selectedMaps.has(data.number));
            const img = document.createElement("img");
            img.src = data.url;
            img.loading = "lazy";
            const label = document.createElement("span");
            label.textContent = mapName;
            item.append(img, label);
            item.onclick = (): void => toggleMapSelection(data.number);
            mapGrid.append(item);
        }
    }

    loadSettings();
    const preset = (info.region ? document.getElementById(info.region) : null) as HTMLInputElement | null;
    if (preset) preset.checked = true;
    buildMapGrid();

    mapSelectorButton.onclick = (): void => mapSelectorOverlay.classList.add("active");
    closeMapSelectorButton.onclick = (): void => mapSelectorOverlay.classList.remove("active");
    mapSelectorOverlay.onclick = (event): void => {
        if (event.target === mapSelectorOverlay) mapSelectorOverlay.classList.remove("active");
    };

    queueButton.onclick = async(): Promise<void> => {
        if (isConnecting) return;
        if (isQueued){
            queueConnection?.close();
            return;
        }
        queueButton.disabled = true;
        isConnecting = true;
        try {
            if (!notificationBuffer) await initializeAudio();
        }
        catch {}
        startQueue();
    };

    closeButton.onclick = (): void => {
        clearInterval(countdownInterval);
        matchPopupOverlay.classList.remove("active");
        stopNotificationSound();
    };

    const regionChanged = (): void => {
        if (isQueued) queueConnection?.close();
        saveSettings();
    };
    for (const input of regionSelectors.querySelectorAll("input")) input.onclick = regionChanged;
})();
