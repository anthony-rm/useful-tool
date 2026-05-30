// ==UserScript==
// @name         Winamax Tennis Tools
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  Extracts "Number of Games" odds from tennis match pages OR upcoming singles matches from the tennis sports page. Features dynamic UI, clipboard copy, dark/light theme, and scroll scanning.
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
    let copyBtn = null;        // secondary button (Copy)
    let progressTimeout = null;
    let currentMode = null;
    let lastExtractedData = '';   // for match mode
    let extractedMatches = [];     // for sports mode

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
            showProgress("🔍 Searching for 'Nombre de jeux' section...");

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
                        showProgress("🔄 Switching to list view...");
                        toggle.click();
                        await sleep(500);
                        toggleClicked = true;
                        break;
                    }
                }
                if (!toggleClicked) {
                    const fallbackToggle = document.evaluate(".//*[contains(@class, 'hukOGC')]", sectionContainer, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
                    if (fallbackToggle && fallbackToggle.click) {
                        showProgress("🔄 Switching to list view (fallback)...");
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
                    showProgress(`📂 Expanding selections (step ${i+1}/10)...`);
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

            lastExtractedData = oddsList.map(o => `${o.name} : ${o.value}`).join('\n');
            GM_setClipboard(lastExtractedData, 'text');
            showProgress(`✅ ${oddsList.length} odds copied!`);
            if (copyBtn) copyBtn.style.display = 'block';
        } catch (err) {
            console.error(err);
            showProgress(`❌ Error: ${err.message}`, true);
            if (copyBtn) copyBtn.style.display = 'none';
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
        let crossedToTomorrow = false;
        let lastTimeMinutes = -1;

        // Filter initial matches: only today's matches (no day indicator)
        let initialMatches = extractCurrentMatches();
        for (let m of initialMatches) {
            const key = `${m.player1}|${m.player2}|${m.tournament}|${m.round}`;
            allSeen.set(key, m);
            if (crossedToTomorrow) continue;
            if (m.dayIndicator) {
                // If the very first matches already have a day indicator,
                // it means there are no matches today at all
                crossedToTomorrow = true;
                continue;
            }
            const mins = timeToMinutes(m.matchTime);
            if (lastTimeMinutes !== -1 && mins < lastTimeMinutes) {
                // Time went backwards: crossed midnight into next day
                crossedToTomorrow = true;
                continue;
            }
            lastTimeMinutes = mins;
            todayMatches.set(key, m);
        }
        if (onProgress) onProgress(todayMatches.size);

        // If we already crossed to tomorrow from initial view, stop early
        if (crossedToTomorrow) {
            if (scrollable === window) window.scrollTo(0, window.scrollY);
            return Array.from(todayMatches.values());
        }

        let noNewCount = 0;
        const MAX_NO_NEW = 8;
        const originalScrollTop = (scrollable === window) ? window.scrollY : scrollable.scrollTop;

        while (noNewCount < MAX_NO_NEW && !crossedToTomorrow) {
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

                if (crossedToTomorrow) continue;

                // Stop if we see a day indicator (Demain, lun., mar., etc.)
                if (m.dayIndicator) {
                    crossedToTomorrow = true;
                    continue;
                }

                const mins = timeToMinutes(m.matchTime);
                if (lastTimeMinutes !== -1 && mins < lastTimeMinutes) {
                    // Time went backwards: crossed midnight into next day
                    crossedToTomorrow = true;
                    continue;
                }

                lastTimeMinutes = mins;
                todayMatches.set(key, m);
                added++;
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
        if (copyBtn) copyBtn.style.display = 'none';
        showProgress('🔍 Scanning for upcoming tennis matches...');

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
            let copySuccess = false;
            try {
                await navigator.clipboard.writeText(formatted);
                copySuccess = true;
            } catch (err) {
                try { GM_setClipboard(formatted, 'text'); copySuccess = true; } catch(e) { console.error(e); }
            }

            if (copySuccess) {
                showProgress(`✅ Found ${extractedMatches.length} match${extractedMatches.length > 1 ? 'es' : ''}. Copied to clipboard!`);
            } else {
                showProgress(`✅ Found ${extractedMatches.length} match${extractedMatches.length > 1 ? 'es' : ''}. Copy failed, use button below.`, true);
            }
            if (copyBtn) copyBtn.style.display = 'block';
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

    async function handleSportsCopy() {
        if (!extractedMatches.length) return;
        const formatted = formatMatches(extractedMatches);
        try {
            await navigator.clipboard.writeText(formatted);
            showProgress(`📋 Copied ${extractedMatches.length} match${extractedMatches.length > 1 ? 'es' : ''}!`);
        } catch (err) {
            try { GM_setClipboard(formatted, 'text'); showProgress(`📋 Copied ${extractedMatches.length} match${extractedMatches.length > 1 ? 'es' : ''}!`); }
            catch(e) { showProgress('❌ Copy failed.', true); console.log(formatted); }
        }
    }

    // --- UI Creation / Destruction --------------------------------------
    function removeUI() {
        if (uiContainer && uiContainer.parentNode) uiContainer.parentNode.removeChild(uiContainer);
        uiContainer = null;
        progressDiv = null;
        actionBtn = null;
        copyBtn = null;
        if (progressTimeout) clearTimeout(progressTimeout);
        currentMode = null;
        lastExtractedData = '';
        extractedMatches = [];
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
            padding: 10px 24px;
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

        copyBtn = document.createElement('button');
        copyBtn.textContent = '📋 Copy';
        copyBtn.style.cssText = `
            background: linear-gradient(135deg, #2c9e5c, #1e6b3e);
            border: none;
            color: white;
            font-size: 14px;
            font-weight: 600;
            padding: 10px 24px;
            border-radius: 40px;
            cursor: pointer;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
            transition: all 0.2s cubic-bezier(0.2, 0.9, 0.4, 1.1);
            letter-spacing: 0.5px;
            backdrop-filter: blur(4px);
            border: 1px solid rgba(255, 255, 255, 0.2);
            display: none;
        `;
        copyBtn.addEventListener('mouseenter', () => {
            copyBtn.style.transform = 'translateY(-2px) scale(1.02)';
            copyBtn.style.boxShadow = '0 8px 20px rgba(0, 0, 0, 0.3)';
        });
        copyBtn.addEventListener('mouseleave', () => {
            copyBtn.style.transform = 'translateY(0) scale(1)';
            copyBtn.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.25)';
        });

        uiContainer.appendChild(progressDiv);
        uiContainer.appendChild(actionBtn);
        uiContainer.appendChild(copyBtn);
        document.body.appendChild(uiContainer);
    }

    function createMatchUI() {
        createBaseUI();
        actionBtn.textContent = '🎾 Extract odds';
        actionBtn.onclick = async () => {
            if (actionBtn.disabled) return;
            actionBtn.disabled = true;
            copyBtn.style.display = 'none';
            const originalText = actionBtn.textContent;
            actionBtn.textContent = '⏳ Extracting...';
            await extractOddsFromMatch();
            actionBtn.disabled = false;
            actionBtn.textContent = originalText;
        };
        copyBtn.onclick = () => {
            if (lastExtractedData) {
                GM_setClipboard(lastExtractedData, 'text');
                showProgress("📋 Odds copied!");
            } else {
                showProgress("⚠️ No data to copy", true);
            }
        };
        currentMode = 'match';
    }

    function createSportsUI() {
        createBaseUI();
        actionBtn.textContent = '🎾 Extract Matches';
        actionBtn.onclick = () => handleSportsExtract();
        copyBtn.onclick = () => handleSportsCopy();
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