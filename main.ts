import { Plugin, MarkdownView, Debouncer, debounce, Platform } from 'obsidian';

interface TocItem {
    level: number;
    text: string;
    line: number;
    id: string;
}

interface CodeMirrorEditor {
    posAtCoords(coords: { x: number, y: number }): number | null;
    lineBlockAtHeight(height: number): { from: number } | null;
    state: {
        doc: {
            lineAt(pos: number): { number: number };
        };
    };
}

export default class SspaiTocPlugin extends Plugin {
    containerEl: HTMLElement | null = null;
    activeHeaderLine: number = -1;
    lastActiveIndex: number = -1;
    lastHeadings: TocItem[] = [];
    debouncedUpdate: Debouncer<[], void>;
    observer: MutationObserver | null = null;
    blockScrollEvent: boolean = false;
    isUserInteracting: boolean = false; // Flag to track if user is interacting with editor
    private currentObservedView: MarkdownView | null = null;
    private eventRemovers: (() => void)[] = [];
    private _resetInteractingTimer: ReturnType<typeof setTimeout> | null = null;

    onload() {
        this.debouncedUpdate = debounce(this.updateToc.bind(this), 100, true);

        this.registerEvent(
            this.app.workspace.on('active-leaf-change', (leaf) => {
                this.updateToc();
            })
        );

        this.registerEvent(
            this.app.workspace.on('layout-change', () => {
                this.updateToc();
            })
        );

        this.registerEvent(
            this.app.workspace.on('resize', () => {
                this.debouncedUpdate();
            })
        );

        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (view && view.file === file) {
                    this.debouncedUpdate();
                }
            })
        );
    }

    onunload() {
        this.removeToc();
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
        this.clearEventRemovers();
    }

    clearEventRemovers() {
        this.eventRemovers.forEach(remove => remove());
        this.eventRemovers = [];
    }

    removeToc() {
        if (this.observer) {
            this.observer.disconnect();
        }
        if (this.containerEl) {
            this.containerEl.remove();
            this.containerEl = null;
        }
    }

    updateToc() {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);

        if (!view) return;

        if (!this.containerEl) {
            this.containerEl = document.createElement('div');
            this.containerEl.addClass('sspai-toc-container');
            view.containerEl.appendChild(this.containerEl);
        } else {
            if (!view.containerEl.contains(this.containerEl)) {
                view.containerEl.appendChild(this.containerEl);
            }
        }

        const newHeaders = this.getTocHeaders(view);

        if (this.areHeadersStructurallyEqual(this.lastHeadings, newHeaders)) { // 检测标题变化 避免编辑文章的时候频繁渲染
            this.updateTocPositions(newHeaders);
            this.lastHeadings = newHeaders;

            if (view.getMode() === 'source' && view.editor) {
                const cursor = view.editor.getCursor();
                if (cursor) {
                    this.highlightActiveHeader(view, cursor.line);
                } else {
                    this.highlightActiveHeader(view);
                }
            } else {
                this.highlightActiveHeader(view);
            }
        } else {
            this.renderToc(view, newHeaders);
            // After render, also sync with cursor if possible
            if (view.getMode() === 'source' && view.editor) {
                const cursor = view.editor.getCursor();
                if (cursor) {
                    this.highlightActiveHeader(view, cursor.line);
                }
            }
        }

        this.registerDomEvents(view);
        this.checkResponsiveVisibility(view);

        if (this.currentObservedView !== view) {
            if (this.observer) {
                this.observer.disconnect();
                this.observer = null;
            }

            const target = view.contentEl.querySelector('.markdown-source-view, .markdown-preview-view'); // 监测缩减栏宽是否开启
            if (target) {
                this.observer = new MutationObserver((mutations) => {
                    for (const mutation of mutations) {
                        if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
                            this.checkResponsiveVisibility(view);
                        }
                    }
                });
                this.observer.observe(target, { attributes: true, attributeFilter: ['class'] });
            }
            this.currentObservedView = view;
        }
    }

    getTocHeaders(view: MarkdownView): TocItem[] {
        const file = view.file;
        if (!file) return [];
        const cache = this.app.metadataCache.getFileCache(file);
        if (!cache || !cache.headings) return [];

        return cache.headings.map(h => ({
            level: h.level,
            text: h.heading,
            line: h.position.start.line,
            id: h.heading.replace(/\s+/g, '-').toLowerCase()
        }));
    }

    areHeadersStructurallyEqual(oldHeaders: TocItem[], newHeaders: TocItem[]): boolean {
        if (oldHeaders.length !== newHeaders.length) return false;

        for (let i = 0; i < oldHeaders.length; i++) {
            const h1 = oldHeaders[i];
            const h2 = newHeaders[i];
            if (h1.level !== h2.level || h1.text !== h2.text) {
                return false;
            }
        }
        return true;
    }

    updateTocPositions(headers: TocItem[]) { // 更新目录项位置信息 data-line
        if (!this.containerEl) return;
        const items = Array.from(this.containerEl.querySelectorAll('.sspai-toc-item')) as HTMLElement[];
        // const items = Array.from(this.containerEl.querySelectorAll('.sspai-toc-item'));

        if (items.length !== headers.length) {
            return;
        }

        items.forEach((item, index) => {
            if (headers[index]) {
                item.dataset.line = headers[index].line.toString();
            }
        });
    }

    checkResponsiveVisibility(view: MarkdownView) { // 检查并应用目录模式
        if (!this.containerEl) return;

        const mode = view.getMode();
        let contentEl: HTMLElement | null = null;

        if (mode === 'source') {
            contentEl = view.contentEl.querySelector('.cm-contentContainer');
            if (!contentEl) {
                contentEl = view.contentEl.querySelector('.cm-sizer');
            }
        } else {
            contentEl = view.contentEl.querySelector('.markdown-preview-sizer');
            if (!contentEl) {
                contentEl = view.contentEl.querySelector('.markdown-preview-section');
            }
        }
        if (contentEl) {
            // Check available space
            const containerRect = view.containerEl.getBoundingClientRect();
            const contentRect = contentEl.getBoundingClientRect();

            // Calculate available space on the right
            const rightSpace = containerRect.right - contentRect.right;
            const minSpaceNeeded = 260; // 220 + 24 + 16 buffer

            // Check if Readable Line Width is enabled
            const isReadable = !!view.contentEl.querySelector('.is-readable-line-width');

            if (!isReadable || rightSpace < minSpaceNeeded) {
                this.containerEl.addClass('compact');
                this.containerEl.removeClass('hidden');
            } else {
                this.containerEl.removeClass('compact');
                this.containerEl.removeClass('hidden');
            }
        }
    }

    registerDomEvents(view: MarkdownView) {
        // Clear previous listeners first to avoid duplication
        this.clearEventRemovers();

        const scrollEl = this.getScroller(view);

        if (scrollEl) {
            const scrollHandler = () => {
                if (!this.blockScrollEvent && !this.isUserInteracting) {
                    this.highlightActiveHeader(view);
                }
            };
            scrollEl.addEventListener('scroll', scrollHandler);
            this.eventRemovers.push(() => scrollEl.removeEventListener('scroll', scrollHandler));

            const resetBlock = () => {
                this.blockScrollEvent = false;
                if (Platform.isMobile && this.containerEl) {
                    this.containerEl.removeClass('mobile-expanded');
                }
            };

            scrollEl.addEventListener('mousedown', resetBlock);
            this.eventRemovers.push(() => scrollEl.removeEventListener('mousedown', resetBlock));

            scrollEl.addEventListener('wheel', resetBlock, { passive: true });
            this.eventRemovers.push(() => scrollEl.removeEventListener('wheel', resetBlock));

            scrollEl.addEventListener('touchstart', resetBlock, { passive: true });
            this.eventRemovers.push(() => scrollEl.removeEventListener('touchstart', resetBlock));

            scrollEl.addEventListener('keydown', resetBlock);
            this.eventRemovers.push(() => scrollEl.removeEventListener('keydown', resetBlock));
        }

        if (view.getMode() === 'source') {
            const handler = () => {
                this.isUserInteracting = true;
                if (Platform.isMobile && this.containerEl) {
                    this.containerEl.removeClass('mobile-expanded');
                }
                this.handleCursorActivity(view);
                // Debounce resetting the interacting flag
                // This prevents scroll events immediately after keyup from taking over
                if (this._resetInteractingTimer) clearTimeout(this._resetInteractingTimer);
                this._resetInteractingTimer = setTimeout(() => {
                    this.isUserInteracting = false;
                }, 150);
            };

            const contentEl = view.contentEl;

            contentEl.addEventListener('keyup', handler);
            this.eventRemovers.push(() => contentEl.removeEventListener('keyup', handler));

            contentEl.addEventListener('mouseup', handler);
            this.eventRemovers.push(() => contentEl.removeEventListener('mouseup', handler));

            contentEl.addEventListener('touchend', handler);
            this.eventRemovers.push(() => contentEl.removeEventListener('touchend', handler));

            contentEl.addEventListener('click', handler);
            this.eventRemovers.push(() => contentEl.removeEventListener('click', handler));
        }
    }

    handleCursorActivity(view: MarkdownView) {
        if (view.getMode() === 'source') {
            if (view.editor) {
                const cursor = view.editor.getCursor();
                if (cursor) {
                    this.highlightActiveHeader(view, cursor.line);
                }
            }
        }
    }

    renderToc(view: MarkdownView, headers?: TocItem[]) {
        if (!this.containerEl) return;

        if (!headers) {
            headers = this.getTocHeaders(view);
        }

        this.containerEl.empty();

        this.lastHeadings = headers;

        headers.forEach((header, index) => {
            const item = this.containerEl.createDiv('sspai-toc-item');
            item.addClass(`sspai-toc-level-${header.level}`);

            const textSpan = item.createSpan('sspai-toc-text');
            textSpan.innerText = this.stripMarkdown(header.text);

            item.onClickEvent(async (event) => {
                event.preventDefault();

                if (!view.file) return;

                // Mobile specific behavior: First touch expands, second touch jumps
                if (Platform.isMobile && this.containerEl && this.containerEl.classList.contains('compact')) {
                    if (!this.containerEl.classList.contains('mobile-expanded')) {
                        this.containerEl.addClass('mobile-expanded');
                        return;
                    }
                }

                // Update lastActiveIndex immediately so that when the scroll event fires,
                this.lastActiveIndex = index;
                this.blockScrollEvent = true;

                if (this.containerEl) {
                    const items = Array.from(this.containerEl.querySelectorAll('.sspai-toc-item')) as HTMLElement[];
                    // const items = Array.from(this.containerEl.querySelectorAll('.sspai-toc-item'));
                    this.updateActiveItem(items, index);
                }

                const mode = view.getMode();
                const line = parseInt(item.getAttribute('data-line') || "0");
                await view.leaf.openFile(view.file, {
                    eState: {
                        line: line,
                        mode: mode
                    }
                });
            });

            item.dataset.line = header.line.toString();
            item.dataset.level = header.level.toString();
        });
    }

    getScroller(view: MarkdownView): HTMLElement | null {
        const mode = view.getMode();

        if (mode === 'source') {
            const scroller = view.contentEl.querySelector('.cm-scroller');
            if (scroller) return scroller as HTMLElement;
            return (view.editor as unknown as { scroller?: HTMLElement })?.scroller || null;
        } else if (mode === 'preview') {
            const scroller = view.contentEl.querySelector('.markdown-preview-view');
            if (scroller) return scroller as HTMLElement;
            return (view.previewMode as unknown as { containerEl?: HTMLElement })?.containerEl || null;
        }
        return null;
    }

    highlightActiveHeader(view: MarkdownView, specificLine?: number) {
        if (!this.containerEl) return;

        const scrollEl = this.getScroller(view);
        const mode = view.getMode();

        if (mode === 'source') {
            this.highlightInSourceMode(view, scrollEl, specificLine ?? -1);
        } else if (mode === 'preview') {
            this.highlightInPreviewMode(view, scrollEl);
        }
    }

    highlightInSourceMode(view: MarkdownView, scrollEl: HTMLElement | null, currentLine: number) {
        if (!this.containerEl) return;

        if (view.editor && currentLine === -1) {
            currentLine = this.detectCurrentLineFromScroll(view, scrollEl);
        }

        const items = Array.from(this.containerEl.querySelectorAll('.sspai-toc-item'));
        let activeIndex = -1;

        for (let i = 0; i < items.length; i++) {
            const itemLine = parseInt((items[i] as HTMLElement).dataset.line || "0");

            if (itemLine <= currentLine) {
                activeIndex = i; // activeIndex = (specificLine !== undefined) ? i : i + 1;
            } else {
                break;
            }
        }

        // 越界保护
        if (activeIndex >= items.length) {
            activeIndex = items.length - 1;
        }

        // Handle Top of Document: force highlight first item if scrolled to top
        // @ts-ignore
        if (view.editor) {
            // @ts-ignore
            const scrollInfo = view.editor.getScrollInfo();
            if (scrollInfo && scrollInfo.top < 50) {
                activeIndex = 0;
            }
        }

        if (activeIndex >= 0) {
            this.lastActiveIndex = activeIndex;
        }
        this.updateActiveItem(items as HTMLElement[], activeIndex);
    }

    detectCurrentLineFromScroll(view: MarkdownView, scrollEl: HTMLElement | null): number {
        if (!view.editor) return -1;

        // @ts-ignore
        const editorScrollInfo = view.editor.getScrollInfo();
        let h = 800;

        if (scrollEl) {
            h = scrollEl.clientHeight;
        } else {
            // @ts-ignore
            if (editorScrollInfo.height) h = editorScrollInfo.height;
        }

        // Adjust offset for source mode to match preview behavior
        // Smaller offset means we look closer to the top of screen
        const userOffset = h / 3000;
        const targetHeight = editorScrollInfo.top + userOffset;
        let currentLine = -1;

        const editorWithCm = view.editor as unknown as { cm: CodeMirrorEditor };
        if (editorWithCm.cm) {
            const cm = editorWithCm.cm;
            try {
                // Use screen coordinates (posAtCoords) for accurate "visual top" detection
                // This bypasses issues with document padding, inline titles, etc.
                let found = false;
                if (scrollEl) {
                    const rect = scrollEl.getBoundingClientRect();
                    const topY = rect.top + (userOffset || 0);
                    const padX = rect.left + 20;

                    const pos = cm.posAtCoords({ x: padX, y: topY });
                    if (pos !== null) {
                        currentLine = cm.state.doc.lineAt(pos).number;
                        found = true;
                    }
                }

                if (!found) {
                    // Fallback to old lineBlockAtHeight if scrollEl missing (unlikely) or posAtCoords failed
                    const block = cm.lineBlockAtHeight(targetHeight);
                    if (block) {
                        currentLine = cm.state.doc.lineAt(block.from).number;
                    }
                }
            } catch (e) {
                console.debug("TOC active line detection failed", e);
            }
        }
        return currentLine;
    }

    highlightInPreviewMode(view: MarkdownView, scrollEl: HTMLElement | null) {
        if (!this.containerEl || !scrollEl) return;

        // Handle Top of Document: force highlight first item if scrolled to top
        if (scrollEl.scrollTop < 50) {
            const items = Array.from(this.containerEl.querySelectorAll('.sspai-toc-item'));
            if (items.length > 0) {
                this.lastActiveIndex = 0;
                this.updateActiveItem(items as HTMLElement[], 0);
                return;
            }
        }

        const userOffset = scrollEl.clientHeight / 2000;
        const containerRect = scrollEl.getBoundingClientRect();
        const targetTop = containerRect.top + userOffset - 20;

        const domHeaders = Array.from(view.contentEl.querySelectorAll('h1, h2, h3, h4, h5, h6'))
            .filter(h => !h.closest('.markdown-embed') && !h.classList.contains('inline-title'));

        let activeDomHeader: Element | null = null;

        for (let i = 0; i < domHeaders.length; i++) {
            const rect = domHeaders[i].getBoundingClientRect();

            if (rect.top <= targetTop) {
                activeDomHeader = domHeaders[i]; // activeDomHeader = domHeaders[i + 1] || domHeaders[i];
            } else {
                break;
            }
        }

        if (activeDomHeader) {
            let headerText = (activeDomHeader as HTMLElement).innerText;

            if (!headerText) {
                headerText = activeDomHeader.getAttribute('data-heading') || "";
            }

            if (headerText) {
                const items = Array.from(this.containerEl.querySelectorAll('.sspai-toc-item'));

                const tagName = activeDomHeader.tagName.toLowerCase();
                const level = parseInt(tagName.replace('h', ''));

                const matchingIndices: number[] = [];

                for (let i = 0; i < items.length; i++) {
                    const item = items[i] as HTMLElement;
                    const itemLevel = parseInt(item.dataset.level || "0");
                    const itemTextSpan = item.querySelector('.sspai-toc-text');
                    const itemText = itemTextSpan ? (itemTextSpan as HTMLElement).innerText : "";

                    if (itemLevel === level && itemText === headerText) {
                        matchingIndices.push(i);
                    }
                }

                let matchedIndex = -1;
                if (matchingIndices.length === 1) {
                    matchedIndex = matchingIndices[0]; // 
                } else if (matchingIndices.length > 1) {
                    let minDistance = Infinity;
                    let bestMatch = matchingIndices[0];

                    for (const idx of matchingIndices) {
                        const distance = Math.abs(idx - this.lastActiveIndex);
                        if (distance < minDistance) {
                            minDistance = distance;
                            bestMatch = idx;
                        }
                    }

                    matchedIndex = bestMatch;
                }

                if (matchedIndex >= 0) {
                    this.lastActiveIndex = matchedIndex;
                    this.updateActiveItem(items as HTMLElement[], matchedIndex);
                }
            }
        }
    }

    updateActiveItem(items: HTMLElement[], activeIndex: number) {
        // Calculate the new state first
        const newActiveIndex = (activeIndex >= 0 && activeIndex < items.length) ? activeIndex : -1;
        const newParentIndices = new Set<number>();

        if (newActiveIndex !== -1) {
            const activeItem = items[newActiveIndex];
            const activeLevel = parseInt(activeItem.dataset.level || "1");

            // Find parent headings (headings with smaller level that appear before active)
            const parentLevelsFound = new Set<number>();
            for (let i = newActiveIndex - 1; i >= 0; i--) {
                const itemLevel = parseInt(items[i].dataset.level || "1");
                if (itemLevel < activeLevel && !parentLevelsFound.has(itemLevel)) {
                    newParentIndices.add(i);
                    parentLevelsFound.add(itemLevel);
                    if (itemLevel === 1) break;
                }
            }
        }

        // Apply changes efficiently by comparing with current state
        items.forEach((item, index) => {
            const shouldBeActive = index === newActiveIndex;
            const shouldBeParent = newParentIndices.has(index);

            // Update Active Class
            if (shouldBeActive) {
                if (!item.classList.contains('active')) item.addClass('active');
            } else {
                if (item.classList.contains('active')) item.removeClass('active');
            }

            // Update Parent Visible Class
            if (shouldBeParent) {
                if (!item.classList.contains('parent-visible')) item.addClass('parent-visible');
            } else {
                if (item.classList.contains('parent-visible')) item.removeClass('parent-visible');
            }
        });

        // Ensure active item is visible in TOC
        if (newActiveIndex !== -1) {
            // items[newActiveIndex].scrollIntoView({ block: 'center', behavior: 'smooth' });
            // Use scrollTop to prevent scrolling parent containers
            const activeItem = items[newActiveIndex] as HTMLElement;
            // const activeItem = items[newActiveIndex];
            if (activeItem && this.containerEl) {
                const containerHeight = this.containerEl.clientHeight;
                const itemTop = activeItem.offsetTop;
                const itemHeight = activeItem.clientHeight;

                // Calculate target scroll position to center the item
                const targetScrollTop = itemTop - (containerHeight / 2) + (itemHeight / 2);

                this.containerEl.scrollTo({
                    top: targetScrollTop,
                    behavior: 'smooth'
                });
            }
        }
    }

    stripMarkdown(text: string): string {
        // 1. Links: [text](url) -> text
        let clean = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

        // 2. Bold/Italic: **text**, *text*, __text__, _text_
        clean = clean.replace(/(\*\*|__)(.*?)\1/g, '$2'); // Bold
        clean = clean.replace(/(\*|_)(.*?)\1/g, '$2');   // Italic

        // 3. Code: `text` -> text
        clean = clean.replace(/`([^`]+)`/g, '$1');

        // 4. Images: ![alt](url) -> alt (or remove if empty)
        clean = clean.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');

        return clean;
    }
}
