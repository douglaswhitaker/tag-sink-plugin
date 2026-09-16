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
 * Not by filename — by a special "marker tag" (default: "tag-sink"). You
 * apply that tag to whichever file should act as the sink, the normal way
 * you'd apply any tag in Eagle. If you don't have one yet, this plugin will
 * create a tiny blank image and tag it for you.
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
const DEFAULT_MARKER_TAG = 'tag-sink';

function getMarkerTag() {
    return localStorage.getItem(MARKER_TAG_STORAGE_KEY) || DEFAULT_MARKER_TAG;
}

function setMarkerTag(value) {
    const cleaned = (value || '').trim();
    localStorage.setItem(MARKER_TAG_STORAGE_KEY, cleaned || DEFAULT_MARKER_TAG);
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
const pluginReady = new Promise((resolve) => {
    resolvePluginReady = resolve;
});

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
    await pluginReady;
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
        const isSink = item.tags.includes(markerTag);
        const visibleTags = item.tags.filter((t) => t !== markerTag);

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

// ---- The main action: compute the tag union and write it to the sink --
async function syncTags() {
    // Protect against a click/event arriving during Eagle's startup race.
    await pluginReady;

    if (!currentFolder) {
        setStatus('Select a folder in Eagle first, then click Refresh.', 'err');
        return;
    }

    const markerTag = getMarkerTag();
    setStatus('Syncing…');
    $('syncBtn').disabled = true;

    try {
        // Re-fetch fresh data in case tags changed since the last refresh.
        const items = await eagle.item.get({ folders: [currentFolder.id] });

        const existingSinks = items.filter((item) => item.tags.includes(markerTag));

        // Build the union of every tag used anywhere in the folder, other
        // than the marker tag itself (that one is metadata about the sink's
        // role, not a content tag we want mixed into search results).
        const unionTags = new Set();
        items.forEach((item) => {
            item.tags.forEach((tag) => {
                if (tag !== markerTag) unionTags.add(tag);
            });
        });
        const finalTags = [...unionTags, markerTag];

        if (existingSinks.length === 0) {
            // No sink yet — create a small placeholder image and tag it.
            const filePath = createPlaceholderImageFile('tag-sink');
            await eagle.item.addFromPath(filePath, {
                name: 'tag-sink',
                tags: finalTags,
                folders: [currentFolder.id],
                annotation: 'Auto-created by the Tag Sink plugin.',
            });
            setStatus(`Created a new tag-sink file with ${unionTags.size} tag(s).`, 'ok');
        } else {
            // One or more files already marked as the sink — mirror the
            // tag union onto every one of them.
            for (const sink of existingSinks) {
                sink.tags = finalTags;
                await sink.save();
            }
            const plural = existingSinks.length === 1 ? '' : 's';
            setStatus(`Synced ${unionTags.size} tag(s) to ${existingSinks.length} tag-sink file${plural}.`, 'ok');
        }

        await refreshFolder();
    } catch (err) {
        console.error(err);
        setStatus('Sync failed — see DevTools console (F12) for details.', 'err');
    } finally {
        $('syncBtn').disabled = false;
    }
}

// ---- Wire up the UI -----------------------------------------------------
function initUI() {
    $('markerTagInput').value = getMarkerTag();

    $('refreshBtn').addEventListener('click', refreshFolder);
    $('syncBtn').addEventListener('click', syncTags);

    $('saveMarkerBtn').addEventListener('click', () => {
        setMarkerTag($('markerTagInput').value);
        $('markerTagInput').value = getMarkerTag();
        setStatus(`Marker tag set to "${getMarkerTag()}".`, 'ok');
        renderItemList(currentItems);
    });
}

// ---- Eagle lifecycle hooks ------------------------------------------------
// Called once when the plugin window is first created.
//
// IMPORTANT: Do not call the public refreshFolder() here because that waits
// on pluginReady. Instead, do the initial API work directly and resolve the
// readiness promise only after this callback has finished its initialization.
eagle.onPluginCreate(async (plugin) => {
    console.log('Tag Sink loaded:', plugin.manifest.name, plugin.manifest.version);
    initUI();

    try {
        await refreshFolderImpl();
    } catch (err) {
        console.error('Initial folder refresh failed:', err);
        setStatus('Initial refresh failed — click Refresh to try again.', 'err');
    } finally {
        // This must happen even if the initial refresh fails, otherwise a
        // plugin-show handler that arrived early would wait forever.
        resolvePluginReady();
    }
});

// Called every time the plugin window is brought back into view — handy
// because you'll typically: click a folder in Eagle, then switch to this
// plugin window to sync, over and over.
eagle.onPluginShow(async () => {
    await refreshFolder();
});
