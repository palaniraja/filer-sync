// Constants and configuration

const PANES = {
    KEYS: ['scratch', 'notes', 'tasks'],
    FALLBACK_PREFIX: 'pane-'
};

const STORAGE = {
    CONTENT_KEY_PREFIX: 'filer_tab_content_',
    SERVER_SNAPSHOT_PREFIX: 'filer_last_server_',
    ACTIVE_TAB_KEY: 'filer_active_tab',
    PB_SYNC_CONFIG_KEY: 'pb_sync_config'
};

const SYNC = {
    DEBOUNCE_MS: 1000,
    POLL_INTERVAL_MS: 10000
};

const CONFLICT = {
    MARKER_OFFLINE: '<<<<< OFFLINE CHANGE',
    MARKER_DIVIDER: '=====',
    MARKER_SERVER: '>>>>> SERVER CHANGE'
};

const PB = {
    AUTH_COLLECTION: 'users',
    RECORD_COLLECTION: 'filer',
    API_COLLECTIONS_PREFIX: '/api/collections',
    AUTH_WITH_PASSWORD_SUFFIX: '/auth-with-password',
    RECORDS_SUFFIX: '/records'
};

PB.AUTH_COLLECTION_BASE = `${PB.API_COLLECTIONS_PREFIX}/${PB.AUTH_COLLECTION}`;
PB.RECORD_COLLECTION_BASE = `${PB.API_COLLECTIONS_PREFIX}/${PB.RECORD_COLLECTION}`;


const syncTimers = new Map();
let pollIntervalId = null;

const STATUS_PRIORITY = { conflict: 3, syncing: 2, offline: 1, synced: 0 };
const paneStatuses = ['offline', 'offline', 'offline'];

// UI status indicator
function updateCombinedIndicator() {
    const indicator = document.getElementById('sync-indicator');
    if (!indicator) {
        return;
    }

    const combined = paneStatuses.reduce((worst, s) =>
        (STATUS_PRIORITY[s] > STATUS_PRIORITY[worst] ? s : worst), 'synced');

    indicator.classList.remove('is-offline', 'is-syncing', 'is-synced', 'is-conflict');
    indicator.classList.add(`is-${combined}`);
}

function setPaneStatus(index, status) {
    paneStatuses[index] = status;
    updateCombinedIndicator();
}

function setAllPaneStatuses(status) {
    paneStatuses.fill(status);
    updateCombinedIndicator();
}

// Storage and pane helpers
function getSavedConfig() {
    const rawConfig = localStorage.getItem(STORAGE.PB_SYNC_CONFIG_KEY);
    return rawConfig ? JSON.parse(rawConfig) : null;
}

function getPaneKey(index) {
    return PANES.KEYS[index] || `${PANES.FALLBACK_PREFIX}${index}`;
}

function getContentStorageKey(index) {
    return `${STORAGE.CONTENT_KEY_PREFIX}${index}`;
}

function getServerSnapshotKey(index) {
    return `${STORAGE.SERVER_SNAPSHOT_PREFIX}${index}`;
}

function setPaneContent(index, content) {
    const area = document.getElementById(`t${index}`);
    localStorage.setItem(getContentStorageKey(index), content);
    if (area && area.value !== content) {
        area.value = content;
    }
}

function hasConflictMarkers(content) {
    return content.includes(CONFLICT.MARKER_OFFLINE);
}

function escapeFilterValue(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// PocketBase auth and fetch helpers
async function reauthenticate(config) {
    let authResponse;
    try {
        authResponse = await fetch(`${config.url}${PB.AUTH_COLLECTION_BASE}${PB.AUTH_WITH_PASSWORD_SUFFIX}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identity: config.email, password: config.password })
        });
    } catch {
        throw new TypeError('PocketBase server unreachable.');
    }

    if (!authResponse.ok) {
        if (authResponse.status === 400 || authResponse.status === 401 || authResponse.status === 403) {
            document.getElementById('pb-config-dialog').showModal();
        }
        throw new Error('Re-authentication failed.');
    }

    const authData = await authResponse.json();
    const nextConfig = { ...config, token: authData.token };
    localStorage.setItem(STORAGE.PB_SYNC_CONFIG_KEY, JSON.stringify(nextConfig));
    return nextConfig;
}

async function pbFetch(endpoint, options = {}) {
    let config = getSavedConfig();
    if (!config) {
        throw new Error('PocketBase not configured.');
    }

    const headers = {
        'Content-Type': 'application/json',
        ...options.headers,
        Authorization: config.token
    };

    let response = await fetch(`${config.url}${endpoint}`, {
        ...options,
        headers
    });

    if (response.status !== 401) {
        return response;
    }

    config = await reauthenticate(config);

    return fetch(`${config.url}${endpoint}`, {
        ...options,
        headers: {
            ...headers,
            Authorization: config.token
        }
    });
}

async function fetchPaneRecord(appId, paneKey) {
    const filter = encodeURIComponent(`app_id='${escapeFilterValue(appId)}' && pane_key='${escapeFilterValue(paneKey)}'`);
    const response = await pbFetch(`${PB.RECORD_COLLECTION_BASE}${PB.RECORDS_SUFFIX}?filter=${filter}&perPage=1`, {
        method: 'GET'
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch pane ${paneKey}.`);
    }

    const data = await response.json();
    return data.items[0] || null;
}

async function createPaneRecord(appId, paneKey, content) {
    const response = await pbFetch(`${PB.RECORD_COLLECTION_BASE}${PB.RECORDS_SUFFIX}`, {
        method: 'POST',
        body: JSON.stringify({
            app_id: appId,
            pane_key: paneKey,
            content
        })
    });

    if (!response.ok) {
        throw new Error(`Failed to create pane ${paneKey}.`);
    }

    return response.json();
}

async function updatePaneRecord(recordId, content) {
    const response = await pbFetch(`${PB.RECORD_COLLECTION_BASE}${PB.RECORDS_SUFFIX}/${recordId}`, {
        method: 'PATCH',
        body: JSON.stringify({ content })
    });

    if (!response.ok) {
        throw new Error('Failed to update pane.');
    }

    return response.json();
}

// Sync conflict merge helper
function mergeText(base, local, remote) {
    const baseLines = base.split('\n');
    const localLines = local.split('\n');
    const remoteLines = remote.split('\n');
    const result = [];
    let i = 0;
    let j = 0;
    let k = 0;

    while (i < localLines.length || j < remoteLines.length) {
        const localLine = localLines[i];
        const remoteLine = remoteLines[j];
        const baseLine = baseLines[k];

        if (localLine === remoteLine) {
            result.push(localLine || '');
            i += 1;
            j += 1;
            k += 1;
            continue;
        }

        if (localLine === baseLine && remoteLine !== baseLine) {
            result.push(remoteLine || '');
            i += 1;
            j += 1;
            k += 1;
            continue;
        }

        if (remoteLine === baseLine && localLine !== baseLine) {
            result.push(localLine || '');
            i += 1;
            j += 1;
            k += 1;
            continue;
        }

        result.push(CONFLICT.MARKER_OFFLINE);
        if (localLine !== undefined) {
            result.push(localLine);
        }
        result.push(CONFLICT.MARKER_DIVIDER);
        if (remoteLine !== undefined) {
            result.push(remoteLine);
        }
        result.push(CONFLICT.MARKER_SERVER);
        i += 1;
        j += 1;
        k += 1;
    }

    return result.join('\n');
}

// Per-pane sync engine
async function syncPane(index) {
    const config = getSavedConfig();
    if (!config || !config.appId) {
        setPaneStatus(index, 'offline');
        return;
    }

    if (!navigator.onLine) {
        setPaneStatus(index, 'offline');
        return;
    }

    setPaneStatus(index, 'syncing');

    const paneKey = getPaneKey(index);
    const localContent = localStorage.getItem(getContentStorageKey(index)) || '';
    const lastKnownServerContent = localStorage.getItem(getServerSnapshotKey(index));

    try {
        const record = await fetchPaneRecord(config.appId, paneKey);

        if (!record) {
            if (!localContent) {
                setPaneStatus(index, 'synced');
                return;
            }

            await createPaneRecord(config.appId, paneKey, localContent);
            localStorage.setItem(getServerSnapshotKey(index), localContent);
            setPaneStatus(index, 'synced');
            return;
        }

        const serverContent = record.content || '';

        if (lastKnownServerContent === null) {
            if (!localContent && serverContent) {
                setPaneContent(index, serverContent);
                localStorage.setItem(getServerSnapshotKey(index), serverContent);
                setPaneStatus(index, 'synced');
                return;
            }

            if (localContent && !serverContent) {
                await updatePaneRecord(record.id, localContent);
                localStorage.setItem(getServerSnapshotKey(index), localContent);
                setPaneStatus(index, 'synced');
                return;
            }

            if (localContent && serverContent && localContent !== serverContent) {
                const mergedContent = mergeText('', localContent, serverContent);
                setPaneContent(index, mergedContent);
                await updatePaneRecord(record.id, mergedContent);
                localStorage.setItem(getServerSnapshotKey(index), mergedContent);
                setPaneStatus(index, 'conflict');
                return;
            }

            localStorage.setItem(getServerSnapshotKey(index), serverContent);
            setPaneStatus(index, 'synced');
            return;
        }

        if (localContent === serverContent) {
            localStorage.setItem(getServerSnapshotKey(index), serverContent);
            setPaneStatus(index, hasConflictMarkers(localContent) ? 'conflict' : 'synced');
            return;
        }

        if (localContent === lastKnownServerContent && serverContent !== lastKnownServerContent) {
            setPaneContent(index, serverContent);
            localStorage.setItem(getServerSnapshotKey(index), serverContent);
            setPaneStatus(index, 'synced');
            return;
        }

        if (localContent !== lastKnownServerContent && serverContent === lastKnownServerContent) {
            await updatePaneRecord(record.id, localContent);
            localStorage.setItem(getServerSnapshotKey(index), localContent);
            setPaneStatus(index, 'synced');
            return;
        }

        const mergedContent = mergeText(lastKnownServerContent, localContent, serverContent);
        setPaneContent(index, mergedContent);
        await updatePaneRecord(record.id, mergedContent);
        localStorage.setItem(getServerSnapshotKey(index), mergedContent);
        setPaneStatus(index, 'conflict');
    } catch (error) {
        // TypeError means fetch couldn't reach the server — treat as offline
        const isNetworkError = error instanceof TypeError;
        setPaneStatus(index, isNetworkError ? 'offline' : 'conflict');
        console.error(`Sync failed for pane ${paneKey}:`, error);
    }
}

// Sync triggers
function schedulePaneSync(index) {
    if (syncTimers.has(index)) {
        clearTimeout(syncTimers.get(index));
    }

    const timerId = window.setTimeout(() => {
        syncTimers.delete(index);
        syncPane(index);
    }, SYNC.DEBOUNCE_MS);

    syncTimers.set(index, timerId);
}

function hydrateSettingsForm() {
    const config = getSavedConfig();
    if (!config) {
        return;
    }

    document.getElementById('pb-url').value = config.url || '';
    document.getElementById('pb-app-id').value = config.appId || '';
    document.getElementById('pb-user').value = config.email || '';
    document.getElementById('pb-pass').value = config.password || '';
}

function exportLocalData() {
    const dump = {};
    for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key || key === STORAGE.PB_SYNC_CONFIG_KEY) {
            continue;
        }
        dump[key] = localStorage.getItem(key);
    }

    const fileContent = JSON.stringify({
        exportedAt: new Date().toISOString(),
        data: dump
    }, null, 2);

    const blob = new Blob([fileContent], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `filer-backup-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

function applyImportedData(data) {
    const imported = data && typeof data === 'object' && data.data && typeof data.data === 'object'
        ? data.data
        : data;

    if (!imported || typeof imported !== 'object') {
        throw new Error('Invalid backup format.');
    }

    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && key !== STORAGE.PB_SYNC_CONFIG_KEY) {
            keysToRemove.push(key);
        }
    }
    keysToRemove.forEach((key) => localStorage.removeItem(key));

    Object.entries(imported).forEach(([key, value]) => {
        if (key !== STORAGE.PB_SYNC_CONFIG_KEY) {
            localStorage.setItem(key, String(value));
        }
    });

    document.querySelectorAll('textarea').forEach((area, index) => {
        area.value = localStorage.getItem(getContentStorageKey(index)) || '';
    });

    const activeTabIndex = parseInt(localStorage.getItem(STORAGE.ACTIVE_TAB_KEY) || '0', 10);
    if (typeof window.setActive === 'function' && !Number.isNaN(activeTabIndex)) {
        window.setActive(activeTabIndex);
    }

    document.getElementById('pb-config-dialog').close();
    alert(`Imported successfully`);
}

function bindPaneSync() {
    const textareas = document.querySelectorAll('textarea');

    textareas.forEach((area, index) => {
        area.addEventListener('input', (event) => {
            localStorage.setItem(getContentStorageKey(index), event.target.value);
            schedulePaneSync(index);
        });
    });
}

function syncAllPanes() {
    const syncJobs = [];
    document.querySelectorAll('textarea').forEach((_, index) => {
        setPaneStatus(index, 'syncing');
        syncJobs.push(syncPane(index));
    });
    return Promise.allSettled(syncJobs);
}

// Polling lifecycle
function canPoll() {
    const config = getSavedConfig();
    return Boolean(
        config &&
        config.appId &&
        navigator.onLine &&
        document.visibilityState === 'visible'
    );
}

function stopPolling() {
    if (pollIntervalId !== null) {
        window.clearInterval(pollIntervalId);
        pollIntervalId = null;
    }
}

function startPolling() {
    if (!canPoll() || pollIntervalId !== null) {
        return;
    }

    pollIntervalId = window.setInterval(() => {
        if (!canPoll()) {
            stopPolling();
            return;
        }

        syncAllPanes();
    }, SYNC.POLL_INTERVAL_MS);
}

function handleOnline() {
    setAllPaneStatuses('synced');
    syncAllPanes();
    startPolling();
}

function handleOffline() {
    setAllPaneStatuses('offline');
    stopPolling();
}

function handleVisibilityChange() {
    if (document.visibilityState === 'visible') {
        syncAllPanes();
        startPolling();
        return;
    }

    stopPolling();
}

function setupPollingLifecycle() {
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    document.addEventListener('visibilitychange', handleVisibilityChange);
}

// Settings and initialization
function setupSettings() {
    const configForm = document.getElementById('pb-config-form');
    const dialog = document.getElementById('pb-config-dialog');
    const indicator = document.getElementById('sync-indicator');
    const exportButton = document.getElementById('pb-export-btn');
    const importButton = document.getElementById('pb-import-btn');
    const importFileInput = document.getElementById('pb-import-file');

    hydrateSettingsForm();
    bindPaneSync();
    setupPollingLifecycle();

    indicator.addEventListener('click', () => {
        hydrateSettingsForm();
        dialog.showModal();
    });

    exportButton.addEventListener('click', () => {
        exportLocalData();
    });

    importButton.addEventListener('click', () => {
        importFileInput.value = '';
        importFileInput.click();
    });

    importFileInput.addEventListener('change', async (event) => {
        const [file] = event.target.files || [];
        if (!file) {
            return;
        }

        try {
            const raw = await file.text();
            const parsed = JSON.parse(raw);
            applyImportedData(parsed);
            syncAllPanes();
        } catch (error) {
            alert(`Import failed: ${error.message}`);
        }
    });

    configForm.addEventListener('submit', async (event) => {
        event.preventDefault();

        const url = document.getElementById('pb-url').value.replace(/\/$/, '');
        const appId = document.getElementById('pb-app-id').value.trim();
        const email = document.getElementById('pb-user').value.trim();
        const password = document.getElementById('pb-pass').value;

        try {
            const authResponse = await fetch(`${url}${PB.AUTH_COLLECTION_BASE}${PB.AUTH_WITH_PASSWORD_SUFFIX}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ identity: email, password })
            });

            if (!authResponse.ok) {
                throw new Error('Auth failed. Check credentials.');
            }

            const authData = await authResponse.json();
            localStorage.setItem(STORAGE.PB_SYNC_CONFIG_KEY, JSON.stringify({
                url,
                appId,
                email,
                password,
                token: authData.token
            }));

            dialog.close();
            syncAllPanes();
            startPolling();
        } catch (error) {
            alert(error.message);
        }
    });

    const savedConfig = getSavedConfig();
    if (!savedConfig || !savedConfig.appId) {
        stopPolling();
        setAllPaneStatuses('offline');
        return;
    }

    syncAllPanes();
    startPolling();

    if (!navigator.onLine) {
        setAllPaneStatuses('offline');
    }
}