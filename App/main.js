// @meta main.js bootstraps the content script, wiring managers, drag logic, and storage sync.
(function () {
    const ns = (window.GlynGPT = window.GlynGPT || {});
    const DraggableElement = ns.DraggableElement;
    const ChatItem = ns.ChatItem;
    const HistoryManager = ns.HistoryManager;
    const FolderManager = ns.FolderManager;
    const FolderMenu = ns.FolderMenu;
    const DragController = ns.DragController;
    const StorageService = ns.StorageService;
    const GlobalSettings = ns.GlobalSettings;
    const LayoutState = ns.LayoutState;
    const SIDEBAR_MIN_WIDTH = 220;
    const SIDEBAR_MAX_RATIO = 0.9; // 90% of viewport width
    const SIDEBAR_WIDTH_VAR = "--sidebar-width";
    const ENABLE_SIDEBAR_RESIZER = true;
    const ENABLE_SAFE_REINIT = true;
    const DEFAULT_SHOW_SIDEBAR_HANDLE = true;

    let historyDiv = null;
    let historyManager = null;
    let folderManager = null;
    let folderMenu = null;
    let dragController = null;
    let storageService = null;
    let globalSettings = null;
    let layoutState = null;

    let dropMarker = null;
    let highlightedFolderRow = null;
    window.FOLDER_ICON_STYLE = window.FOLDER_ICON_STYLE || "outline";
    let messageListenerBound = false;
    let historyObserver = null;
    let containerMonitorTimer = null;
    let reinitPending = false;
    let safeModeActive = false;
    let sidebarContainer = null;
    let sidebarResizerEl = null;
    let sidebarResizeSession = null;
    let sentinelObserver = null;
    let shortcutHandlerBound = false;

    function scheduleSave(opts) {
        if (layoutState) {
            layoutState.markDirty(opts || {});
        }
    }

    function findSidebarContainer() {
        if (!historyDiv) return null;
        const nav = historyDiv.closest('nav[aria-label="Chat history"]');
        if (!nav) return null;
        return (
            nav.closest('[data-testid="left-sidebar"]') ||
            nav.closest('[data-testid="left-panel"]') ||
            nav.closest("aside") ||
            nav.parentElement ||
            nav
        );
    }

    function applySidebarWidth(width) {
        if (!ENABLE_SIDEBAR_RESIZER) return;
        if (!sidebarContainer) return;
        const root = document.documentElement;
        if (!root) return;
        const removeInline = () => {
            sidebarContainer.style.removeProperty("width");
            sidebarContainer.style.removeProperty("minWidth");
            sidebarContainer.style.removeProperty("maxWidth");
            sidebarContainer.style.removeProperty("flex");
        };
        if (typeof width !== "number" || Number.isNaN(width)) {
            removeInline();
            root.style.removeProperty(SIDEBAR_WIDTH_VAR);
            return;
        }
        let clamped = width;
        if (typeof SIDEBAR_MIN_WIDTH === "number") {
            clamped = Math.max(SIDEBAR_MIN_WIDTH, clamped);
        }
        if (typeof SIDEBAR_MAX_RATIO === "number" && SIDEBAR_MAX_RATIO > 0) {
            const vwLimit = Math.floor(window.innerWidth * Math.min(SIDEBAR_MAX_RATIO, 1));
            if (vwLimit > 0) {
                clamped = Math.min(vwLimit, clamped);
            }
        }
        removeInline();
        root.style.setProperty(SIDEBAR_WIDTH_VAR, `${clamped}px`);
    }

    function teardownSidebarResizer() {
        if (!ENABLE_SIDEBAR_RESIZER) return;
        if (sidebarResizerEl && sidebarResizerEl.parentNode) {
            sidebarResizerEl.parentNode.removeChild(sidebarResizerEl);
        }
        sidebarResizerEl = null;
        if (sidebarContainer) {
            sidebarContainer.classList.remove("glyn-sidebar-resizable");
            if (sidebarContainer.dataset && sidebarContainer.dataset.glynSidebarPrevPos === "applied") {
                sidebarContainer.style.position = "";
                delete sidebarContainer.dataset.glynSidebarPrevPos;
            }
            if (sidebarContainer.dataset && Object.prototype.hasOwnProperty.call(sidebarContainer.dataset, "glynSidebarPrevPad")) {
                sidebarContainer.style.paddingRight = sidebarContainer.dataset.glynSidebarPrevPad;
                delete sidebarContainer.dataset.glynSidebarPrevPad;
            }
            if (sidebarContainer.dataset && Object.prototype.hasOwnProperty.call(sidebarContainer.dataset, "glynSidebarPrevBox")) {
                sidebarContainer.style.boxSizing = sidebarContainer.dataset.glynSidebarPrevBox;
                delete sidebarContainer.dataset.glynSidebarPrevBox;
            }
        }
        sidebarContainer = null;
    }

    function setupSidebarResizer() {
        if (!ENABLE_SIDEBAR_RESIZER) return;
        const container = findSidebarContainer();
        if (!container) {
            teardownSidebarResizer();
            return;
        }
        if (sidebarContainer && sidebarContainer !== container) {
            teardownSidebarResizer();
        }
        sidebarContainer = container;
        const style = window.getComputedStyle(container);
        if (style.position === "static") {
            container.dataset.glynSidebarPrevPos = "applied";
            container.style.position = "relative";
        }
        if (!Object.prototype.hasOwnProperty.call(container.dataset, "glynSidebarPrevPad")) {
            container.dataset.glynSidebarPrevPad = container.style.paddingRight || "";
        }
        container.style.paddingRight = "14px";
        if (!Object.prototype.hasOwnProperty.call(container.dataset, "glynSidebarPrevBox")) {
            container.dataset.glynSidebarPrevBox = container.style.boxSizing || "";
        }
        container.style.boxSizing = "border-box";
        container.classList.add("glyn-sidebar-resizable");
        if (!sidebarResizerEl) {
            const handle = document.createElement("div");
            handle.id = "glyn-sidebar-resizer";
            handle.title = "Drag to resize";
            handle.addEventListener("mousedown", onSidebarResizeStart);
            container.appendChild(handle);
            sidebarResizerEl = handle;
        }
        const storedWidth = globalSettings ? globalSettings.getSidebarWidth() : null;
        applySidebarWidth(typeof storedWidth === "number" ? storedWidth : null);
    }

    function onSidebarResizeStart(event) {
        if (!ENABLE_SIDEBAR_RESIZER) return;
        if (event.button !== 0 || !sidebarContainer) return;
        event.preventDefault();
        const rect = sidebarContainer.getBoundingClientRect();
        sidebarResizeSession = {
            startX: event.clientX,
            startWidth: rect.width
        };
        document.addEventListener("mousemove", onSidebarResizeMove, true);
        document.addEventListener("mouseup", onSidebarResizeEnd, true);
        document.body.classList.add("glyn-resizing-sidebar");
    }

    function onSidebarResizeMove(event) {
        if (!ENABLE_SIDEBAR_RESIZER) return;
        if (!sidebarResizeSession || !sidebarContainer) return;
        const delta = event.clientX - sidebarResizeSession.startX;
        const width = sidebarResizeSession.startWidth + delta;
        applySidebarWidth(width);
    }

    function onSidebarResizeEnd() {
        if (!ENABLE_SIDEBAR_RESIZER) return;
        if (!sidebarResizeSession) return;
        document.removeEventListener("mousemove", onSidebarResizeMove, true);
        document.removeEventListener("mouseup", onSidebarResizeEnd, true);
        document.body.classList.remove("glyn-resizing-sidebar");
        const finalWidth = sidebarContainer
            ? sidebarContainer.getBoundingClientRect().width
            : null;
        sidebarResizeSession = null;
        if (globalSettings && typeof finalWidth === "number") {
            globalSettings.setSidebarWidth(finalWidth).catch(() => {});
        }
    }

    function enforceFoldersTopOrder() {
        if (!folderManager || typeof folderManager.pinFoldersAtTop !== "function") return;
        folderManager.pinFoldersAtTop();
    }

    function applyGlobalSettings(options) {
        enforceFoldersTopOrder();
        const style = globalSettings ? globalSettings.getFolderIconStyle() : "outline";
        window.FOLDER_ICON_STYLE = style;
        if (folderManager && typeof folderManager.refreshAllFolderIcons === "function") {
            folderManager.refreshAllFolderIcons();
        }
        const showHandle = globalSettings
            ? globalSettings.getShowSidebarHandle()
            : DEFAULT_SHOW_SIDEBAR_HANDLE;
        const root = document.documentElement;
        if (root) {
            root.classList.toggle("glyn-sidebar-handle-visible", !!showHandle);
        }
        if (ENABLE_SIDEBAR_RESIZER) {
            const savedWidth = globalSettings ? globalSettings.getSidebarWidth() : null;
            applySidebarWidth(typeof savedWidth === "number" ? savedWidth : null);
        }
    }

    function findHistoryContainer() {
        // ChatGPT current sidebar (2026): conversations are listitems
        // inside a semantic role="list" container.
        const chatLink = document.querySelector('a[href^="/c/"]');
        if (chatLink) {
            const listItem = chatLink.closest('[role="listitem"]');
            const list = listItem ? listItem.parentElement : null;
            if (list && list.getAttribute("role") === "list") {
                return list;
            }
        }

        const selectors = [
            "#history",
            '[data-testid="conversation-sidebar-list"]',
            '[data-testid="conversation-list"]',
            'nav[aria-label="Chat history"] ol',
            'nav[aria-label="Chat history"] div[data-testid="conversation-list"]',
            'nav[aria-label="Chat history"] div[role="presentation"]'
        ];
        for (const selector of selectors) {
            const el = document.querySelector(selector);
            if (el) {
                return el;
            }
        }
        const nav = document.querySelector('nav[aria-label="Chat history"]');
        if (nav) {
            const scroll = Array.from(nav.querySelectorAll("div")).find(div =>
                div.scrollHeight > div.clientHeight && div.querySelector("a.__menu-item")
            );
            if (scroll) {
                return scroll;
            }
        }
        return null;
    }

    function ensureMessageListener() {
        if (messageListenerBound || !chrome || !chrome.runtime || !chrome.runtime.onMessage) return;
        chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
            if (!message || !message.glynCommand) return;
            if (message.glynCommand === "createFolder") {
                if (folderManager) {
                    const folder = folderManager.createFolder("New Folder");
                    if (folder && typeof folder.inlineRename === "function") {
                        folder.inlineRename();
                    }
                    if (folder) {
                        scheduleSave({ immediate: true });
                        if (sendResponse) sendResponse({ ok: true });
                    } else if (sendResponse) {
                        sendResponse({ ok: false, error: "folder-not-created" });
                    }
                } else if (sendResponse) {
                    sendResponse({ ok: false, error: "not-ready" });
                }
                return true;
            }
            if (message.glynCommand === "settingsChanged") {
                if (!globalSettings) {
                    if (sendResponse) sendResponse({ ok: false, error: "not-ready" });
                    return true;
                }
                const payload = message.payload || {};
                const updates = {};
                if (Object.prototype.hasOwnProperty.call(payload, "folderIconStyle")) {
                    updates.folderIconStyle = payload.folderIconStyle === "fill" ? "fill" : "outline";
                }
                if (Object.prototype.hasOwnProperty.call(payload, "showSidebarHandle")) {
                    updates.showSidebarHandle = !!payload.showSidebarHandle;
                }
                if (!Object.keys(updates).length) {
                    if (sendResponse) sendResponse({ ok: true });
                    return true;
                }
                globalSettings.setValues(updates)
                    .then(() => {
                        applyGlobalSettings({ persist: true });
                        if (sendResponse) sendResponse({ ok: true });
                    })
                    .catch(err => {
                        console.warn("[GlynGPT] Failed to apply settings", err);
                        if (sendResponse) sendResponse({ ok: false, error: "apply-failed" });
                    });
                return true;
            }
            if (message.glynCommand === "expandAllFolders" || message.glynCommand === "collapseAllFolders") {
                try {
                    if (!folderManager || typeof folderManager.setAllFoldersExpanded !== "function") {
                        if (sendResponse) sendResponse({ ok: false, error: "not-ready" });
                        return true;
                    }
                    const expand = message.glynCommand === "expandAllFolders";
                    const changed = folderManager.setAllFoldersExpanded(expand);
                    if (changed) {
                        scheduleSave({ immediate: true });
                    }
                    if (sendResponse) {
                        sendResponse({ ok: true, changed });
                    }
                } catch (err) {
                    console.warn("[GlynGPT] Failed to update folders", err);
                    if (sendResponse) {
                        sendResponse({ ok: false, error: "update-failed" });
                    }
                }
                return true;
            }
            if (message.glynCommand === "getStatus") {
                if (sendResponse) {
                    sendResponse({
                        ok: true,
                        settings: globalSettings ? globalSettings.getValues() : null,
                        ready: !!folderManager
                    });
                }
                return true;
            }
        });
        messageListenerBound = true;
    }

    // ---- drop marker + highlight helpers ----

    function ensureDropMarker() {
        if (dropMarker) return;
        dropMarker = document.createElement("div");
        dropMarker.id = "glyn-drop-marker";
        dropMarker.style.height = "20px";
        dropMarker.style.margin = "4px 0 4px 6px";
        dropMarker.style.background = "transparent";
        dropMarker.style.border = "1px dashed rgba(255, 255, 255, 0.2)";
        dropMarker.style.borderRadius = "8px";
        dropMarker.style.boxSizing = "border-box";
        dropMarker.style.opacity = "1";
        dropMarker.addEventListener("dragover", onDropMarkerDragOver);
        dropMarker.addEventListener("drop", onDropMarkerDrop);
    }

    function onDropMarkerDragOver(evt) {
        if (!DraggableElement || !DraggableElement.currentDrag) return;
        evt.preventDefault();
        if (evt.dataTransfer) {
            evt.dataTransfer.dropEffect = "move";
        }
    }

    function onDropMarkerDrop(evt) {
        if (!DraggableElement ||
            !DraggableElement.currentDrag ||
            !DraggableElement.dropHandler) {
            return;
        }
        evt.preventDefault();

        const source = DraggableElement.currentDrag;
        const container = dropMarker ? dropMarker.parentNode : null;
        if (!container) return;

        const nextEl = dropMarker.nextElementSibling;
        let target = null;
        let beforeElementTarget = null;
        const isRootContainer = container === historyDiv;
        if (nextEl) {
            if (nextEl.__glynChatItem) {
                target = nextEl.__glynChatItem;
            } else if (nextEl.__glynFolderItem) {
                beforeElementTarget = {
                    type: "before-element",
                    element: nextEl
                };
            } else if (isRootContainer) {
                beforeElementTarget = {
                    type: "before-element",
                    element: nextEl
                };
            }
        } else {
            beforeElementTarget = beforeElementTarget || {
                type: "before-element",
                element: null
            };
        }

        const finalTarget = target || beforeElementTarget;

        DraggableElement.dropHandler(source, finalTarget, container, evt);

        if (DraggableElement.hideDropMarker) {
            DraggableElement.hideDropMarker();
        }
        if (finalTarget && finalTarget.type === "folder" && DraggableElement.unhighlightDropTarget) {
            DraggableElement.unhighlightDropTarget(finalTarget.el);
        }
    }

    function showDropMarker(beforeEl, explicitContainer) {
        let container = explicitContainer || (beforeEl ? beforeEl.parentNode : null);
        if (!container) return;

        if (beforeEl && beforeEl.parentNode &&
            beforeEl.parentNode.classList &&
            beforeEl.parentNode.classList.contains("glyn-folder-wrapper")) {
            beforeEl = beforeEl.parentNode;
            container = beforeEl.parentNode;
        }

        if (!container) return;
        ensureDropMarker();

        const samePosition =
            dropMarker.parentNode === container &&
            (beforeEl ? dropMarker.nextSibling === beforeEl : !dropMarker.nextSibling);

        if (samePosition) {
            return;
        }

        hideDropMarker();
        if (beforeEl) {
            container.insertBefore(dropMarker, beforeEl);
        } else {
            container.appendChild(dropMarker);
        }
    }

    function hideDropMarker() {
        if (dropMarker && dropMarker.parentNode) {
            dropMarker.parentNode.removeChild(dropMarker);
        }
    }

    function highlightFolderRow(rowEl) {
        if (highlightedFolderRow === rowEl) return;

        if (highlightedFolderRow) {
            unhighlightFolderRow(highlightedFolderRow);
        }

        highlightedFolderRow = rowEl;

        if (!rowEl.dataset.glynPrevBg) {
            rowEl.dataset.glynPrevBg = rowEl.style.backgroundColor || "";
        }
        rowEl.style.backgroundColor = "#444";
    }

    function unhighlightFolderRow(rowEl) {
        if (!rowEl) return;
        if (rowEl.dataset && typeof rowEl.dataset.glynPrevBg !== "undefined") {
            rowEl.style.backgroundColor = rowEl.dataset.glynPrevBg;
            delete rowEl.dataset.glynPrevBg;
        }
        if (highlightedFolderRow === rowEl) {
            highlightedFolderRow = null;
        }
    }

    // ---- root chat helpers ----

    function getRootChatLinks() {
        if (!historyDiv) return [];

        // ChatGPT current sidebar (2026): each conversation is represented
        // by a /c/ anchor nested inside a role="listitem".
        const currentLinks = Array.from(
            historyDiv.querySelectorAll(':scope > [role="listitem"] a[href^="/c/"]')
        );
        if (currentLinks.length) {
            return currentLinks;
        }

        // Legacy ChatGPT layout fallback.
        return Array.from(historyDiv.children).filter(el =>
            el.matches("a.__menu-item")
        );
    }

    function makeRootLinksDraggable() {
        if (!historyDiv || !historyManager) return;

        const links = getRootChatLinks();
        historyManager.ensureChatOrderFromLinks(links);

        links.forEach(link => {
            // Current ChatGPT: use the semantic listitem as the native drag
            // surface. The nested anchor remains the source of href/title and
            // continues to handle normal chat navigation.
            const currentRow = link.closest('[role="listitem"]');
            const dragEl = currentRow || link;

            if (dragEl.__glynChatItem) return;

            const href = link.getAttribute("href") || "";
            if (!href) return;

            const title = link.innerText.trim();
            const item = new ChatItem(dragEl, href, title);

            // Keep the item discoverable from both the draggable surface and
            // the conversation anchor for compatibility with existing code.
            dragEl.__glynChatItem = item;
            link.__glynChatItem = item;

            // Native HTML drag-and-drop on current ChatGPT conversation rows
            // is unreliable across Chromium and Firefox. Keep the row and
            // anchor out of native DnD; an extension-owned handle will be
            // the interaction surface.
            dragEl.setAttribute("draggable", "false");
            link.setAttribute("draggable", "false");

            if (dragEl !== link && !dragEl.querySelector(":scope > .glyn-chat-drag-handle")) {
                const handle = document.createElement("button");
                handle.type = "button";
                handle.className = "glyn-chat-drag-handle";
                handle.setAttribute("aria-label", "Move conversation");
                handle.setAttribute("title", "Move conversation");
                handle.setAttribute("tabindex", "-1");
                handle.innerHTML = "⋮⋮";

                // DnD-1: visual affordance only.
                handle.addEventListener("click", evt => {
                    evt.preventDefault();
                    evt.stopPropagation();
                });

                dragEl.appendChild(handle);
            }

            if (layoutState && typeof layoutState.tryHydrateChat === "function") {
                layoutState.tryHydrateChat(item);
            }
        });
    }

    function observeHistory() {
        makeRootLinksDraggable();
        enforceFoldersTopOrder();
        observeHistory();

        if (historyObserver) {
            historyObserver.disconnect();
        }

        historyObserver = new MutationObserver(() => {
            makeRootLinksDraggable();
            if (folderManager) {
                if (typeof folderManager.removeDuplicateWrappers === "function") {
                    folderManager.removeDuplicateWrappers();
                }
                if (typeof folderManager.ensureFolderMounts === "function") {
                    folderManager.ensureFolderMounts();
                }
            }
            enforceFoldersTopOrder();
        });

        historyObserver.observe(historyDiv, {
            childList: true,
            subtree: false
        });
    }

    function stopHistoryObserver() {
        if (historyObserver) {
            historyObserver.disconnect();
            historyObserver = null;
        }
    }

    function handleGlobalShortcuts(event) {
        if (!folderManager) return;
        const active = document.activeElement;
        if (active) {
            const tag = (active.tagName || "").toLowerCase();
            if (tag === "input" || tag === "textarea" || active.isContentEditable) {
                return;
            }
        }
        if (event.ctrlKey && event.key === "\\") {
            event.preventDefault();
            const changed = folderManager.setAllFoldersExpanded(false);
            if (changed) {
                scheduleSave({ immediate: true });
            }
        }
    }

    function startContainerMonitor() {
        if (!ENABLE_SAFE_REINIT) return;
        stopContainerMonitor();
        containerMonitorTimer = setInterval(() => {
            if (!historyDiv || !document.contains(historyDiv)) {
                scheduleReinit("container-detached");
            }
        }, 1000);
    }

    function stopContainerMonitor() {
        if (!ENABLE_SAFE_REINIT) return;
        if (containerMonitorTimer) {
            clearInterval(containerMonitorTimer);
            containerMonitorTimer = null;
        }
    }

    function disconnectSentinelObserver() {
        if (sentinelObserver) {
            sentinelObserver.disconnect();
            sentinelObserver = null;
        }
    }

    function monitorLazyLoadSentinel() {
        disconnectSentinelObserver();
        if (!historyDiv) return;
        const sentinel = historyDiv.querySelector('button[data-testid="history-paging-forward"]') ||
            historyDiv.querySelector('[data-testid="pager-forward"]');
        if (!sentinel) return;
        sentinelObserver = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting) {
                    console.log("[GlynGPT] Lazy sentinel intersected", { time: Date.now() });
                }
            });
        }, {
            root: historyDiv,
            threshold: 0.1
        });
        sentinelObserver.observe(sentinel);
    }

    function enterSafeMode(reason) {
        if (!ENABLE_SAFE_REINIT) return;
        if (safeModeActive) return;
        safeModeActive = true;
        console.warn("[GlynGPT] Entering safe mode:", reason);
        if (folderManager) {
            try {
                folderManager.suspendNotifications();
                folderManager.clearAllFolders();
            } catch (err) {
                console.warn("[GlynGPT] Failed to clear folders during safe mode", err);
            } finally {
                folderManager.resumeNotifications();
            }
        }
    }

    function exitSafeMode() {
        safeModeActive = false;
    }

    function scheduleReinit(reason) {
        if (!ENABLE_SAFE_REINIT) return;
        enterSafeMode(reason);
        if (reinitPending) return;
        reinitPending = true;
        console.warn("[GlynGPT] Reinitialising folders:", reason);
        stopHistoryObserver();
        stopContainerMonitor();
        disconnectSentinelObserver();
        hideDropMarker();
        if (ENABLE_SIDEBAR_RESIZER) {
            teardownSidebarResizer();
        }
        historyManager = null;
        folderManager = null;
        folderMenu = null;
        dragController = null;
        layoutState = null;
        storageService = null;
        globalSettings = null;
        setTimeout(() => {
            reinitPending = false;
            historyDiv = null;
            init();
        }, 300);
    }

    function initOnceHistoryFound() {
        historyManager = new HistoryManager();
        folderMenu = new FolderMenu();
        folderManager = new FolderManager(historyDiv, historyManager, folderMenu);
        ns.folderManager = folderManager;
        ns.historyManager = historyManager;
        ns.historyDiv = historyDiv;
        dragController = new DragController(
            historyDiv,
            historyManager,
            folderManager
        );
        ns.dragController = dragController;

        storageService = new StorageService({
            area: "sync",
            storageKey: "glynGptState"
        });
        globalSettings = new GlobalSettings(storageService);
        layoutState = new LayoutState(storageService, folderManager, historyManager);
        ns.layoutState = layoutState;
        if (ENABLE_SIDEBAR_RESIZER) {
            setupSidebarResizer();
        }
        ensureMessageListener();
        if (!shortcutHandlerBound) {
            document.addEventListener("keydown", handleGlobalShortcuts, true);
            shortcutHandlerBound = true;
        }
        globalSettings.load()
            .then(() => applyGlobalSettings())
            .catch(() => applyGlobalSettings());

        // Wire draggable behaviour
        DraggableElement.showDropMarker = showDropMarker;
        DraggableElement.hideDropMarker = hideDropMarker;
        DraggableElement.highlightDropTarget = highlightFolderRow;
        DraggableElement.unhighlightDropTarget = unhighlightFolderRow;
        DraggableElement.setDropHandler((source, target, containerEl, evt) => {
            dragController.handleDrop(source, target, containerEl, evt);
        });

        // Folder menu callbacks
        folderMenu.onNew = (folderItem) => {
            const newFolder = folderManager.createFolder("New Folder", {
                parentFolder: folderItem,
                insertAtTop: true
            });
            if (newFolder) {
                if (typeof folderItem.setExpanded === "function") {
                    folderItem.setExpanded(true);
                }
                if (typeof newFolder.inlineRename === "function") {
                    newFolder.inlineRename();
                }
            }
            scheduleSave({ immediate: true });
        };
        folderMenu.onRename = (folderItem) => {
            folderItem.inlineRename();
        };
        folderMenu.onChangeColor = (folderItem, color) => {
            console.log("[GlynGPT] folderMenu.onChangeColor", {
                folder: folderItem && folderItem.data,
                color,
            });
            if (folderItem && typeof folderItem.setColor === "function") {
                folderItem.setColor(color);
            }
            // Persistence handled via layout state change handlers
        };
        folderMenu.onExpandAll = () => {
            if (folderManager.setAllFoldersExpanded(true)) {
                scheduleSave({ immediate: true });
            }
        };
        folderMenu.onCollapseAll = () => {
            if (folderManager.setAllFoldersExpanded(false)) {
                scheduleSave({ immediate: true });
            }
        };
        folderMenu.onDelete = (folderItem) => {
            folderManager.deleteFolder(folderItem);
        };

        makeRootLinksDraggable();

        const bindChangeHandlers = () => {
            const immediateReasons = new Set([
                "folder-rename",
                "folder-color",
                "folder-children",
                "create-folder",
                "delete-folder",
                "move-folder",
                "expand-all",
                "collapse-all",
                "ensure",
                "move",
                "remove",
                "set-order"
            ]);
            const onStructureChange = (reason) => {
                const immediate = immediateReasons.has(reason);
                scheduleSave(immediate ? { immediate: true } : undefined);
                enforceFoldersTopOrder();
            };
            folderManager.setChangeHandler(onStructureChange);
            historyManager.setChangeHandler(onStructureChange);
        };

        layoutState.restore()
            .then(() => {
                if (!folderManager.folders.length) {
                    folderManager.createInitialFolder("New Folder");
                }
            })
            .catch(() => {
                if (!folderManager.folders.length) {
                    folderManager.createInitialFolder("New Folder");
                }
            })
            .finally(() => {
                bindChangeHandlers();
                enforceFoldersTopOrder();
                monitorLazyLoadSentinel();
                startContainerMonitor();
                exitSafeMode();
            });
    }

    function init(maxAttempts = 20, delayMs = 250) {
        let attempts = 0;

        function check() {
            historyDiv = findHistoryContainer();

            if (historyDiv) {
                initOnceHistoryFound();
                return;
            }

            attempts += 1;
            if (attempts < maxAttempts) {
                setTimeout(check, delayMs);
            } else {
                console.warn("[GlynGPT] Could not find #history after retries.");
            }
        }

        check();
    }

    init();
})();
