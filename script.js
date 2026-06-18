// ==UserScript==
// @name         Winamax Tools
// @version      9.28
// @description  Extracts betting odds from Winamax.
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

    // --- Player name extraction from match page header -------------------
    // Retrieves the two player names from the middleColumn header using resilient XPath.
    // Returns an array of two strings [player1, player2] or null if not found.
    function getMiddleColumnPlayers() {
        const middleColumn = document.evaluate(
            "//*[@data-testid='middleColumn']",
            document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
        ).singleNodeValue;
        if (!middleColumn) return null;

        // Player names are in divs that contain text with a space (First Last pattern),
        // located within the match header area (the first section of middleColumn).
        // We find the match-route-anchor area and look for player name divs near it.
        // The structure has: tournament/round info at top, then player blocks side by side,
        // then time, then odds buttons.

        // Strategy: Find all leaf divs in the upper portion of middleColumn that look like names
        // (two or more capitalized words, not containing ATP/WWTA/digits/colons)
        const playerDivs = xpathNodes(
            ".//div[string-length(normalize-space(text())) > 2 and contains(text(), ' ') and not(contains(text(), ':')) and not(contains(text(), 'ATP')) and not(contains(text(), 'WTA')) and not(contains(text(), '1/')) and not(contains(text(), 'Extract')) and not(starts-with(normalize-space(text()), '€')) and not(contains(text(), '€'))]",
            middleColumn
        );

        const players = [];
        for (const div of playerDivs) {
            const name = div.textContent.trim();
            // Must look like a name: starts with uppercase letter, has a space, no digits
            if (name && /^[A-ZÀ-ÖØ-ÿ]/.test(name) && !/^\d/.test(name) && !players.includes(name)) {
                players.push(name.split(' ').at(-1));
                if (players.length >= 2) break;
            }
        }

        return players.length >= 2 ? players : null;
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
    let extractedMatches = [];     // for sports mode
    let sportsScanLimit = true;        // for sports mode (true = stop at night gap)
    let sportsLimitSelectorDiv = null; // sports range toggle UI
    let sportsLimitBtns = [];          // store sports limit button references

    // Per-section extract button state
    let processedSectionHeadings = null;
    let sectionInjectObserver = null;

    function showProgress(text, isError = false) {
        if (!progressDiv) return;
        if (progressTimeout) clearTimeout(progressTimeout);
        progressDiv.style.display = 'block';
        progressDiv.textContent = text;
        progressDiv.style.background = isError
            ? 'rgba(220, 53, 69, 0.95)'
            : 'rgba(20, 20, 30, 0.92)';
        progressTimeout = setTimeout(() => {
            if (progressDiv && progressDiv.style.display === 'block') progressDiv.style.display = 'none';
        }, 3000);
    }

    // --- Per-section extract button injection ----------------------------

    // Determines if an element is a valid section heading
    function isSectionHeading(span) {
        // Get the title text from the child div
        const childDiv = span.querySelector && span.querySelector(':scope > div');
        const title = ((childDiv && childDiv.textContent) || span.textContent || '').trim();

        // Filter: title must be 2-40 chars
        if (!title || title.length < 2 || title.length > 40) return false;

        // Filter: skip pure numbers, percentages, short codes
        if (/^\d+([.,]\d+)?%?$/.test(title)) return false;

        // Filter: skip common UI text
        if (/^(Extract|Plus de|Moins de|Titulaire|Nouveau|NEW|\?)/i.test(title)) return false;

        // Filter: skip if it looks like a player name (First Last) with no section context
        // Section titles are typically single words or short phrases
        if (/^[A-Z][a-z]+\s[A-Z][a-z]+$/.test(title) && 
            !/(Résultat|Double chance|Buteur|Buteurs|Score|Nombre|Écart|Total|Match|Vainqueur|Mi-temps|Buts|Tirs|Joueur|Serial)/i.test(title)) {
            return false;
        }

        return true;
    }

    // Determines if a heading element is associated with odds content
    function hasAssociatedOdds(headingEl) {
        // Navigate up to find section container
        let node = headingEl.parentNode;
        while (node && node !== document.body) {
            const hasOdds = document.evaluate(
                ".//div[starts-with(@data-testid, 'odd-button-')]", 
                node, 
                null, 
                XPathResult.BOOLEAN_TYPE, 
                null
            ).booleanValue;
            if (hasOdds) return true;
            node = node.parentNode;
        }
        return false;
    }

    // Find all section headings and inject a blue "Extract" button next to each
    function injectSectionExtractButtons() {
        if (!processedSectionHeadings) {
            processedSectionHeadings = new WeakSet();
        }

        // Find the main content container
        const context = document.evaluate(
            "//*[@data-testid='middleColumn'] | //*[contains(@class, 'ReactVirtualized__Grid')]",
            document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
        ).singleNodeValue || document;

        // Collect all candidate heading spans
        const allSpans = xpathNodes(".//span[div[not(*)]]", context);
        const finalHeadings = [];
        
        // Filter valid section headings using the new helper functions
        for (const span of allSpans) {
            if (!isSectionHeading(span)) continue;
            if (!hasAssociatedOdds(span)) continue;
            
            // Skip if already has a button
            if (span.dataset && span.dataset.sectionExtract === 'true') continue;
            if (document.evaluate(
                ".//*[@data-section-extract='true']", span, null, XPathResult.BOOLEAN_TYPE, null
            ).booleanValue) continue;

            finalHeadings.push(span);
        }

        for (const h of finalHeadings) {
            if (processedSectionHeadings.has(h)) continue;
            processedSectionHeadings.add(h);

            const childDiv = h.querySelector && h.querySelector(':scope > div');
            const headingText = ((childDiv && childDiv.textContent) || h.textContent || '').trim();
            h.dataset.originalTitle = headingText;

            // Determine section type:
            // - "Nombre de jeux" -> Over/Under filtering (threshold-based)
            // - "Écart de jeux" -> Player-based filtering (Player 1 / Player 2)
            const isNombreDeJeuxSection = headingText.includes('Nombre de jeux');
            const isEcartDeJeuxSection = headingText.includes('Écart de jeux');
            const isOverUnderSection = isNombreDeJeuxSection || isEcartDeJeuxSection;

            // Retrieve player names from the match page header (middleColumn) using resilient XPath
            const playerNames = getMiddleColumnPlayers();
            // If we found player names, use them; otherwise fall back to generic labels
            const p1Name = (playerNames && playerNames.length >= 2) ? playerNames[0] : 'Player 1';
            const p2Name = (playerNames && playerNames.length >= 2) ? playerNames[1] : 'Player 2';

            // Shared click handler for section extract buttons
            async function handleSectionExtractClick(e, btn, filter) {
                e.stopPropagation();
                if (btn.disabled) return;
                btn.disabled = true;
                const originalText = btn.textContent;
                btn.textContent = '⏳';
                btn.style.opacity = '0.7';
                btn.style.cursor = 'wait';

                try {
                    const data = await extractSectionData(h, filter);
                    if (data && data.odds.length > 0) {
                        let output = '';
                        if (!isNombreDeJeuxSection && !isEcartDeJeuxSection) {
                            output = data.title + '\n';
                        }
                        
                        for (const line of data.odds) {
                            if (output === '' && line.trim() === '') continue;
                            output += line + '\n';
                        }
                        
                        // Remove trailing newlines
                        output = output.replace(/\n+$/, '');
                        
                        await copyToClipboard(output);
                        const oddCount = data.odds.filter(line => line.includes(':')).length;
                        let filterLabel = '';
                        if (isNombreDeJeuxSection) {
                            filterLabel = filter === 'over' ? ' Over' : filter === 'under' ? ' Under' : '';
                        } else if (isEcartDeJeuxSection) {
                            filterLabel = filter === p1Name ? ` ${p1Name}` : filter === p2Name ? ` ${p2Name}` : '';
                        }
                        showProgress(`✅ ${oddCount} odds from "${data.title}"${filterLabel} copied!`);
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
            }

            // Helper to create a stylized section button
            function createSectionBtn(label, datasetKey) {
                const btn = document.createElement('button');
                btn.textContent = label;
                btn.dataset[datasetKey] = 'true';
                btn.style.cssText = `
                    background: linear-gradient(135deg, #1e6df2, #0a4bc2);
                    border: none;
                    color: white;
                    font-size: 12px;
                    font-weight: 700;
                    padding: 4px 14px;
                    border-radius: 14px;
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

                return btn;
            }

            // Create the standard "Extract" button (all odds)
            const extractBtn = createSectionBtn('Extract', 'sectionExtract');
            extractBtn.addEventListener('click', async (e) => { await handleSectionExtractClick(e, extractBtn, null); });

            // Make the heading a flex container so the buttons sit inline
            const computedDisplay = window.getComputedStyle(h).display;
            if (computedDisplay !== 'flex' && computedDisplay !== 'inline-flex') {
                h.style.display = 'flex';
                h.style.alignItems = 'center';
            }
            // Ensure the heading can accommodate the buttons without overflow
            h.style.flexWrap = 'wrap';

            h.appendChild(extractBtn);

            // For "Nombre de jeux" sections: add Over/Under buttons
            if (isNombreDeJeuxSection) {
                const overBtn = createSectionBtn('Over', 'sectionExtractOver');
                overBtn.addEventListener('click', async (e) => { await handleSectionExtractClick(e, overBtn, 'over'); });
                overBtn.style.background = 'linear-gradient(135deg, #28a745, #1e7e34)';
                h.appendChild(overBtn);

                const underBtn = createSectionBtn('Under', 'sectionExtractUnder');
                underBtn.addEventListener('click', async (e) => { await handleSectionExtractClick(e, underBtn, 'under'); });
                underBtn.style.background = 'linear-gradient(135deg, #dc3545, #b02a37)';
                h.appendChild(underBtn);
            }

            // For "Écart de jeux" sections: add Player 1 / Player 2 buttons
            if (isEcartDeJeuxSection) {
                const player1Btn = createSectionBtn(p1Name, 'sectionExtractPlayer1');
                player1Btn.addEventListener('click', async (e) => { await handleSectionExtractClick(e, player1Btn, p1Name); });
                player1Btn.style.background = 'linear-gradient(135deg, #28a745, #1e7e34)';
                h.appendChild(player1Btn);

                const player2Btn = createSectionBtn(p2Name, 'sectionExtractPlayer2');
                player2Btn.addEventListener('click', async (e) => { await handleSectionExtractClick(e, player2Btn, p2Name); });
                player2Btn.style.background = 'linear-gradient(135deg, #dc3545, #b02a37)';
                h.appendChild(player2Btn);
            }
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
        // Click the toggle (div/button with the 4-rect icon) to switch to list view.
        if (currentOdds.length <= 2) {
            // Find the tabs-wrapper and click the toggle containing the layout SVG icon
            const tabsWrapper = document.evaluate(".//*[contains(@class, 'tabs-wrapper')]", sectionContainer, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            if (tabsWrapper) {
                const toggleDiv = document.evaluate(".//*[local-name()='svg']/parent::*", tabsWrapper, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                if (toggleDiv && toggleDiv.click) {
                    toggleDiv.click();
                    await sleep(500);
                }
            } else {
                // Fallback: find SVG with rects
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
        
        // Expand ALL "Plus de sélections" buttons (multiple teams per section)
        const expandBtns = xpathNodes(
            ".//div[contains(text(),'Plus de sélections')]/ancestor::div[contains(@class, 'expand-button') or contains(@class, 'expand')] | .//div[contains(text(),'Plus de sélections')]/..",
            sectionContainer
        );
        for (const btn of expandBtns) {
            if (btn.textContent.trim().includes("Plus de sélections")) {
                btn.click();
                await sleep(200);
            }
        }
    }

    // Detect if a section is a player-market section (e.g., "Joueur décisif") with 
    // team sub-sections and column categories (Buteur/Passeur/Décisif).
    // IMPORTANT: A standard 1X2 market (like "Résultat") also uses bet-group-template
    // but does NOT have team sub-sections with player names. We must distinguish them.
    // A true player-market section has:
    //   - bet-group-template with team containers that each contain player names
    //   - OR column headers (Buteur/Passeur/etc.)
    function isPlayerMarketSection(sectionContainer) {
        // First check: does it have bet-group-template at all?
        const hasBetGroupTemplate = document.evaluate(
            ".//*[contains(@class, 'bet-group-template')]",
            sectionContainer, null, XPathResult.BOOLEAN_TYPE, null
        ).booleanValue;
        if (!hasBetGroupTemplate) return false;

        // Check for column headers (Buteur/Passeur/Décisif) — definitive player market indicator
        const headerRow = document.evaluate(
            ".//*[contains(@class, 'bet-group-template')]/*[1][self::div or self::header]",
            sectionContainer, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
        ).singleNodeValue;
        if (headerRow) {
            const headerCells = xpathNodes(".//p", headerRow);
            if (headerCells.length > 0) {
                const headerTexts = headerCells.map(c => c.textContent.trim());
                // Check for known column header patterns
                const hasColumnHeaders = headerTexts.some(h => 
                    /buteur|passeur|décisif|but|passe/i.test(h)
                );
                if (hasColumnHeaders) return true;
            }
        }

        // Check for team containers with player names inside bet-group-template
        const teamContainers = xpathNodes(
            ".//*[contains(@class, 'bet-group-template')]/div",
            sectionContainer
        );
        if (teamContainers.length >= 2) {
            // Multiple team containers with player-like names (First Last pattern)
            let teamsWithPlayers = 0;
            for (const tc of teamContainers) {
                const hasPlayerName = document.evaluate(
                    ".//*[self::p or self::span or self::div][string-length(normalize-space(text())) > 3 and contains(text(), ' ') and not(contains(text(), ':')) and not(contains(text(), 'ATP')) and not(contains(text(), 'WTA')) and not(contains(text(), 'Plus de')) and not(contains(text(), 'Moins de')) and not(contains(text(), 'Extract'))]",
                    tc, null, XPathResult.BOOLEAN_TYPE, null
                ).booleanValue;
                if (hasPlayerName) teamsWithPlayers++;
            }
            // If 2+ team containers have player names, it's a player market
            if (teamsWithPlayers >= 2) return true;
        }

        // Default: not a player market (e.g., standard 1X2 like "Résultat")
        return false;
    }

    // Special extraction for "Double chance" sections
    function extractDoubleChanceOdds(sectionContainer, title) {
        const outcomes = [];
        
        // Find all outcome title elements
        const outcomeTitles = xpathNodes(
            ".//div[contains(@class, 'bet-group-outcome-title')]//div[contains(@class, 'label-text')]",
            sectionContainer
        );
        
        for (const titleEl of outcomeTitles) {
            const label = titleEl.textContent.trim();
            if (!label) continue;
            
            // Find the corresponding odds value
            let oddsValue = '';
            let current = titleEl;
            while (current && current !== sectionContainer) {
                const oddsEl = document.evaluate(
                    ".//span[contains(@class, 'odd-button-value')]",
                    current.parentNode,
                    null,
                    XPathResult.FIRST_ORDERED_NODE_TYPE,
                    null
                ).singleNodeValue;
                
                if (oddsEl) {
                    oddsValue = oddsEl.textContent.trim().replace(',', '.');
                    break;
                }
                current = current.parentNode;
            }
            
            if (label && oddsValue) {
                outcomes.push(`${label} : ${oddsValue}`);
            }
        }
        
        if (outcomes.length === 0) return null;
        return {
            title: title,
            odds: outcomes
        };
    }

    // Extract odds from player-market sections where each team has players
    // and odds are in columns (e.g., Buteur/Passeur/Décisif).
    async function extractPlayerMarketOdds(sectionContainer, title) {
        // Find team-split containers (direct child divs of bet-group-template)
        const teamContainers = xpathNodes(
            ".//*[contains(@class, 'bet-group-template')]/div",
            sectionContainer
        );

        // Extract column header from the bet-group-template header row, if present
        let columnHeaders = [];
        // Find header row using more resilient XPath
        const headerRow = document.evaluate(
            ".//*[contains(@class, 'bet-group-template')]/*[1][self::div or self::header]",
            sectionContainer, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
        ).singleNodeValue;
        if (headerRow) {
            const headerCells = xpathNodes(".//p", headerRow);
            columnHeaders = headerCells.map(c => c.textContent.trim());
        }

        // --- Helper: collect all odds for a single player block ----------
        // Collects from ALL threshold wrappers inside the block (e.g. "paliers" sections

        function collectPlayerOdds(playerBlock) {
            // Find odds wrappers by their relationship to odd buttons
            const oddsWrappers = xpathNodes(
                ".//div[.//div[starts-with(@data-testid, 'odd-button-')]]",
                playerBlock
            );

            // If we have column headers from a header row, treat this as a
            // column-based market: take only the first wrapper (3 columns).
            if (columnHeaders.length > 0) {
                const wrapper = oddsWrappers.length > 0 ? oddsWrappers[0] : playerBlock;
                const oddButtons = xpathNodes(
                    ".//div[starts-with(@data-testid, 'odd-button-')]",
                    wrapper
                );
                const values = [];
                for (const btn of oddButtons) {
                    const span = document.evaluate(
                        ".//span[contains(@class, 'odd-button-value')]",
                        btn, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
                    ).singleNodeValue;
                    if (span) values.push(span.textContent.trim().replace(',', '.'));
                }
                const parts = values.map((v, i) => {
                    const colName = (i < columnHeaders.length) ? columnHeaders[i] : `Col${i+1}`;
                    return `${colName}: ${v}`;
                });
                return parts.length > 0 ? parts.join(' | ') : '';
            }

            // No column headers → this is a threshold/paliers market with multiple wrappers.
            // Collect ALL odds from ALL wrappers, prefixing each with its outcome name.
            const allOdds = [];
            for (const wrapper of oddsWrappers) {
                const oddButtons = xpathNodes(
                    ".//div[starts-with(@data-testid, 'odd-button-')]",
                    wrapper
                );
                for (const btn of oddButtons) {
                    const valueSpan = document.evaluate(
                        ".//span[contains(@class, 'odd-button-value')]",
                        btn, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
                    ).singleNodeValue;
                    if (!valueSpan) continue;
                    const oddValue = valueSpan.textContent.trim().replace(',', '.');

                    // Get outcome name (e.g. "Plus de 9,5") – Strategy 1: sibling
                    let outcomeName = '';
                    const valueContainer = valueSpan.parentElement;
                    if (valueContainer && valueContainer.previousElementSibling) {
                        outcomeName = valueContainer.previousElementSibling.textContent.trim();
                    }
                    // Strategy 2: Look for common title/name div/span classes inside the button itself
                    if (!outcomeName) {
                        const nameDiv = document.evaluate(
                            ".//*[contains(@class, 'odd-button-name') or contains(@class, 'outcome-name')]",
                            btn, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
                        ).singleNodeValue;
                        if (nameDiv) outcomeName = nameDiv.textContent.trim();
                    }

                    if (outcomeName && oddValue) {
                        allOdds.push(`${outcomeName} : ${oddValue}`);
                    }
                }
            }
            return allOdds.join(' | ');
        }

        // --- Helper: find the player block DOM node containing a player name element
        function findPlayerBlock(nameEl, boundary) {
            // Walk up the DOM tree to find a container that has both the player name and odds buttons
            let cur = nameEl.parentNode;
            while (cur && cur !== boundary) {
                if (document.evaluate(
                    ".//div[starts-with(@data-testid, 'odd-button-')]",
                    cur, null, XPathResult.BOOLEAN_TYPE, null
                ).booleanValue) return cur;
                cur = cur.parentNode;
            }
            return nameEl.parentNode;
        }

        // --- Case 1: Team-split format (e.g. "Joueur décisif") -------------
        if (teamContainers.length > 0) {
            const sectionOdds = [];
            for (const teamContainer of teamContainers) {
                // Team name: find the first text element that looks like a team name
                // within the team container (direct child of bet-group-template)
                const teamNameEl = document.evaluate(
                    ".//*[self::p or self::span or self::div][string-length(normalize-space(text())) > 1 and not(contains(text(), 'Plus de sélections')) and not(contains(text(), 'paliers')) and not(contains(text(), 'ATP')) and not(contains(text(), 'WTA'))]",
                    teamContainer, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
                ).singleNodeValue;
                const teamName = teamNameEl ? teamNameEl.textContent.trim() : '';

                // Player names: find text elements that look like player names
                // (capitalized, not tournament/round/time indicators)
                const playerNameElements = xpathNodes(
                    ".//*[self::p or self::span or self::div][string-length(normalize-space(text())) > 1 and contains(text(), ' ') and not(contains(text(), ':')) and not(contains(text(), 'ATP')) and not(contains(text(), 'WTA')) and not(contains(text(), 'Plus de')) and not(contains(text(), 'Moins de'))]",
                    teamContainer
                );

                for (const nameEl of playerNameElements) {
                    const playerName = nameEl.textContent.trim();
                    if (!playerName) continue;
                    const playerBlock = findPlayerBlock(nameEl, teamContainer);
                    if (!playerBlock) continue;
                    const oddsStr = collectPlayerOdds(playerBlock);
                    if (oddsStr) {
                        sectionOdds.push(`  ${playerName} | ${oddsStr}`);
                    }
                }
            }

            // Rebuild with team separation
            const outputLines = [];
            // If there's exactly 1 container with no team name, skip team header
            const isSingleUntitledContainer = teamContainers.length === 1 &&
                !document.evaluate(
                    ".//*[self::p or self::span or self::div][string-length(normalize-space(text())) > 1 and not(contains(text(), 'Plus de sélections')) and not(contains(text(), 'paliers')) and not(contains(text(), 'ATP')) and not(contains(text(), 'WTA'))]",
                    teamContainers[0], null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
                ).singleNodeValue;

            if (isSingleUntitledContainer) {
                // Direct player output (no team header)
                for (const item of sectionOdds) {
                    outputLines.push(item);
                }
            } else {
                // Standard team-split output
                let playerIndex = 0;
                for (const teamContainer of teamContainers) {
                    const teamNameEl = document.evaluate(
                        ".//*[self::p or self::span or self::div][string-length(normalize-space(text())) > 1 and not(contains(text(), 'Plus de sélections')) and not(contains(text(), 'paliers')) and not(contains(text(), 'ATP')) and not(contains(text(), 'WTA'))]",
                        teamContainer, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
                    ).singleNodeValue;
                    const teamName = teamNameEl ? teamNameEl.textContent.trim() : '';
                    const playerCount = xpathNodes(
                        ".//*[self::p or self::span or self::div][string-length(normalize-space(text())) > 1 and contains(text(), ' ') and not(contains(text(), ':')) and not(contains(text(), 'ATP')) and not(contains(text(), 'WTA')) and not(contains(text(), 'Plus de')) and not(contains(text(), 'Moins de'))]",
                        teamContainer
                    ).length;
                    if (playerCount > 0 && teamName) {
                        outputLines.push(`=== ${teamName} ===`);
                    }
                    for (let i = 0; i < playerCount && playerIndex < sectionOdds.length; i++) {
                        outputLines.push(sectionOdds[playerIndex]);
                        playerIndex++;
                    }
                }
            }
            if (outputLines.length > 0) return { title, odds: outputLines };
            return null;
        }

        // --- Case 2: Direct player blocks inside bet-group-template ---------
        // (e.g. "Nombre de points du joueur (paliers)" — no team split)
        // Find player blocks: they are descendants of bet-group-template that contain both
        // a player name (text with space, capitalized) and odds buttons
        const candidateBlocks = xpathNodes(
            ".//*[contains(@class, 'bet-group-template')]//*[.//div[starts-with(@data-testid, 'odd-button-')]]",
            sectionContainer
        );
        const playerBlocks = [];
        for (const block of candidateBlocks) {
            // Check if this block contains a player name (text with space, not containing special chars)
            const hasPlayerName = document.evaluate(
                ".//*[self::p or self::span or self::div][string-length(normalize-space(text())) > 1 and contains(text(), ' ') and not(contains(text(), ':')) and not(contains(text(), 'ATP')) and not(contains(text(), 'WTA')) and not(contains(text(), 'Plus de')) and not(contains(text(), 'Moins de'))]",
                block, null, XPathResult.BOOLEAN_TYPE, null
            ).booleanValue;
            if (hasPlayerName) {
                playerBlocks.push(block);
            }
        }
        if (playerBlocks.length === 0) return null;

        const outputLines = [];
        for (const playerBlock of playerBlocks) {
            const playerNameEl = document.evaluate(
                ".//*[self::p or self::span or self::div][string-length(normalize-space(text())) > 1 and contains(text(), ' ') and not(contains(text(), ':')) and not(contains(text(), 'ATP')) and not(contains(text(), 'WTA')) and not(contains(text(), 'Plus de')) and not(contains(text(), 'Moins de'))]",
                playerBlock, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
            ).singleNodeValue;
            const playerName = playerNameEl ? playerNameEl.textContent.trim() : '';
            if (!playerName) continue;
            const oddsStr = collectPlayerOdds(playerBlock);
            if (oddsStr) {
                outputLines.push(`  ${playerName} | ${oddsStr}`);
            }
        }

        if (outputLines.length === 0) return null;
        return { title, odds: outputLines };
    }

    // Extract odds from a section: expand it, then extract, return {title, odds[]} or null
    // Optional filter: 'over', 'under', player name string, or null for all odds
    async function extractSectionData(headingEl, filter = null) {
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

        // Helper to find sub-group title for an odd button using resilient DOM traversal
        function findGroupTitle(btn, sectionTitle, sectionContainer) {
            let current = btn.parentNode;
            while (current && current !== sectionContainer) {
                // If this container doesn't hold multiple odd buttons, it's likely just a single cell layout,
                // and any text is just the outcome label, not a sub-group header.
                const oddButtonsInCurrent = current.querySelectorAll('[data-testid^="odd-button-"]');
                if (oddButtonsInCurrent.length <= 1) {
                    current = current.parentNode;
                    continue;
                }

                const walker = document.createTreeWalker(current, NodeFilter.SHOW_TEXT);
                const candidates = [];
                while (walker.nextNode()) {
                    const text = walker.currentNode.textContent.trim();
                    if (!text) continue;
                    
                    // Ignore if the text is inside an odd button or represents odds/percentages
                    let isInsideBtnOrNoise = false;
                    let node = walker.currentNode.parentNode;
                    while (node && node !== current) {
                        if (node.dataset && node.dataset.testid && node.dataset.testid.startsWith('odd-button-')) {
                            isInsideBtnOrNoise = true;
                            break;
                        }
                        // Skip if the parent class suggests it's an odds value or distribution
                        const className = node.className || '';
                        if (typeof className === 'string' && (
                            className.includes('odd-button-value') || 
                            className.includes('percent-distribution') ||
                            className.includes('completeness')
                        )) {
                            isInsideBtnOrNoise = true;
                            break;
                        }
                        node = node.parentNode;
                    }
                    
                    if (isInsideBtnOrNoise) continue;
                    
                    // Filter out standard option names and values
                    if (text === 'Oui' || text === 'Non' || text === '1' || text === 'N' || text === '2') continue;
                    if (/^\d+([.,]\d+)?%?$/.test(text)) continue; // numbers or percentages
                    if (text.toLowerCase() === sectionTitle.toLowerCase()) continue;
                    if (/^(Extract|Plus de|Moins de|Titulaire|Nouveau|NEW|\?)/i.test(text)) continue;
                    
                    candidates.push(text);
                }
                
                if (candidates.length > 0) {
                    return candidates[0];
                }
                current = current.parentNode;
            }
            return '';
        }

        // Expand the section
        await expandSection(sectionContainer);

        // Special handling for "Double chance" sections
        if (title.toLowerCase().includes('chance')) {
            await sleep(300); // Wait for expansion to complete
            const oddsData = extractDoubleChanceOdds(sectionContainer, title);
            if (oddsData) return oddsData;
        }

        // Detect if this is a player-market section (e.g., "Joueur décisif")
        // These have a bet-group-template layout with team sub-sections and columns
        // BUT exclude "Score exact" sections which also use bet-group-template but have score outcomes (1-0, 2-0, etc.)
        const isScoreExact = title.toLowerCase().includes('score exact');
        if (!isScoreExact && isPlayerMarketSection(sectionContainer)) {
            // Wait a moment after expansion for DOM to settle
            await sleep(300);
            const playerData = await extractPlayerMarketOdds(sectionContainer, title);
            if (playerData) return playerData;
            // Fall through to standard extraction if player mode fails
        }

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
                    ".//*[contains(@class, 'odd-button-name') or contains(@class, 'outcome-name')]",
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
                        // Clean label: remove trailing percentage (e.g. "21%") and distribution text
                        const text = labelNode.textContent.trim();
                        name = text.replace(/\s*\d+([.,]\d+)?%$/, '').trim();
                        break;
                    }
                    current = current.parentNode;
                }
            }

            // Strategy 4: Ultimate text-walking fallback inside row wrapper
            // Find the row wrapper by looking for a common ancestor that contains
            // both the odd button and other text nodes (outcome name, etc.)
            if (!name) {
                // Walk up to find a container that has the button and other text content
                let rowWrapper = btn.parentNode;
                for (let depth = 0; depth < 6 && rowWrapper && rowWrapper !== sectionContainer; depth++) {
                    const textCount = document.evaluate(
                        "count(.//text()[normalize-space(.) != ''])",
                        rowWrapper, null, XPathResult.NUMBER_TYPE, null
                    ).numberValue;
                    if (textCount > 2) break; // Found a wrapper with multiple text nodes
                    rowWrapper = rowWrapper.parentNode;
                }
                if (rowWrapper && rowWrapper !== sectionContainer) {
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
                const groupTitle = findGroupTitle(btn, title, sectionContainer);
                rawOdds.push({ name, value: oddValue.replace(',', '.'), groupTitle });
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

        // "Nombre de jeux" and "Écart de jeux" sections: group by Over/Under sorted by odd value ascending
        if (title.includes('Nombre de jeux') || title.includes('Écart de jeux')) {
            const overOdds = rawOdds.filter(o => o.name.includes('Plus de'));
            const underOdds = rawOdds.filter(o => o.name.includes('Moins de'));
            const sortByValue = (a, b) => parseFloat(a.value) - parseFloat(b.value);
            overOdds.sort(sortByValue);
            underOdds.sort(sortByValue);

            // Apply filter if provided
            if (title.includes('Nombre de jeux')) {
                // "Nombre de jeux": filter is 'over' or 'under'
                if (filter === 'over') {
                    for (const o of overOdds) {
                        const threshold = o.name.replace('Plus de ', '');
                        sectionOdds.push(`Over ${threshold} : ${o.value}`);
                    }
                } else if (filter === 'under') {
                    for (const o of underOdds) {
                        const threshold = o.name.replace('Moins de ', '');
                        sectionOdds.push(`Under ${threshold} : ${o.value}`);
                    }
                } else {
                    for (const o of overOdds) {
                        const threshold = o.name.replace('Plus de ', '');
                        sectionOdds.push(`Over ${threshold} jeux : ${o.value}`);
                    }
                    for (const o of underOdds) {
                        const threshold = o.name.replace('Moins de ', '');
                        sectionOdds.push(`Under ${threshold} jeux : ${o.value}`);
                    }
                }
            } else if (title.includes('Écart de jeux')) {
                // "Écart de jeux": group by player, sorted by odds value ascending (like Over/Under)
                const playerNames = getMiddleColumnPlayers();
                const p1 = playerNames && playerNames.length >= 2 ? playerNames[0] : null;
                const p2 = playerNames && playerNames.length >= 2 ? playerNames[1] : null;

                // Build player grouping from spread-format odds ("Player Name +/-N.N")
                const ecartByPlayer = {};
                for (const o of rawOdds) {
                    const spreadMatch = o.name.match(spreadRegex);
                    const playerNamePart = spreadMatch ? spreadMatch[1].trim() : o.name;
                    if (!ecartByPlayer[playerNamePart]) ecartByPlayer[playerNamePart] = [];
                    ecartByPlayer[playerNamePart].push(o);
                }

                // Determine which players to include based on filter
                let playersToShow = Object.keys(ecartByPlayer);
                if (filter && p1 && p2 && (filter === p1 || filter === p2)) {
                    playersToShow = playersToShow.filter(p => p.includes(filter));
                }
                playersToShow.sort();

                for (const player of playersToShow) {
                    // Sort by odds value ascending
                    ecartByPlayer[player].sort((a, b) => parseFloat(a.value) - parseFloat(b.value));
                    for (const o of ecartByPlayer[player]) {
                        sectionOdds.push(`${o.name} : ${o.value}`);
                    }
                }
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
            // General section: group by groupTitle (preserving order)
            const groups = new Map();
            for (const o of rawOdds) {
                if (!groups.has(o.groupTitle)) {
                    groups.set(o.groupTitle, []);
                }
                groups.get(o.groupTitle).push(o);
            }
            
            for (const [groupTitle, groupOdds] of groups.entries()) {
                if (groupTitle) {
                    sectionOdds.push(groupTitle);
                }
                for (const o of groupOdds) {
                    sectionOdds.push(`${o.name} : ${o.value}`);
                }
            }
        }

        if (sectionOdds.length === 0) return null;
        return { title, odds: sectionOdds };
    }

    async function extractAllOddsFromMatch() {
        try {
            showProgress('🔍 Scanning sections while scrolling...');
            
            const scrollable = findScrollableContainer();
            const allResults = [];
            const processedButtons = new WeakSet();

            // Ensure all currently visible sections have their "Extract" button injected
            injectSectionExtractButtons();

            // Start from top
            if (scrollable === window) {
                window.scrollTo(0, 0);
            } else {
                scrollable.scrollTop = 0;
            }
            await sleep(300);

            let prevScrollTop = -1;
            let noNewSectionsCount = 0;
            const MAX_NO_NEW = 15;

            while (noNewSectionsCount < MAX_NO_NEW) {
                // Ensure all sections currently in the DOM have "Extract" buttons injected
                injectSectionExtractButtons();

                // Find injected "Extract" buttons that we haven't processed yet
                const extractBtns = document.querySelectorAll('[data-section-extract="true"]');
                let foundNew = false;

                for (const btn of extractBtns) {
                    if (processedButtons.has(btn)) continue;

                    const headingEl = btn.parentNode;
                    if (!headingEl || !headingEl.dataset.originalTitle) continue;

                    processedButtons.add(btn);

                    const data = await extractSectionData(headingEl);
                    if (data) {
                        const isOverUnderType = data.title.includes('Nombre de jeux') || data.title.includes('Écart de jeux');
                        if (!isOverUnderType) {
                            allResults.push(data.title);
                        }
                        allResults.push(...data.odds);
                        allResults.push('');
                        foundNew = true;
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
            await copyToClipboard(output);
            const oddCount = output.split('\n').filter(line => line.includes(':')).length;
            const sectionCount = output.split('\n').filter(line => line !== '' && !line.includes(':')).length;
            showProgress(`✅ ${oddCount} odds from ${sectionCount} sections copied!`);
        } catch (err) {
            console.error(err);
            showProgress(`❌ Error: ${err.message}`, true);
        }
    }

    // --- Sports page extraction (upcoming singles) ----------------------
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
                showProgress('⚠️ No upcoming singles matches found', true);
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
        uiContainer.id = 'winamax-tools-ui';
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
            btn.style.cssText = `
                background: linear-gradient(135deg, #1e6df2, #0a4bc2);
                border: none;
                color: white;
                font-size: 10px;
                font-weight: 700;
                padding: 2px 12px;
                border-radius: 12px;
                cursor: pointer;
                font-family: inherit;
                letter-spacing: 0.3px;
                transition: all 0.2s ease;
                white-space: nowrap;
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
            btn.style.background = isActive ? 'linear-gradient(135deg, #1e6df2, #0a4bc2)' : 'rgba(255, 255, 255, 0.1)';
            btn.style.color = isActive ? 'white' : 'rgba(255, 255, 255, 0.6)';
            btn.style.border = isActive ? '1px solid rgba(255,255,255,0.3)' : '1px solid rgba(255,255,255,0.08)';
            btn.style.fontWeight = isActive ? '700' : '400';
            btn.style.boxShadow = isActive ? '0 2px 8px rgba(0,0,0,0.25)' : 'none';
        });
    }

    function createMatchUI() {
        createBaseUI();
        
        actionBtn.textContent = 'Extract all odds';
        
        actionBtn.onclick = async () => {
            if (actionBtn.disabled) return;
            actionBtn.disabled = true;
            const originalText = actionBtn.textContent;
            actionBtn.textContent = '⏳ Extracting all...';
            actionBtn.style.opacity = '0.7';
            actionBtn.style.cursor = 'wait';
            
            await extractAllOddsFromMatch();
            
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
        actionBtn.textContent = 'Extract Matches';
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