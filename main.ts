import { Plugin, MarkdownView, Debouncer, debounce } from 'obsidian';

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

        if (!view) {
            return;
        }

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
            
            // Only highlight if NOT interacting or if we have a specific line preference?
            // Actually, we should probably prefer cursor if available in Source Mode.
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

    updateTocPositions(headers: TocItem[]) {
        if (!this.containerEl) return;
        const items = Array.from(this.containerEl.querySelectorAll('.sspai-toc-item'));

        if (items.length !== headers.length) {
            return;
        }

        items.forEach((item, index) => {
            if (headers[index]) {
                item.dataset.line = headers[index].line.toString();
            }
        });
    }

    checkResponsiveVisibility(view: MarkdownView) {
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
            };
            
            scrollEl.addEventListener('mousedown', resetBlock);
            this.eventRemovers.push(() => scrollEl.removeEventListener('mousedown', resetBlock));
            
            scrollEl.addEventListener('wheel', resetBlock);
            this.eventRemovers.push(() => scrollEl.removeEventListener('wheel', resetBlock));
            
            scrollEl.addEventListener('touchstart', resetBlock);
            this.eventRemovers.push(() => scrollEl.removeEventListener('touchstart', resetBlock));
            
            scrollEl.addEventListener('keydown', resetBlock);
            this.eventRemovers.push(() => scrollEl.removeEventListener('keydown', resetBlock));
        }

        if (view.getMode() === 'source') {
            const handler = () => {
                this.isUserInteracting = true;
                this.handleCursorActivity(view);
                // Debounce resetting the interacting flag
                // This prevents scroll events immediately after keyup from taking over
                if (this._resetInteractingTimer) clearTimeout(this._resetInteractingTimer);
                this._resetInteractingTimer = setTimeout(() => {
                    this.isUserInteracting = false;
                }, 150);
            };
            const contentEl = view.contentEl as HTMLElement;
            
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

                // Update lastActiveIndex immediately so that when the scroll event fires,
                this.lastActiveIndex = index;
                // Optional prompt for immediate feedback, though the scroll event will trigger updateActiveItem shortly
                // this.updateActiveItem(Array.from(this.containerEl.querySelectorAll('.sspai-toc-item')), index);

                const mode = view.getMode();
                const line = parseInt(item.getAttribute('data-line') || "0");

                this.blockScrollEvent = true;
                if (this.containerEl) {
                    const items = Array.from(this.containerEl.querySelectorAll('.sspai-toc-item'));
                    this.updateActiveItem(items, index);
                }

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

        let currentLine = specificLine ?? -1;
        const scrollEl = this.getScroller(view);
        const mode = view.getMode();

        if (mode === 'source') {
            if (view.editor && currentLine === -1) {
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

                const editorWithCm = view.editor as unknown as { cm: CodeMirrorEditor };
                if (editorWithCm.cm) {
                    const cm = editorWithCm.cm;
                    try {
                        // Use screen coordinates (posAtCoords) for accurate "visual top" detection
                        // This bypasses issues with document padding, inline titles, etc.
                        if (scrollEl) {
                            const rect = scrollEl.getBoundingClientRect();
                            const topY = rect.top + (userOffset || 0);
                            const padX = rect.left + 20;

                            const pos = cm.posAtCoords({ x: padX, y: topY });
                            if (pos !== null) {
                                currentLine = cm.state.doc.lineAt(pos).number;
                            }
                        } else {
                            // Fallback to old lineBlockAtHeight if scrollEl missing (unlikely)
                            const block = cm.lineBlockAtHeight(targetHeight);
                            if (block) {
                                currentLine = cm.state.doc.lineAt(block.from).number;
                            }
                        }

                        // if (currentLine !== -1) {
                        //     const lineContent = cm.state.doc.line(currentLine).text;
                        //     console.log({
                        //         "currentLine": currentLine,
                        //         "lineContent": lineContent
                        //     });
                        // }
                    } catch (e) {
                        console.debug("TOC active line detection failed", e);
                    }
                }
            }
        } else if (mode === 'preview') {
            if (scrollEl) {
                // Handle Top of Document: force highlight first item if scrolled to top
                if (scrollEl.scrollTop < 50) {
                    const items = Array.from(this.containerEl.querySelectorAll('.sspai-toc-item'));
                    if (items.length > 0) {
                        this.lastActiveIndex = 0;
                        this.updateActiveItem(items, 0);
                        return;
                    }
                }

                const userOffset = scrollEl.clientHeight / 2000;
                const containerRect = scrollEl.getBoundingClientRect();
                const targetTop = containerRect.top + userOffset - 20;

                // Strategy: Text-Based Header Matching (Best for Virtualization + Missing Line Numbers)
                // We find the header in DOM that is effectively "active" (above reading line)
                // And we match it by TEXT to the TOC list.

                const domHeaders = Array.from(view.contentEl.querySelectorAll('h1, h2, h3, h4, h5, h6'))
                    .filter(h => !h.closest('.markdown-embed') && !h.classList.contains('inline-title'));

                let activeDomHeader: Element | null = null;

                // Find the header closest to the target line (but above it)
                // console.log(`[TOC Debug] targetTop: ${targetTop}`);
                for (let i = 0; i < domHeaders.length; i++) {
                    const rect = domHeaders[i].getBoundingClientRect();

                    // Only log if close to boundary to avoid spam
                    // if (Math.abs(rect.top - targetTop) < 150) {
                    //     const headerText = (domHeaders[i] as HTMLElement).innerText;
                    //     // console.log(`[TOC Debug] Near Boundary - Header: "${headerText}", rect.top: ${rect.top}, targetTop: ${targetTop}, isRead: ${rect.top <= targetTop}`);
                    // }

                    if (rect.top <= targetTop) {
                        // Highlight the header we have just passed (current section)
                        activeDomHeader = domHeaders[i];
                    } else {
                        break;
                    }
                }

                // if (activeDomHeader) {
                //     console.log(`[TOC Debug] Final Active: "${(activeDomHeader as HTMLElement).innerText}"`);
                // }

                if (activeDomHeader) {
                    // Start with innerText which matches the rendered TOC items (stripped of Markdown)
                    let headerText = (activeDomHeader as HTMLElement).innerText;

                    // Fallback to data-heading if innerText is empty? 
                    // Usually innerText is better for matching visual content.
                    if (!headerText) {
                        headerText = activeDomHeader.getAttribute('data-heading') || "";
                    }

                    if (headerText) {
                        // Find this text in our TOC items
                        const items = Array.from(this.containerEl.querySelectorAll('.sspai-toc-item'));

                        // Get the level from DOM tag
                        const tagName = activeDomHeader.tagName.toLowerCase(); // h1..h6
                        const level = parseInt(tagName.replace('h', ''));

                        // Solution for duplicates: Use proximity-based matching
                        // Collect all matching indices, then choose the one closest to last active position
                        const matchingIndices: number[] = [];

                        for (let i = 0; i < items.length; i++) {
                            const item = items[i];
                            const itemLevel = parseInt(item.dataset.level || "0");
                            const itemTextSpan = item.querySelector('.sspai-toc-text');
                            const itemText = itemTextSpan ? (itemTextSpan as HTMLElement).innerText : "";

                            // Check if text and level match
                            if (itemLevel === level && itemText === headerText) {
                                matchingIndices.push(i);
                            }
                        }

                        let matchedIndex = -1;

                        if (matchingIndices.length === 1) {
                            // Only one match, use it
                            matchedIndex = matchingIndices[0];
                        } else if (matchingIndices.length > 1) {
                            // Multiple matches: choose the one closest to last active index
                            // This prevents large jumps and provides smooth scrolling experience
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
                            this.updateActiveItem(items, matchedIndex);
                            return;
                        }
                    }
                }
            }
        }

        // Editor Mode falls through to here
        if (mode === 'source') {
            const items = Array.from(this.containerEl.querySelectorAll('.sspai-toc-item'));
            let activeIndex = -1;

            // let lastMatchedIndex = -1;

            for (let i = 0; i < items.length; i++) {
                const itemLine = parseInt(items[i].dataset.line || "0");

                if (itemLine <= currentLine) {
                    // lastMatchedIndex = i;
                    // Always highlight the current header (the one we are 'in')
                    // This matches the cursor behavior and prevents jumping between 'current' and 'next'
                    activeIndex = i;
                } else {
                    break;
                }
            }

            // 只在最后打印一次
            // if (lastMatchedIndex >= 0) {
            //     const item = items[lastMatchedIndex];
            //     const itemText = (item.querySelector('.sspai-toc-text') as HTMLElement)?.innerText;
            //     const itemLine = parseInt(item.dataset.line || "0");

            //     console.log(
            //         `[TOC Debug] Item "${itemText}" Line: ${itemLine}, CurrentLine: ${currentLine}`
            //     );
            // }

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
            this.updateActiveItem(items, activeIndex);
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
            items[newActiveIndex].scrollIntoView({ block: 'center', behavior: 'smooth' });
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
