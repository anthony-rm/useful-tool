// ==UserScript==
// @name         Winamax Tennis & Volleyball Tools
// @namespace    http://tampermonkey.net/
// @version      9.10
// @description  Extracts betting odds from Winamax match pages. Features per-section "Extract" buttons and a global "Extract all odds" button. Clipboard copy, dark/light theme support.
// @match        https://www.winamax.fr/*
// @updateURL    https://raw.githubusercontent.com/anthony-rm/useful-tool/main/script.js
// @downloadURL  https://raw.githubusercontent.com/anthony-rm/useful-tool/main/script.js
// @grant        GM_setClipboard
// ==/UserScript==

(function() {
    'use strict';

    // --- Shared helpers -------------------------------------------------
    function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

// Cross-browser clipboard copy (compatible with Safari iOS, Safari Userscripts, Tampermonkey, etc.)
async function copyToClipboard(text) {
    // Method 1: Standard Web API
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch (err) {
        console.log('Web Clipboard API failed, trying fallbacks...');
    }

    // Method 2: GM_setClipboard
    try {
        if (typeof GM_setClipboard !== 'undefined') {
            GM_setClipboard(text, 'text');
            return true;
        }
    } catch (gmErr) {
        console.log('GM_setClipboard failed, trying textarea method...');
    }

    // Method 3: Textarea method (for iOS Safari)
    try {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed'; // Avoid scrolling to bottom
        document.body.appendChild(textarea);
        textarea.select();
        
        // iOS requires this range selection
        const range = document.createRange();
        range.selectNodeContents(textarea);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        textarea.setSelectionRange(0, 999999); // For mobile devices
        
        const successful = document.execCommand('copy');
        document.body.removeChild(textarea);
        
        if (successful) return true;
    } catch (err) {
        console.error('Textarea copy method failed:', err);
    }

    return false;
}

    // Evaluate XPath and return array of nodes
    function xpathNodes(xpath, context = document) {
        const result = document.evaluate(xpath, context, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        const nodes = [];
        for (let i = 0; i < result.snapshotLength; i++) nodes.push(result.snapshotItem(i));
        return nodes;
    }

    function waitForXPath(xpath, timeout = 3000, context = document) {
        return new Promise((resolve, reject) => {
            const existing = document.evaluate(xpath, context, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            if (existing) return resolve(existing);
            const observer = new MutationObserver(() => {
                const el = document.evaluate(xpath, context, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                if (el) { observer.disconnect(); resolve(el); }
            });
            observer.observe(context === document ? document.body : context, { childList: true, subtree: true });
            setTimeout(() => { observer.disconnect(); reject(new Error(`Timeout XPath: ${xpath}`)); }, timeout);
        });
    }

    // --- Page detection -------------------------------------------------
    const MATCH_PAGE_PREFIX = 'https://www.winamax.fr/paris-sportifs/match/';
    const SPORTS_PAGE_URL = 'https://www.winamax.fr/paris-sportifs/sports/5';

    function getPageMode() {
        const url = window.location.href;
        if (url.startsWith(MATCH_PAGE_PREFIX)) return 'match';
        if (url === SPORTS_PAGE_URL || url === SPORTS_PAGE_URL + '/') return 'sports';
        return null;
    }

    // --- UI state -------------------------------------------------------
    let uiContainer = null;
    let progressDiv = null;
    let actionBtn = null;      // primary button (Extract)
    let progressTimeout = null;
    let currentMode = null;
    let lastExtractedData = '';   // for match mode
    let extractedMatches = [];     // for sports mode
    let sportsScanLimit = true;        // for sports mode (true = stop at night gap)
    let sportsLimitSelectorDiv = null; // sports range toggle UI
    let sportsLimitBtns = [];          // store sports limit button references

    // Per-section extract button state
    let processedSectionHeadings = null;
    let sectionInjectObserver = null;

    // --- Theming --------------------------------------------------------
    function updateProgressTheme() {
        if (!progressDiv) return;
        const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        progressDiv.style.background = isDark ? 'rgba(20, 20, 30, 0.92)' : 'rgba(245, 245, 255, 0.92)';
        progressDiv.style.color = isDark ? '#f0f0f0' : '#1a1a2e';
        progressDiv.style.border = isDark ? '1px solid rgba(255,255,255,0.15)' : '1px solid rgba(0,0,0,0.1)';
    }

    function showProgress(text, isError = false) {
        if (!progressDiv) return;
        if (progressTimeout) clearTimeout(progressTimeout);
        progressDiv.style.display = 'block';
        progressDiv.textContent = text;
        progressDiv.style.background = isError
            ? 'rgba(220, 53, 69, 0.95)'
            : (window.matchMedia('(prefers-color-scheme: dark)').matches
                ? 'rgba(20, 20, 30, 0.92)'
                : 'rgba(245, 245, 255, 0.92)');
        progressTimeout = setTimeout(() => {
            if (progressDiv && progressDiv.style.display === 'block') progressDiv.style.display = 'none';
        }, 3000);
    }

    // --- Per-section extract button injection ----------------------------

    // Find all section headings and inject a blue "Extract" button next to each
    function injectSectionExtractButtons() {
        if (!processedSectionHeadings) {
            processedSectionHeadings = new WeakSet();
        }

            // Generic approach: find ALL section heading divs inside the odds list area.
        // We match the pattern used by Winamax: a div with class "sc-MyySi" that
        // contains the section title AND is inside a virtualized list container.
        // As a fallback, we also look for any div with data-original-title
        // (Winamax stores tooltip titles there), or any div inside the heading
        // area that contains text and sits above an odds section.

        // Strategy 1: Match heading divs with the known Winamax class "sc-MyySi"
        //            that also have data-original-title (tooltip).
        // Strategy 2: Match divs with data-original-title anywhere in the odds area.
        // Strategy 3: Match the inner text div (class "caruXb") inside sc-MyySi.

        const headingSelectors = [
            // Primary: divs with data-original-title inside the odds list section
            ".//div[@data-original-title]",
            // Fallback: the classic heading containers with known "caruXb" class
            ".//div[contains(@class, 'caruXb')]",
        ];

        // Use the middleColumn or the virtualized grid as the context for searching
        const context = document.evaluate(
            "//*[@data-testid='middleColumn'] | //*[contains(@class, 'ReactVirtualized__Grid')]",
            document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
        ).singleNodeValue || document;

        let allHeadings = new Set();

        for (const sel of headingSelectors) {
            const nodes = xpathNodes(sel, context);
            for (const h of nodes) {
                // Skip empty or very short text
                const text = (h.getAttribute('data-original-title') || h.textContent).trim();
                if (!text || text.length < 2) continue;

                // Skip if this is actually the "Extract" button itself or contains one
                if (h.dataset.sectionExtract === 'true') continue;
                if (h.querySelector('[data-section-extract="true"]')) continue;

                // Skip if child of a heading we already captured (avoid duplicates)
                let isDuplicate = false;
                for (const existing of allHeadings) {
                    if (existing === h || existing.contains(h) || h.contains(existing)) {
                        // Prefer the one with data-original-title, or the outer one
                        if (existing.getAttribute('data-original-title') && !h.getAttribute('data-original-title')) {
                            isDuplicate = true;
                            break;
                        }
                        if (h.contains(existing) && !existing.getAttribute('data-original-title')) {
                            // h is outer, existing is inner without tooltip — replace with h
                            allHeadings.delete(existing);
                            allHeadings.add(h);
                            isDuplicate = true;
                            break;
                        }
                        if (existing.contains(h)) {
                            isDuplicate = true;
                            break;
                        }
                    }
                }
                if (!isDuplicate) allHeadings.add(h);
            }
        }

        // Deduplicate: if both a parent div and its child div are captured,
        // keep the one that has data-original-title, or the outermost one
        const finalHeadings = [];
        for (const h of allHeadings) {
            let dominated = false;
            for (const other of allHeadings) {
                if (other === h) continue;
                if (other.contains(h) && other.getAttribute('data-original-title')) {
                    dominated = true;
                    break;
                }
            }
            if (!dominated) finalHeadings.push(h);
        }

        for (const h of finalHeadings) {
            // Skip if we already added a button to this heading
            if (processedSectionHeadings.has(h)) continue;

            // Verify this heading actually has odds in its parent section container
            let hasOdds = false;
            let node = h.parentNode;
            while (node && node !== document.body) {
                const oddsCheck = document.evaluate(
                    ".//div[starts-with(@data-testid, 'odd-button-')]",
                    node, null, XPathResult.BOOLEAN_TYPE, null
                ).booleanValue;
                if (oddsCheck) { hasOdds = true; break; }
                node = node.parentNode;
            }
            if (!hasOdds) continue;

            // Mark as processed
            processedSectionHeadings.add(h);

            // Store original title text before adding the button (so extractSectionData
            // doesn't accidentally pick up the button's textContent e.g. "⏳")
            // Prefer the data-original-title attribute if it exists (Winamax tooltip),
            // otherwise fall back to textContent trimmed of the "Extract" button text.
            const attrTitle = h.getAttribute('data-original-title');
            h.dataset.originalTitle = (attrTitle && attrTitle.trim()) || h.textContent.trim();

            // Create the extract button (compact, blue gradient like the main button)
            const btn = document.createElement('button');
            btn.textContent = 'Extract';
            btn.dataset.sectionExtract = 'true';
            btn.style.cssText = `
                background: linear-gradient(135deg, #1e6df2, #0a4bc2);
                border: none;
                color: white;
                font-size: 10px;
                font-weight: 700;
                padding: 2px 10px;
                border-radius: 12px;
                cursor: pointer;
                font-family: inherit;
                letter-spacing: 0.3px;
                transition: all 0.2s ease;
                white-space: nowrap;
                flex-shrink: 0;
                margin-left: 8px;
                line-height: normal;
            `;

            btn.addEventListener('mouseenter', () => {
                btn.style.transform = 'scale(1.08)';
                btn.style.boxShadow = '0 2px 8px rgba(0,0,0,0.3)';
            });
            btn.addEventListener('mouseleave', () => {
                btn.style.transform = 'scale(1)';
                btn.style.boxShadow = 'none';
            });

            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (btn.disabled) return;
                btn.disabled = true;
                const originalText = btn.textContent;
                btn.textContent = '⏳';
                btn.style.opacity = '0.7';
                btn.style.cursor = 'wait';

                try {
                    const data = await extractSectionData(h);
                    if (data && data.odds.length > 0) {
                        const output = data.title + '\n' + data.odds.join('\n');
                        await copyToClipboard(output);
                        showProgress(`✅ ${data.odds.length} odds from "${data.title}" copied!`);
                    } else {
                        showProgress('⚠️ No odds found in section', true);
                    }
                } catch (err) {
                    console.error(err);
                    showProgress('❌ Error extracting section', true);
                }

                btn.disabled = false;
                btn.textContent = originalText;
                btn.style.opacity = '1';
                btn.style.cursor = 'pointer';
            });

            // Make the heading a flex container so the button sits inline
            const computedDisplay = window.getComputedStyle(h).display;
            if (computedDisplay !== 'flex' && computedDisplay !== 'inline-flex') {
                h.style.display = 'flex';
                h.style.alignItems = 'center';
            }
            // Ensure the heading can accommodate the button without overflow
            h.style.flexWrap = 'wrap';

            h.appendChild(btn);
        }
    }

    function setupSectionInjectObserver() {
        if (sectionInjectObserver) {
            sectionInjectObserver.disconnect();
        }

        // Throttled observer: re-inject buttons when DOM changes
        let injectTimeout = null;
        sectionInjectObserver = new MutationObserver(() => {
            if (injectTimeout) return;
            injectTimeout = setTimeout(() => {
                injectTimeout = null;
                injectSectionExtractButtons();
            }, 200);
        });

        sectionInjectObserver.observe(document.body, {
            childList: true,
            subtree: true
        });
    }

    function teardownSectionInjector() {
        if (sectionInjectObserver) {
            sectionInjectObserver.disconnect();
            sectionInjectObserver = null;
        }
        processedSectionHeadings = null;

        // Remove all injected buttons from the DOM
        const existingBtns = document.querySelectorAll('[data-section-extract="true"]');
        for (const btn of existingBtns) {
            const parent = btn.parentNode;
            if (parent) {
                btn.remove();
                // Restore the parent display if we changed it
                if (parent.style && parent.style.display === 'flex') {
                    parent.style.display = '';
                    parent.style.alignItems = '';
                    parent.style.flexWrap = '';
                }
            }
        }
    }

    // --- Match page extraction (ALL odds from ALL sections) -------------
    function findScrollableContainer() {
        const grid = document.evaluate("//*[contains(concat(' ', normalize-space(@class), ' '), ' ReactVirtualized__Grid ')]", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        if (!grid) return window;
        let el = grid.parentElement;
        while (el && el !== document.body) {
            const style = getComputedStyle(el);
            if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) return el;
            el = el.parentElement;
        }
        return window;
    }

    // Expand a section: click the grid/list toggle if needed, then expand "Plus de sélections"
    async function expandSection(sectionContainer) {
        // Count current odds to know if we need to toggle view
        const currentOdds = xpathNodes(".//div[starts-with(@data-testid, 'odd-button-')]", sectionContainer);
        
        // If <= 2 odds, the section is in compact grid view.
        // Click the toggle (dcSvAA div with the 4-rect icon) to switch to list view.
        if (currentOdds.length <= 2) {
            // Find the tabs-wrapper and click the toggle with class containing "dcSvAA"
            const tabsWrapper = document.evaluate(".//*[contains(@class, 'tabs-wrapper')]", sectionContainer, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            if (tabsWrapper) {
                const toggleDiv = document.evaluate(".//*[contains(@class, 'dcSvAA')]", tabsWrapper, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                if (toggleDiv && toggleDiv.click) {
                    toggleDiv.click();
                    await sleep(500);
                }
            } else {
                // Fallback: same as tennis - find SVG with rects
                const possibleToggles = xpathNodes(".//*[local-name()='svg' and .//*[local-name()='rect']]/parent::*", sectionContainer);
                for (let toggle of possibleToggles) {
                    if (toggle.click && toggle.innerText === '') {
                        toggle.click();
                        await sleep(500);
                        break;
                    }
                }
            }
        }
        
        // Expand "Plus de sélections" once (only need to click it once)
        const expandBtn = document.evaluate(
            ".//div[contains(text(),'Plus de sélections')]/ancestor::div[contains(@class, 'expand-button') or contains(@class, 'expand')] | .//div[contains(text(),'Plus de sélections')]/..",
            sectionContainer, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
        ).singleNodeValue;
        if (expandBtn && expandBtn.textContent.trim().includes("Plus de sélections")) {
            expandBtn.click();
            await sleep(500);
        }
    }

    // Extract odds from a section: expand it, then extract, return {title, odds[]} or null
    async function extractSectionData(headingEl) {
        const title = headingEl.dataset.originalTitle || headingEl.textContent.trim();
        if (!title || title.length < 2) return null;

        // Navigate up to find section container (the node that contains odds)
        let sectionContainer = null;
        let node = headingEl.parentNode;
        while (node && node !== document.body) {
            const hasOdds = document.evaluate(".//div[starts-with(@data-testid, 'odd-button-')]", node, null, XPathResult.BOOLEAN_TYPE, null).booleanValue;
            if (hasOdds) { sectionContainer = node; break; }
            node = node.parentNode;
        }
        if (!sectionContainer) return null;

        // Expand the section
        await expandSection(sectionContainer);

        // Extract odds from this section
        const oddsButtons = xpathNodes(".//div[starts-with(@data-testid, 'odd-button-')]", sectionContainer);
        if (oddsButtons.length === 0) return null;

        // Collect raw odds as structured objects first
        const rawOdds = [];
        for (const btn of oddsButtons) {
            const valueSpan = document.evaluate(".//span[contains(@class, 'odd-button-value')]", btn, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            if (!valueSpan) continue;
            let oddValue = valueSpan.textContent.trim();
            const valueContainer = valueSpan.parentElement;
            
            let name = '';
            // Strategy 1: Sibling of valueSpan's parent inside the button wrapper
            const nameDiv = valueContainer ? valueContainer.previousElementSibling : null;
            if (nameDiv) {
                name = nameDiv.textContent.trim();
            }

            // Strategy 2: Look for common title/name div classes inside the button itself
            if (!name) {
                const possibleNameDiv = document.evaluate(
                    ".//*[contains(@class, 'fZKtql') or contains(@class, 'odd-button-name') or contains(@class, 'outcome-name')]",
                    btn, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
                ).singleNodeValue;
                if (possibleNameDiv) name = possibleNameDiv.textContent.trim();
            }

            // Strategy 3: Sibling/Parent row container lookup (for outcomes with labels and odds separated)
            // IMPORTANT: Only use 'label-text' class - broader selectors like 'bet-group-outcome-title'
            // would match container elements that also contain percentage distribution text (e.g. "21%"),
            // causing the percentage to be concatenated with the label (e.g. "B. Krejcikova et moins de 21,521%").
            if (!name) {
                let current = btn.parentNode;
                for (let depth = 0; depth < 5 && current && current !== sectionContainer; depth++) {
                    const labelNode = document.evaluate(
                        ".//*[contains(@class, 'label-text')]",
                        current, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
                    ).singleNodeValue;
                    if (labelNode) {
                        name = labelNode.textContent.trim();
                        break;
                    }
                    current = current.parentNode;
                }
            }

            // Strategy 4: Ultimate text-walking fallback inside row wrapper
            if (!name) {
                const rowWrapper = btn.closest("[class*='krYRTo']") || btn.parentNode?.parentNode;
                if (rowWrapper) {
                    const textNodes = [];
                    const walker = document.createTreeWalker(rowWrapper, NodeFilter.SHOW_TEXT);
                    while (walker.nextNode()) {
                        const val = walker.currentNode.textContent.trim();
                        // Ignore current odd values or percentage distributions
                        if (val && val !== oddValue && val !== oddValue.replace('.', ',') && !val.endsWith('%')) {
                            textNodes.push(val);
                        }
                    }
                    if (textNodes.length > 0) {
                        name = textNodes[0];
                    }
                }
            }

            if (name && oddValue) {
                rawOdds.push({ name, value: oddValue.replace(',', '.') });
            }
        }

        if (rawOdds.length === 0) return null;

        // Detect if odds are spread-type (Player Name +N.N or -N.N) and group by player
        const spreadRegex = /^(.+?)\s+([+-]\d+(?:[.,]\d+)?)$/;
        let spreadCount = 0;
        const byPlayer = {};
        for (const o of rawOdds) {
            const match = o.name.match(spreadRegex);
            if (match) {
                spreadCount++;
                const playerName = match[1].trim();
                const handicap = match[2];
                if (!byPlayer[playerName]) byPlayer[playerName] = [];
                byPlayer[playerName].push({
                    sortKey: parseFloat(handicap.replace(',', '.')),
                    text: `${o.name} : ${o.value}`
                });
            }
        }

        // Build final odds array
        const sectionOdds = [];

        // "Nombre de jeux" sections: group by Over/Under sorted by odd value ascending
        if (title.includes('Nombre de jeux')) {
            const overOdds = rawOdds.filter(o => o.name.includes('Plus de'));
            const underOdds = rawOdds.filter(o => o.name.includes('Moins de'));
            const sortByValue = (a, b) => parseFloat(a.value) - parseFloat(b.value);
            overOdds.sort(sortByValue);
            underOdds.sort(sortByValue);

            for (const o of overOdds) {
                const threshold = o.name.replace('Plus de ', '');
                sectionOdds.push(`Over ${threshold} jeux : ${o.value}`);
            }
            for (const o of underOdds) {
                const threshold = o.name.replace('Moins de ', '');
                sectionOdds.push(`Under ${threshold} jeux : ${o.value}`);
            }
        } else if (spreadCount > rawOdds.length / 2) {
            // Spread-type section: group by player, sorted by handicap
            const sortedPlayers = Object.keys(byPlayer).sort();
            for (const player of sortedPlayers) {
                byPlayer[player].sort((a, b) => a.sortKey - b.sortKey);
                for (const odd of byPlayer[player]) {
                    sectionOdds.push(odd.text);
                }
            }
        } else {
            // Non-spread section: keep original order
            for (const o of rawOdds) {
                sectionOdds.push(`${o.name} : ${o.value}`);
            }
        }

        if (sectionOdds.length === 0) return null;
        return { title, odds: sectionOdds };
    }

    async function extractAllOddsFromMatchVb() {
        try {
            showProgress('🔍 Expanding sections while scrolling...');
            
            // Find the scrollable container
            const scrollable = findScrollableContainer();

            // Process sections incrementally while scrolling down
            const allResults = [];
            const processedHeadings = new WeakSet();  // Track actual DOM elements, not position-based keys
            const headingKeywords = [
                'Vainqueur', 'Score exact', 'Nombre de points', 'Écart de points',
                'Nombre de sets', 'Écart de sets', 'Nombre exact de sets',
                'Y aura-t-il', 'remporte au moins', 'Nombre de points de'
            ];

            let prevScrollTop = -1;
            let noNewSectionsCount = 0;
            const MAX_NO_NEW = 15;

            // Start from top
            if (scrollable === window) {
                window.scrollTo(0, 0);
            } else {
                scrollable.scrollTop = 0;
            }
            await sleep(300);

            while (noNewSectionsCount < MAX_NO_NEW) {
                // Find all currently visible sections with headings
                let foundNew = false;
                for (const kw of headingKeywords) {
                    const headings = xpathNodes(`//div[contains(text(),'${kw}')]`);
                    for (const h of headings) {
                        const rect = h.getBoundingClientRect();
                        const isVisible = rect.top < (window.innerHeight + 200) && rect.bottom > -200;
                        if (!isVisible) continue;

                        // Deduplicate by tracking the actual DOM element using WeakSet
                        if (processedHeadings.has(h)) continue;
                        processedHeadings.add(h);

                        const data = await extractSectionData(h);
                        if (data) {
                            allResults.push(data.title);
                            allResults.push(...data.odds);
                            allResults.push('');
                            foundNew = true;
                        }
                    }
                }

                if (foundNew) {
                    noNewSectionsCount = 0;
                } else {
                    noNewSectionsCount++;
                }

                // Scroll down
                const oldScrollTop = (scrollable === window) ? window.scrollY : scrollable.scrollTop;
                if (scrollable === window) {
                    window.scrollBy(0, 500);
                } else {
                    scrollable.scrollBy({ top: 500, behavior: 'auto' });
                }
                await sleep(250);
                const newScrollTop = (scrollable === window) ? window.scrollY : scrollable.scrollTop;
                if (newScrollTop === oldScrollTop && prevScrollTop === newScrollTop) break;
                prevScrollTop = oldScrollTop;

                if (scrollable === window) {
                    if (window.innerHeight + window.scrollY >= document.body.scrollHeight - 100) break;
                } else {
                    if (scrollable.scrollTop + scrollable.clientHeight >= scrollable.scrollHeight - 100) break;
                }
            }

            // Remove trailing blank line
            while (allResults.length > 0 && allResults[allResults.length - 1] === '') {
                allResults.pop();
            }

            if (allResults.length === 0) throw new Error("No odds extracted from any section");

            const output = allResults.join('\n');
            lastExtractedData = output;
            await copyToClipboard(output);
            const oddCount = output.split('\n').filter(line => line.includes(':')).length;
            const sectionCount = output.split('\n').filter(line => line !== '' && !line.includes(':')).length;
            showProgress(`✅ ${oddCount} odds from ${sectionCount} sections copied!`);
        } catch (err) {
            console.error(err);
            showProgress(`❌ Error: ${err.message}`, true);
        }
    }

    // --- Sports page extraction (upcoming singles matches) --------------
    const dayIndicators = ['demain', 'sam', 'dim', 'lun', 'mar', 'mer', 'jeu', 'ven'];
    function isDayIndicator(text) {
        const lower = text.toLowerCase();
        return dayIndicators.some(ind => lower === ind || lower.startsWith(ind + '.'));
    }

    function looksLikePlayerName(text) {
        if (!text || text.length < 2) return false;
        if (/^\d+(?:[.,]\d+)?$/.test(text)) return false;
        if (isDayIndicator(text)) return false;
        return /[A-ZÀ-ÖØ-öø-ÿ]/.test(text) || /^[a-zA-ZÀ-ÖØ-öø-ÿ\s.-]{2,}$/.test(text);
    }

    function extractMatchInfo(card) {
        const texts = [];
        const walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
            let text = walker.currentNode.textContent.trim();
            if (text.length > 0) texts.push(text);
        }

        let tournamentIdx = -1;
        for (let i = 0; i < texts.length; i++) {
            if (texts[i].includes('ATP') || texts[i].includes('WTA')) { tournamentIdx = i; break; }
        }
        if (tournamentIdx === -1) return null;

        let tournament = texts[tournamentIdx];
        tournament = tournament.replace(/\s+\d+(?:[.,]\d+)?$/, '').trim();

        let round = '';
        for (let i = tournamentIdx + 1; i < texts.length; i++) {
            const t = texts[i];
            if (!/^\d{1,2}:\d{2}$/.test(t) && !isDayIndicator(t) && t !== tournament && !t.includes('ATP') && !t.includes('WTA')) {
                round = t;
                break;
            }
        }

        if (tournament.toLowerCase().includes('double') || round.toLowerCase().includes('double')) return null;

        let timeIdx = -1;
        let dayIndicator = '';
        for (let i = 0; i < texts.length; i++) {
            const t = texts[i];
            if (/^\d{1,2}:\d{2}$/.test(t)) {
                timeIdx = i;
                if (i > 0 && isDayIndicator(texts[i-1])) dayIndicator = texts[i-1];
                break;
            }
        }
        if (timeIdx === -1) return null;

        const matchTime = texts[timeIdx];

        let player1 = '';
        for (let i = timeIdx - 1; i >= 0; i--) {
            const t = texts[i];
            if (isDayIndicator(t)) continue;
            if (looksLikePlayerName(t)) { player1 = t; break; }
        }

        let player2 = '';
        for (let i = timeIdx + 1; i < texts.length; i++) {
            const t = texts[i];
            if (looksLikePlayerName(t)) { player2 = t; break; }
        }

        if (!player1 || !player2 || player1 === player2) return null;

        return { tournament, round, player1, player2, matchTime, dayIndicator };
    }

    function extractCurrentMatches() {
        const matches = [];
        const cards = xpathNodes("//*[starts-with(@data-testid, 'match-card-')]");
        for (const card of cards) {
            try {
                const info = extractMatchInfo(card);
                if (info) matches.push(info);
            } catch (err) { console.warn(err); }
        }
        return matches;
    }

    function timeToMinutes(timeStr) {
        const parts = timeStr.split(':');
        return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
    }

    async function extractAllMatchesFromSports(onProgress) {
        const todayMatches = new Map();
        const allSeen = new Map();
        const scrollable = findScrollableContainer();
        const NIGHT_GAP_THRESHOLD = 360; // 6 hours in minutes
        let stoppedByNightGap = false;
        let lastRawMinutes = -1;
        let lastNormalized = -1;
        let dayOffset = 0;

        function shouldKeepMatch(m) {
            const raw = timeToMinutes(m.matchTime);
            let normalized = raw;

            if (lastRawMinutes === -1) {
                // First match — initialise
                lastRawMinutes = raw;
                lastNormalized = raw;
                return true;
            }

            // Handle midnight wrap: if clock goes backwards, add 24h
            if (raw < lastRawMinutes) {
                dayOffset += 1440;
            }
            normalized = raw + dayOffset;

            const gap = normalized - lastNormalized;
            if (gap > NIGHT_GAP_THRESHOLD && sportsScanLimit) {
                stoppedByNightGap = true;
                return false; // This match is the first of the next session
            }

            lastRawMinutes = raw;
            lastNormalized = normalized;
            return true;
        }

        // Process initial visible matches
        let initialMatches = extractCurrentMatches();
        for (let m of initialMatches) {
            const key = `${m.player1}|${m.player2}|${m.tournament}|${m.round}`;
            allSeen.set(key, m);
            if (stoppedByNightGap) continue;
            if (shouldKeepMatch(m)) {
                todayMatches.set(key, m);
            }
        }
        if (onProgress) onProgress(todayMatches.size);

        if (stoppedByNightGap) {
            return Array.from(todayMatches.values());
        }

        let noNewCount = 0;
        const MAX_NO_NEW = 8;
        const originalScrollTop = (scrollable === window) ? window.scrollY : scrollable.scrollTop;

        while (noNewCount < MAX_NO_NEW && !stoppedByNightGap) {
            let oldScrollTop = (scrollable === window) ? window.scrollY : scrollable.scrollTop;
            if (scrollable === window) window.scrollBy(0, 1000);
            else scrollable.scrollBy({ top: 1000, behavior: 'auto' });

            await sleep(100);

            let newScrollTop = (scrollable === window) ? window.scrollY : scrollable.scrollTop;
            if (newScrollTop === oldScrollTop) break;

            const newMatches = extractCurrentMatches();
            let added = 0;
            for (let m of newMatches) {
                const key = `${m.player1}|${m.player2}|${m.tournament}|${m.round}`;
                if (allSeen.has(key)) continue;
                allSeen.set(key, m);

                if (stoppedByNightGap) continue;

                if (shouldKeepMatch(m)) {
                    todayMatches.set(key, m);
                    added++;
                }
            }
            if (added === 0) noNewCount++;
            else noNewCount = 0;

            if (onProgress) onProgress(todayMatches.size);

            let atBottom = (scrollable === window) ?
                (window.innerHeight + window.scrollY >= document.body.scrollHeight - 100) :
                (scrollable.scrollTop + scrollable.clientHeight >= scrollable.scrollHeight - 100);
            if (atBottom) break;
        }

        if (scrollable === window) window.scrollTo(0, originalScrollTop);
        else scrollable.scrollTop = originalScrollTop;

        return Array.from(todayMatches.values());
    }

    function formatMatches(matches) {
        return matches.map(m => `${m.player1} vs ${m.player2} (${m.tournament} - ${m.round})`).join('\n');
    }

    async function handleSportsExtract() {
        if (!actionBtn || actionBtn.disabled) return;
        actionBtn.disabled = true;
        actionBtn.style.opacity = '0.7';
        actionBtn.style.cursor = 'wait';
        const originalText = actionBtn.textContent;
        actionBtn.textContent = '⏳ Scanning...';

        try {
            extractedMatches = await extractAllMatchesFromSports((count) => {
                showProgress(`📡 Scanning... ${count} match${count !== 1 ? 'es' : ''} found so far`);
            });

            if (!extractedMatches.length) {
                showProgress('⚠️ No upcoming tennis singles matches found', true);
                actionBtn.disabled = false;
                actionBtn.style.opacity = '1';
                actionBtn.style.cursor = 'pointer';
                actionBtn.textContent = originalText;
                return;
            }

            const formatted = formatMatches(extractedMatches);
            await copyToClipboard(formatted);

            showProgress(`✅ Found ${extractedMatches.length} match${extractedMatches.length > 1 ? 'es' : ''}. Copied to clipboard!`);
        } catch (err) {
            showProgress('❌ Error: ' + err.message, true);
            console.error(err);
        } finally {
            if (actionBtn) {
                actionBtn.disabled = false;
                actionBtn.style.opacity = '1';
                actionBtn.style.cursor = 'pointer';
                actionBtn.textContent = originalText;
            }
        }
    }

    // --- UI Creation / Destruction --------------------------------------
    function removeUI() {
        if (uiContainer && uiContainer.parentNode) uiContainer.parentNode.removeChild(uiContainer);
        uiContainer = null;
        progressDiv = null;
        actionBtn = null;
        if (progressTimeout) clearTimeout(progressTimeout);
        currentMode = null;
        lastExtractedData = '';
        extractedMatches = [];
        sportsLimitSelectorDiv = null;
        sportsLimitBtns = [];
        sportsScanLimit = true;

        // Clean up per-section extract buttons and observer
        teardownSectionInjector();
    }

    function createBaseUI() {
        if (uiContainer) return;

        uiContainer = document.createElement('div');
        uiContainer.id = 'winamax-tennis-ui';
        uiContainer.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            z-index: 9999;
            display: flex;
            flex-direction: column;
            gap: 12px;
            font-family: 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
        `;

        progressDiv = document.createElement('div');
        progressDiv.style.cssText = `
            background: rgba(20, 20, 30, 0.92);
            backdrop-filter: blur(8px);
            color: #f0f0f0;
            padding: 8px 16px;
            border-radius: 40px;
            font-size: 13px;
            font-weight: 500;
            text-align: center;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
            border: 1px solid rgba(255, 255, 255, 0.15);
            letter-spacing: 0.3px;
            transition: all 0.2s ease;
            display: none;
            white-space: nowrap;
        `;

        updateProgressTheme();
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateProgressTheme);

        actionBtn = document.createElement('button');
        actionBtn.style.cssText = `
            background: linear-gradient(135deg, #1e6df2, #0a4bc2);
            border: none;
            color: white;
            font-size: 14px;
            font-weight: 600;
            padding: 10px 36px;
            min-width: 220px;
            border-radius: 40px;
            cursor: pointer;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
            transition: all 0.2s cubic-bezier(0.2, 0.9, 0.4, 1.1);
            letter-spacing: 0.5px;
            backdrop-filter: blur(4px);
            border: 1px solid rgba(255, 255, 255, 0.2);
        `;
        actionBtn.addEventListener('mouseenter', () => {
            actionBtn.style.transform = 'translateY(-2px) scale(1.02)';
            actionBtn.style.boxShadow = '0 8px 20px rgba(0, 0, 0, 0.3)';
        });
        actionBtn.addEventListener('mouseleave', () => {
            actionBtn.style.transform = 'translateY(0) scale(1)';
            actionBtn.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.25)';
        });

        uiContainer.appendChild(progressDiv);
        uiContainer.appendChild(actionBtn);
        document.body.appendChild(uiContainer);
    }

    function createSportsLimitSelector() {
        if (sportsLimitSelectorDiv) sportsLimitSelectorDiv.remove();

        sportsLimitSelectorDiv = document.createElement('div');
        sportsLimitSelectorDiv.style.cssText = `
            display: flex;
            gap: 4px;
            justify-content: center;
        `;

        const limits = [
            { key: 'true', label: 'Stop at Night Gap' },
            { key: 'false', label: 'Extract All Page' },
        ];

        sportsLimitBtns = [];
        for (const l of limits) {
            const btn = document.createElement('button');
            btn.textContent = l.label;
            btn.dataset.limit = l.key;
            btn.addEventListener('mouseenter', () => {
                const isActive = (btn.dataset.limit === 'true') === sportsScanLimit;
                if (!isActive) {
                    btn.style.background = 'rgba(255, 255, 255, 0.25)';
                }
            });
            btn.addEventListener('mouseleave', () => {
                const isActive = (btn.dataset.limit === 'true') === sportsScanLimit;
                if (!isActive) {
                    btn.style.background = 'rgba(255, 255, 255, 0.15)';
                }
            });
            btn.addEventListener('click', () => {
                sportsScanLimit = btn.dataset.limit === 'true';
                updateSportsLimitButtons();
            });
            sportsLimitBtns.push(btn);
            sportsLimitSelectorDiv.appendChild(btn);
        }

        updateSportsLimitButtons();
        uiContainer.insertBefore(sportsLimitSelectorDiv, actionBtn);
    }

    function updateSportsLimitButtons() {
        sportsLimitBtns.forEach(btn => {
            const isActive = (btn.dataset.limit === 'true') === sportsScanLimit;
            btn.style.background = isActive ? 'linear-gradient(135deg, #1e6df2, #0a4bc2)' : 'rgba(255, 255, 255, 0.15)';
            btn.style.color = isActive ? 'white' : 'rgba(255, 255, 255, 0.7)';
            btn.style.border = isActive ? '1px solid rgba(255,255,255,0.4)' : '1px solid rgba(255,255,255,0.15)';
            btn.style.fontWeight = isActive ? '700' : '500';
        });
    }

    function createMatchUI() {
        createBaseUI();
        
        actionBtn.textContent = '🎾 Extract all odds';
        
        actionBtn.onclick = async () => {
            if (actionBtn.disabled) return;
            actionBtn.disabled = true;
            const originalText = actionBtn.textContent;
            actionBtn.textContent = '⏳ Extracting all...';
            actionBtn.style.opacity = '0.7';
            actionBtn.style.cursor = 'wait';
            
            await extractAllOddsFromMatchVb();
            
            actionBtn.disabled = false;
            actionBtn.style.opacity = '1';
            actionBtn.style.cursor = 'pointer';
            actionBtn.textContent = originalText;
        };

        // Inject per-section "Extract" buttons and observe for new sections
        setTimeout(() => {
            injectSectionExtractButtons();
            setupSectionInjectObserver();
        }, 300);

        currentMode = 'match';
    }

    function createSportsUI() {
        createBaseUI();
        createSportsLimitSelector();
        actionBtn.textContent = '🎾 Extract Matches';
        actionBtn.onclick = () => handleSportsExtract();
        currentMode = 'sports';
    }

    // --- Navigation & initialisation ------------------------------------
    function checkAndUpdateUI() {
        const mode = getPageMode();
        if (mode === currentMode) return; // already correct UI
        removeUI();
        if (mode === 'match') createMatchUI();
        else if (mode === 'sports') createSportsUI();
    }

    function watchForNavigation() {
        if (window.navigation) {
            window.navigation.addEventListener('navigate', () => setTimeout(checkAndUpdateUI, 200));
        } else {
            let lastUrl = window.location.href;
            setInterval(() => {
                if (window.location.href !== lastUrl) {
                    lastUrl = window.location.href;
                    setTimeout(checkAndUpdateUI, 200);
                }
            }, 500);
        }
        window.addEventListener('popstate', () => setTimeout(checkAndUpdateUI, 200));
        const originalPushState = history.pushState;
        const originalReplaceState = history.replaceState;
        history.pushState = function() {
            originalPushState.apply(this, arguments);
            setTimeout(checkAndUpdateUI, 200);
        };
        history.replaceState = function() {
            originalReplaceState.apply(this, arguments);
            setTimeout(checkAndUpdateUI, 200);
        };
    }

    // Start
    checkAndUpdateUI();
    watchForNavigation();
})();