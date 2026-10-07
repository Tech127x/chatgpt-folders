 (function () {
    // @meta LayoutState stores folders/chats using compact records split across storage keys.
    const ns = (window.GlynGPT = window.GlynGPT || {});

    const LAYOUT_VERSION = 2;
    const ROOT_FOLDER_ID = 0;
    const FOLDER_PREFIX = "f";
    const META_SUFFIX = "__meta";
    const CHUNK_SUFFIX = "__chunk_";
    const CHUNK_SIZE = 7000;

    class LayoutState {
        constructor(storageService, folderManager, historyManager) {
            this.storage = storageService;
            this.folderManager = folderManager;
            this.historyManager = historyManager;
            this.isRestoring = false;
            this._saveTimer = null;
            this._knownFolderIds = new Set();
            this.pendingAssignments = new Map();
            this._folderChunkCounts = new Map();
            this._rootChunkCount = 0;
        }

        _defaultState() {
            return { items: [] };
        }

        async restore() {
            if (!this.storage || !this.folderManager || !this.folderManager.historyDiv) {
                return false;
            }

            this._clearPendingPlaceholders();
            this._folderChunkCounts.clear();
            this._rootChunkCount = 0;

            const rootPayload = await this._loadFolderPayload(ROOT_FOLDER_ID);
            if (!rootPayload) {
                this._knownFolderIds.clear();
                this.data = this._defaultState();
                return false;
            }

            const folderIds = Array.isArray(rootPayload.fi) ? rootPayload.fi : [];
            const folderPayloadMap = new Map();
            if (folderIds.length) {
                for (const folderId of folderIds) {
                    const payload = await this._loadFolderPayload(folderId);
                    if (payload) {
                        folderPayloadMap.set(folderId, payload);
                    }
                }
            }

            this.isRestoring = true;
            this.folderManager.suspendNotifications();
            this.historyManager.suspendNotifications();
            this.folderManager.clearAllFolders();

            const rawEntries = Array.isArray(rootPayload.ch) ? rootPayload.ch : [];
            const entries = rawEntries.filter((entry) => entry && entry.t === "f");
            if (folderPayloadMap && folderPayloadMap.size) {
                // f0.ch defines explicit root placement; f0.fi is the global
                // index of every folder. Folders reachable through any ch entry
                // (including transitively) are already placed and must not be
                // promoted to roots; only unclaimed folders fall back to root.
                const claimed = new Set();
                const claimEntry = (entry) => {
                    if (!entry || entry.t !== "f") return;
                    const id = this._folderNumberFromId(entry.i);
                    if (claimed.has(id)) return;
                    claimed.add(id);
                    const payload = folderPayloadMap.get(id);
                    const children = payload && Array.isArray(payload.ch) ? payload.ch : [];
                    children.forEach(claimEntry);
                };
                entries.forEach(claimEntry);
                folderPayloadMap.forEach((_payload, id) => {
                    if (claimed.has(id)) return;
                    entries.push({ t: "f", i: id });
                    claimEntry({ t: "f", i: id });
                });
            }

            console.info("[GlynGPT][Layout] Restoring folders", JSON.stringify({
                requested: entries.length,
                storedFolders: folderPayloadMap.size
            }));

            const chatMap = this._collectChatMap();
            const appliedFolders = new Set();
            this._applyEntries(
                entries,
                this.folderManager.historyDiv,
                null,
                folderPayloadMap,
                chatMap,
                appliedFolders
            );
            console.info("[GlynGPT][Layout] After apply entries, folder count:", this.folderManager.folders.length);
            if (!this.folderManager.folders.length && folderPayloadMap && folderPayloadMap.size) {
                const fallback = Array.from(folderPayloadMap.keys())
                    .sort((a, b) => a - b)
                    .map((id) => ({ t: "f", i: id }));
                console.warn("[GlynGPT][Layout] No folders mounted after first pass. Applying fallback list.");
                this._applyEntries(
                    fallback,
                    this.folderManager.historyDiv,
                    null,
                    folderPayloadMap,
                    chatMap,
                    appliedFolders
                );
                console.warn("[GlynGPT][Layout] Fallback applied. Folder count:", this.folderManager.folders.length);
            }

            const rootLinks = this.folderManager.getRootChatLinks();
            this.historyManager.resetFromLinks(rootLinks);
            if (typeof this.folderManager.removeDuplicateWrappers === "function") {
                this.folderManager.removeDuplicateWrappers();
            }
            if (typeof this.folderManager.ensureFolderMounts === "function") {
                this.folderManager.ensureFolderMounts();
            }
            if (typeof this.folderManager.pinFoldersAtTop === "function") {
                this.folderManager.pinFoldersAtTop();
            }
            this.historyManager.resumeNotifications();
            this.folderManager.resumeNotifications();
            this.isRestoring = false;

            this._knownFolderIds = new Set(folderIds);
            this.data = this._defaultState();
            return true;
        }

        _collectChatMap() {
            const scope = this.folderManager && this.folderManager.historyDiv
                ? this.folderManager.historyDiv
                : document;
            const links = Array.from(scope.querySelectorAll('a.__menu-item, [role="listitem"] a[href^="/c/"]'));
            const map = new Map();
            links.forEach((link) => {
                const href = link.getAttribute("href") || "";
                if (href && !map.has(href)) {
                    map.set(href, link);
                }
            });
            return map;
        }

        _applyEntries(entries, containerEl, parentFolder, folderPayloadMap, chatMap, appliedFolders) {
            if (!Array.isArray(entries) || !containerEl) return;

            entries.forEach((entry) => {
                if (!entry || typeof entry !== "object") return;
                if (entry.t === "c") {
                    const href = this._expandChatId(entry.i);
                    if (!href) return;
                    const link = chatMap.get(href);
                    if (!link) {
                        this._registerPendingChat(entry.i, containerEl, parentFolder);
                        return;
                    }
                    // Keep the current ChatGPT row (including grip) intact.
                    const chatEl = link.__glynChatItem
                        ? link.__glynChatItem.el
                        : link.closest('[role="listitem"]') || link;
                    containerEl.appendChild(chatEl);
                    if (parentFolder && link.__glynChatItem) {
                        parentFolder.addChild(link.__glynChatItem);
                    }
                    return;
                }

                if (entry.t === "f") {
                    const folderPayload = folderPayloadMap.get(entry.i);
                    if (!folderPayload) return;
                    // One logical folder id may be materialized at most once per
                    // restore, regardless of how the payload graph references it.
                    const folderKey = this._folderNumberFromId(entry.i);
                    if (appliedFolders && appliedFolders.has(folderKey)) return;
                    if (appliedFolders) appliedFolders.add(folderKey);
                    const folderId = this._folderIdFromNumber(entry.i);
                    console.debug("[GlynGPT][Layout] Creating folder", folderPayload.n || "Folder", {
                        id: folderId,
                        parent: parentFolder ? parentFolder.id : null
                    });
                    const folder = this.folderManager.createFolder(folderPayload.n || "Folder", {
                        id: folderId,
                        color: folderPayload["#"] ? `#${folderPayload["#"]}` : null,
                        expanded: true,
                        data: {
                            name: folderPayload.n || "Folder",
                            color: folderPayload["#"] ? `#${folderPayload["#"]}` : null
                        },
                        parentFolder,
                        insertAtTop: false
                    });
                    if (!folder) return;
                    if (typeof folder.setExpanded === "function") {
                        folder.setExpanded(true);
                    } else {
                        folder.data.expanded = true;
                        folder.isExpanded = true;
                        if (folder.contentsEl) {
                            folder.contentsEl.style.display = "";
                        }
                        folder.refreshChevron();
                    }
                    const children = Array.isArray(folderPayload.ch) ? folderPayload.ch : [];
                    this._applyEntries(children, folder.contentsEl, folder, folderPayloadMap, chatMap, appliedFolders);
                }
            });
        }

        _registerPendingChat(chatId, containerEl, parentFolder) {
            if (!containerEl) {
                containerEl = this.folderManager ? this.folderManager.historyDiv : null;
            }
            if (!containerEl) return;
            const expanded = this._expandChatId(chatId);
            const compactId = this._compactChatId(expanded);
            if (!compactId || this.pendingAssignments.has(compactId)) return;

            const placeholder = document.createElement("div");
            placeholder.className = "glyn-chat-placeholder";
            placeholder.dataset.chatId = compactId;
            placeholder.textContent = "Loading conversation...";

            containerEl.appendChild(placeholder);

            this.pendingAssignments.set(compactId, {
                container: containerEl,
                parentFolder,
                placeholder
            });
            console.debug("[GlynGPT][Layout] Registered pending chat", compactId, {
                parentFolder: parentFolder ? parentFolder.id : null
            });
        }

        _clearPendingPlaceholders() {
            if (!this.pendingAssignments || !this.pendingAssignments.size) return;
            this.pendingAssignments.forEach(({ placeholder }) => {
                if (placeholder && placeholder.parentNode) {
                    placeholder.parentNode.removeChild(placeholder);
                }
            });
            this.pendingAssignments.clear();
            console.debug("[GlynGPT][Layout] Cleared pending placeholders");
        }

        tryHydrateChat(chatItem) {
            if (!chatItem) return false;
            const compactId = this._compactChatId(chatItem.id || chatItem.href);
            if (!compactId) return false;
            const pending = this.pendingAssignments.get(compactId);
            if (!pending) return false;
            const container = pending.container ||
                (pending.parentFolder && pending.parentFolder.contentsEl) ||
                (this.folderManager ? this.folderManager.historyDiv : null);
            if (!container) return false;

            const placeholder = pending.placeholder;
            if (placeholder && placeholder.parentNode === container) {
                container.insertBefore(chatItem.el, placeholder);
                placeholder.parentNode.removeChild(placeholder);
            } else {
                container.appendChild(chatItem.el);
            }

            if (pending.parentFolder) {
                pending.parentFolder.addChild(chatItem);
                if (typeof pending.parentFolder.syncChildrenFromDOM === "function") {
                    pending.parentFolder.syncChildrenFromDOM();
                }
            }

            this.pendingAssignments.delete(compactId);
            console.info("[GlynGPT][Layout] Hydrated delayed chat", compactId);
            return true;
        }

        async save() {
            if (!this.storage) return false;
            const snapshot = this._buildSnapshot();
            this._mergePendingAssignments(snapshot);
            const setObj = {};
            const removals = [];

            this._encodeFolderPayload(ROOT_FOLDER_ID, snapshot.root, setObj, removals);
            snapshot.folders.forEach((payload, id) => {
                this._encodeFolderPayload(id, payload, setObj, removals);
            });

            const keptIds = new Set(snapshot.folderIds);
            this._knownFolderIds.forEach((id) => {
                if (!keptIds.has(id)) {
                    const baseKey = this._folderKey(id);
                    removals.push(baseKey, this._metaKeyFor(id));
                    const prevCount = this._folderChunkCounts.get(id) || 0;
                    for (let i = 0; i < prevCount; i += 1) {
                        removals.push(this._chunkKeyFor(id, i));
                    }
                    this._folderChunkCounts.delete(id);
                }
            });

            await this.storage.saveKeys(setObj, removals);
            this._knownFolderIds = keptIds;
            this.data = this._defaultState();
            return true;
        }

        // Restored chats still waiting for their sidebar row are represented by
        // a placeholder, which _serializeContainer cannot see. Keep their
        // folder assignments in the snapshot until tryHydrateChat() re-attaches
        // the row; otherwise any save in between erases the assignment.
        _mergePendingAssignments(snapshot) {
            if (!snapshot || !snapshot.folders || !this.pendingAssignments ||
                !this.pendingAssignments.size) {
                return;
            }
            this.pendingAssignments.forEach((pending, compactId) => {
                if (!pending || !compactId) return;
                const folder = pending.parentFolder;
                if (!folder || !folder.id) return;
                const payload = snapshot.folders.get(this._folderNumberFromId(folder.id));
                if (!payload) return;
                const entries = Array.isArray(payload.ch) ? payload.ch : [];
                if (!entries.some(entry => entry && entry.t === "c" && entry.i === compactId)) {
                    entries.push({ t: "c", i: compactId });
                    payload.ch = entries;
                }
            });
        }

        _buildSnapshot() {
            const folderMap = new Map();
            const folderIds = new Set();
            const seenFolders = new Set();
            const topLevel = this._serializeContainer(
                this.folderManager ? this.folderManager.historyDiv : null,
                folderMap,
                folderIds,
                {
                    includeChats: false,
                    preventDuplicates: true,
                    seenFolders
                }
            );
            const rootPayload = {};
            if (topLevel.length) {
                rootPayload.ch = topLevel;
            }
            if (folderIds.size) {
                rootPayload.fi = Array.from(folderIds);
            }
            rootPayload.v = LAYOUT_VERSION;
            return {
                root: rootPayload,
                folders: folderMap,
                folderIds: Array.from(folderIds)
            };
        }

        _serializeContainer(containerEl, folderMap, folderIds, options) {
            if (!containerEl) return [];
            const includeChats = options && options.includeChats;
            const preventDuplicates = options && options.preventDuplicates;
            const seenFolders = options && options.seenFolders;
            const entries = [];
            Array.from(containerEl.children).forEach((node) => {
                if (node.classList && node.classList.contains("glyn-folder-wrapper")) {
                    const folder = node.__glynFolderItem;
                    if (!folder) return;
                    const idNum = this._folderNumberFromId(folder.id);
                    if (preventDuplicates && seenFolders) {
                        if (seenFolders.has(idNum)) {
                            return;
                        }
                        seenFolders.add(idNum);
                    }
                    folderIds.add(idNum);
                    const payload = {
                        n: folder.data && folder.data.name ? folder.data.name : "Folder"
                    };
                    if (folder.data && folder.data.color) {
                        payload["#"] = folder.data.color.replace(/^#/, "");
                    }
                    const childEntries = this._serializeContainer(
                        folder.contentsEl,
                        folderMap,
                        folderIds,
                        {
                            includeChats: true,
                            preventDuplicates: true,
                            seenFolders
                        }
                    );
                    if (childEntries.length) {
                        payload.ch = childEntries;
                    }
                    folderMap.set(idNum, payload);
                    entries.push({ t: "f", i: idNum });
                    return;
                }
                const chatItem = node.__glynChatItem;
                const chatLink = node.matches && node.matches("a.__menu-item")
                    ? node
                    : node.matches && node.matches('[role="listitem"]')
                        ? node.querySelector('a[href^="/c/"]')
                        : null;
                if (includeChats && chatLink) {
                    const href = chatItem ? chatItem.id : chatLink.getAttribute("href") || "";
                    if (href) {
                        const chatId = this._compactChatId(href);
                        if (chatId) {
                            entries.push({ t: "c", i: chatId });
                        }
                    }
                }
            });
            return entries;
        }

        hasFolders() {
            return !!(this.folderManager && this.folderManager.folders.length);
        }

        markDirty(options) {
            if (this.isRestoring) return;
            const immediate = options && options.immediate;
            clearTimeout(this._saveTimer);
            if (immediate) {
                this.save().catch(err => console.warn("[GlynGPT] Failed to save layout", err));
                return;
            }
            this._saveTimer = setTimeout(() => {
                this.save().catch(err => console.warn("[GlynGPT] Failed to save layout", err));
            }, 250);
        }

        _compactChatId(href) {
            if (!href) return null;
            return href.replace(/^\/c\//, "");
        }

        _expandChatId(id) {
            if (!id) return null;
            return id.startsWith("/c/") ? id : `/c/${id}`;
        }

        _folderNumberFromId(id) {
            if (typeof id === "number") return id;
            const match = /(\d+)$/.exec(id || "");
            return match ? parseInt(match[1], 10) : id;
        }

        _folderIdFromNumber(value) {
            if (typeof value === "number") {
                return `folder-${value}`;
            }
            return value;
        }

        _folderKey(id) {
            return `${FOLDER_PREFIX}${id}`;
        }

        _metaKeyFor(id) {
            return `${this._folderKey(id)}${META_SUFFIX}`;
        }

        _chunkKeyFor(id, index) {
            return `${this._folderKey(id)}${CHUNK_SUFFIX}${index}`;
        }

        async _loadFolderPayload(id) {
            if (!this.storage) return null;
            const baseKey = this._folderKey(id);
            const metaKey = this._metaKeyFor(id);
            const data = await this.storage.loadKeys([baseKey, metaKey]);
            let payload = data && data[baseKey];
            let chunkCount = 0;
            if (!payload) {
                const meta = data && data[metaKey];
                if (!meta || !meta.chunkCount || meta.chunkCount <= 0) {
                    return null;
                }
                chunkCount = meta.chunkCount;
                const chunkKeys = [];
                for (let i = 0; i < chunkCount; i += 1) {
                    chunkKeys.push(this._chunkKeyFor(id, i));
                }
                const chunkData = await this.storage.loadKeys(chunkKeys);
                const serialized = chunkKeys.map((key) => chunkData[key] || "").join("");
                if (!serialized) return null;
                try {
                    payload = JSON.parse(serialized);
                } catch (_err) {
                    console.warn("[GlynGPT] Invalid chunked payload:", baseKey);
                    return null;
                }
            } else if (typeof payload === "string") {
                try {
                    payload = JSON.parse(payload);
                } catch (_err) {
                    console.warn("[GlynGPT] Invalid payload:", baseKey);
                    return null;
                }
            }
            if (id === ROOT_FOLDER_ID) {
                this._rootChunkCount = chunkCount;
            } else {
                this._folderChunkCounts.set(id, chunkCount);
            }
            return payload;
        }

        _encodeFolderPayload(id, payload, setObj, removals) {
            if (!payload) return;
            const baseKey = this._folderKey(id);
            const metaKey = this._metaKeyFor(id);
            const chunkPrefix = `${baseKey}${CHUNK_SUFFIX}`;
            const prevCount = id === ROOT_FOLDER_ID
                ? this._rootChunkCount
                : (this._folderChunkCounts.get(id) || 0);
            const serialized = JSON.stringify(payload);
            if (serialized.length <= CHUNK_SIZE) {
                setObj[baseKey] = payload;
                if (prevCount > 0) {
                    removals.push(metaKey);
                    for (let i = 0; i < prevCount; i += 1) {
                        removals.push(`${chunkPrefix}${i}`);
                    }
                }
                if (id === ROOT_FOLDER_ID) {
                    this._rootChunkCount = 0;
                } else {
                    this._folderChunkCounts.set(id, 0);
                }
                return;
            }
            const chunkCount = Math.ceil(serialized.length / CHUNK_SIZE);
            for (let i = 0; i < chunkCount; i += 1) {
                const start = i * CHUNK_SIZE;
                const end = start + CHUNK_SIZE;
                setObj[`${chunkPrefix}${i}`] = serialized.slice(start, end);
            }
            setObj[metaKey] = { chunkCount };
            removals.push(baseKey);
            if (prevCount > chunkCount) {
                for (let i = chunkCount; i < prevCount; i += 1) {
                    removals.push(`${chunkPrefix}${i}`);
                }
            }
            if (id === ROOT_FOLDER_ID) {
                this._rootChunkCount = chunkCount;
            } else {
                this._folderChunkCounts.set(id, chunkCount);
            }
        }
    }

    ns.LayoutState = LayoutState;
})();
