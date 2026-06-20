import browser from './utils/browser-polyfill';
import * as highlighter from './utils/highlighter';
import { removeExistingHighlights } from './utils/highlighter-overlays';
import { loadSettings, generalSettings } from './utils/storage-utils';
import { getDomain } from './utils/string-utils';
import { extractContentBySelector as extractContentBySelectorShared } from './utils/shared';
import Defuddle from 'defuddle';
import { createMarkdownContent } from 'defuddle/full';
import { flattenShadowDom } from './utils/flatten-shadow-dom';
import { serializeChildren } from './utils/dom-utils';
import { saveFile } from './utils/file-utils';
import { debugLog } from './utils/debug';
import { updateSidebarWidth, addResizeHandle, cleanupResizeHandlers } from './utils/iframe-resize';
import { parseForClip } from './utils/clip-utils';

declare global {
	interface Window {
		obsidianClipperGeneration?: number;
	}
}

// IIFE to scope variables and allow safe re-execution
(function() {
	// Bump the generation counter on every injection. Older listeners close
	// over their own generation value and bail out when they see a newer one,
	// so a zombie content script (runtime invalidated after extension update)
	// will silently yield to the freshly-injected instance.
	window.obsidianClipperGeneration = (window.obsidianClipperGeneration ?? 0) + 1;
	const myGeneration = window.obsidianClipperGeneration;

	debugLog('Clipper', 'Initializing content script, generation', myGeneration);

	let isHighlighterMode = false;
	const iframeId = 'obsidian-clipper-iframe';
	const containerId = 'obsidian-clipper-container';

	/**
	 * Remove non-content elements from the page before Defuddle extraction.
	 * Handles site-specific known layouts where Defuddle's auto-detection
	 * picks up comments, sidebars, and other clutter.
	 *
	 * Returns a CLONED document so the live page DOM is not mutated.
	 * Otherwise the sidebar/header would be permanently deleted from the
	 * real page after the user saves, leaving them unable to navigate.
	 */
	function cleanPageForClipping(doc: Document): Document {
		try {
			const url = new URL(doc.URL);
			const hostname = url.hostname;
			const cleaned = doc.cloneNode(true) as Document;
			// cloneNode strips custom URL property — restore it so Defuddle
			// can resolve relative URLs against the original page URL.
			try { Object.defineProperty(cleaned, 'URL', { value: doc.URL, configurable: true }); } catch {}

			// --- VuePress Vdoing theme (cloud.iocoder.cn, etc.) ---
			// This theme renders navigation/sidebar/footer as visible page content
			// that Defuddle incorrectly treats as main content.
			if (hostname.includes('iocoder.cn') || hostname.includes('cloud.iocoder.cn')) {
				// Remove the top navigation bar (repeated links)
				cleaned.querySelector('header.navbar')?.remove();
				// Remove the left sidebar with navigation tree (repeated links)
				cleaned.querySelector('aside.sidebar')?.remove();
				// Remove the right-side table of contents
				cleaned.querySelector('.right-menu-wrapper')?.remove();
				// Remove breadcrumb / article info
				cleaned.querySelector('.articleInfo-wrap')?.remove();
				// Remove bottom page slot (e.g. ad/social sections)
				cleaned.querySelector('.page-slot-bottom')?.remove();
				// Remove "Edit this page" link
				cleaned.querySelector('.page-edit')?.remove();
				// Remove prev/next page navigation
				cleaned.querySelector('.page-nav-wapper')?.remove();
				cleaned.querySelector('.page-nav')?.remove();
				// Remove footer (copyright, theme info, read-mode buttons)
				cleaned.querySelector('.footer')?.remove();
				// Remove background mask / overlay elements
				cleaned.querySelector('.mask')?.remove();
				// Remove the floating theme-switcher button (跟随系统/浅色模式/...)
				cleaned.querySelector('.buttons')?.remove();
				// Remove the floating ad wrapper and its "×" close button
				cleaned.querySelector('.custom-wrapper')?.remove();
			}
			// --- Quill editor code blocks (zsxq.com, etc.) ---
			// Defuddle doesn't recognize `div.ql-code-block-container` (the Quill
			// rich-text editor's code block markup) so it gets flattened into plain
			// text. Convert it to <pre><code> first so Defuddle treats it as a
			// fenced code block in Markdown.
			cleaned.querySelectorAll('div.ql-code-block-container').forEach(container => {
				const pre = cleaned.createElement('pre');
				const code = cleaned.createElement('code');
				const codeLines = container.querySelectorAll('.ql-code-block');
				if (codeLines.length > 0) {
					code.textContent = Array.from(codeLines)
						.map(line => line.textContent || '')
						.join('\n');
				} else {
					code.textContent = container.textContent || '';
				}
				pre.appendChild(code);
				container.replaceWith(pre);
			});
			if (hostname.includes('zhihu.com')) {
				// Remove the right sidebar (AuthorCard, HotSearchCard, etc.)
				cleaned.querySelector('.Post-Row-Content-right')?.remove();

				// Remove the "推荐阅读" recommendations section
				cleaned.querySelector('.Post-Sub.Post-NormalSub')?.remove();

				// Remove the comments section (the div after the article)
				const leftArticle = cleaned.querySelector('.Post-Row-Content-left-article');
				if (leftArticle && leftArticle.children.length > 1) {
					const commentsDiv = leftArticle.children[1];
					if (commentsDiv) commentsDiv.remove();
				}

				// Remove non-content elements inside the article
				const article = cleaned.querySelector('article.Post-Main');
				if (article) {
					// Remove the header (author info, likes, "收录于")
					article.querySelector('.Post-Header')?.remove();
					// Remove edit time metadata
					article.querySelector('.ContentItem-time')?.remove();
					// Remove topic tags
					article.querySelector('.Post-topicsAndReviewer')?.remove();
					// Remove ad / large image section
					article.querySelector('.pc-article-answer-big-img')?.remove();
					// Remove action buttons (last child - like, comment, share)
					const lastChild = article.lastElementChild;
					if (lastChild) lastChild.remove();
				}
			}
			return cleaned;
		} catch (e) {
			console.warn('[Obsidian Clipper] Error cleaning page:', e);
			return doc;
		}
	}

	function removeContainer(container: HTMLElement) {
		container.classList.add('is-closing');
		updateSidebarWidth(document, null);
		cleanupResizeHandlers(document);
		container.addEventListener('animationend', () => {
			container.remove();
			highlighter.repositionHighlights();
		}, { once: true });
	}

	async function toggleIframe() {
		const existingContainer = document.getElementById(containerId);
		if (existingContainer) {
			removeContainer(existingContainer);
			return;
		}

		await ensureHighlighterCSS();

		const container = document.createElement('div');
		container.id = containerId;
		container.classList.add('is-open');

		const { clipperIframeWidth, clipperIframeHeight } = await browser.storage.local.get(['clipperIframeWidth', 'clipperIframeHeight']);
		if (clipperIframeWidth) {
			container.style.width = `${clipperIframeWidth}px`;
		}
		if (clipperIframeHeight) {
			container.style.height = `${clipperIframeHeight}px`;
		}

		const iframe = document.createElement('iframe');
		iframe.id = iframeId;
		iframe.allow = 'clipboard-write; web-share';
		iframe.src = browser.runtime.getURL('side-panel.html?context=iframe');
		container.appendChild(iframe);

		const resizeCallbacks = {
			onResize: () => highlighter.repositionHighlights(),
			onResizeEnd: () => highlighter.repositionHighlights(),
		};
		addResizeHandle(document, container, 'w', resizeCallbacks);
		addResizeHandle(document, container, 's', resizeCallbacks);
		addResizeHandle(document, container, 'sw', resizeCallbacks);

		document.body.appendChild(container);
		updateSidebarWidth(document, container);
		container.addEventListener('animationend', () => highlighter.repositionHighlights(), { once: true });
	}

	// Firefox
	browser.runtime.sendMessage({ action: "contentScriptLoaded" });

	interface ContentResponse {
		content: string;
		selectedHtml: string;
		extractedContent: { [key: string]: string };
		schemaOrgData: any;
		fullHtml: string;
		highlights: string[];
		title: string;
		description: string;
		domain: string;
		favicon: string;
		image: string;
		parseTime: number;
		published: string;
		author: string;
		site: string;
		wordCount: number;
		language: string;
		metaTags: { name?: string | null; property?: string | null; content: string | null }[];
	}

	browser.runtime.onMessage.addListener((request: any, sender, sendResponse) => {
		// If a newer generation of this content script has been injected,
		// yield to it rather than responding from a potentially stale context.
		if (window.obsidianClipperGeneration !== myGeneration) {
			return;
		}

		if (request.action === "ping") {
			sendResponse({});
			return true;
		}

		if (request.action === "toggle-iframe") {
			toggleIframe().then(() => {
				sendResponse({ success: true });
			});
			return true;
		}

		if (request.action === "close-iframe") {
			const existingContainer = document.getElementById(containerId);
			if (existingContainer) {
				removeContainer(existingContainer);
			}
			return;
		}

		if (request.action === "copy-text-to-clipboard") {
			const textArea = document.createElement("textarea");
			textArea.value = request.text;
			document.body.appendChild(textArea);
			textArea.select();
			try {
				document.execCommand('copy');
				sendResponse({success: true});
			} catch (err) {
				sendResponse({success: false});
			}
			document.body.removeChild(textArea);
			return true;
		}

		if (request.action === "copyMarkdownToClipboard") {
			flattenShadowDom(document).then(() => {
				try {
					// Clean up non-content elements for known sites before Defuddle parsing.
					// cleanPageForClipping returns a clone so the live page DOM is preserved.
					const cleanedDoc = cleanPageForClipping(document);

					const defuddled = parseForClip(cleanedDoc);

					// Convert HTML content to markdown
					const markdown = createMarkdownContent(defuddled.content, document.URL);

					// Copy to clipboard
					const textArea = document.createElement("textarea");
					textArea.value = markdown;
					document.body.appendChild(textArea);
					textArea.select();
					document.execCommand('copy');
					document.body.removeChild(textArea);

					sendResponse({ success: true });
				} catch (err) {
					console.error('Failed to copy markdown to clipboard:', err);
					sendResponse({ success: false, error: (err as Error).message });
				}
			});
			return true;
		}

		if (request.action === "saveMarkdownToFile") {
			flattenShadowDom(document).then(async () => {
				try {
					// Clean up non-content elements for known sites before Defuddle parsing.
					// cleanPageForClipping returns a clone so the live page DOM is preserved.
					const cleanedDoc = cleanPageForClipping(document);

					const defuddled = parseForClip(cleanedDoc);
					const markdown = createMarkdownContent(defuddled.content, document.URL);
					const title = defuddled.title || document.title || 'Untitled';
					const fileName = title.replace(/[/\\?%*:|"<>]/g, '-');
					await saveFile({
						content: markdown,
						fileName,
						mimeType: 'text/markdown',
					});
					sendResponse({ success: true });
				} catch (err) {
					console.error('Failed to save markdown file:', err);
					sendResponse({ success: false, error: (err as Error).message });
				}
			});
			return true;
		}

		if (request.action === "getPageContent") {
			// Flatten shadow DOM before extraction (async, needs main world)
			const flattenTimeout = new Promise<void>(resolve => setTimeout(resolve, 3000));
			Promise.race([flattenShadowDom(document), flattenTimeout]).then(async () => {
				let selectedHtml = '';
				const selection = window.getSelection();

				if (selection && selection.rangeCount > 0) {
					const range = selection.getRangeAt(0);
					const clonedSelection = range.cloneContents();
					const div = document.createElement('div');
					div.appendChild(clonedSelection);
					selectedHtml = serializeChildren(div);
				}

				// Work on a cloned document so image preprocessing and site-specific
				// cleanup never mutate the live page DOM. This keeps the sidebar,
				// nav, etc. intact for the user to continue navigating.
				const cleanedDoc = cleanPageForClipping(document);

				// Pre-process images to handle lazy-loaded data-src attributes.
				// Many websites (WeChat, Medium, etc.) use data-src for lazy loading,
				// and Defuddle may not capture the image if src is a placeholder.
				cleanedDoc.querySelectorAll('img').forEach(img => {
					const dataSrc = img.getAttribute('data-src');
					const currentSrc = img.getAttribute('src');

					if (dataSrc && (!currentSrc || (currentSrc.startsWith('data:image/') && currentSrc.length < 200))) {
						try {
							const absoluteUrl = new URL(dataSrc, document.baseURI).href;
							img.setAttribute('src', absoluteUrl);
						} catch (e) {
							img.setAttribute('src', dataSrc);
						}
					}

					const dataSrcset = img.getAttribute('data-srcset');
					if (dataSrcset && !img.getAttribute('srcset')) {
						const newSrcset = dataSrcset.split(',').map(src => {
							const [url, size] = src.trim().split(' ');
							try {
								const absoluteUrl = new URL(url, document.baseURI).href;
								return `${absoluteUrl}${size ? ' ' + size : ''}`;
							} catch (e) {
								return src;
							}
						}).join(', ');
						img.setAttribute('srcset', newSrcset);
					}
				});

				// Use parseAsync to ensure async variables like {{transcript}} are available.
				// If it hangs (e.g. another extension has corrupted fetch), fall back to sync parse.
				const defuddle = new Defuddle(cleanedDoc, { url: document.URL });
				const parseTimeout = new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error('parseAsync timeout')), 8000)
				);
				const defuddled = await Promise.race([defuddle.parseAsync(), parseTimeout])
					.catch(() => defuddle.parse());
				const extractedContent: { [key: string]: string } = {
					...defuddled.variables,
				};

				// If the Defuddle content is missing images that are present in the
				// page's article container, use the container's full HTML instead.
				// Defuddle's scoring algorithm penalizes image-heavy containers and
				// may drop images that should be in the content.
				const articleContainer = cleanedDoc.querySelector(
					'#js_content, .rich_media_content, ' +
					'#article-content, .article-content, ' +
					'.post-content, .entry-content, ' +
					'.article-body, .article_body, ' +
					'.rich_media, #page-content, ' +
					'.content-article, .post-body, ' +
					'[class*="article_body"], [class*="post_body"], ' +
					'#content, .content, ' +
					'main, [role="main"], article, [role="article"], ' +
					'#app, .app, .page-content, .main-content, ' +
					'#main, .apphuh5mr5g2193, [class*="apphuh5mr5g2193"]'
				);
				let usedContainerHtml = false;
				if (articleContainer) {
					// Quick check: if container has images not in Defuddle's content, use it
					const containerImgs = articleContainer.querySelectorAll('img[src], img[data-src]').length;
					const contentImgCount = (defuddled.content.match(/<img[^>]*>/gi) || []).length;
					if (containerImgs > contentImgCount) {
						// Clone the container to avoid modifying the live page
						const containerClone = document.createElement('div');
						containerClone.innerHTML = articleContainer.innerHTML;
						// Remove non-content elements
						containerClone.querySelectorAll('script, style, noscript, iframe, object, embed').forEach(el => el.remove());
						containerClone.querySelectorAll('*').forEach(el => el.removeAttribute('style'));
						// Make relative URLs absolute
						containerClone.querySelectorAll('[src], [href], [data-src], [data-srcset]').forEach(el => {
							['src', 'href', 'srcset', 'data-src', 'data-srcset'].forEach(attr => {
								const val = el.getAttribute(attr);
								if (!val) return;
								if (attr === 'srcset' || attr === 'data-srcset') {
									const newSrcset = val.split(',').map(s => {
										const [url, size] = s.trim().split(' ');
										try { return `${new URL(url, document.baseURI).href}${size ? ' ' + size : ''}`; }
										catch { return s; }
									}).join(', ');
									el.setAttribute(attr, newSrcset);
								} else if (!val.startsWith('http') && !val.startsWith('data:') && !val.startsWith('#') && !val.startsWith('//')) {
									try { el.setAttribute(attr, new URL(val, document.baseURI).href); }
									catch { }
								}
							});
						});
						defuddled.content = containerClone.innerHTML;
						usedContainerHtml = true;
						console.log('[Obsidian Clipper] Using article container HTML (found', containerImgs, 'images)');
					}
				}

				// Fallback: if no article container was used, supplement missing images
				// by scanning the page and inserting missing ones at the end.
				if (!usedContainerHtml && defuddled.content) {
					const fallbackDoc = new DOMParser().parseFromString(defuddled.content, 'text/html');
					const existingSrcs = new Set<string>();
					fallbackDoc.querySelectorAll('img[src]').forEach(img => {
						const s = img.getAttribute('src');
						if (s) existingSrcs.add(s);
					});
					const missingHtml: string[] = [];
					document.querySelectorAll('img').forEach(img => {
						const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
						const alt = img.getAttribute('alt') || '';
						if (!src || src.startsWith('data:') || existingSrcs.has(src)) return;
						try {
							const rect = (img as HTMLElement).getBoundingClientRect();
							if (rect) {
								const w = rect.width;
								const h = rect.height;
								if ((w > 0 && w < 33) || (h > 0 && h < 33)) return;
							}
						} catch (e) {}
						missingHtml.push(`<p><img src="${src.replace(/"/g, '&quot;')}"${alt ? ` alt="${alt}"` : ''}></p>`);
					});
					if (missingHtml.length > 0) {
						defuddled.content += missingHtml.join('');
						console.log('[Obsidian Clipper] Fallback: appended', missingHtml.length, 'missing images');
					}
				}

				// Create a new DOMParser
				const parser = new DOMParser();
				// Parse the document's HTML
				const doc = parser.parseFromString(document.documentElement.outerHTML, 'text/html');

				// Remove all script and style elements
				doc.querySelectorAll('script, style').forEach(el => el.remove());

				// Remove style attributes from all elements
				doc.querySelectorAll('*').forEach(el => el.removeAttribute('style'));

				// Convert all relative URLs to absolute
				doc.querySelectorAll('[src], [href], [data-src], [data-srcset]').forEach(element => {
					['src', 'href', 'srcset', 'data-src', 'data-srcset'].forEach(attr => {
						const value = element.getAttribute(attr);
						if (!value) return;

						if (attr === 'srcset' || attr === 'data-srcset') {
							const newSrcset = value.split(',').map(src => {
								const [url, size] = src.trim().split(' ');
								try {
									const absoluteUrl = new URL(url, document.baseURI).href;
									return `${absoluteUrl}${size ? ' ' + size : ''}`;
								} catch (e) {
									return src;
								}
							}).join(', ');
							element.setAttribute(attr, newSrcset);
						} else if (!value.startsWith('http') && !value.startsWith('data:') && !value.startsWith('#') && !value.startsWith('//')) {
							try {
								const absoluteUrl = new URL(value, document.baseURI).href;
								element.setAttribute(attr, absoluteUrl);
							} catch (e) {
								console.warn(`Failed to process ${attr} URL:`, value);
							}
						}
					});
				});

				// Get the modified HTML without scripts, styles, and style attributes
				const cleanedHtml = doc.documentElement.outerHTML;

				const response: ContentResponse = {
					author: defuddled.author,
					content: defuddled.content,
					description: defuddled.description,
					domain: getDomain(document.URL),
					extractedContent: extractedContent,
					favicon: defuddled.favicon,
					fullHtml: cleanedHtml,
					highlights: highlighter.getHighlights(),
					image: defuddled.image,
					language: defuddled.language || '',
					parseTime: defuddled.parseTime,
					published: defuddled.published,
					schemaOrgData: defuddled.schemaOrgData,
					selectedHtml: selectedHtml,
					site: defuddled.site,
					title: defuddled.title,
					wordCount: defuddled.wordCount,
					metaTags: defuddled.metaTags || []
				};
				if (defuddled.title) {
					highlighter.setPageTitle(defuddled.title);
				}
				highlighter.updatePageDomainSettings({ site: defuddled.site, favicon: defuddled.favicon });
				sendResponse(response);
			}).catch((error: unknown) => {
				console.error('[Obsidian Clipper] getPageContent error:', error);
				sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
			});
			return true;
		} else if (request.action === "extractContent") {
			const content = extractContentBySelector(request.selector, request.attribute, request.extractHtml);
			sendResponse({ content: content });
		} else if (request.action === "paintHighlights") {
			ensureHighlighterCSS().then(() => highlighter.loadHighlights()).then(() => {
				if (generalSettings.alwaysShowHighlights) {
					highlighter.applyHighlights();
				}
				sendResponse({ success: true });
			});
			return true;
		} else if (request.action === "setHighlighterMode") {
			isHighlighterMode = request.isActive;
			ensureHighlighterCSS();
			highlighter.toggleHighlighterMenu(isHighlighterMode);
			updateHasHighlights();
			sendResponse({ success: true });
			return true;
		} else if (request.action === "getHighlighterMode") {
			browser.runtime.sendMessage({ action: "getHighlighterMode" }).then(sendResponse);
			return true;
		} else if (request.action === "toggleHighlighter") {
			ensureHighlighterCSS();
			highlighter.toggleHighlighterMenu(request.isActive);
			updateHasHighlights();
			sendResponse({ success: true });
		} else if (request.action === "highlightSelection") {
			ensureHighlighterCSS();
			highlighter.toggleHighlighterMenu(request.isActive);
			const selection = window.getSelection();
			if (selection && !selection.isCollapsed) {
				highlighter.handleTextSelection(selection);
			}
			updateHasHighlights();
			sendResponse({ success: true });
		} else if (request.action === "highlightElement") {
			ensureHighlighterCSS();
			highlighter.toggleHighlighterMenu(request.isActive);
			if (request.targetElementInfo) {
				const { mediaType, srcUrl, pageUrl } = request.targetElementInfo;
				
				let elementToHighlight: Element | null = null;

				// Function to compare URLs, handling both absolute and relative paths
				const urlMatches = (elementSrc: string, targetSrc: string) => {
					const elementUrl = new URL(elementSrc, pageUrl);
					const targetUrl = new URL(targetSrc, pageUrl);
					return elementUrl.href === targetUrl.href;
				};

				// Try to find the element using the src attribute
				elementToHighlight = document.querySelector(`${mediaType}[src="${srcUrl}"]`);

				// If not found, try with relative URL
				if (!elementToHighlight) {
					const relativeSrc = new URL(srcUrl).pathname;
					elementToHighlight = document.querySelector(`${mediaType}[src="${relativeSrc}"]`);
				}

				// If still not found, iterate through all elements of the media type
				if (!elementToHighlight) {
					const elements = Array.from(document.getElementsByTagName(mediaType));
					for (const el of elements) {
						if (el instanceof HTMLImageElement || el instanceof HTMLVideoElement || el instanceof HTMLAudioElement) {
							if (urlMatches(el.src, srcUrl)) {
								elementToHighlight = el;
								break;
							}
						}
					}
				}

				if (elementToHighlight) {
					highlighter.highlightElement(elementToHighlight);
				} else {
					console.warn('Could not find element to highlight. Info:', request.targetElementInfo);
				}
			}
			updateHasHighlights();
			sendResponse({ success: true });
		} else if (request.action === "clearHighlights") {
			highlighter.clearHighlights();
			updateHasHighlights();
			sendResponse({ success: true });
		} else if (request.action === "getHighlighterState") {
			browser.runtime.sendMessage({ action: "getHighlighterMode" })
				.then(response => {
					sendResponse(response);
				})
				.catch(error => {
					console.error("Error getting highlighter mode:", error);
					sendResponse({ isActive: false });
				});
			return true;
		} else if (request.action === "getReaderModeState") {
			sendResponse({ isActive: document.documentElement.classList.contains('obsidian-reader-active') });
			return true;
		}
		return true;
	});

	function extractContentBySelector(selector: string, attribute?: string, extractHtml: boolean = false): string | string[] {
		return extractContentBySelectorShared(document, selector, attribute, extractHtml);
	}

	function updateHasHighlights() {
		const hasHighlights = highlighter.getHighlights().length > 0;
		browser.runtime.sendMessage({ action: "updateHasHighlights", hasHighlights });
	}

	let highlighterCSSPromise: Promise<void> | null = null;
	function ensureHighlighterCSS(): Promise<void> {
		if (!highlighterCSSPromise) {
			highlighterCSSPromise = new Promise<void>((resolve) => {
				const link = document.createElement('link');
				link.rel = 'stylesheet';
				link.href = browser.runtime.getURL('highlighter.css');
				link.onload = () => resolve();
				link.onerror = () => resolve();
				(document.head || document.documentElement).appendChild(link);
			});
		}
		return highlighterCSSPromise;
	}

	async function initializeHighlighter() {
		await loadSettings();

		if (generalSettings.alwaysShowHighlights) {
			const result = await browser.storage.local.get('highlights');
			const allHighlights = (result.highlights || {}) as Record<string, unknown>;
			if (allHighlights[window.location.href]) {
				await ensureHighlighterCSS();
			}
		}

		await highlighter.loadHighlights();
		highlighter.setPageTitle(document.title);
		updateHasHighlights();
	}

	// Initialize highlighter
	initializeHighlighter();

	// Expose highlighter API on window so reader-script.js (a separate
	// webpack bundle injected when reader mode activates) can delegate
	// all state operations to this single module instance. Without this,
	// both bundles own a copy of highlighter.ts with independent mutable
	// state — the bridge ensures one source of truth per tab.
	window.__obsidianHighlighter = {
		toggleHighlighterMenu: highlighter.toggleHighlighterMenu,
		handleTextSelection: highlighter.handleTextSelection,
		highlightElement: highlighter.highlightElement,
		applyHighlights: highlighter.applyHighlights,
		loadHighlights: highlighter.loadHighlights,
		invalidateHighlightCache: highlighter.invalidateHighlightCache,
		repositionHighlights: highlighter.repositionHighlights,
		getHighlights: highlighter.getHighlights,
		setPageUrl: highlighter.setPageUrl,
		setPageTitle: highlighter.setPageTitle,
		updatePageDomainSettings: highlighter.updatePageDomainSettings,
		clearHighlights: highlighter.clearHighlights,
		saveHighlights: highlighter.saveHighlights,
		updateHighlighterMenu: highlighter.updateHighlighterMenu,
		removeExistingHighlights,
		ensureHighlighterCSS: () => { ensureHighlighterCSS(); },
	} satisfies highlighter.HighlighterAPI;

	// Call updateHasHighlights when the page loads
	window.addEventListener('load', updateHasHighlights);

	// Deactivate highlighter mode on unload
	function handlePageUnload() {
		if (isHighlighterMode) {
			highlighter.toggleHighlighterMenu(false);
			browser.runtime.sendMessage({ action: "highlighterModeChanged", isActive: false });
			browser.storage.local.set({ isHighlighterMode: false });
		}
	}

	window.addEventListener('beforeunload', handlePageUnload);

	// Listen for custom events from the reader script
	document.addEventListener('obsidian-reader-init', async () => {
		// Find the highlighter button
		const button = document.querySelector('[data-action="toggle-highlighter"]');
		if (button) {
			// Handle highlighter button clicks
			button.addEventListener('click', async (e) => {
				try {
					// First try to get the tab ID from the background script
					const response = await browser.runtime.sendMessage({ action: "ensureContentScriptLoaded" });
					
					let tabId: number | undefined;
					if (response && typeof response === 'object') {
						tabId = (response as { tabId: number }).tabId;
					}

					// If we didn't get a tab ID, try to get it from the background script
					if (!tabId) {
						try {
							const response = await browser.runtime.sendMessage({ action: "getActiveTab" }) as { tabId?: number; error?: string };
							if (response && !response.error && response.tabId) {
								tabId = response.tabId;
							}
						} catch (error) {
							console.error('[Content] Failed to get tab ID from background script:', error);
						}
					}

					if (tabId) {
						await browser.runtime.sendMessage({ action: "toggleHighlighterMode", tabId });
					} else {
						console.error('[Content]','Could not determine tab ID');
					}
				} catch (error) {
					console.error('[Content]','Error in toggle flow:', error);
				}
			});
		}
	});

})();
