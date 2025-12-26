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
});

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

// Navigation Handler
browser.webNavigation.onCommitted.addListener(async (details) => {
    // Determine if we should check this navigation
    // We strictly ignore reloads to prevent potential loops or annoyance
    if (details.transitionType === "reload") return;

    // We only care about main frame navigations
    if (details.frameId !== 0) return;

    // Note: We originally checked for 'auto_bookmark', but some contexts (sidebar, library, etc.)
    // might fire different types. Since the user wants mapped bookmarks to ALWAYS open in the container,
    // checking if the URL matches a mapped bookmark is the robust source of truth.

    const url = details.url;
    // Helper to find bookmark by URL
    const bookmarks = await browser.bookmarks.search({ url });

    if (bookmarks.length === 0) return;

    for (const bookmark of bookmarks) {
        const targetCookieStoreId = await getMappedContainerForBookmark(bookmark.id);

        if (targetCookieStoreId) {
            // Found a mapped container for this URL
            const tab = await browser.tabs.get(details.tabId);

            // If already in the correct container, do nothing
            if (tab.cookieStoreId === targetCookieStoreId) {
                return;
            }

            // Reopen in correct container
            await browser.tabs.create({
                url: url,
                cookieStoreId: targetCookieStoreId,
                index: tab.index + 1,
                active: true
            });

            // Close the old tab (the one that opened in the wrong container)
            await browser.tabs.remove(details.tabId);

            // Stop checking other bookmarks (first match wins)
            break;
        }
    }
});
