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
    lastHeadings: TocItem[] = []; // Cache for comparing structure changes
    debouncedUpdate: Debouncer<[], void>;
    observer: MutationObserver | null = null;
    blockScrollEvent: boolean = false;

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

        const newHeaders = this.getTocHeaders(view);

        // Diff check
        if (this.areHeadersStructurallyEqual(this.lastHeadings, newHeaders)) {
            // Optimization: Structure is same, just update line numbers
            this.updateTocPositions(newHeaders);
            this.lastHeadings = newHeaders; // Update cache with new lines
            this.highlightActiveHeader(view);
        } else {
            // Structure changed (added/removed/renamed), full render
            this.renderToc(view, newHeaders);
        }

        this.registerDomEvents(view);
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
            // Compare text and level. Ignore line number for structure check.
            if (h1.level !== h2.level || h1.text !== h2.text) {
                return false;
            }
        }
        return true;
    }

    updateTocPositions(headers: TocItem[]) {
        if (!this.containerEl) return;
        const items = Array.from(this.containerEl.querySelectorAll('.sspai-toc-item')) as HTMLElement[];

        if (items.length !== headers.length) {
            // Fallback, shouldn't happen if check passed
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

    registerDomEvents(view: MarkdownView) {
        const scrollEl = this.getScroller(view);

        if (scrollEl) {
            // Use registerDomEvent to manage lifecycle automatically
            this.registerDomEvent(scrollEl, 'scroll', () => {
                if (!this.blockScrollEvent) {
                    this.highlightActiveHeader(view);
                }
            });

            // Reset block flag on user interaction
            const resetBlock = () => {
                this.blockScrollEvent = false;
            };
            this.registerDomEvent(scrollEl, 'mousedown', resetBlock);
            this.registerDomEvent(scrollEl, 'wheel', resetBlock);
            this.registerDomEvent(scrollEl, 'touchstart', resetBlock);
            this.registerDomEvent(scrollEl, 'keydown', resetBlock);
        }

        if (view.getMode() === 'source') {
            const handler = () => this.handleCursorActivity(view);
            // Listen for cursor movement and interaction
            this.registerDomEvent(view.contentEl, 'keyup', handler);
            this.registerDomEvent(view.contentEl, 'mouseup', handler);
            this.registerDomEvent(view.contentEl, 'touchend', handler);
            this.registerDomEvent(view.contentEl, 'click', handler);
        }
    }

    handleCursorActivity(view: MarkdownView) {
        if (view.getMode() === 'source') {
            // @ts-ignore
            if (view.editor) {
                // @ts-ignore
                const cursor = view.editor.getCursor();
                if (cursor) {
                    this.highlightActiveHeader(view, cursor.line);
                }
            }
        }
    }

    renderToc(view: MarkdownView, headers?: TocItem[]) {
        if (!this.containerEl) return;

        // If headers not provided, fetch them
        if (!headers) {
            headers = this.getTocHeaders(view);
        }

        this.containerEl.empty();

        // Update lastHeadings if we are doing a full render
        this.lastHeadings = headers;

        headers.forEach((header, index) => {
            const item = this.containerEl!.createDiv('sspai-toc-item');
            item.addClass(`sspai-toc-level-${header.level}`);

            // Wrap text for better ellipsis handling
            const textSpan = item.createSpan('sspai-toc-text');
            textSpan.innerText = this.stripMarkdown(header.text);

            // Click to scroll
            item.onClickEvent(async (event) => {
                event.preventDefault();

                if (!view.file) return;

                // Update lastActiveIndex immediately so that when the scroll event fires,
                // the proximity check favors this item (handling duplicates correctly).
                this.lastActiveIndex = index;
                // Optional prompt for immediate feedback, though the scroll event will trigger updateActiveItem shortly
                // this.updateActiveItem(Array.from(this.containerEl.querySelectorAll('.sspai-toc-item')) as HTMLElement[], index);

                const mode = view.getMode();
                // Dynamic lookup: fetch the latest line number from the DOM element's dataset
                // because line numbers might have shifted since the render time if we only updated attributes
                const line = parseInt(item.dataset.line || "0");

                this.blockScrollEvent = true;
                if (this.containerEl) {
                    const items = Array.from(this.containerEl.querySelectorAll('.sspai-toc-item')) as HTMLElement[];
                    this.updateActiveItem(items, index);
                }

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

    highlightActiveHeader(view: MarkdownView, specificLine?: number) {
        if (!this.containerEl) return;

        let currentLine = specificLine ?? -1;
        const scrollEl = this.getScroller(view);
        const mode = view.getMode();

        // Editor Mode (Source / Live Preview)
        if (mode === 'source') {
            // @ts-ignore
            if (view.editor && currentLine === -1) { // Double check safely and only if no specific line provided
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
                const userOffset = h / 3000;
                const targetHeight = editorScrollInfo.top + userOffset;

                const editorAny = view.editor as any;
                if (editorAny.cm) {
                    const cm = editorAny.cm;
                    try {
                        // Use screen coordinates (posAtCoords) for accurate "visual top" detection
                        // This bypasses issues with document padding, inline titles, etc.
                        if (scrollEl) {
                            const rect = scrollEl.getBoundingClientRect();
                            const topY = rect.top + (userOffset || 0);
                            // X position: just slightly inside the content
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
                    }
                }
            }
        } else if (mode === 'preview') {
            // Reading Mode (Preview)
            if (scrollEl) {
                // Handle Top of Document: force highlight first item if scrolled to top
                if (scrollEl.scrollTop < 50) {
                    const items = Array.from(this.containerEl.querySelectorAll('.sspai-toc-item')) as HTMLElement[];
                    if (items.length > 0) {
                        this.lastActiveIndex = 0;
                        this.updateActiveItem(items, 0);
                        return; // Skip complex DOM calculation
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
                    if (Math.abs(rect.top - targetTop) < 150) {
                        const headerText = (domHeaders[i] as HTMLElement).innerText;
                        // console.log(`[TOC Debug] Near Boundary - Header: "${headerText}", rect.top: ${rect.top}, targetTop: ${targetTop}, isRead: ${rect.top <= targetTop}`);
                    }

                    if (rect.top <= targetTop) {
                        // 当前标题已读完，尝试选中下一个
                        activeDomHeader = domHeaders[i + 1] || domHeaders[i];
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

            // let lastMatchedIndex = -1;

            for (let i = 0; i < items.length; i++) {
                const itemLine = parseInt(items[i].dataset.line || "0");

                if (itemLine <= currentLine) {
                    // lastMatchedIndex = i;
                    activeIndex = (specificLine !== undefined) ? i : i + 1;
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

    stripMarkdown(text: string): string {
        // 1. Links: [text](url) -> text
        let clean = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

        // 2. Bold/Italic: **text**, *text*, __text__, _text_
        // Note: This is a simple regex and might not handle nested or complex cases perfectly, 
        // but sufficient for TOC display.
        clean = clean.replace(/(\*\*|__)(.*?)\1/g, '$2'); // Bold
        clean = clean.replace(/(\*|_)(.*?)\1/g, '$2');   // Italic

        // 3. Code: `text` -> text
        clean = clean.replace(/`([^`]+)`/g, '$1');

        // 4. Images: ![alt](url) -> alt (or remove if empty)
        // actually image syntax is ![alt](url), closely related to links but starting with !
        // The link regex above might leave the '!' if not handled.

        // Let's handle images specifically before links if we want to remove them or keep alt
        // Re-run for images specifically: ![alt](url) -> alt
        clean = clean.replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1');

        // Clean up remaining brackets if any (optional)

        return clean;
    }
}
