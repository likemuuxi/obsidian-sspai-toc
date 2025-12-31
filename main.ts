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
    debouncedUpdate: Debouncer<[], void>;

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
    }

    removeToc() {
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

                const userOffset = h / 3;
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
                    // Try to get text from 'data-heading' (Obsidian standard) or innerText
                    let headerText = activeDomHeader.getAttribute('data-heading');
                    if (!headerText) {
                        headerText = (activeDomHeader as HTMLElement).innerText;
                    }

                    if (headerText) {
                        // Find this text in our TOC items
                        // We need to match against the 'headers' source data, but we don't have it easily here.
                        // We can look at the DOM elements in TOC container! structure: item -> textSpan
                        const items = Array.from(this.containerEl.querySelectorAll('.sspai-toc-item')) as HTMLElement[];

                        // We iterate TOC items and try to match text.
                        // Issue: Duplicates. 
                        // Heuristic: If we are in the middle of document, we might pick wrong duplicate?
                        // But usually people have unique headers. We pick the FIRST match for now?
                        // Or better: We can match Level + Text.

                        // Let's get the level from DOM tag
                        const tagName = activeDomHeader.tagName.toLowerCase(); // h1..h6
                        const level = parseInt(tagName.replace('h', ''));

                        let matchedIndex = -1;

                        // We check the items.
                        for (let i = 0; i < items.length; i++) {
                            const item = items[i];
                            const itemLevel = parseInt(item.dataset.level || "0");
                            const itemTextSpan = item.querySelector('.sspai-toc-text') as HTMLElement;
                            const itemText = itemTextSpan ? itemTextSpan.innerText : "";

                            // Loose match: check if text matches and level matches
                            if (itemLevel === level && itemText === headerText) {
                                matchedIndex = i;

                                // Can we improve duplicate handling? 
                                // If we assume the user reads forward, maybe we match the one closest to previous active?
                                // For now, break on first match. Logic can be improved if user complains of duplicates.
                                // Actually, if there are duplicates, we might want to check if there's a subsequent header in DOM
                                // that matches a subsequent header in TOC? Too complex for now.
                                break;
                            }
                        }

                        // If we found a match by text, update it.
                        if (matchedIndex >= 0) {

                            this.updateActiveItem(items, matchedIndex);
                            return;
                        } else {

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
            // Use block: 'center' to keep it in middle of TOC view if possible
            activeItem.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    }
}
