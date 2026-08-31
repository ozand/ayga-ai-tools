// utils/artifact-converter.js - Content-script safe converter without ESM export

(function initArtifactConverter(root) {
    'use strict';

    const MAX_MARKDOWN_CHARS = 50000;
    const MAX_DOM_DEPTH = 32;
    const MAX_DOM_NODES = 10000;
    const MAX_WARNINGS = 50;

    const BLACKLISTED_TAGS = new Set([
        'SCRIPT',
        'STYLE',
        'NOSCRIPT',
        'TEMPLATE',
        'IFRAME',
        'FRAME',
        'OBJECT',
        'EMBED',
        'APPLET'
    ]);

    const EXCLUDED_ROLES = new Set([
        'presentation',
        'none',
        'hidden',
        'navigation',
        'banner',
        'search',
        'complementary',
        'contentinfo',
        'toolbar'
    ]);

    const EXCLUDED_CLASS_SUBSTRINGS = [
        'copy-button',
        'copy-code',
        'action-button',
        'service-icon',
        'tooltip',
        'toast',
        'popup',
        'overlay',
        'modal',
        'menu-button',
        'collapse-button',
        'nav-bar',
        'sidebar',
        'toolbar'
    ];

    function getTagName(node) {
        if (!node) return '';
        if (typeof node.tagName === 'string') return node.tagName.toUpperCase();
        if (typeof node.nodeName === 'string') return node.nodeName.toUpperCase();
        return '';
    }

    function getAttribute(node, attrName) {
        if (!node || node.nodeType !== 1) return null;
        if (typeof node.getAttribute === 'function') {
            return node.getAttribute(attrName);
        }
        if (node.attributes && typeof node.attributes === 'object') {
            return node.attributes[attrName] !== undefined ? String(node.attributes[attrName]) : null;
        }
        return null;
    }

    function hasAttribute(node, attrName) {
        if (!node || node.nodeType !== 1) return false;
        if (typeof node.hasAttribute === 'function') {
            return Boolean(node.hasAttribute(attrName));
        }
        if (node.attributes && typeof node.attributes === 'object') {
            return node.attributes[attrName] !== undefined;
        }
        return false;
    }

    function getChildNodes(node) {
        if (!node) return [];
        if (node.childNodes && Array.isArray(node.childNodes)) {
            return node.childNodes;
        }
        if (node.childNodes && typeof node.childNodes.length === 'number') {
            return Array.from(node.childNodes);
        }
        if (node.children && Array.isArray(node.children)) {
            return node.children;
        }
        if (node.children && typeof node.children.length === 'number') {
            return Array.from(node.children);
        }
        return [];
    }

    function findDescendants(node, predicate, results = []) {
        const children = getChildNodes(node);
        for (const child of children) {
            if (predicate(child)) {
                results.push(child);
            }
            findDescendants(child, predicate, results);
        }
        return results;
    }

    function shouldExcludeElement(el) {
        if (!el || el.nodeType !== 1) return false;
        const tag = getTagName(el);

        if (BLACKLISTED_TAGS.has(tag)) return true;
        if (tag === 'SVG') return true;

        if (getAttribute(el, 'aria-hidden') === 'true') return true;
        if (hasAttribute(el, 'hidden')) return true;
        if (hasAttribute(el, 'inert')) return true;

        const roleAttr = getAttribute(el, 'role');
        if (roleAttr && EXCLUDED_ROLES.has(roleAttr.trim().toLowerCase())) {
            return true;
        }

        const styleAttr = getAttribute(el, 'style');
        if (styleAttr && typeof styleAttr === 'string') {
            const normalized = styleAttr.replace(/\s+/g, '').toLowerCase();
            if (
                normalized.includes('display:none') ||
                normalized.includes('visibility:hidden') ||
                normalized.includes('opacity:0')
            ) {
                return true;
            }
        }

        let classString = '';
        if (typeof el.className === 'string') {
            classString = el.className;
        } else if (el.classList && typeof el.classList.contains === 'function') {
            if (Array.isArray(el.classList)) {
                classString = el.classList.join(' ');
            } else if (el.classList instanceof Set) {
                classString = Array.from(el.classList).join(' ');
            }
        }
        if (!classString) {
            const classAttr = getAttribute(el, 'class');
            if (typeof classAttr === 'string') {
                classString = classAttr;
            }
        }

        const lowerClass = classString.toLowerCase();
        for (const needle of EXCLUDED_CLASS_SUBSTRINGS) {
            if (lowerClass.includes(needle)) {
                return true;
            }
        }

        return false;
    }

    function isSafeUrl(rawUrl) {
        if (typeof rawUrl !== 'string') return false;
        const url = rawUrl.trim();
        if (!url || url.length === 0 || url.length > 4096) return false;
        if (/[\u0000-\u001F\u007F-\u009F]/.test(url)) return false;

        const schemeMatch = url.match(/^([a-zA-Z0-9+.-]+):/);
        if (schemeMatch) {
            const scheme = schemeMatch[1].toLowerCase();
            return scheme === 'http' || scheme === 'https' || scheme === 'mailto';
        }

        if (url.startsWith('//') || url.startsWith('/') || url.startsWith('./') || url.startsWith('../') || url.startsWith('#') || url.startsWith('?')) {
            return true;
        }

        return false;
    }

    const SENSITIVE_QUERY_PARAMS = new Set([
        'token',
        'access_token',
        'auth_token',
        'api_key',
        'apikey',
        'secret',
        'key',
        'auth',
        'session',
        'jwt',
        'signature',
        'sig'
    ]);

    function sanitizeUrl(rawUrl) {
        if (typeof rawUrl !== 'string') return null;
        let url = rawUrl.trim();
        if (!url || url.length === 0 || url.length > 4096) return null;

        url = url.replace(/[\u0000-\u001F\u007F-\u009F]/g, '');

        const schemeMatch = url.match(/^([a-zA-Z0-9+.-]+):/);
        if (schemeMatch) {
            const scheme = schemeMatch[1].toLowerCase();
            if (scheme !== 'http' && scheme !== 'https' && scheme !== 'mailto') {
                return null;
            }
        } else {
            if (
                !url.startsWith('//') &&
                !url.startsWith('/') &&
                !url.startsWith('./') &&
                !url.startsWith('../') &&
                !url.startsWith('#') &&
                !url.startsWith('?')
            ) {
                return null;
            }
        }

        try {
            const hasExplicitScheme = Boolean(schemeMatch);
            const isSchemeRelative = url.startsWith('//');
            const dummyBase = 'https://ayga-parser-base.internal';
            const parsed = isSchemeRelative
                ? new URL('https:' + url)
                : (hasExplicitScheme ? new URL(url) : new URL(url, dummyBase));

            if (parsed.protocol === 'mailto:') {
                return url;
            }

            if (parsed.search) {
                const params = new URLSearchParams(parsed.search);
                const keysToDelete = [];
                for (const param of params.keys()) {
                    if (SENSITIVE_QUERY_PARAMS.has(param.toLowerCase())) {
                        keysToDelete.push(param);
                    }
                }
                for (const k of keysToDelete) {
                    params.delete(k);
                }
                const newQuery = params.toString();
                parsed.search = newQuery ? `?${newQuery}` : '';
            }

            if (parsed.hash) {
                const rawHash = parsed.hash.replace(/^#\??/, '');
                if (rawHash.includes('=')) {
                    const hashParams = new URLSearchParams(rawHash);
                    const keysToDelete = [];
                    for (const param of hashParams.keys()) {
                        if (SENSITIVE_QUERY_PARAMS.has(param.toLowerCase())) {
                            keysToDelete.push(param);
                        }
                    }
                    if (keysToDelete.length > 0) {
                        for (const k of keysToDelete) {
                            hashParams.delete(k);
                        }
                        const newHash = hashParams.toString();
                        parsed.hash = newHash ? `#${newHash}` : '';
                    }
                }
            }

            if (hasExplicitScheme) {
                return parsed.href;
            } else if (isSchemeRelative) {
                return '//' + parsed.host + parsed.pathname + parsed.search + parsed.hash;
            } else if (url.startsWith('#')) {
                return parsed.hash;
            } else if (url.startsWith('?')) {
                return parsed.search + parsed.hash;
            } else {
                return parsed.pathname + parsed.search + parsed.hash;
            }
        } catch {
            return null;
        }
    }

    function createSafeFence(codeText) {
        if (!codeText) return '```';
        const matches = String(codeText).match(/`+/g);
        let maxRun = 2;
        if (matches) {
            for (const m of matches) {
                if (m.length > maxRun) {
                    maxRun = m.length;
                }
            }
        }
        return '`'.repeat(maxRun + 1);
    }

    function escapeInlineCode(codeText) {
        if (!codeText) return '``';
        const str = String(codeText);
        const matches = str.match(/`+/g);
        let maxRun = 0;
        if (matches) {
            for (const m of matches) {
                if (m.length > maxRun) {
                    maxRun = m.length;
                }
            }
        }
        const fence = '`'.repeat(maxRun + 1);
        if (str.startsWith('`') || str.endsWith('`')) {
            return `${fence} ${str} ${fence}`;
        }
        return `${fence}${str}${fence}`;
    }

    function sanitizeInlineAttr(text) {
        if (!text) return '';
        return String(text).replace(/[\r\n]+/g, ' ').replace(/["\\]/g, '\\$&').trim();
    }

    function sanitizeAltText(text) {
        if (!text) return '';
        return String(text).replace(/[\r\n]+/g, ' ').replace(/[\[\]\\]/g, '\\$&').trim();
    }

    function isRenderedMermaidViewer(node) {
        if (!node || node.nodeType !== 1) return false;
        let classString = '';
        if (typeof node.className === 'string') {
            classString = node.className;
        } else if (node.classList && typeof node.classList.contains === 'function') {
            if (Array.isArray(node.classList)) {
                classString = node.classList.join(' ');
            } else if (node.classList instanceof Set) {
                classString = Array.from(node.classList).join(' ');
            }
        }
        if (!classString) {
            const classAttr = getAttribute(node, 'class');
            if (typeof classAttr === 'string') {
                classString = classAttr;
            }
        }
        const lowerClass = classString.toLowerCase();
        if (lowerClass.includes('mermaid-viewer') || lowerClass.includes('mermaid-container') || lowerClass.includes('mermaid')) {
            const svgChild = findDescendants(node, (child) => {
                const tag = getTagName(child);
                if (tag !== 'SVG') return false;
                const id = getAttribute(child, 'id') || '';
                return id.startsWith('claude-mermaid-') || id.includes('mermaid');
            });
            return svgChild.length > 0;
        }

        const tag = getTagName(node);
        if (tag === 'SVG') {
            const id = getAttribute(node, 'id') || '';
            return id.startsWith('claude-mermaid-') || id.includes('mermaid');
        }

        return false;
    }

    function checkTraversalBudget(state) {
        state.visitedNodes++;
        if (state.visitedNodes > state.maxNodes) {
            addWarning(state, 'DOM traversal limit reached; input was truncated.');
            state.budgetExceeded = true;
            return false;
        }
        return true;
    }

    function addWarning(state, warningText) {
        if (state.warnings.length < MAX_WARNINGS) {
            state.warnings.push(warningText);
        }
    }

    function convertInlineChildren(node, state, depth = 0) {
        if (state.budgetExceeded || state.outputBudgetExceeded) return '';
        if (depth > state.maxDepth) {
            addWarning(state, 'DOM depth limit reached; deep nodes omitted.');
            return '';
        }
        let result = '';
        const children = getChildNodes(node);
        for (const child of children) {
            if (state.budgetExceeded || state.outputBudgetExceeded) break;
            result += convertInlineNode(child, state, depth + 1);
        }
        return result;
    }

    function convertInlineNode(node, state, depth = 0) {
        if (!node) return '';
        if (state.budgetExceeded || state.outputBudgetExceeded) return '';
        if (depth > state.maxDepth) {
            addWarning(state, 'DOM depth limit reached; deep nodes omitted.');
            return '';
        }
        if (!checkTraversalBudget(state)) return '';

        if (node.nodeType === 3) {
            return node.nodeValue || node.textContent || '';
        }

        if (node.nodeType !== 1) return '';

        if (shouldExcludeElement(node)) return '';

        const tag = getTagName(node);

        switch (tag) {
            case 'BR':
                return '  \n';

            case 'STRONG':
            case 'B': {
                const inner = convertInlineChildren(node, state, depth);
                return inner ? `**${inner}**` : '';
            }

            case 'EM':
            case 'I': {
                const inner = convertInlineChildren(node, state, depth);
                return inner ? `*${inner}*` : '';
            }

            case 'DEL':
            case 'S':
            case 'STRIKE': {
                const inner = convertInlineChildren(node, state, depth);
                return inner ? `~~${inner}~~` : '';
            }

            case 'CODE': {
                const codeText = node.textContent || '';
                return escapeInlineCode(codeText);
            }

            case 'A': {
                const href = getAttribute(node, 'href');
                const title = getAttribute(node, 'title');
                const innerText = convertInlineChildren(node, state, depth).trim();
                const sanitized = sanitizeUrl(href);

                if (sanitized) {
                    state.metadata.linksCount++;
                    const safeTitle = title ? ` "${sanitizeInlineAttr(title)}"` : '';
                    return `[${innerText || sanitized}](${sanitized}${safeTitle})`;
                } else {
                    return innerText;
                }
            }

            case 'IMG': {
                const src = getAttribute(node, 'src');
                const alt = getAttribute(node, 'alt') || '';
                const title = getAttribute(node, 'title');
                const sanitized = sanitizeUrl(src);

                if (sanitized) {
                    state.metadata.imagesCount++;
                    const safeAlt = sanitizeAltText(alt);
                    const safeTitle = title ? ` "${sanitizeInlineAttr(title)}"` : '';
                    return `![${safeAlt}](${sanitized}${safeTitle})`;
                }
                return '';
            }

            case 'SPAN':
            case 'LABEL':
            case 'SMALL':
            case 'SUB':
            case 'SUP':
            case 'MARK':
            case 'TIME':
            case 'ABBR':
            case 'CITE':
            case 'Q':
            case 'KBD':
            case 'VAR':
            case 'SAMP':
            case 'DATA':
            case 'DFN':
            case 'BDI':
            case 'BDO':
            case 'RUBY':
            case 'RT':
            case 'RP':
                return convertInlineChildren(node, state, depth);

            default:
                return convertInlineChildren(node, state, depth);
        }
    }

    function getCellAlignment(thOrTd) {
        const alignAttr = getAttribute(thOrTd, 'align');
        if (alignAttr) {
            const lower = alignAttr.toLowerCase();
            if (lower === 'left') return ':---';
            if (lower === 'center') return ':---:';
            if (lower === 'right') return '---:';
        }
        const styleAttr = getAttribute(thOrTd, 'style');
        if (styleAttr) {
            const normalized = styleAttr.replace(/\s+/g, '').toLowerCase();
            if (normalized.includes('text-align:left')) return ':---';
            if (normalized.includes('text-align:center')) return ':---:';
            if (normalized.includes('text-align:right')) return '---:';
        }
        return '---';
    }

    function convertTable(tableEl, state, depth = 0) {
        if (state.budgetExceeded || state.outputBudgetExceeded) return '';
        if (depth > state.maxDepth) {
            addWarning(state, 'DOM depth limit reached; deep nodes omitted.');
            return '';
        }
        if (!checkTraversalBudget(state)) return '';

        state.metadata.tablesCount++;
        const trElements = findDescendants(tableEl, (child) => getTagName(child) === 'TR');
        if (trElements.length === 0) return '';

        const rows = [];
        let maxCols = 0;
        const alignments = [];

        for (const tr of trElements) {
            if (state.budgetExceeded || state.outputBudgetExceeded) break;
            if (!checkTraversalBudget(state)) break;
            if (shouldExcludeElement(tr)) continue;

            const cells = getChildNodes(tr).filter((c) => {
                const tag = getTagName(c);
                return tag === 'TH' || tag === 'TD';
            });

            if (cells.length === 0) continue;

            const rowCells = [];
            cells.forEach((cell, colIndex) => {
                if (shouldExcludeElement(cell)) return;
                checkTraversalBudget(state);
                const cellText = convertInlineChildren(cell, state, depth + 1).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
                rowCells.push(cellText);

                if (!alignments[colIndex]) {
                    alignments[colIndex] = getCellAlignment(cell);
                }
            });

            if (rowCells.length > maxCols) {
                maxCols = rowCells.length;
            }
            rows.push(rowCells);
        }

        if (rows.length === 0 || maxCols === 0) return '';

        for (let i = 0; i < maxCols; i++) {
            if (!alignments[i]) {
                alignments[i] = '---';
            }
        }

        const formattedRows = rows.map((r) => {
            while (r.length < maxCols) {
                r.push('');
            }
            return `| ${r.join(' | ')} |`;
        });

        const headerRow = formattedRows[0];
        const separatorRow = `| ${alignments.slice(0, maxCols).join(' | ')} |`;
        const bodyRows = formattedRows.slice(1);

        let tableMd = `${headerRow}\n${separatorRow}`;
        if (bodyRows.length > 0) {
            tableMd += '\n' + bodyRows.join('\n');
        }

        return tableMd + '\n\n';
    }

    function convertList(listEl, state, listDepth = 0, domDepth = 0) {
        if (state.budgetExceeded || state.outputBudgetExceeded) return '';
        if (domDepth > state.maxDepth) {
            addWarning(state, 'DOM depth limit reached; deep nodes omitted.');
            return '';
        }
        if (!checkTraversalBudget(state)) return '';

        state.metadata.listsCount++;
        const isOrdered = getTagName(listEl) === 'OL';
        const startAttr = getAttribute(listEl, 'start');
        let counter = startAttr && !isNaN(parseInt(startAttr, 10)) ? parseInt(startAttr, 10) : 1;

        const items = getChildNodes(listEl).filter((c) => getTagName(c) === 'LI');
        let result = '';
        const indent = '  '.repeat(listDepth);

        for (const li of items) {
            if (state.budgetExceeded || state.outputBudgetExceeded) break;
            if (!checkTraversalBudget(state)) break;
            if (shouldExcludeElement(li)) continue;

            const prefix = isOrdered ? `${counter++}. ` : '- ';
            let inlineText = '';
            let nestedListsMd = '';

            const liChildren = getChildNodes(li);
            for (const liChild of liChildren) {
                if (state.budgetExceeded || state.outputBudgetExceeded) break;
                if (shouldExcludeElement(liChild)) continue;
                const childTag = getTagName(liChild);
                if (childTag === 'UL' || childTag === 'OL') {
                    nestedListsMd += convertList(liChild, state, listDepth + 1, domDepth + 1);
                } else if (childTag === 'TABLE') {
                    nestedListsMd += '\n' + convertTable(liChild, state, domDepth + 1);
                } else if (childTag === 'PRE') {
                    nestedListsMd += '\n' + convertPre(liChild, state, domDepth + 1);
                } else if (childTag === 'BLOCKQUOTE') {
                    nestedListsMd += '\n' + convertBlockquote(liChild, state, domDepth + 1);
                } else {
                    inlineText += convertInlineNode(liChild, state, domDepth + 1);
                }
            }

            result += `${indent}${prefix}${inlineText.trim()}\n`;
            if (nestedListsMd) {
                result += nestedListsMd;
            }
        }

        return listDepth === 0 ? (result ? result + '\n' : '') : result;
    }

    function convertBlockquote(el, state, depth = 0) {
        if (state.budgetExceeded || state.outputBudgetExceeded) return '';
        if (depth > state.maxDepth) {
            addWarning(state, 'DOM depth limit reached; deep nodes omitted.');
            return '';
        }
        if (!checkTraversalBudget(state)) return '';

        state.metadata.quotesCount++;
        const content = convertBlockChildren(el, state, depth + 1).trim();
        if (!content) return '';
        const lines = content.split('\n');
        return lines.map((line) => `> ${line}`).join('\n') + '\n\n';
    }

    function convertPre(preEl, state, depth = 0) {
        if (state.budgetExceeded || state.outputBudgetExceeded) return '';
        if (depth > state.maxDepth) {
            addWarning(state, 'DOM depth limit reached; deep nodes omitted.');
            return '';
        }
        if (!checkTraversalBudget(state)) return '';

        state.metadata.codeBlocksCount++;
        const codeChildren = findDescendants(preEl, (child) => getTagName(child) === 'CODE');
        let lang = '';
        let rawCode = '';

        if (codeChildren.length > 0) {
            const codeEl = codeChildren[0];
            const cls = getAttribute(codeEl, 'class') || '';
            const match = cls.match(/(?:language|lang)-([a-zA-Z0-9_-]+)/);
            if (match) {
                lang = match[1];
            }
            rawCode = codeEl.textContent || '';
        } else {
            rawCode = preEl.textContent || '';
        }

        if (lang === 'mermaid' || lang === 'mermaid-diagram') {
            state.metadata.hasMermaidSource = true;
            state.metadata.mermaidCount++;
        }

        const fence = createSafeFence(rawCode);
        return `${fence}${lang}\n${rawCode}\n${fence}\n\n`;
    }

    function convertBlockNode(node, state, depth = 0) {
        if (!node) return '';
        if (state.budgetExceeded || state.outputBudgetExceeded) return '';
        if (depth > state.maxDepth) {
            addWarning(state, 'DOM depth limit reached; deep nodes omitted.');
            return '';
        }
        if (!checkTraversalBudget(state)) return '';

        if (node.nodeType === 3) {
            const val = (node.nodeValue || node.textContent || '').trim();
            return val ? val + '\n\n' : '';
        }

        if (node.nodeType !== 1) return '';

        if (shouldExcludeElement(node)) return '';

        if (isRenderedMermaidViewer(node)) {
            const hasExplicitSource = Boolean(state.metadata.hasMermaidSource);
            if (!hasExplicitSource) {
                state.metadata.hasSvgOnlyMermaid = true;
                state.metadata.mermaidCount++;
                addWarning(state, 'Mermaid source is unavailable; rendered SVG was not converted.');
                return '> [!WARNING]\n> Mermaid source is unavailable; rendered SVG was not converted.\n\n';
            }
            return '';
        }

        const tag = getTagName(node);

        switch (tag) {
            case 'H1':
            case 'H2':
            case 'H3':
            case 'H4':
            case 'H5':
            case 'H6': {
                state.metadata.headingsCount++;
                const level = parseInt(tag.charAt(1), 10);
                const hashes = '#'.repeat(level);
                const text = convertInlineChildren(node, state, depth + 1).trim();
                return text ? `${hashes} ${text}\n\n` : '';
            }

            case 'P': {
                const text = convertInlineChildren(node, state, depth + 1).trim();
                return text ? `${text}\n\n` : '';
            }

            case 'HR':
                return '---\n\n';

            case 'PRE':
                return convertPre(node, state, depth);

            case 'UL':
            case 'OL':
                return convertList(node, state, 0, depth);

            case 'TABLE':
                return convertTable(node, state, depth);

            case 'BLOCKQUOTE':
                return convertBlockquote(node, state, depth);

            case 'ARTICLE':
            case 'SECTION':
            case 'MAIN':
            case 'DIV':
                return convertBlockChildren(node, state, depth + 1);

            default: {
                const inline = convertInlineNode(node, state, depth).trim();
                return inline ? `${inline}\n\n` : '';
            }
        }
    }

    function convertBlockChildren(node, state, depth = 0) {
        if (state.budgetExceeded || state.outputBudgetExceeded) return '';
        if (depth > state.maxDepth) {
            addWarning(state, 'DOM depth limit reached; deep nodes omitted.');
            return '';
        }
        let result = '';
        const children = getChildNodes(node);
        for (const child of children) {
            if (state.budgetExceeded || state.outputBudgetExceeded) break;
            const blockResult = convertBlockNode(child, state, depth);
            if (blockResult) {
                result += blockResult;
                if (result.length > state.maxChars) {
                    addWarning(state, 'Character limit reached; Markdown output truncated.');
                    state.outputBudgetExceeded = true;
                    result = result.slice(0, state.maxChars);
                    break;
                }
            }
        }
        return result;
    }

    function convertDomToMarkdown(rootNode, options = {}) {
        if (!rootNode) {
            return {
                ok: false,
                code: 'NO_ROOT',
                markdown: '',
                warnings: ['Root element is missing.'],
                metadata: {}
            };
        }

        const maxChars = typeof options.maxChars === 'number' ? options.maxChars : MAX_MARKDOWN_CHARS;
        const maxDepth = typeof options.maxDepth === 'number' ? options.maxDepth : MAX_DOM_DEPTH;
        const maxNodes = typeof options.maxNodes === 'number' ? options.maxNodes : MAX_DOM_NODES;

        // Pre-scan for explicit Mermaid source code blocks before top-down traversal
        const explicitMermaidSources = findDescendants(rootNode, (el) => {
            if (!el || el.nodeType !== 1) return false;
            const tag = getTagName(el);
            if (tag === 'CODE') {
                const cls = (getAttribute(el, 'class') || '').toLowerCase();
                const lang = getAttribute(el, 'data-language') || getAttribute(el, 'data-lang') || '';
                return cls.includes('language-mermaid') || cls.includes('lang-mermaid') || lang.toLowerCase() === 'mermaid';
            }
            return false;
        });

        const state = {
            warnings: [],
            visitedNodes: 0,
            maxNodes,
            maxDepth,
            maxChars,
            budgetExceeded: false,
            outputBudgetExceeded: false,
            metadata: {
                title: '',
                headingsCount: 0,
                codeBlocksCount: 0,
                tablesCount: 0,
                listsCount: 0,
                quotesCount: 0,
                linksCount: 0,
                imagesCount: 0,
                mermaidCount: 0,
                hasMermaidSource: explicitMermaidSources.length > 0,
                hasSvgOnlyMermaid: false,
                characterCount: 0
            }
        };

        let docTitle = '';
        if (typeof options.title === 'string' && options.title.trim()) {
            docTitle = options.title.trim();
        } else if (options.document && typeof options.document.title === 'string' && options.document.title.trim()) {
            docTitle = options.document.title.trim();
        } else if (typeof document !== 'undefined' && typeof document.title === 'string' && document.title.trim()) {
            docTitle = document.title.trim();
        }

        if (docTitle && docTitle !== 'Claude' && docTitle !== 'Artifact Viewer') {
            state.metadata.title = docTitle;
        }

        let markdown = convertBlockNode(rootNode, state, 0).trim();

        if (!state.metadata.title) {
            const h1Match = markdown.match(/^#\s+(.+)$/m);
            if (h1Match) {
                state.metadata.title = h1Match[1].trim();
            }
        }

        if (markdown.length > state.maxChars) {
            markdown = markdown.slice(0, state.maxChars).trim();
            addWarning(state, 'Character limit reached; Markdown output truncated.');
        }

        state.metadata.characterCount = markdown.length;

        return {
            ok: true,
            markdown,
            warnings: state.warnings,
            metadata: state.metadata
        };
    }

    root.AygaArtifactConverter = Object.freeze({
        convertDomToMarkdown,
        sanitizeUrl,
        isSafeUrl,
        createSafeFence,
        escapeInlineCode,
        shouldExcludeElement,
        MAX_MARKDOWN_CHARS,
        MAX_DOM_DEPTH,
        MAX_DOM_NODES
    });
})(typeof globalThis !== 'undefined' ? globalThis : this);
