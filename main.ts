import { Plugin, MarkdownView, WorkspaceLeaf, Debouncer, debounce } from 'obsidian';

interface TocItem {
    level: number;
    text: string;
    line: number;
    id: string; // generated id for anchor
}

export default class SspaiTocPlugin extends Plugin {
    containerEl: HTMLElement | null = null;
    activeHeaderLine: number = -1;
    lastActiveIndex: number = -1; // Track last active TOC item for proximity-based matching
    debouncedUpdate: Debouncer<[], void>;
    observer: MutationObserver | null = null;

    async onload() {
        console.log('Loading Sspai TOC Plugin');

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

        // Update TOC when file content changes (e.g. typing headings)
        this.registerEvent(
            this.app.vault.on('modify', (file) => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (view && view.file === file) {
                    this.debouncedUpdate();
                }
            })
        );

        // Use an interval to check if scroll listener needs to be attached, 
        // because the view might not be fully ready immediately.
        // A better way is wrapping the scroll event logic in the updateToc or a separate attacher.
    }

    onunload() {
        console.log('Unloading Sspai TOC Plugin');
        this.removeToc();
        if (this.observer) {
            this.observer.disconnect();
            this.observer = null;
        }
    }

    removeToc() {
        if (this.observer) {
            this.observer.disconnect();
            // Don't null observer here, as we might reuse it or re-init it. 
            // Actually best to stick to pattern: cleanup on update.
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

        // Ensure TOC container exists
        if (!this.containerEl) {
            this.containerEl = document.createElement('div');
            this.containerEl.addClass('sspai-toc-container');
            view.containerEl.appendChild(this.containerEl);
        } else {
            // Re-attach if lost (e.g. view re-render)
            if (!view.containerEl.contains(this.containerEl)) {
                view.containerEl.appendChild(this.containerEl);
            }
        }

        this.renderToc(view);
        this.registerScrollEvent(view);
        this.checkResponsiveVisibility(view);

        // Setup MutationObserver to watch for class changes (Readable Line Width toggle)
        if (this.observer) {
            this.observer.disconnect();
        }

        // Target: We need to watch the element that gets the 'is-readable-line-width' class.
        // It's usually a child of contentEl (markdown-source-view etc)
        const target = view.contentEl.querySelector('.markdown-source-view, .markdown-preview-view');
        if (target) {
            this.observer = new MutationObserver((mutations) => {
                // Check if class attribute changed
                for (const mutation of mutations) {
                    if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
                        this.checkResponsiveVisibility(view);
                    }
                }
            });
            this.observer.observe(target, { attributes: true, attributeFilter: ['class'] });
        }
    }

    checkResponsiveVisibility(view: MarkdownView) {
        if (!this.containerEl) return;

        const mode = view.getMode();
        let contentEl: HTMLElement | null = null;

        if (mode === 'source') {
            // Source mode content container
            contentEl = view.contentEl.querySelector('.cm-contentContainer') as HTMLElement;
            if (!contentEl) {
                // Fallback
                contentEl = view.contentEl.querySelector('.cm-sizer') as HTMLElement;
            }
        } else {
            // Reading mode content container
            contentEl = view.contentEl.querySelector('.markdown-preview-sizer') as HTMLElement;
            if (!contentEl) {
                contentEl = view.contentEl.querySelector('.markdown-preview-section') as HTMLElement;
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
            // If NOT enabled (isReadable is false), content is usually wide, so we force compact mode
            // OR if enabled but space is small, force compact mode.
            const isReadable = !!view.contentEl.querySelector('.is-readable-line-width');

            if (!isReadable || rightSpace < minSpaceNeeded) {
                // Not enough space OR Full width mode -> Compact Mode
                this.containerEl.addClass('compact');
                this.containerEl.removeClass('hidden');
            } else {
                // Enough space -> Normal Mode
                this.containerEl.removeClass('compact');
                this.containerEl.removeClass('hidden');
            }
        }
    }

    registerScrollEvent(view: MarkdownView) {
        const scrollEl = this.getScroller(view);

        if (scrollEl) {
            // Use registerDomEvent to manage lifecycle automatically
            this.registerDomEvent(scrollEl, 'scroll', () => {
                this.highlightActiveHeader(view);
            });
        } else {

        }
    }

    renderToc(view: MarkdownView) {
        if (!this.containerEl) return;
        this.containerEl.empty();

        const headers: TocItem[] = [];

        // Parse metadata cache for headers
        const file = view.file;
        if (!file) return;

        const cache = this.app.metadataCache.getFileCache(file);
        if (!cache || !cache.headings) return;

        cache.headings.forEach(h => {
            headers.push({
                level: h.level,
                text: h.heading,
                line: h.position.start.line,
                id: h.heading.replace(/\s+/g, '-').toLowerCase() // Simple slug
            });
        });

        headers.forEach((header, index) => {
            const item = this.containerEl!.createDiv('sspai-toc-item');
            item.addClass(`sspai-toc-level-${header.level}`);

            // Wrap text for better ellipsis handling
            const textSpan = item.createSpan('sspai-toc-text');
            textSpan.innerText = header.text;

            // Click to scroll
            item.onClickEvent(async (event) => {
                event.preventDefault();

                if (!view.file) return;

                const mode = view.getMode();
                const line = header.line;

                // Use eState for precise line-based navigation (solves duplicate headers)
                await view.leaf.openFile(view.file, {
                    eState: {
                        line: line,
                        mode: mode
                    }
                });
            });

            // Store line and level for highlighting
            item.dataset.line = header.line.toString();
            item.dataset.level = header.level.toString();
        });

        this.highlightActiveHeader(view);
    }

    getScroller(view: MarkdownView): HTMLElement | null {
        const mode = view.getMode();

        if (mode === 'source') {
            // Live Preview or Source Mode
            // return view.editor?.scroller; // Check if this is reliable
            // Better: look for .cm-scroller inside the view content
            const scroller = view.contentEl.querySelector('.cm-scroller') as HTMLElement;
            if (scroller) return scroller;
            // Fallback
            // @ts-ignore
            return view.editor?.scroller;
        } else if (mode === 'preview') {
            // Reading View
            // The containerEl might be a wrapper. The actual scrollable is usually .markdown-preview-view
            const scroller = view.contentEl.querySelector('.markdown-preview-view') as HTMLElement;
            if (scroller) return scroller;

            // Fallback
            // @ts-ignore
            return view.previewMode?.containerEl;
        }
        return null;
    }

    highlightActiveHeader(view: MarkdownView) {
        if (!this.containerEl) return;

        let currentLine = 0;
        const scrollEl = this.getScroller(view);
        const mode = view.getMode();

        // Editor Mode (Source / Live Preview)
        if (mode === 'source') {
            // @ts-ignore
            if (view.editor) { // Double check safely
                // @ts-ignore
                const editorScrollInfo = view.editor.getScrollInfo();

                // Fix TS error: getScrollInfo return type might not have height in strict definition
                // Use scrollEl logic if available (preferred), or fallback to a default
                let h = 800;
                if (scrollEl) {
                    h = scrollEl.clientHeight;
                } else {
                    // @ts-ignore
                    if (editorScrollInfo.height) h = editorScrollInfo.height;
                }

                // Adjust offset for source mode to match preview behavior
                // Smaller offset means we look closer to the top of screen
                const userOffset = h / 18;
                const targetHeight = editorScrollInfo.top + userOffset;

                // Use CodeMirror 6 API if available
                // @ts-ignore
                if (view.editor.cm) {
                    // @ts-ignore
                    const cm = view.editor.cm;
                    try {
                        const block = cm.lineBlockAtHeight(targetHeight);
                        if (block) {
                            currentLine = cm.state.doc.lineAt(block.from).number;
                        }
                    } catch (e) {

                    }
                }
            }
        } else if (mode === 'preview') {
            // Reading Mode (Preview)
            if (scrollEl) {
                const userOffset = scrollEl.clientHeight / 3;
                const containerRect = scrollEl.getBoundingClientRect();
                const targetTop = containerRect.top + userOffset;

                // Strategy: Text-Based Header Matching (Best for Virtualization + Missing Line Numbers)
                // We find the header in DOM that is effectively "active" (above reading line)
                // And we match it by TEXT to the TOC list.

                const domHeaders = Array.from(view.contentEl.querySelectorAll('h1, h2, h3, h4, h5, h6'))
                    .filter(h => !h.closest('.markdown-embed') && !h.classList.contains('inline-title'));

                let activeDomHeader: Element | null = null;

                // Find the header closest to the target line (but above it)
                for (let i = 0; i < domHeaders.length; i++) {
                    const headerEl = domHeaders[i];
                    const rect = headerEl.getBoundingClientRect();

                    if (rect.top <= targetTop) {
                        activeDomHeader = headerEl;
                    } else {
                        // This header is below, so the previous one (activeDomHeader) is the winner.
                        break;
                    }
                }

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
                        const items = Array.from(this.containerEl.querySelectorAll('.sspai-toc-item')) as HTMLElement[];

                        // Get the level from DOM tag
                        const tagName = activeDomHeader.tagName.toLowerCase(); // h1..h6
                        const level = parseInt(tagName.replace('h', ''));

                        // Solution for duplicates: Use proximity-based matching
                        // Collect all matching indices, then choose the one closest to last active position
                        const matchingIndices: number[] = [];

                        for (let i = 0; i < items.length; i++) {
                            const item = items[i];
                            const itemLevel = parseInt(item.dataset.level || "0");
                            const itemTextSpan = item.querySelector('.sspai-toc-text') as HTMLElement;
                            const itemText = itemTextSpan ? itemTextSpan.innerText : "";

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

                        // If we found a match, update it
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
            const items = Array.from(this.containerEl.querySelectorAll('.sspai-toc-item')) as HTMLElement[];
            let activeIndex = -1;

            for (let i = 0; i < items.length; i++) {
                const itemLine = parseInt(items[i].dataset.line || "0");
                if (itemLine <= currentLine) {
                    activeIndex = i;
                } else {
                    break;
                }
            }

            if (activeIndex >= 0) {
                this.lastActiveIndex = activeIndex;
            }
            this.updateActiveItem(items, activeIndex);
        }
    }

    updateActiveItem(items: HTMLElement[], activeIndex: number) {
        // Clear all visibility classes
        items.forEach(i => {
            i.removeClass('active');
            i.removeClass('parent-visible');
        });

        if (activeIndex >= 0 && activeIndex < items.length) {
            const activeItem = items[activeIndex];
            activeItem.addClass('active');

            // Get the level of active item
            const activeLevel = parseInt(activeItem.dataset.level || "1");

            // Find parent headings (headings with smaller level that appear before active)
            const parentLevelsFound = new Set<number>();
            for (let i = activeIndex - 1; i >= 0; i--) {
                const itemLevel = parseInt(items[i].dataset.level || "1");
                // A parent is a heading with smaller level number
                if (itemLevel < activeLevel && !parentLevelsFound.has(itemLevel)) {
                    items[i].addClass('parent-visible');
                    parentLevelsFound.add(itemLevel);
                    if (itemLevel === 1) break;
                }
            }

            // Ensure active item is visible in TOC
            // Use block: 'center' to keep it in middle of TOC view
            activeItem.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
    }
}
