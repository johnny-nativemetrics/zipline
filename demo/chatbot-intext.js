(function () {
    'use strict';

    // ─── InText integration: set this before the script loads if your InText
    //     API lives on a different origin than the page.
    //     e.g. window.INTEXT_API_BASE = 'https://api.yourdomain.com';
    //     If not set, falls back to window.location.origin.

    const CHATBOT_ENTRY_POINT_DEFAULT = 'default';
    const CHATBOT_ENTRY_POINT_ALIASES = {
        default: 'default',
        ask_anything: 'ask_anything',
        askanything: 'ask_anything',
        'ask-anything': 'ask_anything'
    };

    const CHATBOT_NAME = 'AskAnything';
    const CHATBOT_LAUNCHER_TITLE = 'Ask Anything About This Topic';
    const CHATBOT_WINDOW_TITLE = 'Ask Zipline!';
    const CHATBOT_INPUT_PLACEHOLDER = 'Ask anything about this topic...';
    const CHATBOT_LAUNCHER_DEFAULTS = {
        variant: 'default',
        ctaText: CHATBOT_LAUNCHER_TITLE,
        inputPlaceholder: 'Ask anything about this topic...',
        primaryColor: '#49aff6',
        secondaryColor: '#49aff6',
        textColor: '#ffffff',
        badgeText: '',
        badgeColor: 'rgba(255, 255, 255, 0.85)',
        badgeTextColor: '#3143b8'
    };
    const BOLT_SVG = '<svg class="zippy-bolt" viewBox="0 0 483.73 483.73" aria-hidden="true"><polygon fill="currentColor" points="119.637,282.441 192.449,282.441 165.869,483.73 364.094,189.622 296.631,189.622 325.678,0"></polygon></svg>';
    const CHAT_BUBBLE_SVG = '<svg class="zippy-chat-bubble" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path stroke-width="2" d="M12.005 10.5h.008m3.987 0h.009m-8 0h.009"></path><path stroke-width="1.5" d="M2 10.5c0-.77.013-1.523.04-2.25c.083-2.373.125-3.56 1.09-4.533c.965-.972 2.186-1.024 4.626-1.129A100 100 0 0 1 12 2.5c1.48 0 2.905.03 4.244.088c2.44.105 3.66.157 4.626 1.13c.965.972 1.007 2.159 1.09 4.532a64 64 0 0 1 0 4.5c-.083 2.373-.125 3.56-1.09 4.533c-.965.972-2.186 1.024-4.626 1.129q-1.102.047-2.275.07c-.74.014-1.111.02-1.437.145s-.6.358-1.148.828l-2.179 1.87A.73.73 0 0 1 8 20.77v-2.348l-.244-.01c-2.44-.105-3.66-.157-4.626-1.13c-.965-.972-1.007-2.159-1.09-4.532A64 64 0 0 1 2 10.5"></path></g></svg>';

    class ZippyChatbot {
        constructor() {
            this.ws = null;
            this.isOpen = false;
            this.pageContent = null;
            this.suggestedQuestions = [];
            this.currentStreamingMessage = null;
            this.currentStreamingContent = '';
            this.hasAutoOpened = false;
            this.markedReady = false;
            this.launcherConfig = Object.assign({}, CHATBOT_LAUNCHER_DEFAULTS);
            this.publisherConfig = null;
            this.launcherContainer = null;
            this.launcherPill = null;
            this.launcherExpanded = false;
            this.launcherBlurTimer = null;
            this.launcherSubmitting = false;
            this.launcherHideTimer = null;
            this.launcherViewportHandler = null;
            this.windowVisibilityObserver = null;

            this.reconnectAttempts = 0;
            this.maxReconnectAttempts = 8;
            this.isReconnecting = false;
            this.pingKeepaliveIntervalId = null;

            this.startTime = Date.now();
            this.streamingStartTime = null;
            this.responseComplete = false;
            this.variation = CHATBOT_NAME;
            this.trackingUrl = 'https://e.nativemetrics-svc.com/event';

            this.abTestAssignment = null;
            this.abTestConfig = null;
            this.abTestAssignmentComplete = false;
            this.sessionId = this.generateSessionId();
            this.sessionTokenUsage = null;
            this.abTestApiUrl = window.CHATBOT_AB_TEST_API_URL || window.location.origin + '/api/v1/ab-tests/chatbot';

            this.channelId = this.getChannelIdFromScript();
            this.psid = this.getPsidFromScript();

            this.entryPoint = this.resolveEntryPoint();

            this.init();
        }

        resolveEntryPoint() {
            let raw = '';
            if (typeof window !== 'undefined' && window.CHATBOT_ENTRY_POINT != null && String(window.CHATBOT_ENTRY_POINT).trim() !== '') {
                raw = String(window.CHATBOT_ENTRY_POINT).trim();
            } else {
                const p = this.getScriptParams();
                raw = this.firstNonEmpty(p.entry_point, p.entryPoint, p.ep) || '';
            }
            if (!raw) return CHATBOT_ENTRY_POINT_DEFAULT;
            const key = String(raw).trim().toLowerCase().replace(/-/g, '_');
            const resolved = CHATBOT_ENTRY_POINT_ALIASES[key] || CHATBOT_ENTRY_POINT_ALIASES[String(raw).trim().toLowerCase()];
            if (resolved) return resolved;
            console.warn('[Zippy] Unknown entry_point:', raw, '– using', CHATBOT_ENTRY_POINT_DEFAULT);
            return CHATBOT_ENTRY_POINT_DEFAULT;
        }

        getPsidFromScript() {
            if (typeof window !== 'undefined' && window.CHATBOT_PSID) {
                return String(window.CHATBOT_PSID).trim();
            }
            const params = this.getScriptParams();
            return (params.psid || '').trim();
        }

        getPubIdFromScript() {
            if (typeof window !== 'undefined' && window.CHATBOT_PUBID) {
                return String(window.CHATBOT_PUBID).trim();
            }
            const params = this.getScriptParams();
            return (params.pubid || '').trim();
        }

        getPublisherApiBaseFromScript() {
            if (typeof window !== 'undefined' && window.CHATBOT_PUBLISHER_API_BASE) {
                return String(window.CHATBOT_PUBLISHER_API_BASE).trim();
            }
            const params = this.getScriptParams();
            return (params.publisher_api_base || params.publisherApiBase || params.cms_api_base || params.cmsApiBase || '').trim();
        }

        firstNonEmpty() {
            for (let i = 0; i < arguments.length; i++) {
                const value = arguments[i];
                if (value != null && String(value).trim() !== '') {
                    return String(value).trim();
                }
            }
            return '';
        }

        normalizeLauncherVariant(value) {
            const raw = String(value || '').toLowerCase().trim();
            if (raw === 'animated-light' || raw === 'light' || raw === 'button-animated-light') return 'animated-light';
            if (raw === 'animated-dark' || raw === 'dark' || raw === 'button-animated-dark') return 'animated-dark';
            return 'default';
        }

        getLauncherConfigSource() {
            const scriptParams = this.getScriptParams();
            const abConfig = this.abTestConfig && typeof this.abTestConfig === 'object' ? this.abTestConfig : {};
            const publisherConfig = this.publisherConfig || {};
            return {
                variant: this.firstNonEmpty(
                    scriptParams.launcher_variant,
                    scriptParams.button_variant,
                    abConfig.launcher_variant,
                    abConfig.button_variant,
                    publisherConfig.launcher_variant
                ),
                ctaText: this.firstNonEmpty(
                    scriptParams.launcher_cta_text,
                    scriptParams.cta_text,
                    scriptParams.cta,
                    scriptParams.button_text,
                    abConfig.launcher_cta_text,
                    abConfig.cta_text,
                    abConfig.cta,
                    abConfig.button_text,
                    publisherConfig.launcher_cta_text
                ),
                inputPlaceholder: this.firstNonEmpty(
                    scriptParams.input_placeholder,
                    scriptParams.inputPlaceholder,
                    abConfig.input_placeholder,
                    abConfig.inputPlaceholder,
                    publisherConfig.input_placeholder,
                    publisherConfig.inputPlaceholder
                ),
                primaryColor: this.firstNonEmpty(
                    scriptParams.launcher_primary_color,
                    scriptParams.primary_color,
                    scriptParams.button_primary,
                    abConfig.launcher_primary_color,
                    abConfig.primary_color,
                    abConfig.button_primary,
                    publisherConfig.launcher_primary_color
                ),
                secondaryColor: this.firstNonEmpty(
                    scriptParams.launcher_secondary_color,
                    scriptParams.secondary_color,
                    scriptParams.button_secondary,
                    abConfig.launcher_secondary_color,
                    abConfig.secondary_color,
                    abConfig.button_secondary,
                    publisherConfig.launcher_secondary_color
                ),
                textColor: this.firstNonEmpty(
                    scriptParams.launcher_text_color,
                    scriptParams.text_color,
                    scriptParams.button_text_color,
                    abConfig.launcher_text_color,
                    abConfig.text_color,
                    abConfig.button_text_color,
                    publisherConfig.launcher_text_color
                ),
                badgeText: this.firstNonEmpty(
                    scriptParams.launcher_badge_text,
                    scriptParams.badge_text,
                    scriptParams.button_badge_text,
                    abConfig.launcher_badge_text,
                    abConfig.badge_text,
                    abConfig.button_badge_text,
                    publisherConfig.launcher_badge_text
                ),
                badgeColor: this.firstNonEmpty(
                    scriptParams.launcher_badge_color,
                    scriptParams.badge_color,
                    scriptParams.button_badge_color,
                    abConfig.launcher_badge_color,
                    abConfig.badge_color,
                    abConfig.button_badge_color,
                    publisherConfig.launcher_badge_color
                ),
                badgeTextColor: this.firstNonEmpty(
                    scriptParams.launcher_badge_text_color,
                    scriptParams.badge_text_color,
                    scriptParams.button_badge_text_color,
                    abConfig.launcher_badge_text_color,
                    abConfig.badge_text_color,
                    abConfig.button_badge_text_color,
                    publisherConfig.launcher_badge_text_color
                )
            };
        }

        buildLauncherConfig() {
            const source = this.getLauncherConfigSource();
            const variant = this.normalizeLauncherVariant(source.variant);
            const isAnimated = variant === 'animated-light' || variant === 'animated-dark';
            return {
                variant,
                ctaText: source.ctaText || CHATBOT_LAUNCHER_DEFAULTS.ctaText,
                inputPlaceholder: source.inputPlaceholder || CHATBOT_LAUNCHER_DEFAULTS.inputPlaceholder,
                primaryColor: source.primaryColor || (variant === 'animated-dark' ? '#52e5ff' : CHATBOT_LAUNCHER_DEFAULTS.primaryColor),
                secondaryColor: source.secondaryColor || (variant === 'animated-dark' ? '#8b5cf6' : CHATBOT_LAUNCHER_DEFAULTS.secondaryColor),
                textColor: source.textColor || (variant === 'animated-dark' ? '#effbff' : CHATBOT_LAUNCHER_DEFAULTS.textColor),
                badgeText: source.badgeText || (isAnimated ? 'AI' : CHATBOT_LAUNCHER_DEFAULTS.badgeText),
                badgeColor: source.badgeColor || (variant === 'animated-dark' ? 'rgba(7, 15, 34, 0.8)' : CHATBOT_LAUNCHER_DEFAULTS.badgeColor),
                badgeTextColor: source.badgeTextColor || (variant === 'animated-dark' ? '#9fe8ff' : CHATBOT_LAUNCHER_DEFAULTS.badgeTextColor)
            };
        }

        applyLauncherConfig() {
            this.launcherConfig = this.buildLauncherConfig();
            if (this.entryPoint === 'ask_anything' && this.launcherContainer) {
                this.launcherContainer.style.setProperty('--zippy-launcher-primary', this.launcherConfig.primaryColor || '');
                this.launcherContainer.style.setProperty('--zippy-launcher-secondary', this.launcherConfig.secondaryColor || '');
                this.launcherContainer.style.setProperty('--zippy-launcher-text', this.launcherConfig.textColor || '');
                this.launcherContainer.style.setProperty('--zippy-launcher-badge-bg', this.launcherConfig.badgeColor || '');
                this.launcherContainer.style.setProperty('--zippy-launcher-badge-text', this.launcherConfig.badgeTextColor || '');
            }
            if (this.entryPoint === 'ask_anything') {
                const label = document.getElementById('zippy-pill-label');
                if (label && this.launcherConfig.ctaText) {
                    label.textContent = this.launcherConfig.ctaText;
                }
                if (this.launcherPill && this.launcherConfig.ctaText) {
                    this.launcherPill.setAttribute('aria-label', this.launcherConfig.ctaText);
                }
                const input = document.getElementById('zippy-pill-input');
                if (input && this.launcherConfig.inputPlaceholder) {
                    input.placeholder = this.launcherConfig.inputPlaceholder;
                    input.setAttribute('aria-label', this.launcherConfig.inputPlaceholder);
                }
                const badge = document.getElementById('zippy-pill-badge');
                if (badge) {
                    if (this.launcherConfig.badgeText) {
                        badge.textContent = this.launcherConfig.badgeText;
                        badge.style.display = '';
                    } else {
                        badge.textContent = '';
                        badge.style.display = 'none';
                    }
                }
            } else {
                const toggle = document.getElementById('zippy-toggle');
                if (toggle) {
                    if (this.launcherConfig.ctaText) {
                        toggle.setAttribute('aria-label', this.launcherConfig.ctaText);
                    }
                    const p = this.launcherConfig.primaryColor || '#667eea';
                    const s = this.launcherConfig.secondaryColor || '#764ba2';
                    toggle.style.background = `linear-gradient(135deg, ${p} 0%, ${s} 100%)`;
                }
            }
        }

        async loadPublisherConfig() {
            const pubid = this.getPubIdFromScript();
            const publisherApiBase = this.getPublisherApiBaseFromScript();
            if (!pubid || !publisherApiBase) {
                this.publisherConfig = null;
                this.applyLauncherConfig();
                return null;
            }

            try {
                const base = publisherApiBase.replace(/\/$/, '');
                const response = await fetch(`${base}/publishers/config?pubid=${encodeURIComponent(pubid)}`);
                if (!response.ok) {
                    this.publisherConfig = null;
                    this.applyLauncherConfig();
                    return null;
                }
                this.publisherConfig = await response.json();
                this.applyLauncherConfig();
                return this.publisherConfig;
            } catch (error) {
                console.warn('AskAnything: Failed to load publisher config', error);
                this.publisherConfig = null;
                this.applyLauncherConfig();
                return null;
            }
        }

        getScriptParams() {
            let script = document.currentScript;
            if (!script || !script.src) {
                const scripts = document.getElementsByTagName('script');
                for (let i = scripts.length - 1; i >= 0; i--) {
                    if (scripts[i].src && scripts[i].src.indexOf('chatbot.js') !== -1) {
                        script = scripts[i];
                        break;
                    }
                }
            }
            if (!script || !script.src) return {};
            const qStart = script.src.indexOf('?');
            if (qStart === -1) return {};
            const q = script.src.slice(qStart + 1);
            const params = {};
            q.split('&').forEach(function (pair) {
                const eq = pair.indexOf('=');
                if (eq !== -1) {
                    params[decodeURIComponent(pair.slice(0, eq).replace(/\+/g, ' '))] =
                        decodeURIComponent((pair.slice(eq + 1) || '').replace(/\+/g, ' '));
                }
            });
            return params;
        }

        getChannelIdFromScript() {
            if (typeof window !== 'undefined' && window.CHATBOT_CHANNEL_ID) {
                return this.normalizeChannelId(String(window.CHATBOT_CHANNEL_ID));
            }
            const params = this.getScriptParams();
            const raw = params.channel_id || params.channelid || '';
            return this.normalizeChannelId(raw);
        }

        normalizeChannelId(raw) {
            let s = String(raw || '').trim();
            while (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
                s = s.slice(1, -1).trim();
            }
            return s;
        }

        readBypassCacheFromPageUrl() {
            try {
                const params = new URLSearchParams(window.location.search);
                const keys = ['bypasscache', 'bypassCache', 'bypass_cache'];
                for (let i = 0; i < keys.length; i++) {
                    const v = String(params.get(keys[i]) || '').trim().toLowerCase();
                    if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
                }
            } catch (e) { /* ignore */ }
            return false;
        }

        getCookie(name) {
            const value = `; ${document.cookie}`;
            const parts = value.split(`; ${name}=`);
            if (parts.length === 2) return parts.pop().split(';').shift();
            return null;
        }

        setCookie(name, value, minutes) {
            const date = new Date();
            date.setTime(date.getTime() + (minutes * 60 * 1000));
            const expires = `expires=${date.toUTCString()}`;
            document.cookie = `${name}=${value}; ${expires}; path=/`;
        }

        setCookieForever(name, value) {
            const maxDate = new Date('9999-12-31T23:59:59Z');
            const expires = `expires=${maxDate.toUTCString()}`;
            document.cookie = `${name}=${value}; ${expires}; path=/; SameSite=Lax`;
        }

        getUserId() {
            let domain = '';
            try {
                const urlObj = new URL(window.location.href);
                domain = urlObj.hostname;
            } catch (e) {
                domain = window.location.hostname;
            }

            const STORAGE_KEY = `zippy_user_id_${domain}`;
            const COOKIE_NAME = `zippy_user_id_${domain}`;

            try {
                let userId = localStorage.getItem(STORAGE_KEY);
                if (userId) {
                    return userId;
                }
            } catch (e) {}

            let userId = this.getCookie(COOKIE_NAME);
            if (userId) {
                try {
                    localStorage.setItem(STORAGE_KEY, userId);
                } catch (e) {}
                return userId;
            }

            userId = 'zippy_user_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);

            try {
                localStorage.setItem(STORAGE_KEY, userId);
            } catch (e) {}
            this.setCookieForever(COOKIE_NAME, userId);

            return userId;
        }

        generateSessionId() {
            const SESSION_COOKIE_NAME = 'zippy_session_id';
            const SESSION_TIMESTAMP_COOKIE_NAME = 'zippy_session_timestamp';
            const SESSION_DURATION_MINUTES = 10;

            let sessionId = this.getCookie(SESSION_COOKIE_NAME);
            const sessionTimestamp = this.getCookie(SESSION_TIMESTAMP_COOKIE_NAME);

            if (sessionId && sessionTimestamp) {
                const sessionAge = Date.now() - parseInt(sessionTimestamp, 10);
                const sessionAgeMinutes = sessionAge / (1000 * 60);

                if (sessionAgeMinutes < SESSION_DURATION_MINUTES) {
                    return sessionId;
                }
            }

            sessionId = 'zippy_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            const timestamp = Date.now().toString();

            this.setCookie(SESSION_COOKIE_NAME, sessionId, SESSION_DURATION_MINUTES);
            this.setCookie(SESSION_TIMESTAMP_COOKIE_NAME, timestamp, SESSION_DURATION_MINUTES);

            return sessionId;
        }

        refreshSessionIfNeeded() {
            const SESSION_TIMESTAMP_COOKIE_NAME = 'zippy_session_timestamp';
            const SESSION_DURATION_MINUTES = 10;

            const sessionTimestamp = this.getCookie(SESSION_TIMESTAMP_COOKIE_NAME);
            if (sessionTimestamp) {
                const sessionAge = Date.now() - parseInt(sessionTimestamp, 10);
                const sessionAgeMinutes = sessionAge / (1000 * 60);

                if (sessionAgeMinutes >= SESSION_DURATION_MINUTES) {
                    this.sessionId = this.generateSessionId();
                }
            } else {
                this.sessionId = this.generateSessionId();
            }
        }

        // ─── Core init ──────────────────────────────────────────────────────────

        init() {
            this.createWidget();
            this.setupWindowVisibilityObserver();
            this.scrapePageContent();
            this.loadMarked();
            this.setupMobileResizeHandler();
            this.setupTrackingHandlers();
            this.loadPublisherConfig();
            this.checkABTestAssignment();
            this.initIntext(); // ← InText integration
        }

        // ─── InText: initialisation ─────────────────────────────────────────────

        initIntext() {
            this._intextTermsPromise = null; // cached fetch promise
            this._intextTerms        = null; // resolved term array
            this._intextPopover      = null; // shared popover DOM node
            this._intextActiveMark   = null; // currently active mark button
            this._intextHideTimer    = null;
            this._intextUsedTerms    = new Set();

            // Pre-warm the terms cache immediately so it's ready by the time
            // the first response finishes streaming.
            this._fetchIntextTerms();

            // Reposition the popover if the viewport or scroll position changes.
            window.addEventListener('resize', () => {
                if (this._intextActiveMark) this._intextPositionPopover(this._intextActiveMark);
            });
            document.addEventListener('scroll', () => {
                if (this._intextActiveMark) this._intextPositionPopover(this._intextActiveMark);
            }, true);
        }

        // ─── InText: terms fetching ─────────────────────────────────────────────

        _intextApiBase() {
            return (window.INTEXT_API_BASE || window.location.origin).replace(/\/$/, '');
        }

        _fetchIntextTerms() {
            if (this._intextTermsPromise) return this._intextTermsPromise;

            const pageUrl = window.location.href.split('#')[0];
            let url = `${this._intextApiBase()}/api/v1/intext/terms?url=${encodeURIComponent(pageUrl)}`;
            if (this.channelId) url += `&channel_id=${encodeURIComponent(this.channelId)}`;
            if (this.sessionId) url += `&session_id=${encodeURIComponent(this.sessionId)}`;

            this._intextTermsPromise = fetch(url, { credentials: 'omit' })
                .then(r => {
                    if (!r.ok) throw new Error(`terms fetch ${r.status}`);
                    return r.json();
                })
                .then(payload => {
                    const terms = Array.isArray(payload?.terms) ? payload.terms : [];
                    this._intextTerms = terms;
                    return terms;
                })
                .catch(err => {
                    console.warn('[Zippy InText] failed to load terms:', err);
                    this._intextTerms = [];
                    return [];
                });

            return this._intextTermsPromise;
        }

        // ─── InText: public highlight entry point ───────────────────────────────
        // Called by finishStreamingMessage() with the bot's .zippy-message-content el.

        highlightIntextTerms(el) {
            this._ensureIntextPopover();
            this._fetchIntextTerms().then(apiTerms => {
                const articleTerms = this._scrapeArticleTerms();
                // API terms take priority (they have definitions); article <strong> terms fill the gaps
                const apiPhrases = new Set(apiTerms.map(t => t.phrase.toLowerCase()));
                const merged = [
                    ...apiTerms,
                    ...articleTerms.filter(t => !apiPhrases.has(t.phrase.toLowerCase()))
                ];
                merged
                    .filter(term => !this._intextUsedTerms.has(term.phrase.toLowerCase()))
                    .forEach(term => {
                        const matched = this._intextHighlightTermInEl(el, term);
                        if (matched) this._intextUsedTerms.add(term.phrase.toLowerCase());
                    });
            });
        }

        // ─── InText: DOM walker & mark injection ────────────────────────────────

        _intextEscapeRegExp(str) {
            return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        }

        _intextHighlightTermInEl(el, term) {
            const regex = new RegExp(`\\b${this._intextEscapeRegExp(term.phrase)}\\b`, 'gi');
            const skipTags = /^(script|style|button|a|textarea|input|code|pre)$/;

            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
                acceptNode: node => {
                    if (!node.nodeValue?.trim()) return NodeFilter.FILTER_REJECT;
                    const tag = node.parentNode?.nodeName?.toLowerCase() ?? '';
                    if (skipTags.test(tag)) return NodeFilter.FILTER_REJECT;
                    if (node.parentNode?.closest?.('.zipline-intext-mark')) return NodeFilter.FILTER_REJECT;
                    regex.lastIndex = 0;
                    return regex.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
                }
            });

            const nodes = [];
            while (walker.nextNode()) nodes.push(walker.currentNode);

            let didMatch = false;

            nodes.forEach(node => {
                const text = node.nodeValue;
                regex.lastIndex = 0;
                const fragment = document.createDocumentFragment();
                let lastIndex = 0, match;

                while ((match = regex.exec(text)) !== null) {
                    if (match.index > lastIndex) {
                        fragment.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
                    }
                    fragment.appendChild(this._intextCreateMark(term));
                    lastIndex = match.index + match[0].length;
                }
                if (lastIndex < text.length) {
                    fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
                }
                node.parentNode.replaceChild(fragment, node);
                didMatch = true;
            });

            return didMatch;
        }

        _scrapeArticleTerms() {
            const article = document.querySelector('article, main, [role="main"]');
            if (!article) return [];
            const seen = new Set();
            const terms = [];
            article.querySelectorAll('strong, b').forEach(el => {
                const phrase = el.textContent.trim();
                if (!phrase || phrase.length < 3) return;
                const key = phrase.toLowerCase();
                if (seen.has(key)) return;
                seen.add(key);
                terms.push({
                    phrase,
                    label: phrase,
                    definition: '',
                    follow_up_question: `Tell me more about ${phrase}`
                });
            });
            return terms;
        }

        _intextCreateMark(term) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'zipline-intext-mark';
            btn.textContent = term.phrase;
            btn.setAttribute('aria-label', `Ask about: ${term.label || term.phrase}`);

            const isTouch = () =>
                !!(window.matchMedia?.('(hover: none)')?.matches ||
                   window.matchMedia?.('(pointer: coarse)')?.matches);

            btn.addEventListener('mouseenter', () => {
                if (!isTouch()) this._intextShowPopover(btn, term);
            });
            btn.addEventListener('mouseleave', () => this._intextScheduleHide());
            btn.addEventListener('focus',      () => this._intextShowPopover(btn, term));
            btn.addEventListener('blur',       () => this._intextScheduleHide());

            btn.addEventListener('click', e => {
                e.preventDefault();
                e.stopPropagation();

                if (isTouch()) {
                    // First tap → show popover so user reads definition first.
                    const isOpen = this._intextPopover?.getAttribute('data-open') === 'true';
                    if (this._intextActiveMark !== btn || !isOpen) {
                        this._intextShowPopover(btn, term, true);
                        return;
                    }
                    // Second tap on same mark → send.
                }

                // Desktop click / second touch tap: send directly to chat.
                this._intextSendTerm(term);
            });

            return btn;
        }

        // ─── InText: popover ────────────────────────────────────────────────────

        _ensureIntextPopover() {
            if (this._intextPopover) return this._intextPopover;

            const popover = document.createElement('div');
            popover.className = 'zipline-intext-popover';
            popover.innerHTML =
                '<div class="zipline-intext-chip"></div>' +
                '<p class="zipline-intext-definition"></p>' +
                '<button type="button" class="zipline-intext-cta">' +
                    '<span class="zipline-intext-cta-label"></span>' +
                    '<span class="zipline-intext-cta-arrow">&#8250;</span>' +
                '</button>';
            document.body.appendChild(popover);

            popover.addEventListener('mouseenter', () => this._intextClearHideTimer());
            popover.addEventListener('mouseleave', () => this._intextScheduleHide());

            // Tap/click outside → dismiss.
            document.addEventListener('pointerdown', e => {
                if (!this._intextActiveMark) return;
                if (this._intextActiveMark.contains(e.target)) return;
                if (popover.contains(e.target)) return;
                this._intextHidePopover();
            });

            this._intextPopover = popover;
            return popover;
        }

        _intextShowPopover(mark, term, forceTouch = false) {
            const isTouch = !!(window.matchMedia?.('(hover: none)')?.matches ||
                            window.matchMedia?.('(pointer: coarse)')?.matches);
            if (isTouch && !forceTouch) return;

            const popover = this._ensureIntextPopover();
            this._intextClearHideTimer();

            if (this._intextActiveMark && this._intextActiveMark !== mark) {
                this._intextActiveMark.setAttribute('data-active', 'false');
            }
            this._intextActiveMark = mark;
            mark.setAttribute('data-active', 'true');

            popover.querySelector('.zipline-intext-chip').textContent = term.label || term.phrase;

            const defEl = popover.querySelector('.zipline-intext-definition');
            defEl.textContent = term.definition || '';
            defEl.style.display = term.definition ? '' : 'none';

            const ctaLabel = term.follow_up_question || `Tell me more about ${term.label || term.phrase}`;
            popover.querySelector('.zipline-intext-cta-label').textContent = ctaLabel;
            popover.querySelector('.zipline-intext-cta').onclick = e => {
                e.preventDefault();
                this._intextSendTerm(term);
            };

            popover.setAttribute('data-open', 'true');
            this._intextPositionPopover(mark);
        }

        _intextHidePopover() {
            this._intextClearHideTimer();
            if (this._intextActiveMark) this._intextActiveMark.setAttribute('data-active', 'false');
            this._intextActiveMark = null;
            this._intextPopover?.removeAttribute('data-open');
        }

        _intextClearHideTimer() {
            if (!this._intextHideTimer) return;
            clearTimeout(this._intextHideTimer);
            this._intextHideTimer = null;
        }

        _intextScheduleHide() {
            this._intextClearHideTimer();
            this._intextHideTimer = setTimeout(() => this._intextHidePopover(), 180);
        }

        _intextPositionPopover(mark) {
            const popover = this._intextPopover;
            if (!popover) return;
            const gap  = 14;
            const rect = mark.getBoundingClientRect();

            let top  = rect.bottom + gap;
            let left = rect.left + rect.width / 2 - popover.offsetWidth / 2;

            if (left < 12) left = 12;
            if (left + popover.offsetWidth > window.innerWidth - 12) {
                left = window.innerWidth - popover.offsetWidth - 12;
            }
            if (top + popover.offsetHeight > window.innerHeight - 12) {
                top = rect.top - popover.offsetHeight - gap;
            }
            if (top < 12) top = 12;

            popover.style.left = `${left}px`;
            popover.style.top  = `${top}px`;
        }

        // ─── InText: send term question into the chat ───────────────────────────

        _intextSendTerm(term) {
            this._intextHidePopover();
            const question = term.follow_up_question || `Tell me more about ${term.label || term.phrase}`;

            if (!this.isOpen) this.open({ focusInput: false });

            const doSend = () => this.sendQuestion(question);
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                this.waitForWebSocketOpen(4000).then(ready => { if (ready) doSend(); });
            } else {
                doSend();
            }
        }

        // ─── A/B testing ────────────────────────────────────────────────────────

        async checkABTestAssignment() {
            try {
                const response = await fetch(`${this.abTestApiUrl}/assign`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        session_id: this.sessionId,
                        user_id: null
                    })
                });

                if (response.ok) {
                    const assignment = await response.json();

                    if (!assignment || !assignment.variant_name) {
                        console.log('Zippy: No active A/B test (empty or null response)');
                        this.abTestAssignment = null;
                        this.abTestConfig = null;
                        this.abTestAssignmentComplete = true;
                        return;
                    }

                    this.abTestAssignment = assignment;

                    if (assignment.configuration) {
                        try {
                            if (typeof assignment.configuration === 'string') {
                                this.abTestConfig = JSON.parse(assignment.configuration);
                            } else if (typeof assignment.configuration === 'object') {
                                this.abTestConfig = assignment.configuration;
                            } else {
                                this.abTestConfig = null;
                            }
                            console.log('Zippy: A/B test config parsed:', this.abTestConfig, 'from:', assignment.configuration);
                        } catch (e) {
                            console.warn('Zippy: Failed to parse A/B test configuration:', e, 'Raw config:', assignment.configuration);
                            this.abTestConfig = null;
                        }
                    } else {
                        this.abTestConfig = null;
                        console.log('Zippy: No A/B test configuration (null)');
                    }
                    this.applyLauncherConfig();

                    this.logABTestEvent('chatbot_assigned', {
                        variant_name: assignment.variant_name,
                        is_control: assignment.is_control
                    });
                } else if (response.status === 404 || response.status === 403) {
                    this.abTestAssignment = null;
                    this.abTestConfig = null;
                    if (response.status === 403) {
                        console.log('Zippy: User excluded from A/B test traffic, using default behavior');
                    }
                }
                this.applyLauncherConfig();
                this.abTestAssignmentComplete = true;
            } catch (error) {
                console.warn('Zippy: Failed to check A/B test assignment:', error);
                this.abTestAssignment = null;
                this.abTestConfig = null;
                this.applyLauncherConfig();
                this.abTestAssignmentComplete = true;
            }
        }

        async logABTestEvent(eventType, eventData = {}) {
            if (!this.abTestAssignment) {
                return;
            }

            try {
                await fetch(`${this.abTestApiUrl}/log-event`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        session_id: this.sessionId,
                        user_id: null,
                        event_type: eventType,
                        event_data: JSON.stringify(eventData)
                    })
                });
            } catch (error) {
                console.warn('Zippy: Failed to log A/B test event:', error);
            }
        }

        setupMobileResizeHandler() {
            let resizeTimer;
            window.addEventListener('resize', () => {
                clearTimeout(resizeTimer);
                resizeTimer = setTimeout(() => {
                    if (this.isOpen && window.innerWidth <= 480) {
                        this.adjustMobilePosition();
                    }
                }, 100);
            });
        }

        setupTrackingHandlers() {
            window.addEventListener('beforeunload', () => {
                const duration = Math.round((Date.now() - this.startTime) / 1000);
                this.sendEvent('chatbot_page_duration', { duration_seconds: duration });
            });

            this.sendEvent('chatbot_page_view', {
                referrer: document.referrer,
                screen_resolution: `${window.screen.width}x${window.screen.height}`,
                viewport_size: `${window.innerWidth}x${window.innerHeight}`
            });
        }

        getTrackingPayload(eventData = {}) {
            this.refreshSessionIfNeeded();

            const urlParams = {};
            const searchParams = new URLSearchParams(window.location.search);
            for (const [key, value] of searchParams.entries()) {
                urlParams[key] = value;
            }

            const currentUrl = window.location.href;
            let domain = '';
            try {
                const urlObj = new URL(currentUrl);
                domain = urlObj.hostname;
            } catch (e) {
                domain = window.location.hostname;
            }

            return {
                timestamp: new Date().toISOString(),
                url: currentUrl,
                domain: domain,
                referrer: document.referrer || '',
                url_parameters: urlParams,
                user_agent: navigator.userAgent,
                language: navigator.language,
                variation: this.variation,
                session_id: this.sessionId,
                user_id: this.getUserId(),
                channel_id: this.channelId || '',
                entry_point: this.entryPoint || CHATBOT_ENTRY_POINT_DEFAULT,
                input_tokens: this.sessionTokenUsage?.input_tokens ?? null,
                output_tokens: this.sessionTokenUsage?.output_tokens ?? null,
                total_tokens: this.sessionTokenUsage?.total_tokens ?? null,
                ...eventData
            };
        }

        sendEvent(eventType, data = {}, useBeacon = false) {
            const payload = this.getTrackingPayload(data);

            const searchParams = new URLSearchParams(window.location.search).toString();
            const url = `${this.trackingUrl}/${eventType}${searchParams ? '?' + searchParams : ''}`;

            console.log(`[Zippy Tracking] ${eventType}`, payload);

            const navigationEvents = ['chatbot_page_duration', 'chatbot_ad_click', 'chatbot_sponsored_link_click'];
            const shouldUseBeacon = useBeacon || (navigationEvents.includes(eventType) && navigator.sendBeacon);

            if (shouldUseBeacon) {
                fetch(url, {
                    method: 'POST',
                    mode: 'no-cors',
                    keepalive: true,
                    credentials: 'omit',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }).catch(() => {});
            } else {
                fetch(url, {
                    method: 'POST',
                    mode: 'no-cors',
                    credentials: 'omit',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }).catch(err => {
                    console.error(`[Zippy Tracking] ${eventType} FAILED:`, err);
                });
            }

            if (eventType === 'ad_click' || eventType === 'sponsored_link_click' ||
                eventType === 'chatbot_ad_click' || eventType === 'chatbot_sponsored_link_click') {
                this.trackClickToPostgres(eventType, payload);
            }
        }

        trackClickToPostgres(eventType, payload) {
            let backendUrl = window.CHATBOT_BACKEND_URL || window.location.origin;

            const clickData = {
                user_id: payload.user_id || null,
                session_id: payload.session_id || null,
                domain: payload.domain || null,
                url: payload.url || window.location.href,
                container_id: payload.container_id || null,
                link_url: payload.link_url || null,
                link_text: payload.link_text || null,
                query: payload.query || null,
                event_type: eventType,
                clicked_element: payload.clicked_element || null,
                clicked_element_class: payload.clicked_element_class || null,
                referrer: payload.referrer || document.referrer || null,
                user_agent: payload.user_agent || navigator.userAgent || null
            };

            fetch(`${backendUrl}/api/track-click`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(clickData)
            }).catch(err => {
                console.error(`[Zippy Tracking] Failed to track click to Postgres:`, err);
            });
        }

        getChatWindowHTML() {
            return `
                <div id="zippy-chatbot-window" class="zippy-window" style="display: none;">
                    <div class="zippy-resize-handle zippy-resize-tl" data-corner="tl"></div>
                    <div class="zippy-resize-handle zippy-resize-tr" data-corner="tr"></div>
                    <div class="zippy-resize-handle zippy-resize-bl" data-corner="bl"></div>
                    <div class="zippy-resize-handle zippy-resize-br" data-corner="br"></div>
                    <div class="zippy-header">
                        <div class="zippy-title">
                            <span class="zippy-icon" aria-hidden="true">${BOLT_SVG}</span>
                            <span class="zippy-title-text">${CHATBOT_WINDOW_TITLE}</span>
                            <span class="zippy-ai-pill">AI</span>
                        </div>
                        <button class="zippy-close" id="zippy-close-btn">×</button>
                    </div>
                    <div class="zippy-messages" id="zippy-messages"></div>
                    <div class="zippy-suggestions" id="zippy-suggestions"></div>
                    <div class="zippy-input-container">
                        <input type="text" id="zippy-input" name="chatbot-query" class="zippy-input" placeholder="${CHATBOT_INPUT_PLACEHOLDER}" autocomplete="off" data-1p-ignore data-lpignore="true" data-form-type="other" role="textbox" aria-label="Chatbot question input">
                        <button id="zippy-send-btn" class="zippy-send-btn">Send</button>
                    </div>
                </div>
            `;
        }

        getLauncherSectionHTML() {
            if (this.entryPoint === 'ask_anything') {
                return `
                <div id="zippy-pill-container">
                    <div id="zippy-pill" class="zippy-pill" role="button" tabindex="0" aria-label="${CHATBOT_LAUNCHER_TITLE}">
                        <span class="zippy-pill-dots" aria-hidden="true">
                            <span class="zippy-pill-dot"></span>
                            <span class="zippy-pill-dot"></span>
                            <span class="zippy-pill-dot"></span>
                        </span>
                        <span class="zippy-pill-label" id="zippy-pill-label">${CHATBOT_LAUNCHER_TITLE}</span>
                        <span class="zippy-pill-badge" id="zippy-pill-badge" style="display:none"></span>
                    </div>
                    <div id="zippy-pill-expanded" class="zippy-pill-input-wrapper" role="search">
                        <input type="text" id="zippy-pill-input" class="zippy-pill-input-field" placeholder="${CHATBOT_INPUT_PLACEHOLDER}" autocomplete="off" aria-label="${CHATBOT_INPUT_PLACEHOLDER}" data-1p-ignore data-lpignore="true" data-form-type="other">
                        <button id="zippy-pill-send" class="zippy-pill-send-btn">Send</button>
                    </div>
                </div>
            `;
            }
            const aria = this.escapeHtml(this.launcherConfig.ctaText || CHATBOT_LAUNCHER_TITLE);
            return `
                <button type="button" id="zippy-toggle" class="zippy-toggle" aria-label="${aria}">
                    <span class="zippy-toggle-icon" aria-hidden="true">${BOLT_SVG}</span>
                </button>
            `;
        }

        attachLauncherSectionListeners() {
            if (this.entryPoint === 'ask_anything') {
                this.launcherPill.addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (!this.isOpen) {
                        if (this.abTestAssignment) {
                            this.logABTestEvent('chatbot_button_clicked');
                        }
                        this.expandLauncher();
                    }
                });
                this.launcherPill.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        if (!this.isOpen) {
                            this.expandLauncher();
                        }
                    }
                });
                document.getElementById('zippy-pill-send').addEventListener('click', () => this.handleLauncherSend());
                document.getElementById('zippy-pill-input').addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        this.handleLauncherSend();
                    }
                    if (e.key === 'Escape') {
                        e.preventDefault();
                        this.collapseLauncher(true);
                    }
                });
                document.getElementById('zippy-pill-input').addEventListener('focus', () => this.startLauncherViewportWatch());
                document.getElementById('zippy-pill-input').addEventListener('blur', () => {
                    clearTimeout(this.launcherBlurTimer);
                    this.launcherBlurTimer = setTimeout(() => {
                        if (this.launcherSubmitting) return;
                        const active = document.activeElement;
                        if (active !== document.getElementById('zippy-pill-send') && active !== document.getElementById('zippy-pill-input')) {
                            this.collapseLauncher(true);
                        }
                    }, 200);
                });
                return;
            }

            const toggle = document.getElementById('zippy-toggle');
            if (!toggle) return;
            toggle.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.isOpen) return;
                if (this.abTestAssignment) {
                    this.logABTestEvent('chatbot_button_clicked');
                }
                this.open();
            });
            toggle.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    if (!this.isOpen) {
                        if (this.abTestAssignment) {
                            this.logABTestEvent('chatbot_button_clicked');
                        }
                        this.open();
                    }
                }
            });
        }

        createWidget() {
            const container = document.createElement('div');
            container.id = 'zippy-chatbot-container';
            container.setAttribute('data-zippy-entry-point', this.entryPoint);
            container.innerHTML = this.getLauncherSectionHTML() + this.getChatWindowHTML();
            document.body.appendChild(container);

            if (this.entryPoint === 'ask_anything') {
                this.launcherContainer = document.getElementById('zippy-pill-container');
                this.launcherPill = document.getElementById('zippy-pill');
            } else {
                this.launcherContainer = null;
                this.launcherPill = null;
            }

            this.applyLauncherConfig();
            this.attachLauncherSectionListeners();

            document.getElementById('zippy-close-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                this.close();
            });
            document.getElementById('zippy-send-btn').addEventListener('click', () => this.sendQuestion());
            document.getElementById('zippy-input').addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    this.sendQuestion();
                }
            });

            let typingTimer;
            document.getElementById('zippy-input').addEventListener('input', () => {
                clearTimeout(typingTimer);
                const inputValue = document.getElementById('zippy-input').value;
                typingTimer = setTimeout(() => {
                    if (inputValue.trim().length > 0) {
                        this.sendEvent('chatbot_question_typed', {
                            question: inputValue,
                            input_length: inputValue.length
                        });
                    }
                }, 2000);
            });

            container.addEventListener('click', (e) => {
                this.sendEvent('chatbot_widget_click', {
                    element_id: e.target.id,
                    element_tag: e.target.tagName,
                    element_class: e.target.className
                });
            });

            this.initResizeHandles();
            this.initDrag();
        }

        setupWindowVisibilityObserver() {
            const windowEl = document.getElementById('zippy-chatbot-window');
            if (!windowEl || this.windowVisibilityObserver) return;

            this.windowVisibilityObserver = new MutationObserver(() => {
                const isOpenNow = windowEl.style.display === 'flex';
                if (isOpenNow) {
                    this.isOpen = true;
                    this.hideLauncherPill();
                } else if (this.isOpen) {
                    this.isOpen = false;
                    this.showLauncherPill(true);
                }
            });

            this.windowVisibilityObserver.observe(windowEl, { attributes: true, attributeFilter: ['style'] });
        }

        hideLauncherPill() {
            if (this.entryPoint === 'ask_anything') {
                if (!this.launcherContainer) return;
                clearTimeout(this.launcherHideTimer);
                this.launcherContainer.classList.remove('zippy-pill-returning');
                this.launcherContainer.classList.add('zippy-pill-leaving');
                this.launcherHideTimer = setTimeout(() => {
                    if (this.launcherContainer) {
                        this.launcherContainer.style.display = 'none';
                        this.launcherContainer.classList.remove('zippy-pill-leaving');
                    }
                }, 180);
                return;
            }
            const t = document.getElementById('zippy-toggle');
            if (t) t.style.display = 'none';
        }

        showLauncherPill(isReturn) {
            if (this.entryPoint === 'ask_anything') {
                if (!this.launcherContainer) return;
                clearTimeout(this.launcherHideTimer);
                this.launcherHideTimer = null;
                this.launcherContainer.style.display = '';
                this.launcherContainer.classList.remove('zippy-pill-leaving');
                this.launcherContainer.classList.remove('zippy-pill-returning');
                if (isReturn) {
                    void this.launcherContainer.offsetWidth;
                    this.launcherContainer.classList.add('zippy-pill-returning');
                    setTimeout(() => {
                        if (this.launcherContainer) {
                            this.launcherContainer.classList.remove('zippy-pill-returning');
                        }
                    }, 400);
                }
                return;
            }
            const t = document.getElementById('zippy-toggle');
            if (t) t.style.display = '';
        }

        startLauncherViewportWatch() {
            if (this.launcherViewportHandler || !window.visualViewport) return;
            this.launcherViewportHandler = () => {
                const kbHeight = window.innerHeight - window.visualViewport.height - window.visualViewport.offsetTop;
                if (this.launcherContainer) {
                    this.launcherContainer.style.bottom = kbHeight > 60 ? `${kbHeight + 12}px` : '';
                }
            };
            window.visualViewport.addEventListener('resize', this.launcherViewportHandler);
            window.visualViewport.addEventListener('scroll', this.launcherViewportHandler);
            this.launcherViewportHandler();
        }

        stopLauncherViewportWatch() {
            if (!this.launcherViewportHandler || !window.visualViewport) return;
            window.visualViewport.removeEventListener('resize', this.launcherViewportHandler);
            window.visualViewport.removeEventListener('scroll', this.launcherViewportHandler);
            this.launcherViewportHandler = null;
            if (this.launcherContainer) {
                this.launcherContainer.style.bottom = '';
            }
        }

        expandLauncher() {
            if (!this.launcherContainer) return;
            const pill = document.getElementById('zippy-pill');
            const expanded = document.getElementById('zippy-pill-expanded');
            const input = document.getElementById('zippy-pill-input');
            if (!pill || !expanded || !input) return;

            pill.style.display = 'none';
            expanded.classList.add('zippy-pill-active');
            this.launcherExpanded = true;
            this.startLauncherViewportWatch();
            setTimeout(() => {
                input.focus();
                input.select();
            }, 0);
        }

        collapseLauncher(clearValue = true, revealPill = true) {
            const pill = document.getElementById('zippy-pill');
            const expanded = document.getElementById('zippy-pill-expanded');
            const input = document.getElementById('zippy-pill-input');
            if (!pill || !expanded || !input) return;

            expanded.classList.remove('zippy-pill-active');
            if (clearValue) {
                input.value = '';
            }
            pill.style.display = revealPill ? '' : 'none';
            this.launcherExpanded = false;
            this.launcherSubmitting = false;
            this.stopLauncherViewportWatch();
            clearTimeout(this.launcherBlurTimer);
            this.launcherBlurTimer = null;
        }

        waitForWebSocketOpen(timeoutMs = 5000) {
            return new Promise((resolve) => {
                const start = Date.now();
                const check = () => {
                    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                        resolve(true);
                        return;
                    }
                    if (Date.now() - start >= timeoutMs) {
                        resolve(false);
                        return;
                    }
                    setTimeout(check, 50);
                };
                check();
            });
        }

        setNativeInputValue(input, value) {
            if (!input) return;
            const descriptor = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
            if (descriptor && descriptor.set) {
                descriptor.set.call(input, value);
            } else {
                input.value = value;
            }
        }

        waitForPaint(frames = 1) {
            return new Promise((resolve) => {
                const step = (remaining) => {
                    if (remaining <= 0) {
                        resolve();
                        return;
                    }
                    requestAnimationFrame(() => step(remaining - 1));
                };
                step(Math.max(1, frames));
            });
        }

        async handleLauncherSend() {
            if (this.entryPoint !== 'ask_anything') return;
            if (this.launcherSubmitting) return;
            const input = document.getElementById('zippy-pill-input');
            const text = input ? input.value.trim() : '';
            if (!text) {
                if (input) input.focus();
                return;
            }

            this.launcherSubmitting = true;
            clearTimeout(this.launcherBlurTimer);
            this.launcherBlurTimer = null;
            this.stopLauncherViewportWatch();
            this.hideLauncherPill();

            if (!this.isOpen) {
                this.open({ focusInput: false, preserveLauncherHidden: true });
            }

            await new Promise((resolve) => setTimeout(resolve, 320));
            const chatInput = document.getElementById('zippy-input');
            if (chatInput) {
                this.setNativeInputValue(chatInput, text);
                chatInput.dispatchEvent(new Event('input', { bubbles: true }));
                chatInput.dispatchEvent(new Event('change', { bubbles: true }));
                chatInput.focus();
            }

            await this.waitForPaint(2);
            const wsReady = await this.waitForWebSocketOpen(5000);
            this.collapseLauncher(true, false);

            if (wsReady) {
                this.sendQuestion();
            } else if (chatInput) {
                chatInput.focus();
            }

            setTimeout(() => {
                this.launcherSubmitting = false;
            }, 600);
        }

        initResizeHandles() {
            const window = document.getElementById('zippy-chatbot-window');
            const handles = window.querySelectorAll('.zippy-resize-handle');

            handles.forEach(handle => {
                handle.addEventListener('mousedown', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.startResize(e, handle.dataset.corner);
                });
            });
        }

        initDrag() {
            const header = document.querySelector('.zippy-header');
            const closeBtn = document.getElementById('zippy-close-btn');

            header.addEventListener('mousedown', (e) => {
                if (e.target === closeBtn || closeBtn.contains(e.target)) {
                    return;
                }
                e.preventDefault();
                this.startDrag(e);
            });

            header.style.cursor = 'move';
        }

        startDrag(e) {
            const windowEl = document.getElementById('zippy-chatbot-window');
            const container = windowEl.parentElement;

            e.preventDefault();
            windowEl.style.transform = 'none';

            const windowRect = windowEl.getBoundingClientRect();
            const shiftX = e.clientX - windowRect.left;
            const shiftY = e.clientY - windowRect.top;

            const onMouseMove = (e) => {
                const containerRect = container.getBoundingClientRect();

                let newLeft = e.clientX - shiftX - containerRect.left;
                let newTop = e.clientY - shiftY - containerRect.top;

                const maxLeft = window.innerWidth - windowEl.offsetWidth - containerRect.left;
                const maxTop = window.innerHeight - windowEl.offsetHeight - containerRect.top;
                const minLeft = -containerRect.left;
                const minTop = -containerRect.top;

                newLeft = Math.max(minLeft, Math.min(newLeft, maxLeft));
                newTop = Math.max(minTop, Math.min(newTop, maxTop));

                windowEl.style.left = newLeft + 'px';
                windowEl.style.right = 'auto';
                windowEl.style.top = newTop + 'px';
                windowEl.style.bottom = 'auto';
            };

            const onMouseUp = () => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            document.body.style.cursor = 'move';
            document.body.style.userSelect = 'none';
        }

        startResize(e, corner) {
            const windowEl = document.getElementById('zippy-chatbot-window');
            const container = windowEl.parentElement;
            const containerRect = container.getBoundingClientRect();
            const windowRect = windowEl.getBoundingClientRect();
            windowEl.style.transform = 'none';

            const computedStyle = getComputedStyle(windowEl);
            const startX = e.clientX;
            const startY = e.clientY;
            const startWidth = windowRect.width;
            const startHeight = windowRect.height;

            const startLeft = parseFloat(computedStyle.left) || 0;
            const startBottom = parseFloat(computedStyle.bottom) || 80;
            const startTop = parseFloat(computedStyle.top) || (containerRect.height - startBottom - startHeight);

            const minWidth = 320;
            const minHeight = 400;
            const maxWidth = window.innerWidth - 40;
            const maxHeight = window.innerHeight - 120;

            const onMouseMove = (e) => {
                const deltaX = e.clientX - startX;
                const deltaY = e.clientY - startY;
                let newWidth = startWidth;
                let newHeight = startHeight;
                let newLeft = startLeft;
                let newBottom = startBottom;
                let newTop = startTop;

                switch (corner) {
                    case 'tl':
                        newWidth = Math.max(minWidth, Math.min(maxWidth, startWidth - deltaX));
                        newHeight = Math.max(minHeight, Math.min(maxHeight, startHeight - deltaY));
                        newLeft = startLeft + (startWidth - newWidth);
                        newBottom = startBottom;
                        break;
                    case 'tr':
                        newWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + deltaX));
                        newHeight = Math.max(minHeight, Math.min(maxHeight, startHeight - deltaY));
                        newBottom = startBottom;
                        break;
                    case 'bl':
                        newWidth = Math.max(minWidth, Math.min(maxWidth, startWidth - deltaX));
                        newHeight = Math.max(minHeight, Math.min(maxHeight, startHeight + deltaY));
                        newLeft = startLeft + (startWidth - newWidth);
                        newTop = startTop;
                        break;
                    case 'br':
                        newWidth = Math.max(minWidth, Math.min(maxWidth, startWidth + deltaX));
                        newHeight = Math.max(minHeight, Math.min(maxHeight, startHeight + deltaY));
                        newTop = startTop;
                        break;
                }

                windowEl.style.width = newWidth + 'px';
                windowEl.style.height = newHeight + 'px';
                windowEl.style.left = newLeft + 'px';
                windowEl.style.right = 'auto';

                if (corner === 'bl' || corner === 'br') {
                    windowEl.style.top = newTop + 'px';
                    windowEl.style.bottom = 'auto';
                } else {
                    windowEl.style.bottom = newBottom + 'px';
                    windowEl.style.top = 'auto';
                }
            };

            const onMouseUp = () => {
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            document.body.style.cursor = this.getCursorForCorner(corner);
            document.body.style.userSelect = 'none';
        }

        getCursorForCorner(corner) {
            switch (corner) {
                case 'tl': return 'nwse-resize';
                case 'tr': return 'nesw-resize';
                case 'bl': return 'nesw-resize';
                case 'br': return 'nwse-resize';
                default: return 'default';
            }
        }

        scrapePageContent() {
            const selectors = ['main', 'article', 'section', '[role="main"]', '.content', '#content'];
            let content = '';

            for (const selector of selectors) {
                const elements = document.querySelectorAll(selector);
                elements.forEach(el => {
                    const clone = el.cloneNode(true);
                    const scripts = clone.querySelectorAll('script, style, nav, header, footer, aside');
                    scripts.forEach(s => s.remove());

                    const text = clone.textContent || clone.innerText || '';
                    if (text.trim().length > 50) {
                        content += text.trim() + ' ';
                    }
                });
            }

            if (!content.trim()) {
                const body = document.body.cloneNode(true);
                const scripts = body.querySelectorAll('script, style, nav, header, footer, aside');
                scripts.forEach(s => s.remove());
                content = body.textContent || body.innerText || '';
            }

            this.pageContent = content.trim().replace(/\s+/g, ' ').substring(0, 8000);
        }

        connectWebSocket() {
            if (this.pingKeepaliveIntervalId) {
                clearInterval(this.pingKeepaliveIntervalId);
                this.pingKeepaliveIntervalId = null;
            }
            if (this.ws) {
                this.ws.onclose = null;
                this.ws.onerror = null;
                this.ws.close();
                this.ws = null;
            }
            try {
                const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
                const host = window.CHATBOT_WS_HOST || window.location.host;
                const wsUrl = window.CHATBOT_WS_URL || `${protocol}//${host}/ws`;

                this.ws = new WebSocket(wsUrl);

                this.ws.onopen = () => {
                    console.log('Zippy: WebSocket connected');
                    this.reconnectAttempts = 0;
                    this.isReconnecting = false;
                    this.sendPageContent();
                    const pingIntervalMs = 30000;
                    this.pingKeepaliveIntervalId = setInterval(() => {
                        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                            this.ws.send(JSON.stringify({ type: 'ping' }));
                        }
                    }, pingIntervalMs);
                };

                this.ws.onmessage = (event) => {
                    const msg = JSON.parse(event.data);
                    this.handleMessage(msg);
                };

                this.ws.onerror = (error) => {
                    console.error('Zippy: WebSocket error', error);
                };

                this.ws.onclose = () => {
                    console.log('Zippy: WebSocket closed');
                    if (this.pingKeepaliveIntervalId) {
                        clearInterval(this.pingKeepaliveIntervalId);
                        this.pingKeepaliveIntervalId = null;
                    }
                    this.isReconnecting = true;
                    this.reconnectAttempts += 1;
                    if (this.reconnectAttempts <= this.maxReconnectAttempts) {
                        setTimeout(() => this.connectWebSocket(), 3000);
                    } else {
                        this.addMessage('error', 'Connection error. Please refresh the page.');
                        this.isReconnecting = false;
                        this.reconnectAttempts = 0;
                    }
                };
            } catch (error) {
                console.error('Zippy: Failed to connect', error);
                this.addMessage('error', 'Failed to connect to chat service.');
            }
        }

        sendPageContent() {
            if (this.ws && this.ws.readyState === WebSocket.OPEN && this.pageContent) {
                const pageUrl = window.location.href.split('#')[0];

                this.ws.send(JSON.stringify({
                    type: 'page_content',
                    data: {
                        content: this.pageContent,
                        url: pageUrl,
                        channel_id: this.channelId || '',
                        psid: this.psid || '',
                        session_id: this.sessionId,
                        bypass_cache: this.readBypassCacheFromPageUrl()
                    }
                }));
            }
        }

        sendQuestion(question = null) {
            const input = document.getElementById('zippy-input');
            const questionText = question || input.value.trim();

            if (!questionText) return;

            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({
                    type: 'user_question',
                    data: {
                        question: questionText,
                        session_id: this.sessionId
                    }
                }));

                if (question === null || question === undefined) {
                    this.sendEvent('chatbot_question_typed', { question: questionText });
                }

                this.logABTestEvent('chatbot_user_question', {
                    question_length: questionText.length
                });

                this.addMessage('user', questionText);
                input.value = '';
                this.hideSuggestions();
            }
        }

        handleMessage(msg) {
            switch (msg.type) {
                case 'suggest_questions':
                    if (msg.data && msg.data.questions) {
                        if (msg.data.token_usage) {
                            this.sessionTokenUsage = msg.data.token_usage;
                        }
                        this.showSuggestions(msg.data.questions);
                        this.autoOpen().catch(err => {
                            console.warn('Zippy: Error in autoOpen:', err);
                        });
                    }
                    break;
                case 'response':
                    this.startStreamingMessage();
                    break;
                case 'response_chunk':
                    this.appendStreamingChunk(msg.content);
                    break;
                case 'response_done':
                    if (msg.data && msg.data.token_usage) {
                        this.sessionTokenUsage = msg.data.token_usage;
                    }
                    this.finishStreamingMessage(msg.content);
                    if (this.streamingStartTime && !this.responseComplete) {
                        const renderTime = Date.now() - this.streamingStartTime;
                        this.sendEvent('chatbot_response_rendered', { render_time_ms: renderTime });
                        this.responseComplete = true;
                    }
                    break;
                case 'adsense':
                    if (msg.data) {
                        this.addAdSenseAd(msg.data);
                    }
                    break;
                case 'error':
                    this.addMessage('error', msg.content);
                    break;
                case 'pong':
                    break;
            }
        }

        startStreamingMessage() {
            if (!this.streamingStartTime) {
                this.streamingStartTime = Date.now();
            }
            const messagesDiv = document.getElementById('zippy-messages');
            const messageDiv = document.createElement('div');
            messageDiv.className = 'zippy-message zippy-message-bot';
            messageDiv.innerHTML = `
                <div class="zippy-message-header">
                    <span class="zippy-icon" aria-hidden="true">${BOLT_SVG}</span>
                    <span>${CHATBOT_NAME}</span>
                </div>
                <div class="zippy-message-content"></div>
            `;
            messagesDiv.appendChild(messageDiv);

            this.currentStreamingMessage = messageDiv.querySelector('.zippy-message-content');
            this.currentStreamingContent = '';
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }

        appendStreamingChunk(chunk) {
            if (!this.currentStreamingMessage) {
                this.startStreamingMessage();
            }

            this.currentStreamingContent += chunk;
            this.currentStreamingMessage.innerHTML = this.renderMarkdown(this.currentStreamingContent);

            const messagesDiv = document.getElementById('zippy-messages');
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }

        finishStreamingMessage(finalContent) {
            if (!this.currentStreamingMessage) {
                return;
            }

            const contentEl = this.currentStreamingMessage;
            contentEl.innerHTML = this.renderMarkdown(finalContent || this.currentStreamingContent);

            // ← InText: highlight terms in the completed response
            this.highlightIntextTerms(contentEl);

            this.applyReadMoreTruncation(contentEl);

            this.currentStreamingMessage = null;
            this.currentStreamingContent = '';

            const messagesDiv = document.getElementById('zippy-messages');
            messagesDiv.scrollTop = messagesDiv.scrollHeight;

            if (window.innerWidth > 480) {
                setTimeout(() => this.adjustDesktopSize(), 100);
            }
        }

        applyReadMoreTruncation(contentEl) {
            if (!contentEl || contentEl.dataset.readMoreApplied === '1') return;

            const COLLAPSED_PX = 180;
            const SLACK_PX = 32;
            if (contentEl.scrollHeight <= COLLAPSED_PX + SLACK_PX) return;

            contentEl.classList.add('zippy-message-content--truncated');
            contentEl.dataset.readMoreApplied = '1';

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'zippy-read-more-btn';
            btn.textContent = 'Read more';
            btn.setAttribute('aria-expanded', 'false');

            btn.addEventListener('click', () => {
                contentEl.classList.remove('zippy-message-content--truncated');
                btn.remove();
                this.sendEvent('chatbot_read_more_click', {});
                contentEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });

            const messageWrapper = contentEl.parentElement;
            if (messageWrapper) {
                messageWrapper.appendChild(btn);
            }
        }

        addMessage(type, content) {
            const messagesDiv = document.getElementById('zippy-messages');

            if (messagesDiv.style.padding === '8px 20px') {
                messagesDiv.style.padding = '';
            }

            const messageDiv = document.createElement('div');
            messageDiv.className = `zippy-message zippy-message-${type}`;

            if (type === 'bot') {
                messageDiv.innerHTML = `
                    <div class="zippy-message-header">
                        <span class="zippy-icon" aria-hidden="true">${BOLT_SVG}</span>
                        <span>${CHATBOT_NAME}</span>
                    </div>
                    <div class="zippy-message-content">${this.renderMarkdown(content)}</div>
                `;
            } else if (type === 'user') {
                messageDiv.innerHTML = `
                    <div class="zippy-message-content">${this.escapeHtml(content)}</div>
                `;
            } else if (type === 'error') {
                messageDiv.className = 'zippy-message zippy-message-bot zippy-message-error';
                messageDiv.innerHTML = `
                    <div class="zippy-message-header">
                        <span class="zippy-icon" aria-hidden="true">${BOLT_SVG}</span>
                        <span>${CHATBOT_NAME}</span>
                    </div>
                    <div class="zippy-message-content zippy-error">${this.escapeHtml(content)}</div>
                `;
            } else {
                messageDiv.innerHTML = `
                    <div class="zippy-message-content">${this.escapeHtml(content)}</div>
                `;
            }

            messagesDiv.appendChild(messageDiv);
            messagesDiv.scrollTop = messagesDiv.scrollHeight;

            if (window.innerWidth > 480) {
                setTimeout(() => this.adjustDesktopSize(), 100);
            }
        }

        loadMarked() {
            if (typeof marked !== 'undefined') {
                this.configureMarked();
                this.markedReady = true;
                return;
            }

            if (document.querySelector('script[src*="marked"]')) {
                const checkMarked = setInterval(() => {
                    if (typeof marked !== 'undefined') {
                        clearInterval(checkMarked);
                        this.configureMarked();
                        this.markedReady = true;
                    }
                }, 100);
                return;
            }

            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/marked@12.0.0/marked.min.js';
            script.onload = () => {
                this.configureMarked();
                this.markedReady = true;
            };
            script.onerror = () => {
                console.error('Zippy: Failed to load marked.js, falling back to custom renderer');
                this.markedReady = false;
            };
            document.head.appendChild(script);
        }

        configureMarked() {
            if (typeof marked === 'undefined') return;

            const renderer = new marked.Renderer();
            renderer.link = (href, title, text) => {
                const titleAttr = title ? ` title="${this.escapeHtml(title)}"` : '';
                return `<a href="${this.escapeHtml(href)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${text}</a>`;
            };

            marked.setOptions({
                breaks: true,
                gfm: true,
                renderer: renderer,
                silent: true
            });
        }

        renderMarkdown(text) {
            if (this.markedReady && typeof marked !== 'undefined') {
                try {
                    let html = marked.parse(text);
                    html = this.sanitizeHtml(html);
                    return html || '<p></p>';
                } catch (error) {
                    console.error('Zippy: Error rendering markdown with marked.js:', error);
                }
            }

            let html = this.escapeHtml(text);

            const lines = html.split('\n');
            const processedLines = [];
            let inList = false;
            let listType = null;
            let listItems = [];

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();

                const numberedMatch = line.match(/^(\d+)\.\s+(.+)$/);
                if (numberedMatch) {
                    if (inList && listType !== 'ol') {
                        processedLines.push('</' + listType + '>');
                        listItems = [];
                    }
                    inList = true;
                    listType = 'ol';
                    listItems.push('<li>' + numberedMatch[2] + '</li>');
                    continue;
                }

                const bulletMatch = line.match(/^[-*]\s+(.+)$/);
                if (bulletMatch) {
                    if (inList && listType !== 'ul') {
                        processedLines.push('</' + listType + '>');
                        listItems = [];
                    }
                    inList = true;
                    listType = 'ul';
                    listItems.push('<li>' + bulletMatch[1] + '</li>');
                    continue;
                }

                if (inList) {
                    processedLines.push('<' + listType + '>' + listItems.join('') + '</' + listType + '>');
                    inList = false;
                    listType = null;
                    listItems = [];
                }

                if (line.match(/^###\s+(.+)$/)) {
                    processedLines.push('<h3>' + line.replace(/^###\s+/, '') + '</h3>');
                    continue;
                }
                if (line.match(/^##\s+(.+)$/)) {
                    processedLines.push('<h2>' + line.replace(/^##\s+/, '') + '</h2>');
                    continue;
                }
                if (line.match(/^#\s+(.+)$/)) {
                    processedLines.push('<h1>' + line.replace(/^#\s+/, '') + '</h1>');
                    continue;
                }

                if (line) {
                    processedLines.push(line);
                } else {
                    processedLines.push('');
                }
            }

            if (inList) {
                processedLines.push('<' + listType + '>' + listItems.join('') + '</' + listType + '>');
            }

            html = processedLines.join('\n');

            html = html.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
            html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
            html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
            html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
            html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
            html = html.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');
            html = html.replace(/(?<!_)_([^_\n]+)_(?!_)/g, '<em>$1</em>');

            const paragraphs = html.split(/\n\n+/);
            html = paragraphs.map(p => {
                p = p.trim();
                if (!p) return '';
                if (/^<(h[1-6]|ul|ol|pre|p)/.test(p)) {
                    return p;
                }
                return '<p>' + p.replace(/\n/g, '<br>') + '</p>';
            }).join('');

            return html || '<p></p>';
        }

        getAfsNoFillDiagnostics(adData, adsenseContainer) {
            const container = adsenseContainer || document.getElementById(adData && adData.container_id);
            const iframe = container ? container.querySelector('iframe') : null;
            const iframeStyle = iframe ? window.getComputedStyle(iframe) : null;
            let iframeURL = null;
            let iframeNum = '';
            let iframeScStatus = '';
            if (iframe && iframe.src) {
                try {
                    iframeURL = new URL(iframe.src);
                    iframeNum = iframeURL.searchParams.get('num') || '';
                    iframeScStatus = iframeURL.searchParams.get('sc_status') || '';
                } catch (e) {}
            }
            if ((!iframeNum || !iframeScStatus) && iframe && iframe.name) {
                try {
                    const raw = iframe.name.indexOf('|') !== -1 ? iframe.name.split('|').pop() : iframe.name;
                    const parsed = JSON.parse(raw);
                    const master = parsed && (parsed['master-1'] || parsed.master);
                    if (master) {
                        if (!iframeNum && master.num != null) iframeNum = String(master.num);
                        if (!iframeScStatus && master.sc_status != null) iframeScStatus = String(master.sc_status);
                    }
                } catch (e) {}
            }
            const rect = iframe ? iframe.getBoundingClientRect() : null;
            const containerRect = container ? container.getBoundingClientRect() : null;
            const iframeHeight = rect ? Math.round(rect.height) : null;
            const iframeVisibility = iframeStyle ? iframeStyle.visibility : '';
            const iframeDisplay = iframeStyle ? iframeStyle.display : '';
            const suspectedNoFill = !!iframe && (
                iframeHeight === 0 ||
                iframe.offsetHeight === 0 ||
                iframeVisibility === 'hidden' ||
                iframeDisplay === 'none' ||
                iframeNum === '0' ||
                iframeScStatus === '6'
            );
            return {
                container_id: adData && adData.container_id ? adData.container_id : '',
                query: adData && adData.query ? adData.query : '',
                iframe_exists: !!iframe,
                iframe_count: container ? container.querySelectorAll('iframe').length : 0,
                iframe_height: iframeHeight,
                iframe_offset_height: iframe ? iframe.offsetHeight : null,
                iframe_client_height: iframe ? iframe.clientHeight : null,
                iframe_width: rect ? Math.round(rect.width) : null,
                iframe_visibility: iframeVisibility,
                iframe_display: iframeDisplay,
                iframe_style_height: iframe ? iframe.style.height || '' : '',
                iframe_style_visibility: iframe ? iframe.style.visibility || '' : '',
                iframe_num: iframeNum,
                iframe_sc_status: iframeScStatus,
                iframe_src_host: iframeURL ? iframeURL.hostname : '',
                iframe_src_path: iframeURL ? iframeURL.pathname : '',
                container_height: containerRect ? Math.round(containerRect.height) : null,
                container_child_count: container ? container.childElementCount : 0,
                suspected_no_fill: suspectedNoFill
            };
        }

        trackAfsNoFillIfSuspected(adData, adsenseContainer, extra = {}) {
            const diagnostics = this.getAfsNoFillDiagnostics(adData, adsenseContainer);
            if (!diagnostics.suspected_no_fill) return false;
            this.sendEvent('chatbot_afs_no_fill', Object.assign({}, diagnostics, extra));
            return true;
        }

        addAdSenseAd(adData) {
            const messagesDiv = document.getElementById('zippy-messages');

            const messageDiv = document.createElement('div');
            messageDiv.className = 'zippy-message zippy-message-bot zippy-message-ad';
            messageDiv.innerHTML = `
                <div class="zippy-message-header">
                    <span class="zippy-icon" aria-hidden="true">${BOLT_SVG}</span>
                    <span>${CHATBOT_NAME} · Sponsored suggestions</span>
                </div>
                <div class="zippy-message-content" style="width: 100%">
                    <div class="zippy-adsense-container" style="width: 100%"></div>
                </div>
            `;

            const adsenseContainer = messageDiv.querySelector('.zippy-adsense-container');
            adsenseContainer.innerHTML = adData.html;

            this.sendEvent('chatbot_ad_viewed', { container_id: adData.container_id, query: adData.query || '' });
            setTimeout(() => this.trackAfsNoFillIfSuspected(adData, adsenseContainer, { check_after_ms: 2500 }), 2500);
            setTimeout(() => this.trackAfsNoFillIfSuspected(adData, adsenseContainer, { check_after_ms: 6000 }), 6000);

            messagesDiv.appendChild(messageDiv);

            const messageHandler = (e) => {
                if (![
                    "https://www.google.com",
                    "https://www.adsensecustomsearchads.com",
                    "https://syndicatedsearch.goog",
                ].includes(e.origin)) {
                    return;
                }
                const s = e.data;
                if (s && typeof s === 'string' && s.startsWith("FSXDC,.aCS")) {
                    this.sendEvent('chatbot_ad_click', {
                        container_id: adData.container_id,
                        query: adData.query || '',
                        origin: e.origin,
                        message: s
                    }, true);
                    this.sendEvent('chatbot_sponsored_link_click', {
                        container_id: adData.container_id,
                        query: adData.query || '',
                        origin: e.origin,
                        message: s
                    }, true);
                }
            };
            window.addEventListener("message", messageHandler);
            messageDiv._adMessageHandler = messageHandler;

            adsenseContainer.addEventListener('click', (event) => {
                const linkElement = event.target.closest('a, button, [role="button"]');

                if (linkElement) {
                    const linkData = {
                        container_id: adData.container_id,
                        link_url: linkElement.href || linkElement.getAttribute('href') || null,
                        link_text: linkElement.textContent?.trim() || linkElement.innerText?.trim() || '',
                        link_title: linkElement.title || linkElement.getAttribute('title') || '',
                        target: linkElement.target || linkElement.getAttribute('target') || '_blank',
                        clicked_element: linkElement.tagName.toLowerCase(),
                        clicked_element_class: linkElement.className || '',
                        query: adData.query || ''
                    };

                    this.sendEvent('chatbot_sponsored_link_click', linkData);
                    this.sendEvent('chatbot_ad_click', { container_id: adData.container_id });

                    console.log('[Zippy Tracking] Sponsored link clicked:', linkData);
                } else {
                    this.sendEvent('chatbot_ad_click', {
                        container_id: adData.container_id,
                        clicked_element: event.target.tagName?.toLowerCase() || 'unknown'
                    });
                }
            }, true);

            const observer = new MutationObserver((mutations) => {
                mutations.forEach((mutation) => {
                    mutation.addedNodes.forEach((node) => {
                        if (node.nodeType === 1) {
                            const links = node.querySelectorAll ? node.querySelectorAll('a, button, [role="button"]') : [];
                            links.forEach((link) => {
                                link.addEventListener('click', (event) => {
                                    const linkData = {
                                        container_id: adData.container_id,
                                        link_url: link.href || link.getAttribute('href') || null,
                                        link_text: link.textContent?.trim() || link.innerText?.trim() || '',
                                        link_title: link.title || link.getAttribute('title') || '',
                                        target: link.target || link.getAttribute('target') || '_blank',
                                        clicked_element: link.tagName.toLowerCase(),
                                        clicked_element_class: link.className || '',
                                        query: adData.query || '',
                                        dynamically_loaded: true
                                    };

                                    this.sendEvent('chatbot_sponsored_link_click', linkData);
                                    this.sendEvent('chatbot_ad_click', { container_id: adData.container_id });

                                    console.log('[Zippy Tracking] Dynamically loaded sponsored link clicked:', linkData);
                                }, true);
                            });
                        }
                    });
                });
            });

            observer.observe(adsenseContainer, {
                childList: true,
                subtree: true
            });

            messageDiv._adObserver = observer;

            const container = document.getElementById(adData.container_id);
            if (!container) {
                console.error('Zippy: Failed to create AdSense container with ID:', adData.container_id);
                return;
            }
            console.log('Zippy: AdSense container created:', adData.container_id, 'Parent:', container.parentElement);

            this.scrollToShowAd(messageDiv, messagesDiv);

            setTimeout(() => {
                this.scrollToShowAd(messageDiv, messagesDiv);
            }, 500);

            if (!window._googCsaLoaded) {
                if (typeof window._googCsa === 'undefined') {
                    window._googCsa = window._googCsa || function () {
                        (window._googCsa.q = window._googCsa.q || []).push(arguments);
                    };
                    window._googCsa.t = 1 * new Date();
                }

                const adsScript = document.createElement('script');
                adsScript.async = true;
                adsScript.src = 'https://www.google.com/adsense/search/ads.js';
                adsScript.onload = () => {
                    console.log('Zippy: AdSense ads.js loaded');
                    window._googCsaAdsLoaded = true;
                    this.executeAdSenseCall(adData);
                };
                adsScript.onerror = () => {
                    console.error('Zippy: Failed to load AdSense ads.js');
                };
                document.head.appendChild(adsScript);

                window._googCsaLoaded = true;
            } else {
                this.executeAdSenseCall(adData);
            }
        }

        executeAdSenseCall(adData) {
            let attempts = 0;
            const maxAttempts = 50;

            const checkAndExecute = () => {
                attempts++;
                const container = document.getElementById(adData.container_id);

                if (!container) {
                    if (attempts < maxAttempts) {
                        setTimeout(checkAndExecute, 100);
                    } else {
                        console.error('Zippy: AdSense container not found after', maxAttempts, 'attempts:', adData.container_id);
                    }
                    return;
                }

                if (typeof window._googCsa === 'function') {
                    this.executeScriptDirectly(adData.call_script);
                    console.log('Zippy: AdSense ad request sent for container:', adData.container_id);

                    setTimeout(() => {
                        const messagesDiv = document.getElementById('zippy-messages');
                        if (messagesDiv) {
                            const adMessage = messagesDiv.querySelector('.zippy-message-ad:last-child');
                            if (adMessage) {
                                this.scrollToShowAd(adMessage, messagesDiv);
                            } else {
                                messagesDiv.scrollTo({ top: messagesDiv.scrollHeight, behavior: 'smooth' });
                            }
                        }
                    }, 1000);

                    setTimeout(() => {
                        const messagesDiv = document.getElementById('zippy-messages');
                        if (messagesDiv) {
                            const adMessage = messagesDiv.querySelector('.zippy-message-ad:last-child');
                            if (adMessage) {
                                this.scrollToShowAd(adMessage, messagesDiv);
                            } else {
                                messagesDiv.scrollTo({ top: messagesDiv.scrollHeight, behavior: 'smooth' });
                            }
                        }
                    }, 2000);
                } else {
                    if (attempts < maxAttempts) {
                        setTimeout(checkAndExecute, 100);
                    } else {
                        console.error('Zippy: _googCsa not available after', maxAttempts, 'attempts. Type:', typeof window._googCsa);
                    }
                }
            };

            setTimeout(checkAndExecute, 300);
        }

        executeScriptDirectly(scriptContent) {
            const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/g;
            let match;
            let scriptsExecuted = 0;

            while ((match = scriptRegex.exec(scriptContent)) !== null) {
                const scriptText = match[1].trim();
                if (scriptText) {
                    try {
                        const script = document.createElement('script');
                        script.type = 'text/javascript';
                        script.charset = 'utf-8';
                        script.textContent = scriptText;
                        document.body.appendChild(script);
                        scriptsExecuted++;
                        console.log('Zippy: Executed AdSense script:', scriptText.substring(0, 100) + '...');
                    } catch (e) {
                        console.error('Zippy: Error executing AdSense script:', e, 'Script:', scriptText.substring(0, 100));
                    }
                }
            }

            if (scriptsExecuted === 0) {
                console.warn('Zippy: No script content found in:', scriptContent.substring(0, 100));
            } else {
                console.log('Zippy: Successfully executed', scriptsExecuted, 'AdSense script(s)');
            }
        }

        scrollToShowAd(adMessageDiv, messagesDiv) {
            const isNearBottom = messagesDiv.scrollHeight - messagesDiv.scrollTop - messagesDiv.clientHeight < 50;

            if (!isNearBottom) {
                messagesDiv.scrollTo({
                    top: messagesDiv.scrollHeight,
                    behavior: 'smooth'
                });
            }
        }

        showSuggestions(questions) {
            const suggestionsDiv = document.getElementById('zippy-suggestions');
            const messagesDiv = document.getElementById('zippy-messages');

            this.sendEvent('chatbot_leading_questions_viewed', { questions_count: questions.length, questions: questions });

            suggestionsDiv.innerHTML = '';

            questions.slice(0, 2).forEach((question) => {
                const btn = document.createElement('button');
                btn.className = 'zippy-suggestion-btn';
                btn.textContent = question;
                btn.addEventListener('click', () => {
                    this.sendEvent('chatbot_leading_question_clicked', { question: question });
                    this.sendQuestion(question);
                });
                suggestionsDiv.appendChild(btn);
            });

            suggestionsDiv.style.display = 'flex';

            if (messagesDiv.children.length === 0) {
                messagesDiv.style.padding = '0 16px 8px';
            }

            if (window.innerWidth > 480) {
                setTimeout(() => this.adjustDesktopSize(), 100);
            }
        }

        async autoOpen() {
            if (this.hasAutoOpened || this.isOpen) {
                return;
            }

            if (!this.abTestAssignmentComplete) {
                let waitCount = 0;
                while (!this.abTestAssignmentComplete && waitCount < 20) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                    waitCount++;
                }
            }

            if (this.abTestAssignment) {
                console.log('Zippy: A/B test assignment found:', {
                    variant_name: this.abTestAssignment.variant_name,
                    is_control: this.abTestAssignment.is_control,
                    configuration: this.abTestAssignment.configuration,
                    parsed_config: this.abTestConfig
                });

                if (this.abTestConfig) {
                    if (this.abTestConfig.auto_open === false || this.abTestConfig.require_click === true) {
                        console.log('Zippy: Click-to-open variant detected, skipping auto-open', this.abTestConfig);
                        this.logABTestEvent('chatbot_auto_open_skipped', {
                            reason: 'click_to_open_variant',
                            config: this.abTestConfig
                        });
                        return;
                    }
                } else {
                    if (this.abTestAssignment.is_control === true) {
                        console.log('Zippy: Control variant (is_control=true) without config, allowing auto-open');
                    } else if (this.abTestAssignment.is_control === false) {
                        const variantName = (this.abTestAssignment.variant_name || '').toLowerCase();
                        if (variantName.includes('control') || variantName.includes('auto')) {
                            console.log('Zippy: Variant name suggests Control, allowing auto-open despite is_control=false');
                        } else {
                            console.log('Zippy: Test variant (is_control=false) without config, skipping auto-open');
                            this.logABTestEvent('chatbot_auto_open_skipped', {
                                reason: 'test_variant_no_config'
                            });
                            return;
                        }
                    } else {
                        const variantName = (this.abTestAssignment.variant_name || '').toLowerCase();
                        if (variantName.includes('control') || variantName.includes('auto')) {
                            console.log('Zippy: Variant name suggests Control, allowing auto-open (is_control was null/undefined)');
                        } else {
                            console.log('Zippy: Variant name suggests Test, skipping auto-open (is_control was null/undefined)');
                            this.logABTestEvent('chatbot_auto_open_skipped', {
                                reason: 'test_variant_by_name'
                            });
                            return;
                        }
                    }
                }
            }

            if (!this.abTestAssignment) {
                if (window.CHATBOT_AUTO_OPEN !== true) {
                    console.log('Zippy: No A/B test, defaulting to no auto-open (user must click)');
                    return;
                }
                console.log('Zippy: No A/B test, auto-open enabled via CHATBOT_AUTO_OPEN = true');
            }

            setTimeout(() => {
                if (!this.isOpen && !this.hasAutoOpened) {
                    this.hasAutoOpened = true;
                    this.open();
                    if (this.abTestAssignment) {
                        this.logABTestEvent('chatbot_auto_opened');
                    }
                }
            }, 5000);
        }

        open(options = {}) {
            if (this.isOpen) return;

            this.isOpen = true;
            this.sendEvent('chatbot_widget_open');

            if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
                this.connectWebSocket();
            }

            if (this.abTestAssignment && !this.hasAutoOpened) {
                this.logABTestEvent('chatbot_manual_open');
            }

            const windowEl = document.getElementById('zippy-chatbot-window');
            if (windowEl) {
                windowEl.style.display = 'flex';
            }
            if (!options.preserveLauncherHidden) {
                this.hideLauncherPill();
            }

            if (windowEl) {
                windowEl.classList.add('zippy-opening');
            }
            setTimeout(() => {
                if (windowEl) {
                    windowEl.classList.remove('zippy-opening');
                }
                this.adjustMobilePosition();
                if (globalThis.innerWidth > 480) {
                    this.adjustDesktopSize();
                }
            }, 300);

            if (options.focusInput !== false) {
                setTimeout(() => {
                    const input = document.getElementById('zippy-input');
                    if (input) input.focus();
                }, 100);
            }
        }

        adjustDesktopSize() {
            if (window.innerWidth <= 480) return;

            const windowEl = document.getElementById('zippy-chatbot-window');
            const messagesDiv = document.getElementById('zippy-messages');

            let maxContentWidth = 480;

            const messages = messagesDiv.querySelectorAll('.zippy-message-content');
            messages.forEach(msg => {
                const msgWidth = msg.scrollWidth;
                if (msgWidth > maxContentWidth) {
                    maxContentWidth = Math.min(msgWidth + 100, 700);
                }
            });

            const suggestions = document.querySelectorAll('.zippy-suggestion-btn');
            suggestions.forEach(btn => {
                const btnWidth = btn.scrollWidth;
                if (btnWidth > maxContentWidth) {
                    maxContentWidth = Math.min(btnWidth + 100, 700);
                }
            });

            if (maxContentWidth > 480) {
                windowEl.style.width = maxContentWidth + 'px';
            }
        }

        adjustMobilePosition() {
            if (window.innerWidth > 480) return;

            const windowEl = document.getElementById('zippy-chatbot-window');
            const viewportHeight = window.innerHeight;
            const maxHeight = viewportHeight - 90;

            windowEl.style.position = 'fixed';
            windowEl.style.top = 'auto';
            windowEl.style.bottom = '80px';
            windowEl.style.left = '10px';
            windowEl.style.right = '10px';
            windowEl.style.width = 'auto';
            windowEl.style.maxHeight = maxHeight + 'px';
            windowEl.style.minHeight = (viewportHeight * 0.6) + 'px';
        }

        hideSuggestions() {
            document.getElementById('zippy-suggestions').style.display = 'none';
        }

        toggle() {
            if (this.isOpen) {
                this.close();
            } else {
                this.open();
            }
        }

        close() {
            if (!this.isOpen) return;

            this.isOpen = false;
            this.sendEvent('chatbot_widget_close');
            const windowEl = document.getElementById('zippy-chatbot-window');
            if (windowEl) {
                windowEl.style.display = 'none';
            }

            if (windowEl) {
                windowEl.style.position = '';
                windowEl.style.top = '';
                windowEl.style.bottom = '';
                windowEl.style.left = '';
                windowEl.style.right = '';
                windowEl.style.transform = '';
                windowEl.style.width = '';
                windowEl.style.maxHeight = '';
            }
            this.showLauncherPill(true);
        }

        escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        sanitizeHtml(html) {
            const allowedTags = ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li', 'a', 'br', 'blockquote'];
            const allowedAttributes = {
                'a': ['href', 'target', 'rel', 'title']
            };

            const temp = document.createElement('div');
            temp.innerHTML = html;

            const allElements = temp.querySelectorAll('*');
            allElements.forEach(node => {
                const tagName = node.tagName.toLowerCase();

                if (!allowedTags.includes(tagName)) {
                    const textNode = document.createTextNode(node.textContent);
                    node.parentNode.replaceChild(textNode, node);
                    return;
                }

                const allowedAttrs = allowedAttributes[tagName] || [];
                Array.from(node.attributes).forEach(attr => {
                    if (!allowedAttrs.includes(attr.name.toLowerCase())) {
                        node.removeAttribute(attr.name);
                    }
                });

                if (tagName === 'a' && node.hasAttribute('href')) {
                    const href = node.getAttribute('href');
                    if (!/^(https?:\/\/|mailto:|#|\/)/i.test(href)) {
                        node.removeAttribute('href');
                    }
                }
            });

            return temp.innerHTML;
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => new ZippyChatbot());
    } else {
        new ZippyChatbot();
    }
})();
