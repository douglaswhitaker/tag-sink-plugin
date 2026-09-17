/*
 * Tag Sink — Eagle plugin
 * ------------------------------------------------------------
 * WHAT THIS DOES
 * For the folder you currently have selected in Eagle, this collects every
 * tag used on every file in that folder, and writes the complete set onto
 * one designated file (the "tag-sink"). That way, searching by ANY tag used
 * anywhere in the dataset bundle will surface the sink file, and because
 * they're all in the same Eagle folder, you land on the whole bundle.
 *
 * HOW THE SINK IS IDENTIFIED
 * The root folder uses a special marker tag (default: "tag-sink"). In
 * recursive mode, sinks in child folders use a separate marker derived from
 * it (default: "tag-sink-subdir"). This keeps child sinks from appearing as
 * root dataset sinks in tag searches.
 *
 * SYNC BEHAVIOR
 * Each time you click "Sync", the sink's tags are REPLACED with:
 *   (union of every tag on every other file in the folder) + (the marker tag)
 * This is a full mirror, not additive — if a source file loses a tag, the
 * next sync removes it from the sink too. The marker tag itself is always
 * kept so the sink stays identifiable on the next sync.
 *
 * A NOTE ON JAVASCRIPT, FOR SOMEONE COMING FROM R
 * - `const`/`let` declare variables (like `<-` in R, but block-scoped).
 * - `async function` / `await` is JS's way of waiting for something slow
 *   (like a file read, or asking Eagle for data) without freezing the UI.
 *   Every Eagle API call returns a "promise", which is why you'll see
 *   `await eagle.something(...)` everywhere below.
 * - Arrays have `.map()`, `.filter()`, `.forEach()` — these are close
 *   cousins of `sapply`/`Filter`/`lapply` in R, just methods on the array
 *   itself rather than functions you pass the array into.
 * - A `Set` is just a collection with no duplicates — used below to build
 *   the union of tags without writing dedup logic by hand.
 */

// ---- Node's built-in modules, available because Eagle plugins run with
// Node integration enabled. `fs` = file system, `os` = operating system
// info (used here just to find a scratch/temp directory), `path` = safe
// path joining across Windows/macOS.
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---- Settings persistence -------------------------------------------------
// localStorage here is just this plugin window's own local storage; it
// persists between plugin launches on this machine.
const MARKER_TAG_STORAGE_KEY = 'tagsink.markerTag';
const AUTO_CLOSE_STORAGE_KEY = 'tagsink.autoClose';
const RECURSIVE_STORAGE_KEY = 'tagsink.recursive';
const CONTEXT_TAG_STORAGE_KEY = 'tagsink.contextTag';
const DEFAULT_MARKER_TAG = 'tag-sink';
const SUBDIRECTORY_MARKER_SUFFIX = '-subdir';
const DEFAULT_CONTEXT_TAG = 'context-image';
const DEFAULT_AUTO_CLOSE = false;
const DEFAULT_RECURSIVE = false;

function getMarkerTag() {
    return localStorage.getItem(MARKER_TAG_STORAGE_KEY) || DEFAULT_MARKER_TAG;
}

function getSubdirectoryMarkerTag(markerTag = getMarkerTag()) {
    return `${markerTag}${SUBDIRECTORY_MARKER_SUFFIX}`;
}

function setMarkerTag(value) {
    const cleaned = (value || '').trim();
    localStorage.setItem(MARKER_TAG_STORAGE_KEY, cleaned || DEFAULT_MARKER_TAG);
}

function getAutoClose() {
    return localStorage.getItem(AUTO_CLOSE_STORAGE_KEY) === 'true';
}

function setAutoClose(value) {
    localStorage.setItem(AUTO_CLOSE_STORAGE_KEY, value ? 'true' : 'false');
}

function getRecursive() {
    return localStorage.getItem(RECURSIVE_STORAGE_KEY) === 'true';
}

function setRecursive(value) {
    localStorage.setItem(RECURSIVE_STORAGE_KEY, value ? 'true' : 'false');
}

function getContextTag() {
    return localStorage.getItem(CONTEXT_TAG_STORAGE_KEY) || DEFAULT_CONTEXT_TAG;
}

function setContextTag(value) {
    const cleaned = (value || '').trim();
    localStorage.setItem(CONTEXT_TAG_STORAGE_KEY, cleaned);
}

// ---- Small DOM helpers ------------------------------------------------
// (Plain DOM, no framework — these just save repeating document.getElementById)
const $ = (id) => document.getElementById(id);

function escapeHtml(str) {
    return String(str)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}

function setStatus(message, kind) {
    const el = $('status');
    el.textContent = message;
    el.className = kind || '';
}

// ---- App state --------------------------------------------------------
let currentFolder = null; // the Folder object currently selected in Eagle
let currentItems = [];    // items in that folder, refreshed on demand

// ---- Eagle lifecycle readiness ------------------------------------------
// Eagle can fire plugin-show before the asynchronous plugin-create handler
// has finished initializing the plugin API. In particular, calls such as
// eagle.folder.getSelected() can fail with:
//   "This method can only be used after the plugin-create event is triggered."
//
// Keep a promise that resolves only after plugin-create has completed. Event
// handlers and UI actions that use the Eagle API wait for this promise.
// The plugin-create callback calls refreshFolderImpl() directly so it does
// not wait on its own readiness promise.
let resolvePluginReady;
const pluginReadyPromise = new Promise((resolve) => {
    resolvePluginReady = resolve;
});

// ---- Folder hierarchy helpers -------------------------------------------
// Eagle exposes each folder's direct children through `folder.children`.
// Walking the hierarchy this way avoids relying on a second global folder
// lookup and lets us process each subtree bottom-up in one recursive pass.
function uniqueTagsFromItems(items, markerTags) {
    const markers = new Set(Array.isArray(markerTags) ? markerTags : [markerTags]);
    const tags = new Set();
    items.forEach((item) => {
        // Sink files are outputs of this plugin, not source files. Excluding
        // them is important: otherwise an old/stale sink tag can never be
        // removed on a later sync.
        if ((item.tags || []).some((tag) => markers.has(tag))) return;
        (item.tags || []).forEach((tag) => {
            if (!markers.has(tag)) tags.add(tag);
        });
    });
    return tags;
}

// Sync one folder from its own files plus the already-computed tag sets of
// its direct child folders.
async function syncOneFolder(folder, markerTag, sinkMarkerTag, childTagSets = [], isRoot = false) {
    let items = await eagle.item.get({ folders: [folder.id] });
    let sinks = items.filter((item) => (item.tags || []).includes(sinkMarkerTag));

    // 1.3.3 used the root marker for every sink. When upgrading an existing
    // recursive tree, migrate the old child sink to the new child-specific
    // marker instead of creating a duplicate. We only do this for folders
    // below the selected root.
    if (!isRoot && sinks.length === 0) {
        const legacySinks = items.filter((item) => (item.tags || []).includes(markerTag));
        if (legacySinks.length > 0) {
            // 1.3.3 could create more than one marker-tagged sink in a folder.
            // Migrate all of them so no old child sink remains marked as the
            // root sink type.
            for (const legacySink of legacySinks) {
                legacySink.tags = [...new Set([
                    ...(legacySink.tags || []).filter((tag) => tag !== markerTag),
                    sinkMarkerTag,
                ])];
                await legacySink.save();
            }
            items = await eagle.item.get({ folders: [folder.id] });
            sinks = items.filter((item) => (item.tags || []).includes(sinkMarkerTag));
        }
    }
    let createdSink = false;

    if (sinks.length === 0) {
        const contextImage = findContextImage(items, folder);
        if (contextImage) {
            await createSinkFromContextImage(contextImage, folder, sinkMarkerTag);
        } else {
            const filePath = createPlaceholderImageFile(folder.name || 'tag-sink');
            await eagle.item.addFromPath(filePath, {
                name: folder.name || 'tag-sink',
                tags: [sinkMarkerTag],
                folders: [folder.id],
                annotation: 'Auto-created by the Tag Sink plugin.',
            });
        }
        createdSink = true;
        items = await eagle.item.get({ folders: [folder.id] });
        sinks = items.filter((item) => (item.tags || []).includes(markerTag));
    }

    const unionTags = uniqueTagsFromItems(items, [markerTag, sinkMarkerTag]);
    childTagSets.forEach((tagSet) => {
        tagSet.forEach((tag) => {
            if (tag !== markerTag && tag !== sinkMarkerTag) unionTags.add(tag);
        });
    });

    const finalTags = [...unionTags, sinkMarkerTag];

    for (const sink of sinks) {
        // The sink represents the dataset/folder, so keep its visible name
        // synchronized with the folder name as well as its tags.
        sink.name = folder.name || sink.name || 'tag-sink';
        sink.tags = finalTags;
        await sink.save();
    }

    return {
        folder,
        items,
        sinks,
        tags: unionTags,
        tagCount: unionTags.size,
        createdSink,
    };
}

// Recursively sync the selected folder's entire subtree, deepest folders
// first. Each child returns its complete tag set, which is then included in
// the parent's sink. This is the key behavior: one click on the parent
// handles every descendant automatically.
async function syncFolderTree(folder, markerTag, sinkMarkerTag, results = [], isRoot = true) {
    const children = Array.isArray(folder.children) ? folder.children : [];
    const childResults = [];

    for (const child of children) {
        childResults.push(await syncFolderTree(child, markerTag, sinkMarkerTag, results, false));
    }

    const childTagSets = childResults.map((result) => result.tags);
    const result = await syncOneFolder(folder, markerTag, sinkMarkerTag, childTagSets, isRoot);
    results.push(result);
    return result;
}

// ---- Core: refresh the view from whatever folder is selected in Eagle -
async function refreshFolderImpl() {
    const folders = await eagle.folder.getSelected();

    if (!folders || folders.length === 0) {
        currentFolder = null;
        currentItems = [];
        $('folderName').textContent = '(none selected)';
        renderItemList([]);
        setStatus('Select a dataset folder in Eagle, then click Refresh.');
        return;
    }

    // If multiple folders are selected, just use the first one — syncing
    // is a per-folder operation.
    currentFolder = folders[0];
    $('folderName').textContent = currentFolder.name;

    currentItems = await eagle.item.get({ folders: [currentFolder.id] });
    renderItemList(currentItems);
    setStatus(`${currentItems.length} file(s) in this folder.`);
}

// Public refresh entry point. If plugin-show or a button click happens
// before plugin-create has finished, wait until Eagle's plugin API is ready.
async function refreshFolder() {
    await pluginReadyPromise;
    return refreshFolderImpl();
}

// ---- Render the file list, highlighting whichever file(s) carry the
// marker tag so it's obvious which one is currently the sink.
function renderItemList(items) {
    const markerTag = getMarkerTag();
    const listEl = $('itemList');
    const emptyEl = $('emptyState');

    listEl.innerHTML = '';

    if (!items || items.length === 0) {
        emptyEl.style.display = 'block';
        return;
    }
    emptyEl.style.display = 'none';

    items.forEach((item) => {
        const isSink = item.tags.includes(markerTag) || item.tags.includes(getSubdirectoryMarkerTag(markerTag));
        const visibleTags = item.tags.filter((t) => t !== markerTag && t !== getSubdirectoryMarkerTag(markerTag));

        const row = document.createElement('div');
        row.className = 'item-row' + (isSink ? ' sink' : '');
        row.innerHTML = `
            <span class="item-name">${escapeHtml(item.name)}${isSink ? '<span class="badge">tag-sink</span>' : ''}</span>
            <span class="item-tags">${visibleTags.length ? escapeHtml(visibleTags.join(', ')) : '(no tags)'}</span>
        `;
        listEl.appendChild(row);
    });
}

// ---- Create a tiny blank transparent PNG on disk, for use as a brand
// new tag-sink when the folder doesn't have one yet. This is a fixed,
// pre-encoded 1x1 pixel PNG — there's no need to actually render an
// image at runtime for something this small.
function createPlaceholderImageFile(baseName) {
    const onePixelPngBase64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const buffer = Buffer.from(onePixelPngBase64, 'base64');

    const safeName = (baseName || 'tag-sink').replace(/[\\/:*?"<>|]/g, '_');
    const tmpPath = path.join(os.tmpdir(), `${safeName}-${Date.now()}.png`);
    fs.writeFileSync(tmpPath, buffer);
    return tmpPath;
}

// Find an optional context image to use as the visual for a newly-created
// sink. The order is deliberately conservative: an explicitly marked image
// wins; then an image whose base filename matches the folder; finally, if the
// folder contains exactly one image, use that. If several images exist and
// none is identified, the plugin falls back to the blank placeholder.
function findContextImage(items, folder) {
    const imageExts = new Set([
        'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'svg', 'heic', 'avif'
    ]);
    const images = items.filter((item) => imageExts.has(String(item.ext || '').toLowerCase().replace(/^\./, '')));
    if (images.length === 0) return null;

    const contextTag = getContextTag();
    if (contextTag) {
        const tagged = images.filter((item) => (item.tags || []).includes(contextTag));
        if (tagged.length === 1) return tagged[0];
    }

    const folderName = String(folder.name || '').trim().toLowerCase();
    if (folderName) {
        const matchingName = images.filter((item) => {
            const name = String(item.name || '').trim();
            const base = name.replace(/\.[^.]+$/, '').toLowerCase();
            return base === folderName;
        });
        if (matchingName.length === 1) return matchingName[0];
    }

    return images.length === 1 ? images[0] : null;
}

async function createSinkFromContextImage(contextImage, folder, markerTag) {
    const ext = String(contextImage.ext || 'jpg').toLowerCase().replace(/^\./, '') || 'jpg';
    const safeName = (folder.name || 'tag-sink').replace(/[\\/:*?"<>|]/g, '_');
    const tmpPath = path.join(os.tmpdir(), `${safeName}-${Date.now()}.${ext}`);
    fs.copyFileSync(contextImage.filePath, tmpPath);

    const sourceTags = (contextImage.tags || []).filter((tag) => tag !== markerTag);
    const itemId = await eagle.item.addFromPath(tmpPath, {
        name: folder.name || 'tag-sink',
        tags: [...new Set([...sourceTags, markerTag])],
        folders: [folder.id],
        annotation: `Tag-sink created from context image: ${contextImage.name}`,
    });

    try { fs.unlinkSync(tmpPath); } catch (_) {}
    return itemId;
}

// ---- File-type tagging ---------------------------------------------------
// Eagle exposes the file extension as `item.ext`. File-type tags are applied
// to the original files themselves, rather than to the tag-sink. This makes
// them ordinary source tags, so a subsequent sync will propagate them to the
// appropriate sink (including through a recursive folder tree).
async function addFileTypesToSink() {
    await pluginReadyPromise;

    const folders = await eagle.folder.getSelected();
    if (!folders || folders.length === 0) {
        setStatus('Select a folder in Eagle first.', 'err');
        await showNotification('Tag Sink', 'No Eagle folder is selected.', true);
        return;
    }
    currentFolder = folders[0];

    const markerTag = getMarkerTag();
    const sinkMarkerTag = getSubdirectoryMarkerTag(markerTag);
    const recursive = getRecursive();
    setStatus(recursive ? 'Adding file-type tags to files in the folder tree…' : 'Adding file-type tags to files…');
    if ($('fileTypeBtn')) $('fileTypeBtn').disabled = true;

    try {
        const foldersToProcess = recursive ? getFolderTreeList(currentFolder) : [currentFolder];
        let taggedFileCount = 0;
        const fileTypes = new Set();

        for (const folder of foldersToProcess) {
            const items = await eagle.item.get({ folders: [folder.id] });

            for (const item of items) {
                // Tag-sinks are outputs, not source files.
                if ((item.tags || []).includes(markerTag) || (item.tags || []).includes(sinkMarkerTag)) continue;

                const ext = String(item.ext || '').trim().toLowerCase().replace(/^\./, '');
                if (!ext) continue;

                const newTags = new Set(item.tags || []);
                const hadTag = newTags.has(ext);
                newTags.add(ext);
                fileTypes.add(ext);

                if (!hadTag) {
                    item.tags = [...newTags];
                    await item.save();
                    taggedFileCount++;
                }
            }
        }

        await refreshFolderImpl();

        if (fileTypes.size === 0) {
            setStatus('No file extensions found to add.', 'ok');
            await showNotification(
                'Tag Sink',
                recursive
                    ? `No file extensions found in the folder tree rooted at "${currentFolder.name}".`
                    : `No file extensions found in "${currentFolder.name}".`,
                false
            );
            return;
        }

        const scope = recursive ? 'the folder tree' : 'the selected folder';
        const message =
            `Added file-type tags to ${taggedFileCount} file${taggedFileCount === 1 ? '' : 's'} in ${scope}: ` +
            [...fileTypes].sort().join(', ');
        setStatus(`Added file-type tags to ${taggedFileCount} file${taggedFileCount === 1 ? '' : 's'}.`, 'ok');
        await showNotification('Tag Sink', message, false);
        await closeWindowIfConfigured();
    } catch (err) {
        console.error(err);
        setStatus('File-type tagging failed — see DevTools console (F12).', 'err');
        const detail = err && err.message ? ` ${err.message}` : '';
        await showNotification('Tag Sink — Error', `File-type tagging failed.${detail}`, true);
    } finally {
        if ($('fileTypeBtn')) $('fileTypeBtn').disabled = false;
    }
}

// Return the selected folder and all descendants in traversal order.
// This is used by file-type tagging when recursive mode is enabled.
function getFolderTreeList(folder) {
    const result = [folder];
    const children = Array.isArray(folder.children) ? folder.children : [];
    for (const child of children) {
        result.push(...getFolderTreeList(child));
    }
    return result;
}

// ---- The main action: compute the tag union and write it to the sink --
async function syncTags() {
    await pluginReadyPromise;

    if (!currentFolder) {
        setStatus('Select a folder in Eagle first, then click Refresh.', 'err');
        return;
    }

    const markerTag = getMarkerTag();
    const recursive = getRecursive();
    const sinkMarkerTag = recursive ? getSubdirectoryMarkerTag(markerTag) : markerTag;
    setStatus(recursive ? `Syncing folder tree (subdirectory marker: ${sinkMarkerTag})…` : 'Syncing…');
    if ($('syncBtn')) $('syncBtn').disabled = true;

    try {
        let results;
        if (recursive) {
            results = [];
            await syncFolderTree(currentFolder, markerTag, sinkMarkerTag, results, true);
        } else {
            results = [await syncOneFolder(currentFolder, markerTag, markerTag, [], true)];
        }

        // Refresh the selected folder only; Eagle's normal folder view can
        // then be used to inspect any child folder's own sink.
        await refreshFolderImpl();

        if (!recursive) {
            const result = results[0];
            const message = result.sinks.length === 0
                ? `No tag-sink was created in "${result.folder.name}".`
                : `Synced ${result.tagCount} tag(s) to ${result.sinks.length} tag-sink file${result.sinks.length === 1 ? '' : 's'} in "${result.folder.name}".`;
            setStatus(`Synced ${result.tagCount} tag(s) to the tag-sink.`, 'ok');
            await showNotification('Tag Sink', message, false);
        } else {
            const created = results.filter((r) => r.createdSink).length;
            const total = results.length;
            const rootResult = results.find((r) => r.folder.id === currentFolder.id);
            const message = `Synced ${total} folder${total === 1 ? '' : 's'} in the tree rooted at "${currentFolder.name}". The parent sink includes tags from all descendant folders.`;
            setStatus(`Synced ${total} folder${total === 1 ? '' : 's'} recursively (${created} with a tag-sink).`, 'ok');
            await showNotification('Tag Sink', message, false);
        }

        await closeWindowIfConfigured();
    } catch (err) {
        console.error(err);
        setStatus('Sync failed — see DevTools console (F12) for details.', 'err');
        const detail = err && err.message ? ` ${err.message}` : '';
        await showNotification('Tag Sink — Error', `Sync failed.${detail}`, true);
    } finally {
        if ($('syncBtn')) $('syncBtn').disabled = false;
    }
}

// Native Eagle notification. Notifications auto-dismiss, so shortcut
// operation never requires the user to click anything.
async function showNotification(title, body, isError = false) {
    try {
        await eagle.notification.show({
            title,
            body,
            mute: isError,
            duration: isError ? 5000 : 3000,
        });
    } catch (notificationError) {
        // Notification failure should never turn a successful sync into a
        // reported sync failure.
        console.warn('Could not show Eagle notification:', notificationError);
    }
}

// Optional convenience setting. It is OFF by default. This is deliberately
// separate from Eagle's plugin-run/shortcut mechanism: launching the plugin
// does not perform any action or hide the window.
async function closeWindowIfConfigured() {
    if (!getAutoClose()) return;
    try {
        await eagle.window.hide();
    } catch (err) {
        console.warn('Could not hide Tag Sink window:', err);
    }
}

// ---- Wire up the UI -----------------------------------------------------
function initUI() {
    $('markerTagInput').value = getMarkerTag();
    $('autoCloseCheckbox').checked = getAutoClose();
    $('recursiveCheckbox').checked = getRecursive();

    $('refreshBtn').addEventListener('click', refreshFolder);
    $('syncBtn').addEventListener('click', syncTags);
    $('fileTypeBtn').addEventListener('click', addFileTypesToSink);

    $('saveMarkerBtn').addEventListener('click', () => {
        setMarkerTag($('markerTagInput').value);
        $('markerTagInput').value = getMarkerTag();
        setStatus(`Marker tag set to "${getMarkerTag()}".`, 'ok');
        renderItemList(currentItems);
    });

    $('recursiveCheckbox').addEventListener('change', () => {
        setRecursive($('recursiveCheckbox').checked);
        setStatus(
            getRecursive()
                ? 'Recursive sync is enabled: child folders will get their own tag-sinks, and parent sinks will include descendant tags.'
                : 'Recursive sync is disabled: only the selected folder will be synchronized.',
            'ok'
        );
    });

    $('autoCloseCheckbox').addEventListener('change', () => {
        setAutoClose($('autoCloseCheckbox').checked);
        setStatus(
            getAutoClose()
                ? 'The window will close automatically after a successful operation.'
                : 'The window will remain open after operations.',
            'ok'
        );
    });
}

// ---- Eagle lifecycle hooks ------------------------------------------------
// Called once when the plugin window is first created.
eagle.onPluginCreate(async (plugin) => {
    console.log('Tag Sink loaded:', plugin.manifest.name, plugin.manifest.version);
    initUI();

    try {
        await refreshFolderImpl();
    } catch (err) {
        console.error('Initial folder refresh failed:', err);
        setStatus('Initial refresh failed — click Refresh to try again.', 'err');
    } finally {
        // Must resolve even after an initial-refresh error, otherwise a
        // shortcut/onPluginShow event arriving early would wait forever.
        resolvePluginReady();
    }
});

// The plugin-run event is intentionally not used for background work or
// keyboard shortcuts. Launching the plugin simply opens the normal UI so it
// can be inspected and used manually.
eagle.onPluginRun(async () => {
    console.log('Tag Sink launched. Use the window controls to run an operation.');
});

// When the plugin window is displayed normally, refresh its contents.
eagle.onPluginShow(async () => {
    await refreshFolder();
});
