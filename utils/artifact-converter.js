(function attachArtifactConverter(root) {
    'use strict';

    const MAX_MARKDOWN_CHARS = 50000;
    const MAX_DOM_DEPTH = 32;
    const MAX_WARNINGS = 50;

    const BLACKLISTED_TAGS = new Set([
        'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE',
        'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'APPLET',
        'FORM', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'OPTGROUP',
        'DIALOG', 'AUDIO', 'VIDEO'
    ]);

    const SERVICE_CLASS_PATTERNS = [
        /(?:^|\s)copy[-_]?button(?:\s|$)/i,
        /(?:^|\s)service[-_]?(?:icon|ui)(?:\s|$)/i,
        /(?:^|\s)artifact[-_]?toolbar(?:\s|$)/i,
        /(?:^|\s)action[-_]?button(?:\s|$)/i,
        /(?:^|\s)feedback[-_]?button(?:\s|$)/i,
        /(?:^|\s)sr[-_]?only(?:\s|$)/i,
        /(?:^|\s)visually[-_]?hidden(?:\s|$)/i
    ];

    function getTagName(node) {
        if (!node || node.nodeType !== 1) return '';
        return (node.nodeName || node.tagName || '').toUpperCase();
    }

    function getChildNodes(node) {
        if (!node) return [];
        if (node.childNodes && typeof node.childNodes.length === 'number') {
            return Array.from(node.childNodes);
        }
        if (Array.isArray(node.children)) {
            return node.children;
        }
        return [];
    }

    function getAttribute(node, attrName) {
        if (!node || node.nodeType !== 1) return null;
        if (typeof node.getAttribute === 'function') {
            return node.getAttribute(attrName);
        }
        if (node.attributes && typeof node.attributes === 'object') {
            return node.attributes[attrName] !== undefined ? node.attributes[attrName] : null;
        }
        return null;
    }

    function hasAttribute(node, attrName) {
        if (!node || node.nodeType !== 1) return false;
        if (typeof node.hasAttribute === 'function') {
            return node.hasAttribute(attrName);
        }
        if (node.attributes && typeof node.attributes === 'object') {
            return node.attributes[attrName] !== undefined;
        }
        return false;
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

        const styleAttr = getAttribute(el, 'style');
        if (typeof styleAttr === 'string') {
            const normalized = styleAttr.toLowerCase().replace(/\s+/g, '');
            if (normalized.includes('display:none') || normalized.includes('visibility:hidden')) {
                return true;
            }
        }
        if (el.style && (el.style.display === 'none' || el.style.visibility === 'hidden')) {
            return true;
        }

        const className = typeof el.className === 'string'
            ? el.className
            : (getAttribute(el, 'class') || '');
        if (typeof className === 'string' && className.length > 0) {
            if (SERVICE_CLASS_PATTERNS.some((pattern) => pattern.test(className))) {
                return true;
            }
        }

        if (getAttribute(el, 'data-service-ui') === 'true' || getAttribute(el, 'data-action') === 'copy') {
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
            if (scheme === 'javascript' || scheme === 'data' || scheme === 'vbscript' || scheme === 'file' || scheme === 'blob') {
                return null;
            }
            if (scheme !== 'http' && scheme !== 'https' && scheme !== 'mailto') {
                return null;
            }
        }

        if (/^https?:\/\//i.test(url)) {
            try {
                const parsed = new URL(url);
                if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

                if (parsed.hostname.includes('claudeusercontent.com')) {
                    return null;
                }

                // Check for sensitive auth params
                for (const param of parsed.searchParams.keys()) {
                    if (SENSITIVE_QUERY_PARAMS.has(param.toLowerCase())) {
                        return null;
                    }
                }

                parsed.username = '';
                parsed.password = '';
                return parsed.href;
            } catch {
                return null;
            }
        }

        if (/^mailto:/i.test(url)) {
            try {
                const parsed = new URL(url);
                return parsed.protocol === 'mailto:' ? parsed.href : null;
            } catch {
                return null;
            }
        }

        if (url.startsWith('#') || url.startsWith('/') || url.startsWith('./') || url.startsWith('../')) {
            return url;
        }

        if (!url.includes(':') && !url.startsWith('//')) {
            return url;
        }

        return null;
    }

    function createSafeFence(codeText) {
        if (typeof codeText !== 'string') return '```';
        const matches = codeText.match(/`+/g);
        let maxTicks = 2;
        if (matches) {
            for (const m of matches) {
                if (m.length > maxTicks) {
                    maxTicks = m.length;
                }
            }
        }
        return '`'.repeat(maxTicks + 1);
    }

    function extractCodeLanguage(element) {
        if (!element || element.nodeType !== 1) return '';

        const dataLang = getAttribute(element, 'data-language') || getAttribute(element, 'data-lang');
        if (dataLang && typeof dataLang === 'string') {
            const cleaned = dataLang.trim().toLowerCase();
            if (/^[a-zA-Z0-9_+#.-]+$/.test(cleaned)) {
                return cleaned;
            }
        }

        const className = typeof element.className === 'string'
            ? element.className
            : (getAttribute(element, 'class') || '');

        if (typeof className === 'string') {
            const match = className.match(/(?:^|\s)(?:language|lang)-([a-zA-Z0-9_+#.-]+)(?:\s|$)/i);
            if (match && /^[a-zA-Z0-9_+#.-]+$/.test(match[1])) return match[1].toLowerCase();
        }

        return '';
    }

    function isRenderedMermaidViewer(node) {
        if (!node || node.nodeType !== 1) return false;
        const tag = getTagName(node);
        const className = typeof node.className === 'string'
            ? node.className
            : (getAttribute(node, 'class') || '');
        const id = typeof node.id === 'string'
            ? node.id
            : (getAttribute(node, 'id') || '');

        if (tag === 'SVG' && (id.startsWith('claude-mermaid') || /(?:^|\s)mermaid(?:\s|$)/i.test(className))) {
            return true;
        }

        if (/(?:^|\s)mermaid-viewer(?:\s|$)/i.test(className)) {
            return true;
        }

        const svgChild = findDescendants(node, (child) => {
            const childTag = getTagName(child);
            const childId = typeof child.id === 'string' ? child.id : (getAttribute(child, 'id') || '');
            return childTag === 'SVG' && childId.startsWith('claude-mermaid');
        });

        return svgChild.length > 0;
    }

    function isInsideThead(node) {
        let current = node ? node.parentNode : null;
        while (current) {
            if (getTagName(current) === 'THEAD') return true;
            if (getTagName(current) === 'TABLE') return false;
            current = current.parentNode;
        }
        return false;
    }

    function getCellAlignment(cell) {
        const alignAttr = getAttribute(cell, 'align');
        if (alignAttr) {
            const alignLower = alignAttr.toLowerCase();
            if (alignLower === 'center') return 'center';
            if (alignLower === 'right') return 'right';
            if (alignLower === 'left') return 'left';
        }

        const styleAttr = getAttribute(cell, 'style');
        if (typeof styleAttr === 'string') {
            const normalized = styleAttr.toLowerCase().replace(/\s+/g, '');
            if (normalized.includes('text-align:center')) return 'center';
            if (normalized.includes('text-align:right')) return 'right';
            if (normalized.includes('text-align:left')) return 'left';
        }

        return 'left';
    }

    function addWarning(state, warningText) {
        if (state.warnings.length < MAX_WARNINGS) {
            state.warnings.push(warningText);
        }
    }

    function convertInlineChildren(node, state) {
        const children = getChildNodes(node);
        let result = '';
        for (const child of children) {
            result += convertInlineNode(child, state);
        }
        return result;
    }

    function convertInlineNode(node, state) {
        if (!node) return '';

        if (node.nodeType === 3) {
            const text = node.textContent !== undefined ? node.textContent : (node.nodeValue || '');
            return text.replace(/\s+/g, ' ');
        }

        if (node.nodeType !== 1) return '';
        if (shouldExcludeElement(node)) return '';

        const tag = getTagName(node);

        switch (tag) {
            case 'STRONG':
            case 'B': {
                const inner = convertInlineChildren(node, state).trim();
                return inner ? `**${inner}**` : '';
            }
            case 'EM':
            case 'I': {
                const inner = convertInlineChildren(node, state).trim();
                return inner ? `*${inner}*` : '';
            }
            case 'DEL':
            case 'S':
            case 'STRIKE': {
                const inner = convertInlineChildren(node, state).trim();
                return inner ? `~~${inner}~~` : '';
            }
            case 'CODE': {
                const codeText = node.textContent !== undefined ? node.textContent : '';
                if (!codeText) return '';
                if (codeText.includes('`')) {
                    const fence = codeText.startsWith('`') || codeText.endsWith('`') ? '`` ' : '``';
                    const closingFence = codeText.startsWith('`') || codeText.endsWith('`') ? ' ``' : '``';
                    return `${fence}${codeText}${closingFence}`;
                }
                return `\`${codeText}\``;
            }
            case 'A': {
                state.metadata.linksCount++;
                const href = getAttribute(node, 'href');
                const sanitized = sanitizeUrl(href);
                const text = convertInlineChildren(node, state).trim();
                if (!sanitized) {
                    return text;
                }
                const linkText = text || sanitized;
                const title = getAttribute(node, 'title');
                if (title && typeof title === 'string') {
                    const safeTitle = title.replace(/"/g, '\\"');
                    return `[${linkText}](${sanitized} "${safeTitle}")`;
                }
                return `[${linkText}](${sanitized})`;
            }
            case 'IMG': {
                state.metadata.imagesCount++;
                const src = getAttribute(node, 'src');
                const sanitized = sanitizeUrl(src);
                if (!sanitized) {
                    if (src) {
                        addWarning(state, 'Unsafe image source was omitted.');
                    }
                    return '';
                }
                const alt = (getAttribute(node, 'alt') || '').replace(/[\[\]]/g, '');
                const title = getAttribute(node, 'title');
                if (title && typeof title === 'string') {
                    const safeTitle = title.replace(/"/g, '\\"');
                    return `![${alt}](${sanitized} "${safeTitle}")`;
                }
                return `![${alt}](${sanitized})`;
            }
            case 'BR':
                return '  \n';
            case 'SPAN':
            case 'SMALL':
            case 'SUB':
            case 'SUP':
            case 'MARK':
            case 'ABBR':
            case 'CITE':
            case 'Q':
            case 'TIME':
            case 'VAR':
            case 'KBD':
            case 'SAMP':
                return convertInlineChildren(node, state);
            default:
                return convertInlineChildren(node, state);
        }
    }

    function convertTable(tableEl, state) {
        state.metadata.tablesCount++;
        const trElements = findDescendants(tableEl, (child) => getTagName(child) === 'TR');
        if (trElements.length === 0) return '';

        const rows = [];
        let maxCols = 0;

        for (const tr of trElements) {
            const cells = [];
            const cellChildren = getChildNodes(tr).filter((c) => {
                const tag = getTagName(c);
                return tag === 'TH' || tag === 'TD';
            });

            for (const cell of cellChildren) {
                const align = getCellAlignment(cell);
                const cellText = convertInlineChildren(cell, state)
                    .replace(/\r?\n/g, '<br>')
                    .replace(/\|/g, '\\|')
                    .trim();
                cells.push({ text: cellText, align });
            }

            if (cells.length > maxCols) {
                maxCols = cells.length;
            }
            if (cells.length > 0) {
                rows.push(cells);
            }
        }

        if (rows.length === 0 || maxCols === 0) return '';

        const alignments = [];
        for (let c = 0; c < maxCols; c++) {
            let colAlign = 'left';
            for (const r of rows) {
                if (r[c] && r[c].align && r[c].align !== 'left') {
                    colAlign = r[c].align;
                    break;
                }
            }
            alignments.push(colAlign);
        }

        const lines = [];
        const headerRow = rows[0];
        const headerCells = [];
        for (let c = 0; c < maxCols; c++) {
            headerCells.push(headerRow[c] ? headerRow[c].text : '');
        }
        lines.push(`| ${headerCells.join(' | ')} |`);

        const delimiterCells = alignments.map((align) => {
            if (align === 'center') return ':---:';
            if (align === 'right') return '---:';
            return ':---';
        });
        lines.push(`| ${delimiterCells.join(' | ')} |`);

        for (let r = 1; r < rows.length; r++) {
            const row = rows[r];
            const rowCells = [];
            for (let c = 0; c < maxCols; c++) {
                rowCells.push(row[c] ? row[c].text : '');
            }
            lines.push(`| ${rowCells.join(' | ')} |`);
        }

        return lines.join('\n') + '\n\n';
    }

    function convertList(listEl, state, depth = 0) {
        state.metadata.listsCount++;
        const isOrdered = getTagName(listEl) === 'OL';
        let startIndex = 1;
        if (isOrdered) {
            const startAttr = getAttribute(listEl, 'start');
            if (startAttr && /^\d+$/.test(startAttr)) {
                startIndex = parseInt(startAttr, 10);
            }
        }

        const indent = '  '.repeat(depth);
        const lines = [];
        let currentIndex = startIndex;

        const childNodes = getChildNodes(listEl);
        for (const child of childNodes) {
            if (shouldExcludeElement(child)) continue;
            const tag = getTagName(child);
            if (tag === 'LI') {
                const prefix = isOrdered ? `${currentIndex}. ` : '- ';
                currentIndex++;

                let inlineText = '';
                const nestedListElements = [];

                const liChildren = getChildNodes(child);
                for (const liChild of liChildren) {
                    if (shouldExcludeElement(liChild)) continue;
                    const liChildTag = getTagName(liChild);
                    if (liChildTag === 'UL' || liChildTag === 'OL') {
                        nestedListElements.push(liChild);
                    } else if (liChildTag === 'P') {
                        inlineText += convertInlineChildren(liChild, state) + ' ';
                    } else {
                        inlineText += convertInlineNode(liChild, state);
                    }
                }

                inlineText = inlineText.trim();
                lines.push(`${indent}${prefix}${inlineText}`);

                for (const nested of nestedListElements) {
                    const nestedMd = convertList(nested, state, depth + 1);
                    if (nestedMd.trim()) {
                        lines.push(nestedMd.trimEnd());
                    }
                }
            }
        }

        const result = lines.join('\n');
        return depth === 0 ? (result ? result + '\n\n' : '') : result;
    }

    function convertBlockquote(el, state) {
        state.metadata.quotesCount++;
        const inner = convertBlockChildren(el, state).trim();
        if (!inner) return '';
        const lines = inner.split('\n');
        const quotedLines = lines.map((line) => (line.length > 0 ? `> ${line}` : '>'));
        return quotedLines.join('\n') + '\n\n';
    }

    function convertPre(preEl, state) {
        state.metadata.codeBlocksCount++;
        const codeChildren = findDescendants(preEl, (child) => getTagName(child) === 'CODE');
        const codeEl = codeChildren.length > 0 ? codeChildren[0] : preEl;

        let lang = extractCodeLanguage(codeEl) || extractCodeLanguage(preEl);
        const rawCode = (codeEl.textContent !== undefined ? codeEl.textContent : (preEl.textContent || '')).replace(/\r\n/g, '\n');

        if (lang === 'mermaid') {
            state.metadata.hasMermaidSource = true;
            state.metadata.mermaidCount++;
        }

        const fence = createSafeFence(rawCode);
        const cleanCode = rawCode.endsWith('\n') ? rawCode.slice(0, -1) : rawCode;
        return `${fence}${lang}\n${cleanCode}\n${fence}\n\n`;
    }

    function convertBlockNode(node, state) {
        if (!node) return '';

        if (node.nodeType === 3) {
            const text = (node.textContent !== undefined ? node.textContent : (node.nodeValue || '')).trim();
            return text ? `${text}\n\n` : '';
        }

        if (node.nodeType !== 1) return '';
        if (shouldExcludeElement(node)) return '';

        const tag = getTagName(node);

        if (isRenderedMermaidViewer(node)) {
            const hasExplicitSource = Boolean(state.metadata.hasMermaidSource);
            if (!hasExplicitSource) {
                state.metadata.hasSvgOnlyMermaid = true;
                state.metadata.mermaidCount++;
                addWarning(state, 'Mermaid diagram source code was unavailable; rendered vector graphic omitted.');
                return '<!-- [Mermaid diagram: source code unavailable; rendered vector graphic omitted] -->\n\n';
            }
            return '';
        }

        switch (tag) {
            case 'H1':
            case 'H2':
            case 'H3':
            case 'H4':
            case 'H5':
            case 'H6': {
                state.metadata.headingsCount++;
                const level = parseInt(tag[1], 10);
                const prefix = '#'.repeat(level) + ' ';
                const inner = convertInlineChildren(node, state).trim();
                return inner ? `${prefix}${inner}\n\n` : '';
            }
            case 'P': {
                const inner = convertInlineChildren(node, state).trim();
                return inner ? `${inner}\n\n` : '';
            }
            case 'HR':
                return '---\n\n';
            case 'BLOCKQUOTE':
                return convertBlockquote(node, state);
            case 'UL':
            case 'OL':
                return convertList(node, state, 0);
            case 'TABLE':
                return convertTable(node, state);
            case 'PRE':
                return convertPre(node, state);
            case 'DIV':
            case 'SECTION':
            case 'ARTICLE':
            case 'MAIN':
            case 'HEADER':
            case 'FOOTER':
            case 'ASIDE':
            case 'BODY':
            case 'HTML':
                return convertBlockChildren(node, state);
            default: {
                const inline = convertInlineNode(node, state).trim();
                return inline ? `${inline}\n\n` : '';
            }
        }
    }

    function convertBlockChildren(node, state) {
        const children = getChildNodes(node);
        let result = '';
        for (const child of children) {
            result += convertBlockNode(child, state);
        }
        return result;
    }

    function convertDomToMarkdown(rootNode, options = {}) {
        const state = {
            warnings: [],
            metadata: {
                title: '',
                headingsCount: 0,
                codeBlocksCount: 0,
                tablesCount: 0,
                imagesCount: 0,
                linksCount: 0,
                listsCount: 0,
                quotesCount: 0,
                mermaidCount: 0,
                hasMermaidSource: false,
                hasSvgOnlyMermaid: false,
                characterCount: 0
            },
            maxChars: typeof options.maxChars === 'number' ? options.maxChars : MAX_MARKDOWN_CHARS
        };

        if (!rootNode) {
            return {
                markdown: '',
                warnings: ['No DOM root provided for conversion.'],
                metadata: state.metadata
            };
        }

        const doc = options.document || rootNode.ownerDocument || (rootNode.nodeType === 9 ? rootNode : null);
        if (doc && doc.title && typeof doc.title === 'string') {
            const cleanTitle = doc.title.trim();
            if (cleanTitle && !/^artifact frame/i.test(cleanTitle) && !/^user-generated/i.test(cleanTitle)) {
                state.metadata.title = cleanTitle;
            }
        }

        let markdown = convertBlockChildren(rootNode, state).trim();

        if (!state.metadata.title) {
            const h1Match = markdown.match(/^#\s+(.+)$/m);
            if (h1Match) {
                state.metadata.title = h1Match[1].trim();
            }
        }

        markdown = markdown.replace(/\n{3,}/g, '\n\n').trim();

        if (markdown.length > state.maxChars) {
            markdown = markdown.slice(0, state.maxChars).trim();
            addWarning(state, 'Markdown output was truncated to stay within message size limits.');
        }

        state.metadata.characterCount = markdown.length;

        return {
            markdown,
            warnings: state.warnings,
            metadata: state.metadata
        };
    }

    const AygaArtifactConverter = Object.freeze({
        convertDomToMarkdown,
        sanitizeUrl,
        createSafeFence,
        extractCodeLanguage,
        shouldExcludeElement,
        MAX_MARKDOWN_CHARS,
        MAX_DOM_DEPTH
    });

    root.AygaArtifactConverter = AygaArtifactConverter;

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = AygaArtifactConverter;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);

export const convertDomToMarkdown = (typeof globalThis !== 'undefined' && globalThis.AygaArtifactConverter ? globalThis.AygaArtifactConverter.convertDomToMarkdown : null);
export const sanitizeUrl = (typeof globalThis !== 'undefined' && globalThis.AygaArtifactConverter ? globalThis.AygaArtifactConverter.sanitizeUrl : null);
export const createSafeFence = (typeof globalThis !== 'undefined' && globalThis.AygaArtifactConverter ? globalThis.AygaArtifactConverter.createSafeFence : null);
export const extractCodeLanguage = (typeof globalThis !== 'undefined' && globalThis.AygaArtifactConverter ? globalThis.AygaArtifactConverter.extractCodeLanguage : null);
export const shouldExcludeElement = (typeof globalThis !== 'undefined' && globalThis.AygaArtifactConverter ? globalThis.AygaArtifactConverter.shouldExcludeElement : null);
export const MAX_MARKDOWN_CHARS = 200000;
export const MAX_DOM_DEPTH = 32;

export default (typeof globalThis !== 'undefined' ? globalThis.AygaArtifactConverter : null);

