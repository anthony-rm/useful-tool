// ==UserScript==
// @name         Winamax Tennis & Volleyball Tools
// @namespace    http://tampermonkey.net/
// @version      9.3
// @description  Extracts betting odds from Winamax match pages. Tennis: "Number of Games" & "Game Spread" odds. Volleyball: ALL odds from all sections. Features dynamic UI, clipboard copy, dark/light theme.
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
    let oddsMode = 'all';          // 'all', 'over', 'under' for match mode
    let modeSelectorDiv = null;    // mode toggle UI container
    let sectionType = 'Total Games'; // 'All', 'Total Games' or 'Games Spread'
    let sectionSelectorDiv = null;     // section toggle UI container
    let spreadFilter = 'all';          // 'all', 'player1', 'player2' for spread mode
    let spreadFilterDiv = null;        // spread filter UI container
    let spreadPlayer1Name = '';        // detected player 1 name
    let spreadPlayer2Name = '';        // detected player 2 name
    let modeBtns = [];                 // store mode button references
    let sectionBtns = [];              // store section button references
    let filterBtns = [];               // store filter button references
    let sportsScanLimit = true;        // for sports mode (true = stop at night gap)
    let sportsLimitSelectorDiv = null; // sports range toggle UI
    let sportsLimitBtns = [];          // store sports limit button references

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

    // Global button update function
    function updateAllButtons() {
        // Update mode buttons
        modeBtns.forEach(btn => {
            const isActive = btn.dataset.mode === oddsMode;
            btn.style.background = isActive ? 'linear-gradient(135deg, #1e6df2, #0a4bc2)' : 'rgba(255, 255, 255, 0.15)';
            btn.style.color = isActive ? 'white' : 'rgba(255, 255, 255, 0.7)';
            btn.style.borderColor = isActive ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.15)';
            btn.style.fontWeight = isActive ? '700' : '500';
        });

        // Update section buttons
        sectionBtns.forEach(btn => {
            const isActive = btn.dataset.section === sectionType;
            btn.style.background = isActive ? 'linear-gradient(135deg, #1e6df2, #0a4bc2)' : 'rgba(255, 255, 255, 0.15)';
            btn.style.color = isActive ? 'white' : 'rgba(255, 255, 255, 0.7)';
            btn.style.borderColor = isActive ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.15)';
            btn.style.fontWeight = isActive ? '700' : '500';
        });

        // Update filter buttons
        filterBtns.forEach(btn => {
            const isActive = btn.dataset.filter === spreadFilter;
            btn.style.background = isActive ? 'linear-gradient(135deg, #1e6df2, #0a4bc2)' : 'rgba(255, 255, 255, 0.15)';
            btn.style.color = isActive ? 'white' : 'rgba(255, 255, 255, 0.7)';
            btn.style.borderColor = isActive ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.15)';
            btn.style.fontWeight = isActive ? '700' : '500';
        });

        // Update sports limit buttons
        sportsLimitBtns.forEach(btn => {
            const isActive = (btn.dataset.limit === 'true') === sportsScanLimit;
            btn.style.background = isActive ? 'linear-gradient(135deg, #1e6df2, #0a4bc2)' : 'rgba(255, 255, 255, 0.15)';
            btn.style.color = isActive ? 'white' : 'rgba(255, 255, 255, 0.7)';
            btn.style.borderColor = isActive ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.15)';
            btn.style.fontWeight = isActive ? '700' : '500';
        });

        // Update filter button labels with player names
        if (filterBtns.length >= 3) {
            filterBtns[1].textContent = spreadPlayer1Name || 'J1';
            filterBtns[2].textContent = spreadPlayer2Name || 'J2';
        }

        // Show/hide controls based on section type
        if (sectionType === 'All') {
            if (modeSelectorDiv) modeSelectorDiv.style.display = 'none';
            if (spreadFilterDiv) spreadFilterDiv.style.display = 'none';
        } else if (sectionType === 'Total Games') {
            if (modeSelectorDiv) modeSelectorDiv.style.display = 'flex';
            if (spreadFilterDiv) spreadFilterDiv.style.display = 'none';
        } else if (sectionType === 'Games Spread') {
            if (modeSelectorDiv) modeSelectorDiv.style.display = 'none';
            if (spreadFilterDiv) spreadFilterDiv.style.display = 'flex';
        }
    }

    // --- Match page extraction (Nombre de jeux odds) --------------------
    async function extractOddsFromMatch() {
        try {

            const heading = await waitForXPath("//div[contains(text(),'Nombre de jeux')]");
            if (!heading) throw new Error("Heading 'Nombre de jeux' not found");

            let sectionContainer = null;
            let node = heading.parentNode;
            while (node && node !== document.body) {
                const hasOdds = document.evaluate(".//div[starts-with(@data-testid, 'odd-button-')]", node, null, XPathResult.BOOLEAN_TYPE, null).booleanValue;
                if (hasOdds) { sectionContainer = node; break; }
                node = node.parentNode;
            }
            if (!sectionContainer) throw new Error("Section container not found");

            let currentOdds = xpathNodes(".//div[starts-with(@data-testid, 'odd-button-')]", sectionContainer);
            if (currentOdds.length <= 2) {
                const possibleToggles = xpathNodes(".//*[local-name()='svg' and .//*[local-name()='rect']]/parent::*", sectionContainer);
                let toggleClicked = false;
                for (let toggle of possibleToggles) {
                    if (toggle.click && toggle.innerText === '') {
                        toggle.click();
                        await sleep(500);
                        toggleClicked = true;
                        break;
                    }
                }
                if (!toggleClicked) {
                    const fallbackToggle = document.evaluate(".//*[contains(@class, 'hukOGC')]", sectionContainer, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                    if (fallbackToggle && fallbackToggle.click) {
                        fallbackToggle.click();
                        await sleep(500);
                    }
                }
            }

            let previousCount = 0;
            for (let i = 0; i < 10; i++) {
                const expandBtn = document.evaluate(
                    ".//div[contains(text(),'Plus de sélections')]/ancestor::div[contains(@class, 'expand-button') or contains(@class, 'expand')] | .//div[contains(text(),'Plus de sélections')]/..",
                    sectionContainer, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
                ).singleNodeValue;
                if (!expandBtn) break;
                if (expandBtn.innerText.trim().includes("Plus de sélections")) {
                    expandBtn.click();
                    await sleep(400);
                    const newOdds = xpathNodes(".//div[starts-with(@data-testid, 'odd-button-')]", sectionContainer);
                    if (newOdds.length === previousCount) break;
                    previousCount = newOdds.length;
                } else break;
            }

            const oddsButtons = xpathNodes(".//div[starts-with(@data-testid, 'odd-button-')]", sectionContainer);
            if (oddsButtons.length === 0) throw new Error("No odds buttons found");

            const oddsList = [];
            for (const btn of oddsButtons) {
                const valueSpan = document.evaluate(".//span[contains(@class, 'odd-button-value')]", btn, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                if (!valueSpan) continue;
                let oddValue = valueSpan.textContent.trim();
                const valueContainer = valueSpan.parentElement;
                const nameDiv = valueContainer.previousElementSibling;
                let name = nameDiv ? nameDiv.textContent.trim() : '';
                if (!name) {
                    const possibleNameDiv = document.evaluate(".//div[contains(text(),'Plus de') or contains(text(),'Moins de')]", btn, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                    if (possibleNameDiv) name = possibleNameDiv.textContent.trim();
                }
                if (name && oddValue) oddsList.push({ name, value: oddValue });
            }

            if (oddsList.length === 0) throw new Error("No odds extracted");

            // Group odds into Over (Plus de) and Under (Moins de)
            const overOdds = oddsList.filter(o => o.name.includes('Plus de'));
            const underOdds = oddsList.filter(o => o.name.includes('Moins de'));

            // Sort each group by odd value ascending
            const sortByValue = (a, b) => parseFloat(a.value.replace(',', '.')) - parseFloat(b.value.replace(',', '.'));
            overOdds.sort(sortByValue);
            underOdds.sort(sortByValue);

            // Format a single odd with Over/Under label
            const formatOdd = (o) => {
                const label = o.name.includes('Plus de') ? 'Over' : 'Under';
                const threshold = o.name.replace('Plus de ', '').replace('Moins de ', '');
                return `${label} ${threshold} jeux : ${o.value.replace(',', '.')}`;
            };

            // Build output based on selected mode
            let formattedOdds;
            if (oddsMode === 'over') {
                formattedOdds = overOdds.map(formatOdd);
            } else if (oddsMode === 'under') {
                formattedOdds = underOdds.map(formatOdd);
            } else {
                formattedOdds = [...overOdds.map(formatOdd), ...underOdds.map(formatOdd)];
            }

            lastExtractedData = formattedOdds.join('\n');
            await copyToClipboard(lastExtractedData);
            showProgress(`✅ ${formattedOdds.length} odds copied!`);
        } catch (err) {
            console.error(err);
            showProgress(`❌ Error: ${err.message}`, true);
        }
    }

    // --- Match page extraction (Écart de jeux odds) --------------------
    function detectSpreadPlayerNames() {
        // Try to find the "Écart de jeux" heading
        const heading = document.evaluate("//div[contains(text(),'Écart de jeux')]", document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        if (!heading) return;

        // Find the section container
        let sectionContainer = null;
        let node = heading.parentNode;
        while (node && node !== document.body) {
            const hasOdds = document.evaluate(".//div[starts-with(@data-testid, 'odd-button-')]", node, null, XPathResult.BOOLEAN_TYPE, null).booleanValue;
            if (hasOdds) { sectionContainer = node; break; }
            node = node.parentNode;
        }
        if (!sectionContainer) return;

        // Read existing odds (whatever is visible without clicking)
        const oddsButtons = xpathNodes(".//div[starts-with(@data-testid, 'odd-button-')]", sectionContainer);
        if (oddsButtons.length === 0) return;

        const uniquePlayers = new Set();
        for (const btn of oddsButtons) {
            const valueSpan = document.evaluate(".//span[contains(@class, 'odd-button-value')]", btn, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            if (!valueSpan) continue;
            const valueContainer = valueSpan.parentElement;
            const nameDiv = valueContainer.previousElementSibling;
            let name = nameDiv ? nameDiv.textContent.trim() : '';
            if (!name) {
                const possibleNameDiv = document.evaluate(".//div[contains(text(),'+') or contains(text(),'-')]", btn, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                if (possibleNameDiv) name = possibleNameDiv.textContent.trim();
            }
            if (name) {
                const match = name.match(/^(.+?)\s[+-]/);
                if (match) uniquePlayers.add(match[1].trim());
            }
        }

        const nameArray = Array.from(uniquePlayers).sort();
        if (nameArray.length >= 2) {
            spreadPlayer1Name = nameArray[0];
            spreadPlayer2Name = nameArray[1];
        } else if (nameArray.length === 1) {
            spreadPlayer1Name = nameArray[0];
        }
        updateSpreadFilterLabels();
    }

    function updateSpreadFilterLabels() {
        if (spreadFilterDiv) {
            const btns = spreadFilterDiv.children;
            if (btns.length >= 3) {
                btns[1].textContent = spreadPlayer1Name || 'J1';
                btns[2].textContent = spreadPlayer2Name || 'J2';
            }
        }
    }

    async function extractSpreadOddsFromMatch() {
        try {

            const heading = await waitForXPath("//div[contains(text(),'Écart de jeux')]");
            if (!heading) throw new Error("Heading 'Écart de jeux' not found");

            let sectionContainer = null;
            let node = heading.parentNode;
            while (node && node !== document.body) {
                const hasOdds = document.evaluate(".//div[starts-with(@data-testid, 'odd-button-')]", node, null, XPathResult.BOOLEAN_TYPE, null).booleanValue;
                if (hasOdds) { sectionContainer = node; break; }
                node = node.parentNode;
            }
            if (!sectionContainer) throw new Error("Section container not found");

            // Try to toggle to list view if needed
            let currentOdds = xpathNodes(".//div[starts-with(@data-testid, 'odd-button-')]", sectionContainer);
            if (currentOdds.length <= 2) {
                const possibleToggles = xpathNodes(".//*[local-name()='svg' and .//*[local-name()='rect']]/parent::*", sectionContainer);
                let toggleClicked = false;
                for (let toggle of possibleToggles) {
                    if (toggle.click && toggle.innerText === '') {
                        toggle.click();
                        await sleep(500);
                        toggleClicked = true;
                        break;
                    }
                }
                if (!toggleClicked) {
                    const fallbackToggle = document.evaluate(".//*[contains(@class, 'hukOGC')]", sectionContainer, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                    if (fallbackToggle && fallbackToggle.click) {
                        fallbackToggle.click();
                        await sleep(500);
                    }
                }
            }

            // Expand "Plus de sélections"
            let previousCount = 0;
            for (let i = 0; i < 10; i++) {
                const expandBtn = document.evaluate(
                    ".//div[contains(text(),'Plus de sélections')]/ancestor::div[contains(@class, 'expand-button') or contains(@class, 'expand')] | .//div[contains(text(),'Plus de sélections')]/..",
                    sectionContainer, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
                ).singleNodeValue;
                if (!expandBtn) break;
                if (expandBtn.innerText.trim().includes("Plus de sélections")) {
                    expandBtn.click();
                    await sleep(400);
                    const newOdds = xpathNodes(".//div[starts-with(@data-testid, 'odd-button-')]", sectionContainer);
                    if (newOdds.length === previousCount) break;
                    previousCount = newOdds.length;
                } else break;
            }

            const oddsButtons = xpathNodes(".//div[starts-with(@data-testid, 'odd-button-')]", sectionContainer);
            if (oddsButtons.length === 0) throw new Error("No odds buttons found");

            const oddsList = [];
            for (const btn of oddsButtons) {
                const valueSpan = document.evaluate(".//span[contains(@class, 'odd-button-value')]", btn, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                if (!valueSpan) continue;
                let oddValue = valueSpan.textContent.trim();
                const valueContainer = valueSpan.parentElement;
                const nameDiv = valueContainer.previousElementSibling;
                let name = nameDiv ? nameDiv.textContent.trim() : '';
                if (!name) {
                    const possibleNameDiv = document.evaluate(".//div[contains(text(),'+') or contains(text(),'-')]", btn, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                    if (possibleNameDiv) name = possibleNameDiv.textContent.trim();
                }
                if (name && oddValue) oddsList.push({ name, value: oddValue });
            }

            if (oddsList.length === 0) throw new Error("No odds extracted");

            // Detect player names from odds (text before +/- sign)
            const uniquePlayers = new Set();
            for (const o of oddsList) {
                const match = o.name.match(/^(.+?)\s[+-]/);
                if (match) uniquePlayers.add(match[1].trim());
            }
            const playerNamesArray = Array.from(uniquePlayers).sort();
            if (playerNamesArray.length >= 2) {
                spreadPlayer1Name = playerNamesArray[0];
                spreadPlayer2Name = playerNamesArray[1];
            } else if (playerNamesArray.length === 1) {
                spreadPlayer1Name = playerNamesArray[0];
            }
            updateSpreadFilterLabels();

            // Apply player filter
            let filteredOdds = oddsList;
            if (spreadFilter === 'player1' && spreadPlayer1Name) {
                filteredOdds = oddsList.filter(o => o.name.includes(spreadPlayer1Name));
            } else if (spreadFilter === 'player2' && spreadPlayer2Name) {
                filteredOdds = oddsList.filter(o => o.name.includes(spreadPlayer2Name));
            }

            // Group odds by player
            const playerOdds = {};
            for (const o of filteredOdds) {
                // Extract player name (text before the handicap)
                const match = o.name.match(/^(.+?)\s+([+-]\d+(?:[.,]\d+)?)$/);
                if (!match) continue;
                
                const playerName = match[1].trim();
                const handicap = match[2];
                
                if (!playerOdds[playerName]) {
                    playerOdds[playerName] = [];
                }
                
                // Store both the full name and the numeric value for sorting
                playerOdds[playerName].push({
                    full: o.name,
                    value: o.value,
                    handicap: parseFloat(handicap.replace(',', '.'))
                });
            }

            // Sort each player's odds by handicap value
            for (const player in playerOdds) {
                playerOdds[player].sort((a, b) => a.handicap - b.handicap);
            }

            // Format output - all of player1's odds first, then player2's
            const formattedOdds = [];
            for (const player in playerOdds) {
                for (const odd of playerOdds[player]) {
                    formattedOdds.push(`${odd.full} : ${odd.value}`);
                }
            }

            lastExtractedData = formattedOdds.join('\n');
            await copyToClipboard(lastExtractedData);
            showProgress(`✅ ${filteredOdds.length} odds copied!`);
        } catch (err) {
            console.error(err);
            showProgress(`❌ Error: ${err.message}`, true);
        }
    }

    // --- Match page extraction (Volleyball - ALL odds from ALL sections) -
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
        const title = headingEl.textContent.trim();
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

        const sectionOdds = [];
        for (const btn of oddsButtons) {
            const valueSpan = document.evaluate(".//span[contains(@class, 'odd-button-value')]", btn, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            if (!valueSpan) continue;
            let oddValue = valueSpan.textContent.trim();
            const valueContainer = valueSpan.parentElement;
            const nameDiv = valueContainer ? valueContainer.previousElementSibling : null;
            let name = nameDiv ? nameDiv.textContent.trim() : '';
            if (!name) {
                const possibleNameDiv = document.evaluate(".//div[contains(@class, 'fZKtql')]" , btn, null , XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                if (possibleNameDiv) name = possibleNameDiv.textContent.trim();
            }
            if (name && oddValue) {
                sectionOdds.push(`${name} : ${oddValue.replace(',', '.')}`);
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
        modeSelectorDiv = null;
        sectionSelectorDiv = null;
        spreadFilterDiv = null;
        if (progressTimeout) clearTimeout(progressTimeout);
        currentMode = null;
        lastExtractedData = '';
        extractedMatches = [];
        oddsMode = 'all';
        sectionType = 'Total Games';
        spreadFilter = 'all';
        spreadPlayer1Name = '';
        spreadPlayer2Name = '';
        sportsLimitSelectorDiv = null;
        sportsLimitBtns = [];
        sportsScanLimit = true;
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

    function createMainSelector() {
        if (sectionSelectorDiv) sectionSelectorDiv.remove();

        sectionSelectorDiv = document.createElement('div');
        sectionSelectorDiv.style.cssText = `
            display: flex;
            gap: 4px;
            justify-content: center;
        `;

        const sections = [
            { key: 'All', label: 'All' },
            { key: 'Total Games', label: 'Tennis Total Games' },
            { key: 'Games Spread', label: 'Tennis Games Spread' },
        ];

        sectionBtns = [];
        for (const s of sections) {
            const btn = document.createElement('button');
            btn.textContent = s.label;
            btn.dataset.section = s.key;
            btn.style.cssText = `
                background: rgba(255, 255, 255, 0.15);
                border: 1px solid rgba(255, 255, 255, 0.15);
                color: rgba(255, 255, 255, 0.7);
                font-size: 11px;
                font-weight: 500;
                padding: 4px 14px;
                min-width: 100px;
                border-radius: 20px;
                cursor: pointer;
                transition: all 0.2s ease;
                font-family: inherit;
                letter-spacing: 0.3px;
            `;
            btn.addEventListener('mouseenter', () => {
                if (btn.dataset.section !== sectionType) {
                    btn.style.background = 'rgba(255, 255, 255, 0.25)';
                }
            });
            btn.addEventListener('mouseleave', () => {
                if (btn.dataset.section !== sectionType) {
                    btn.style.background = 'rgba(255, 255, 255, 0.15)';
                }
            });
            btn.addEventListener('click', () => {
                sectionType = btn.dataset.section;
                updateAllButtons();
                // Update action button text
                if (actionBtn) {
                    if (sectionType === 'All') {
                        actionBtn.textContent = '🎾 Extract all odds';
                    } else {
                        actionBtn.textContent = '🎾 Extract odds';
                    }
                }
                // Detect player names when switching to Games Spread (deferred to avoid blocking UI)
                if (sectionType === 'Games Spread') {
                    setTimeout(() => detectSpreadPlayerNames(), 0);
                }
            });
            sectionBtns.push(btn);
            sectionSelectorDiv.appendChild(btn);
        }

        updateAllButtons();
        uiContainer.insertBefore(sectionSelectorDiv, actionBtn);
    }

    function createModeSelector() {
        if (modeSelectorDiv) modeSelectorDiv.remove();

        modeSelectorDiv = document.createElement('div');
        modeSelectorDiv.style.cssText = `
            display: flex;
            gap: 4px;
            justify-content: center;
        `;

        const modes = [
            { key: 'all', label: 'All' },
            { key: 'over', label: 'Over' },
            { key: 'under', label: 'Under' },
        ];

        modeBtns = [];
        for (const m of modes) {
            const btn = document.createElement('button');
            btn.textContent = m.label;
            btn.dataset.mode = m.key;
            btn.style.cssText = `
                background: rgba(255, 255, 255, 0.15);
                border: 1px solid rgba(255, 255, 255, 0.15);
                color: rgba(255, 255, 255, 0.7);
                font-size: 11px;
                font-weight: 500;
                padding: 4px 14px;
                min-width: 60px;
                border-radius: 20px;
                cursor: pointer;
                transition: all 0.2s ease;
                font-family: inherit;
                letter-spacing: 0.3px;
            `;
            btn.addEventListener('mouseenter', () => {
                if (btn.dataset.mode !== oddsMode) {
                    btn.style.background = 'rgba(255, 255, 255, 0.25)';
                }
            });
            btn.addEventListener('mouseleave', () => {
                if (btn.dataset.mode !== oddsMode) {
                    btn.style.background = 'rgba(255, 255, 255, 0.15)';
                }
            });
            btn.addEventListener('click', () => {
                oddsMode = btn.dataset.mode;
                updateAllButtons();
            });
            modeBtns.push(btn);
            modeSelectorDiv.appendChild(btn);
        }

        updateAllButtons();
        // Insert mode selector after section selector
        if (sectionSelectorDiv && sectionSelectorDiv.parentNode) {
            sectionSelectorDiv.after(modeSelectorDiv);
        } else {
            uiContainer.insertBefore(modeSelectorDiv, actionBtn);
        }
    }

    function createSpreadFilterSelector() {
        if (spreadFilterDiv) spreadFilterDiv.remove();

        spreadFilterDiv = document.createElement('div');
        spreadFilterDiv.style.cssText = `
            display: flex;
            gap: 4px;
            justify-content: center;
        `;

        const filters = [
            { key: 'all', label: 'All' },
            { key: 'player1', label: spreadPlayer1Name || 'J1' },
            { key: 'player2', label: spreadPlayer2Name || 'J2' },
        ];

        filterBtns = [];
        for (const f of filters) {
            const btn = document.createElement('button');
            btn.textContent = f.label;
            btn.dataset.filter = f.key;
            btn.style.cssText = `
                background: rgba(255, 255, 255, 0.15);
                border: 1px solid rgba(255, 255, 255, 0.15);
                color: rgba(255, 255, 255, 0.7);
                font-size: 11px;
                font-weight: 500;
                padding: 4px 14px;
                min-width: 60px;
                border-radius: 20px;
                cursor: pointer;
                transition: all 0.2s ease;
                font-family: inherit;
                letter-spacing: 0.3px;
            `;
            btn.addEventListener('mouseenter', () => {
                if (btn.dataset.filter !== spreadFilter) {
                    btn.style.background = 'rgba(255, 255, 255, 0.25)';
                }
            });
            btn.addEventListener('mouseleave', () => {
                if (btn.dataset.filter !== spreadFilter) {
                    btn.style.background = 'rgba(255, 255, 255, 0.15)';
                }
            });
            btn.addEventListener('click', () => {
                spreadFilter = btn.dataset.filter;
                updateAllButtons();
            });
            filterBtns.push(btn);
            spreadFilterDiv.appendChild(btn);
        }

        updateAllButtons();
        // Insert spread filter after mode selector (same slot, one visible at a time)
        if (modeSelectorDiv && modeSelectorDiv.parentNode) {
            modeSelectorDiv.after(spreadFilterDiv);
        } else {
            uiContainer.insertBefore(spreadFilterDiv, actionBtn);
        }
        // Initially hidden (only shown when Écart Jeux is selected)
        spreadFilterDiv.style.display = 'none';
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
                background: rgba(255, 255, 255, 0.15);
                border: 1px solid rgba(255, 255, 255, 0.15);
                color: rgba(255, 255, 255, 0.7);
                font-size: 11px;
                font-weight: 500;
                padding: 4px 14px;
                min-width: 100px;
                border-radius: 20px;
                cursor: pointer;
                transition: all 0.2s ease;
                font-family: inherit;
                letter-spacing: 0.3px;
            `;
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
                updateAllButtons();
            });
            sportsLimitBtns.push(btn);
            sportsLimitSelectorDiv.appendChild(btn);
        }

        updateAllButtons();
        uiContainer.insertBefore(sportsLimitSelectorDiv, actionBtn);
    }

    function createMatchUI() {
        createBaseUI();
        createMainSelector();
        createModeSelector();
        createSpreadFilterSelector();
        // Pre-populate player names from the DOM if available
        detectSpreadPlayerNames();
        
        // Set default action button text
        actionBtn.textContent = '🎾 Extract odds';
        
        actionBtn.onclick = async () => {
            if (actionBtn.disabled) return;
            actionBtn.disabled = true;
            const originalText = actionBtn.textContent;
            
            if (sectionType === 'All') {
                actionBtn.textContent = '⏳ Extracting all...';
                await extractAllOddsFromMatchVb();
            } else if (sectionType === 'Total Games') {
                actionBtn.textContent = '⏳ Extracting...';
                await extractOddsFromMatch();
            } else {
                actionBtn.textContent = '⏳ Extracting...';
                await extractSpreadOddsFromMatch();
            }
            
            actionBtn.disabled = false;
            actionBtn.textContent = originalText;
        };
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