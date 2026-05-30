// ==UserScript==
// @name         Winamax Tennis Tools
// @namespace    http://tampermonkey.net/
// @version      4.0
// @description  Extracts "Number of Games" & "Game Spread" odds from tennis match pages OR upcoming singles matches from the tennis sports page. Features dynamic UI, clipboard copy, dark/light theme, and scroll scanning.
// @match        https://www.winamax.fr/*
// @updateURL    https://raw.githubusercontent.com/anthony-rm/useful-tool/main/script.js
// @downloadURL  https://raw.githubusercontent.com/anthony-rm/useful-tool/main/script.js
// @grant        GM_setClipboard
// ==/UserScript==

(function() {
    'use strict';

    // --- Shared helpers -------------------------------------------------
    function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

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
    let sectionType = 'nombre-de-jeux'; // 'nombre-de-jeux' or 'ecart-de-jeux'
    let sectionSelectorDiv = null;     // section toggle UI container
    let spreadFilter = 'all';          // 'all', 'player1', 'player2' for spread mode
    let spreadFilterDiv = null;        // spread filter UI container
    let spreadPlayer1Name = '';        // detected player 1 name
    let spreadPlayer2Name = '';        // detected player 2 name

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
                return `${label} ${threshold} : ${o.value}`;
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
            GM_setClipboard(lastExtractedData, 'text');
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
            const btns = spreadFilterDiv.querySelectorAll('button');
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

            // Group by handicap absolute value and sort
            const grouped = {};
            for (const o of filteredOdds) {
                const match = o.name.match(/([+-]\d+(?:[.,]\d+)?)/);
                const key = match ? match[1] : o.name;
                if (!grouped[key]) grouped[key] = [];
                grouped[key].push(o);
            }

            // Sort handicap keys numerically
            const sortedKeys = Object.keys(grouped).sort((a, b) => {
                const numA = parseFloat(a.replace(',', '.'));
                const numB = parseFloat(b.replace(',', '.'));
                return numA - numB;
            });

            const formattedOdds = [];
            for (const key of sortedKeys) {
                const items = grouped[key];
                // Each handicap group has 2 items (one per player)
                formattedOdds.push(items.map(o => `${o.name} : ${o.value}`).join(' | '));
            }

            lastExtractedData = formattedOdds.join('\n');
            GM_setClipboard(lastExtractedData, 'text');
            showProgress(`✅ ${filteredOdds.length} odds copied!`);
        } catch (err) {
            console.error(err);
            showProgress(`❌ Error: ${err.message}`, true);
        }
    }

    // --- Sports page extraction (upcoming singles matches) --------------
    function findScrollableContainer() {
        const grid = document.querySelector('.ReactVirtualized__Grid');
        if (!grid) return window;
        let el = grid.parentElement;
        while (el && el !== document.body) {
            const style = getComputedStyle(el);
            if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) return el;
            el = el.parentElement;
        }
        return window;
    }

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
        const cards = document.querySelectorAll('[data-testid^="match-card-"]');
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
            if (gap > NIGHT_GAP_THRESHOLD) {
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
            try {
                await navigator.clipboard.writeText(formatted);
            } catch (err) {
                try { GM_setClipboard(formatted, 'text'); } catch(e) { console.error(e); }
            }

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
        sectionType = 'nombre-de-jeux';
        spreadFilter = 'all';
        spreadPlayer1Name = '';
        spreadPlayer2Name = '';
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

        const updateModeBtns = () => {
            modeBtns.forEach(btn => {
                const isActive = btn.dataset.mode === oddsMode;
                btn.style.background = isActive
                    ? 'linear-gradient(135deg, #1e6df2, #0a4bc2)'
                    : 'rgba(255, 255, 255, 0.15)';
                btn.style.color = isActive ? 'white' : 'rgba(255, 255, 255, 0.7)';
                btn.style.borderColor = isActive ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.15)';
                btn.style.fontWeight = isActive ? '700' : '500';
            });
        };

        const modeBtns = [];
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
                updateModeBtns();
            });
            modeBtns.push(btn);
            modeSelectorDiv.appendChild(btn);
        }

        updateModeBtns();
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

        const updateFilterBtns = () => {
            filterBtns.forEach(btn => {
                const isActive = btn.dataset.filter === spreadFilter;
                btn.style.background = isActive
                    ? 'linear-gradient(135deg, #1e6df2, #0a4bc2)'
                    : 'rgba(255, 255, 255, 0.15)';
                btn.style.color = isActive ? 'white' : 'rgba(255, 255, 255, 0.7)';
                btn.style.borderColor = isActive ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.15)';
                btn.style.fontWeight = isActive ? '700' : '500';
            });
            // Update button labels with player names if available
            if (filterBtns.length >= 3) {
                filterBtns[1].textContent = spreadPlayer1Name || 'J1';
                filterBtns[2].textContent = spreadPlayer2Name || 'J2';
            }
        };

        const filterBtns = [];
        const filters = [
            { key: 'all', label: 'All' },
            { key: 'player1', label: spreadPlayer1Name || 'J1' },
            { key: 'player2', label: spreadPlayer2Name || 'J2' },
        ];

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
                updateFilterBtns();
            });
            filterBtns.push(btn);
            spreadFilterDiv.appendChild(btn);
        }

        updateFilterBtns();
        // Insert spread filter after mode selector (same slot, one visible at a time)
        if (modeSelectorDiv && modeSelectorDiv.parentNode) {
            modeSelectorDiv.after(spreadFilterDiv);
        } else {
            uiContainer.insertBefore(spreadFilterDiv, actionBtn);
        }
        // Initially hidden (only shown when Écart Jeux is selected)
        spreadFilterDiv.style.display = 'none';
    }

    function createSectionSelector() {
        if (sectionSelectorDiv) sectionSelectorDiv.remove();

        sectionSelectorDiv = document.createElement('div');
        sectionSelectorDiv.style.cssText = `
            display: flex;
            gap: 4px;
            justify-content: center;
        `;

        const sections = [
            { key: 'Total Games', label: 'Total Games' },
            { key: 'Games Spread', label: 'Games Spread' },
        ];

        const updateSectionBtns = () => {
            sectionBtns.forEach(btn => {
                const isActive = btn.dataset.section === sectionType;
                btn.style.background = isActive
                    ? 'linear-gradient(135deg, #1e6df2, #0a4bc2)'
                    : 'rgba(255, 255, 255, 0.15)';
                btn.style.color = isActive ? 'white' : 'rgba(255, 255, 255, 0.7)';
                btn.style.borderColor = isActive ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.15)';
                btn.style.fontWeight = isActive ? '700' : '500';
            });
            // Show/hide mode and spread filter selectors based on section
            if (modeSelectorDiv) {
                modeSelectorDiv.style.display = sectionType === 'Total Games' ? 'flex' : 'none';
            }
            if (spreadFilterDiv) {
                spreadFilterDiv.style.display = sectionType === 'Games Spread' ? 'flex' : 'none';
            }
        };

        const sectionBtns = [];
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
                min-width: 80px;
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
                updateSectionBtns();
                // Update action button text
                if (actionBtn) {
                    actionBtn.textContent = sectionType === 'Total Games' ? '🎾 Extract odds' : '🎾 Extract odds';
                }
                // Detect player names when switching to Games Spread
                if (sectionType === 'Games Spread') {
                    detectSpreadPlayerNames();
                }
            });
            sectionBtns.push(btn);
            sectionSelectorDiv.appendChild(btn);
        }

        updateSectionBtns();
        // Insert section selector before actionBtn (first in the options row)
        uiContainer.insertBefore(sectionSelectorDiv, actionBtn);
    }

    function createMatchUI() {
        createBaseUI();
        createSectionSelector();
        createModeSelector();
        createSpreadFilterSelector();
        // Pre-populate player names from the DOM if available
        detectSpreadPlayerNames();
        actionBtn.textContent = '🎾 Extract odds';
        actionBtn.onclick = async () => {
            if (actionBtn.disabled) return;
            actionBtn.disabled = true;
            const originalText = actionBtn.textContent;
            actionBtn.textContent = '⏳ Extracting...';
            if (sectionType === 'Total Games') {
                await extractOddsFromMatch();
            } else {
                await extractSpreadOddsFromMatch();
            }
            actionBtn.disabled = false;
            actionBtn.textContent = originalText;
        };
        currentMode = 'match';
    }

    function createSportsUI() {
        createBaseUI();
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