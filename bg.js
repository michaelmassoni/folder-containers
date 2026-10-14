/**
 * Background script for Folder Containers
 */

// Constants
const ROOT_MENU_ID = "folder-containers-root";
const NO_CONTAINER_ID = "no-container";

console.log("Folder Containers: Background script loaded via HTML page.");

let isBuilding = false;

// Initialize Context Menus
function buildContextMenu() {
    if (isBuilding) {
        console.log("Folder Containers: Already building menu, skipping.");
        return;
    }
    isBuilding = true;

    console.log("Folder Containers: Building context menu...");
    browser.menus.removeAll().then(async () => {
        // 1. Create Root Menu Item
        try {
            browser.menus.create({
                id: ROOT_MENU_ID,
                title: "Always Open in Container",
                contexts: ["bookmark"],
                // Removed viewTypes to be broader
            });
            console.log("Folder Containers: Root menu created.");
        } catch (e) {
            console.error("Folder Containers: Error creating root menu:", e);
        }

        // 2. Create "Default (No Container)" option
        browser.menus.create({
            id: NO_CONTAINER_ID,
            parentId: ROOT_MENU_ID,
            title: "Default (No Container)",
            contexts: ["bookmark"],
        });

        browser.menus.create({
            type: "separator",
            parentId: ROOT_MENU_ID,
            contexts: ["bookmark"],
        });

        // 3. Fetch Containers and create menu items
        try {
            const identities = await browser.contextualIdentities.query({});
            console.log(`Folder Containers: Found ${identities.length} containers.`);

            if (identities.length === 0) {
                console.warn("Folder Containers: No containers found.");
                browser.menus.create({
                    id: "no-containers-warning",
                    parentId: ROOT_MENU_ID,
                    title: "No Containers Found",
                    enabled: false,
                    contexts: ["bookmark"],
                });
            }

            identities.forEach((identity) => {
                browser.menus.create({
                    id: `container-${identity.cookieStoreId}`,
                    parentId: ROOT_MENU_ID,
                    title: identity.name,
                    contexts: ["bookmark"],
                });
            });
            console.log("Folder Containers: Container menu items created.");
        } catch (error) {
            console.error("Folder Containers: Error fetching containers:", error);
        }
    }).catch(err => {
        console.error("Folder Containers: Menus removeAll failed:", err);
    }).finally(() => {
        isBuilding = false;
    });
}

// Initial build - Call immediately once
buildContextMenu();

// Rebuild on install/startup - Debounce if needed, but usually redundant with direct call?
// Firefox documentation recommends re-creating on start.
// Let's rely on the direct call at file load (which happens on start) and remove explicit listeners to avoid race.
// Or keep one listener.
// Actually, `onStartup` fires *after* the script loads? No, script loads *on* startup.
// So `buildContextMenu()` at the bottom runs effectively on startup.
// `onInstalled` runs on update/install.
browser.runtime.onInstalled.addListener(() => {
    console.log("Folder Containers: onInstalled event.");
    buildContextMenu();
});

// Handle Menu Clicks
browser.menus.onClicked.addListener(async (info, tab) => {
    // Only handle our menus
    if (!info.menuItemId.startsWith(ROOT_MENU_ID) &&
        !info.menuItemId.startsWith("container-") &&
        info.menuItemId !== NO_CONTAINER_ID) {
        return;
    }

    const bookmarkId = info.bookmarkId;
    if (!bookmarkId) return;

    if (info.menuItemId === NO_CONTAINER_ID) {
        // Remove mapping
        await browser.storage.local.remove(bookmarkId);
        console.log(`Removed mapping for bookmarkId: ${bookmarkId}`);
    } else if (info.menuItemId.startsWith("container-")) {
        const cookieStoreId = info.menuItemId.replace("container-", "");
        // Save mapping
        await browser.storage.local.set({ [bookmarkId]: cookieStoreId });
        console.log(`Mapped bookmarkId: ${bookmarkId} to ${cookieStoreId}`);
    }

    scheduleTagSync();
});

// Bookmark tagging
//
// Firefox doesn't tell extensions which bookmark was clicked, only which URL is loading.
// To support the same URL in folders mapped to different containers, every bookmark
// under a mapped folder gets a marker in its URL fragment identifying the bookmark,
// e.g. https://login.microsoft.com/#fc-bm=<bookmarkId>. The navigation handler reads
// the marker, picks that bookmark's container and loads the URL without the marker.
const TAG_KEY = "fc-bm";
const TAG_REGEX = new RegExp(`[#&]${TAG_KEY}=([\\w-]+)$`);

function parseTag(url) {
    const match = url.match(TAG_REGEX);
    if (!match) return { bookmarkId: null, cleanUrl: url };
    return { bookmarkId: match[1], cleanUrl: url.slice(0, match.index) };
}

function addTag(url, bookmarkId) {
    return `${url}${url.includes("#") ? "&" : "#"}${TAG_KEY}=${bookmarkId}`;
}

function isTaggableUrl(url) {
    return /^https?:\/\//i.test(url);
}

// Clean URL -> Set of cookieStoreIds of mapped bookmarks with that URL.
// Used for navigations that don't come from a tagged bookmark (e.g. typed URLs).
let urlContainerIndex = new Map();

let tagSyncRunning = false;
let tagSyncPending = false;
let tagSyncTimer = null;

function scheduleTagSync() {
    clearTimeout(tagSyncTimer);
    tagSyncTimer = setTimeout(syncTags, 250);
}

// Walk the whole bookmark tree: tag bookmarks that resolve to a container, untag the rest.
// Idempotent, so the onChanged events caused by our own updates settle immediately.
async function syncTags() {
    if (tagSyncRunning) {
        tagSyncPending = true;
        return;
    }
    tagSyncRunning = true;

    try {
        const storage = await browser.storage.local.get();
        const [root] = await browser.bookmarks.getTree();
        const index = new Map();
        const updates = [];

        const walk = (node, inherited) => {
            const container = storage[node.id] || inherited;

            if (node.url) {
                const { cleanUrl } = parseTag(node.url);
                const wanted = container && isTaggableUrl(cleanUrl)
                    ? addTag(cleanUrl, node.id)
                    : cleanUrl;

                if (wanted !== node.url) {
                    updates.push({ id: node.id, url: wanted });
                }
                if (container) {
                    if (!index.has(cleanUrl)) index.set(cleanUrl, new Set());
                    index.get(cleanUrl).add(container);
                }
            }

            for (const child of node.children || []) {
                walk(child, container);
            }
        };
        walk(root, null);

        urlContainerIndex = index;

        for (const { id, url } of updates) {
            try {
                await browser.bookmarks.update(id, { url });
            } catch (e) {
                console.error(`Folder Containers: Failed to update bookmark ${id}:`, e);
            }
        }
        if (updates.length) {
            console.log(`Folder Containers: Updated tags on ${updates.length} bookmark(s).`);
        }
    } catch (e) {
        console.error("Folder Containers: Tag sync failed:", e);
    } finally {
        tagSyncRunning = false;
        if (tagSyncPending) {
            tagSyncPending = false;
            scheduleTagSync();
        }
    }
}

browser.bookmarks.onCreated.addListener(scheduleTagSync);
browser.bookmarks.onChanged.addListener(scheduleTagSync);
browser.bookmarks.onMoved.addListener(scheduleTagSync);
browser.bookmarks.onRemoved.addListener(scheduleTagSync);
syncTags();

// Helper: Check if a bookmark node or its ancestors are mapped to a container
async function getMappedContainerForBookmark(bookmarkId) {
    let currentId = bookmarkId;
    const storage = await browser.storage.local.get();

    for (let i = 0; i < 50; i++) {
        if (storage[currentId]) {
            return storage[currentId];
        }

        try {
            const [node] = await browser.bookmarks.get(currentId);
            if (!node || !node.parentId) break;
            currentId = node.parentId;
        } catch (e) {
            break;
        }
    }
    return null;
}

// Helper to get tab details with retries, as tab might not be fully initialized in onBeforeNavigate
async function getTabWithRetry(tabId, retries = 10, delay = 20) {
    for (let i = 0; i < retries; i++) {
        try {
            const tab = await browser.tabs.get(tabId);
            if (tab) return tab;
        } catch (e) {
            if (i === retries - 1) throw e;
        }
        await new Promise(resolve => setTimeout(resolve, delay));
    }
}

// Navigation Handler
browser.webNavigation.onBeforeNavigate.addListener(async (details) => {
    // We only care about main frame navigations
    if (details.frameId !== 0) return;

    // Ignore invalid tabId
    if (details.tabId === undefined || details.tabId === -1) return;

    const { bookmarkId, cleanUrl } = parseTag(details.url);

    let targetCookieStoreId = null;
    if (bookmarkId) {
        // Opened from a tagged bookmark: its own folder decides the container
        targetCookieStoreId = await getMappedContainerForBookmark(bookmarkId);
    }
    if (!targetCookieStoreId) {
        // Untagged (e.g. typed URL): only redirect if every mapped bookmark agrees
        const containers = urlContainerIndex.get(cleanUrl);
        if (containers && containers.size === 1) {
            [targetCookieStoreId] = containers;
        }
    }

    if (!targetCookieStoreId) {
        if (bookmarkId) {
            await browser.tabs.update(details.tabId, { url: cleanUrl, loadReplace: true }).catch(() => {});
        }
        return;
    }

    let tab;
    try {
        tab = await getTabWithRetry(details.tabId);
    } catch (e) {
        console.error("Folder Containers: Failed to get tab details after retries:", e);
        return;
    }

    // Already in the correct container: just drop the tag from the URL
    if (tab.cookieStoreId === targetCookieStoreId) {
        if (bookmarkId) {
            await browser.tabs.update(details.tabId, { url: cleanUrl, loadReplace: true }).catch(() => {});
        }
        return;
    }

    try {
        // Reopen in correct container
        await browser.tabs.create({
            url: cleanUrl,
            cookieStoreId: targetCookieStoreId,
            index: tab.index + 1,
            active: true
        });

        // Close the old tab (the one that opened in the wrong container)
        await browser.tabs.remove(details.tabId);
    } catch (err) {
        console.error("Folder Containers: Error during tab create/remove:", err);
    }
});
