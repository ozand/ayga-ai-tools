// utils/artifact-converter.js - Content-script safe converter without ESM export

(function initArtifactConverter(root) {
    'use strict';

    const MAX_MARKDOWN_CHARS = 50000;
    const MAX_DOM_DEPTH = 32;
    const MAX_DOM_NODES = 10000;
    const MAX_WARNINGS = 50;
    const MAX_SVG_BYTES = 256 * 1024; // 256 KB limit for SVG diagrams
    const MAX_SVG_NODES = 1000;
    const MAX_SVG_DEPTH = 32;
    const MAX_SVG_ATTRS_PER_NODE = 30;
    const MAX_SVG_TEXT_PER_NODE = 10000;

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

    const ALLOWED_SVG_TAGS = new Set([
        'svg', 'g', 'path', 'rect', 'circle', 'ellipse',
        'line', 'polyline', 'polygon', 'text', 'tspan',
        'textpath', 'defs', 'marker', 'lineargradient',
        'radialgradient', 'stop', 'clippath', 'pattern',
        'desc', 'title'
    ]);

    const FORBIDDEN_SVG_TAGS = new Set([
        'script', 'style', 'foreignobject', 'animate',
        'animatemotion', 'animatetransform', 'animatecolor',
        'set', 'discard', 'use', 'image', 'iframe', 'frame',
        'object', 'embed', 'audio', 'video', 'link', 'a',
        'meta', 'html', 'body', 'head'
    ]);

    const ALLOWED_SVG_ATTRS = new Set([
        'xmlns', 'viewbox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
        'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'dx', 'dy', 'transform',
        'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap',
        'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset',
        'stroke-opacity', 'opacity', 'color', 'visibility', 'display',
        'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor',
        'dominant-baseline', 'alignment-baseline', 'letter-spacing', 'word-spacing', 'direction',
        'id', 'class', 'version', 'marker-start', 'marker-mid', 'marker-end',
        'clip-path', 'mask', 'patternunits', 'patterncontentunits',
        'gradientunits', 'gradienttransform', 'offset', 'stop-color', 'stop-opacity',
        'style'
    ]);

    const ALLOWED_STYLE_PROPERTIES = new Set([
        'fill', 'fill-opacity', 'fill-rule',
        'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit',
        'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity',
        'opacity', 'color', 'visibility', 'display',
        'font-family', 'font-size', 'font-weight', 'font-style',
        'text-anchor', 'dominant-baseline', 'alignment-baseline',
        'letter-spacing', 'word-spacing'
    ]);

    const RESERVED_WINDOWS_NAMES = new Set([
        'CON', 'PRN', 'AUX', 'NUL',
        'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
        'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
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
        if (node.childNodes) {
            return Array.from(node.childNodes);
        }
        if (node.children) {
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

    function escapeXml(str) {
        if (typeof str !== 'string') return '';
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    function escapeXmlAttr(str) {
        if (typeof str !== 'string') return '';
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function sanitizeBaseName(rawInput) {
        if (typeof rawInput !== 'string') return 'artifact';
        let input = rawInput.normalize('NFC').trim();
        if (!input) return 'artifact';

        while (/\.(md|markdown|html|htm|svg)$/i.test(input)) {
            input = input.replace(/\.(md|markdown|html|htm|svg)$/i, '').trim();
        }

        input = input.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '');
        input = input.replace(/[\\/:*?"<>|]+/g, ' ');
        input = input.replace(/\s+/g, '-').trim();
        input = input.replace(/^[.\s-]+|[.\s-]+$/g, '');

        if (!input) return 'artifact';

        const baseUpper = input.toUpperCase().split('.')[0];
        if (RESERVED_WINDOWS_NAMES.has(baseUpper)) {
            input = `artifact-${input}`;
        }

        if (input.length > 100) {
            input = input.slice(0, 100).replace(/[.\s-]+$/, '');
        }

        return input || 'artifact';
    }

    function sanitizeCssStyle(rawStyle, definedIds = null) {
        if (typeof rawStyle !== 'string') return '';
        const style = rawStyle.trim();
        if (!style) return '';

        const declarations = style.split(';');
        const safeDecls = [];

        for (const decl of declarations) {
            const trimmed = decl.trim();
            if (!trimmed) continue;
            const colonIdx = trimmed.indexOf(':');
            if (colonIdx === -1) continue;

            const prop = trimmed.slice(0, colonIdx).trim().toLowerCase();
            const val = trimmed.slice(colonIdx + 1).trim();

            if (!ALLOWED_STYLE_PROPERTIES.has(prop)) continue;
            if (/[\u0000-\u001F\u007F-\u009F]/.test(val)) continue;
            if (/javascript:|vbscript:|expression\(|@import|-moz-binding|<|>|http:\/\/|https:\/\/|\/\//i.test(val)) continue;
            if (/\bbehavior\b/i.test(val) || /\b-ms-behavior\b/i.test(val)) continue;

            if (/url\(/i.test(val)) {
                const urlMatch = val.match(/^url\s*\(\s*#([A-Za-z0-9_-]+)\s*\)$/i);
                if (!urlMatch) {
                    continue;
                }
                if (definedIds && !definedIds.has(urlMatch[1])) {
                    continue;
                }
            }

            safeDecls.push(`${prop}: ${val}`);
        }

        return safeDecls.length > 0 ? safeDecls.join('; ') + ';' : '';
    }

    function collectDefinedSvgIds(rootNode) {
        const definedIds = new Set();
        const stack = [{ node: rootNode, depth: 0 }];
        let visited = 0;
        while (stack.length > 0) {
            visited++;
            if (visited > MAX_SVG_NODES) break;
            const { node, depth } = stack.pop();
            if (!node || node.nodeType !== 1 || depth > MAX_SVG_DEPTH) continue;

            const idVal = getAttribute(node, 'id');
            if (idVal && typeof idVal === 'string') {
                const trimmed = idVal.trim();
                if (/^[A-Za-z0-9_-]+$/.test(trimmed)) {
                    definedIds.add(trimmed);
                }
            }

            const children = getChildNodes(node);
            for (let i = children.length - 1; i >= 0; i--) {
                stack.push({ node: children[i], depth: depth + 1 });
            }
        }
        return definedIds;
    }

    function getSanitizedSvgAttributes(node, isRoot = false, definedIds = null) {
        const result = {};
        if (!node || node.nodeType !== 1) return result;

        let rawAttrs = {};
        if (node.attributes && typeof node.attributes === 'object') {
            if (Array.isArray(node.attributes)) {
                for (const attr of node.attributes) {
                    if (attr && attr.name) rawAttrs[attr.name] = attr.value;
                }
            } else if (typeof node.attributes.length === 'number') {
                for (let i = 0; i < node.attributes.length; i++) {
                    const attr = node.attributes[i];
                    if (attr && attr.name) rawAttrs[attr.name] = attr.value;
                }
            } else {
                rawAttrs = { ...node.attributes };
            }
        }

        let attrCount = 0;
        for (const [attrName, rawVal] of Object.entries(rawAttrs)) {
            if (typeof attrName !== 'string') continue;
            if (attrCount >= MAX_SVG_ATTRS_PER_NODE) break;

            const lowerName = attrName.toLowerCase();

            // Strip event handlers
            if (lowerName.startsWith('on')) continue;

            // Strip active/external links and source references
            if (
                lowerName === 'href' ||
                lowerName === 'xlink:href' ||
                lowerName === 'xmlns:xlink' ||
                lowerName === 'src' ||
                lowerName === 'action' ||
                lowerName === 'formaction' ||
                lowerName === 'data' ||
                lowerName === 'ping' ||
                lowerName === 'poster'
            ) {
                continue;
            }

            if (!ALLOWED_SVG_ATTRS.has(lowerName)) continue;

            const valStr = String(rawVal);
            if (/[\u0000-\u001F\u007F-\u009F]/.test(valStr)) continue;
            if (/javascript:|vbscript:|data:text\/html|expression\(|-moz-binding|@import/i.test(valStr)) continue;

            if (lowerName === 'id') {
                const trimmedId = valStr.trim();
                if (/^[A-Za-z0-9_-]+$/.test(trimmedId)) {
                    result['id'] = trimmedId;
                    attrCount++;
                }
                continue;
            }

            if (lowerName === 'style') {
                const cleanStyle = sanitizeCssStyle(valStr, definedIds);
                if (cleanStyle) {
                    result['style'] = cleanStyle;
                    attrCount++;
                }
            } else {
                // Disallow external URLs in attributes (only allow safe local fragment references like url(#id))
                if (/url\(/i.test(valStr)) {
                    const urlMatch = valStr.match(/^url\s*\(\s*#([A-Za-z0-9_-]+)\s*\)$/i);
                    if (!urlMatch) {
                        continue;
                    }
                    if (definedIds && !definedIds.has(urlMatch[1])) {
                        continue;
                    }
                }
                result[attrName] = valStr;
                attrCount++;
            }
        }

        if (isRoot) {
            result['xmlns'] = 'http://www.w3.org/2000/svg';
        }

        return result;
    }

    function serializeSvgTree(node, budget, definedIds, isRoot = false, depth = 0) {
        if (!node) return '';

        budget.nodeCount++;
        if (budget.nodeCount > budget.maxNodes || depth > budget.maxDepth) {
            return null;
        }

        if (node.nodeType === 3) {
            const text = node.nodeValue || node.textContent || '';
            if (text.length > MAX_SVG_TEXT_PER_NODE) return null;
            const escaped = escapeXml(text);
            budget.bytes += escaped.length;
            if (budget.bytes > budget.maxBytes) return null;
            return escaped;
        }

        if (node.nodeType !== 1) return '';

        const tag = getTagName(node).toLowerCase();
        if (FORBIDDEN_SVG_TAGS.has(tag)) return '';
        if (!ALLOWED_SVG_TAGS.has(tag)) {
            // Unrecognized tag. Skip the container tag but serialize safe children
            const children = getChildNodes(node);
            let innerStr = '';
            for (const child of children) {
                const childResult = serializeSvgTree(child, budget, definedIds, false, depth + 1);
                if (childResult === null) return null;
                innerStr += childResult;
            }
            return innerStr;
        }

        if (isRoot && tag !== 'svg') return null;

        const attrs = getSanitizedSvgAttributes(node, isRoot, definedIds);
        let attrStr = '';
        for (const [k, v] of Object.entries(attrs)) {
            attrStr += ` ${k}="${escapeXmlAttr(v)}"`;
        }

        const children = getChildNodes(node);
        let innerStr = '';

        for (const child of children) {
            const childResult = serializeSvgTree(child, budget, definedIds, false, depth + 1);
            if (childResult === null) return null;
            innerStr += childResult;
        }

        let output = '';
        if (children.length === 0 && (tag === 'path' || tag === 'rect' || tag === 'circle' || tag === 'line' || tag === 'polyline' || tag === 'polygon' || tag === 'ellipse' || tag === 'stop')) {
            output = `<${tag}${attrStr}/>`;
        } else {
            output = `<${tag}${attrStr}>${innerStr}</${tag}>`;
        }

        budget.bytes += output.length;
        if (budget.bytes > budget.maxBytes) return null;
        return output;
    }

    function sanitizeSvg(svgInput) {
        if (!svgInput) return null;

        let rootSvgNode = null;

        if (typeof svgInput === 'string') {
            const str = svgInput.trim();
            if (!str || str.length > MAX_SVG_BYTES) return null;

            // Reject DOCTYPE or entity declarations (prevents DTD / XML entity expansion attacks)
            if (/<!DOCTYPE/i.test(str) || /<!ENTITY/i.test(str) || /<\?xml-stylesheet/i.test(str)) {
                return null;
            }

            if (typeof DOMParser !== 'undefined') {
                try {
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(str, 'image/svg+xml');
                    const parserError = doc.querySelector('parsererror');
                    if (parserError) return null;
                    rootSvgNode = doc.documentElement;
                } catch {
                    // Fall back to simple parser if DOMParser fails or is mock
                    rootSvgNode = null;
                }
            }
            if (!rootSvgNode && root && typeof root.parseHTML === 'function') {
                try {
                    const doc = root.parseHTML(str);
                    rootSvgNode = doc.querySelector('svg');
                } catch {
                    return null;
                }
            } else if (!rootSvgNode && typeof parseHTML === 'function') {
                try {
                    const doc = parseHTML(str);
                    rootSvgNode = doc.querySelector('svg');
                } catch {
                    return null;
                }
            }
        } else if (typeof svgInput === 'object' && svgInput.nodeType === 1) {
            rootSvgNode = svgInput;
        }

        if (!rootSvgNode || getTagName(rootSvgNode) !== 'SVG') {
            return null;
        }

        const definedIds = collectDefinedSvgIds(rootSvgNode);
        const budget = {
            bytes: 0,
            maxBytes: MAX_SVG_BYTES,
            nodeCount: 0,
            maxNodes: MAX_SVG_NODES,
            maxDepth: MAX_SVG_DEPTH
        };
        const serialized = serializeSvgTree(rootSvgNode, budget, definedIds, true, 0);

        if (!serialized || budget.bytes > MAX_SVG_BYTES) return null;

        // Ensure serialized SVG is a single <svg> element with valid content
        if (!serialized.startsWith('<svg') || !serialized.endsWith('</svg>')) {
            return null;
        }

        return serialized;
    }

    function extractCodeLanguage(codeEl, preEl) {
        let raw = '';
        if (codeEl && codeEl.nodeType === 1) {
            const dataLang = getAttribute(codeEl, 'data-language') ||
                getAttribute(codeEl, 'data-lang') ||
                getAttribute(codeEl, 'data-code-language');
            if (dataLang && typeof dataLang === 'string') {
                raw = dataLang.trim();
            }
            if (!raw) {
                const cls = getAttribute(codeEl, 'class') || '';
                const match = cls.match(/(?:^|\s)(?:language|lang)-([a-zA-Z0-9_+-]+)(?:\s|$)/i);
                if (match) {
                    raw = match[1];
                }
            }
        }
        if (!raw && preEl && preEl.nodeType === 1) {
            const dataLang = getAttribute(preEl, 'data-language') ||
                getAttribute(preEl, 'data-lang') ||
                getAttribute(preEl, 'data-code-language');
            if (dataLang && typeof dataLang === 'string') {
                raw = dataLang.trim();
            }
            if (!raw) {
                const cls = getAttribute(preEl, 'class') || '';
                const match = cls.match(/(?:^|\s)(?:language|lang)-([a-zA-Z0-9_+-]+)(?:\s|$)/i);
                if (match) {
                    raw = match[1];
                }
            }
        }
        if (!raw) return '';
        const cleaned = raw.toLowerCase().trim();
        if (!/^[a-zA-Z0-9_+-]+$/.test(cleaned)) return '';
        return cleaned;
    }

    function isMermaidCodeElement(el) {
        if (!el || el.nodeType !== 1) return false;
        const tag = getTagName(el);
        if (tag === 'CODE') {
            const parent = el.parentElement || el.parentNode;
            const lang = extractCodeLanguage(el, parent && getTagName(parent) === 'PRE' ? parent : null);
            return lang === 'mermaid' || lang === 'mermaid-diagram';
        }
        if (tag === 'PRE') {
            const codeChildren = findDescendants(el, (c) => getTagName(c) === 'CODE');
            const lang = extractCodeLanguage(codeChildren.length > 0 ? codeChildren[0] : null, el);
            return lang === 'mermaid' || lang === 'mermaid-diagram';
        }
        return false;
    }

    function isRenderedMermaidSvg(node) {
        if (!node || node.nodeType !== 1) return false;
        if (getTagName(node) !== 'SVG') return false;
        const id = getAttribute(node, 'id') || '';
        if (/^claude-mermaid(?:-[a-zA-Z0-9_-]+)?$/i.test(id)) return true;
        const cls = getAttribute(node, 'class') || '';
        if (/(?:^|\s)claude-mermaid(?:-[a-zA-Z0-9_-]+)?(?:\s|$)/i.test(cls)) return true;
        return false;
    }

    function isRenderedMermaidViewer(node) {
        if (!node || node.nodeType !== 1) return false;
        if (isRenderedMermaidSvg(node)) return true;

        const cls = getAttribute(node, 'class') || '';
        if (cls.includes('mermaid-viewer') || cls.includes('mermaid-container') || cls.includes('mermaid-wrapper')) {
            const svgs = findDescendants(node, isRenderedMermaidSvg);
            if (svgs.length > 0) return true;
        }

        return false;
    }

    function getPreviousElementSibling(el) {
        if (!el) return null;
        if (el.previousElementSibling !== undefined) return el.previousElementSibling;
        const parent = el.parentNode || el.parentElement;
        if (!parent || !parent.childNodes) return null;
        const idx = parent.childNodes.indexOf(el);
        for (let i = idx - 1; i >= 0; i--) {
            if (parent.childNodes[i].nodeType === 1) return parent.childNodes[i];
        }
        return null;
    }

    function getNextElementSibling(el) {
        if (!el) return null;
        if (el.nextElementSibling !== undefined) return el.nextElementSibling;
        const parent = el.parentNode || el.parentElement;
        if (!parent || !parent.childNodes) return null;
        const idx = parent.childNodes.indexOf(el);
        for (let i = idx + 1; i < parent.childNodes.length; i++) {
            if (parent.childNodes[i].nodeType === 1) return parent.childNodes[i];
        }
        return null;
    }

    function extractMermaidSvgElement(node) {
        if (!node || node.nodeType !== 1) return null;
        if (isRenderedMermaidSvg(node)) return node;
        const svgs = findDescendants(node, isRenderedMermaidSvg);
        return svgs.length > 0 ? svgs[0] : null;
    }

    function hasLocalMermaidSource(node, rootNode) {
        if (!node || node.nodeType !== 1) return false;

        // Check inside node itself
        const inside = findDescendants(node, isMermaidCodeElement);
        if (inside.length > 0) return true;

        // Check enclosing diagram wrapper / card (e.g. .mermaid-viewer, .diagram-container)
        // But do not check the entire root document / body
        let parent = node.parentNode || node.parentElement;
        while (parent && parent !== rootNode) {
            const parentTag = getTagName(parent);
            if (parentTag === 'BODY' || parentTag === 'HTML') break;
            const cls = getAttribute(parent, 'class') || '';
            if (cls.includes('mermaid') || cls.includes('diagram') || cls.includes('chart')) {
                const inWrapper = findDescendants(parent, isMermaidCodeElement);
                if (inWrapper.length > 0) return true;
            }
            // Check immediate sibling code blocks
            const prev = getPreviousElementSibling(parent);
            if (prev && isMermaidCodeElement(prev)) return true;
            const next = getNextElementSibling(parent);
            if (next && isMermaidCodeElement(next)) return true;
            break;
        }

        // Check immediate sibling code block of node
        const prevNode = getPreviousElementSibling(node);
        if (prevNode && (isMermaidCodeElement(prevNode) || findDescendants(prevNode, isMermaidCodeElement).length > 0)) return true;
        const nextNode = getNextElementSibling(node);
        if (nextNode && (isMermaidCodeElement(nextNode) || findDescendants(nextNode, isMermaidCodeElement).length > 0)) return true;

        return false;
    }

    function shouldExcludeElement(el) {
        if (!el || el.nodeType !== 1) return false;
        const tag = getTagName(el);

        if (BLACKLISTED_TAGS.has(tag)) return true;
        if (tag === 'SVG') {
            // Rendered Mermaid SVGs are handled by isRenderedMermaidViewer; exclude general/unrelated SVGs
            return !isRenderedMermaidViewer(el);
        }

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
        const codeEl = codeChildren.length > 0 ? codeChildren[0] : null;
        const lang = extractCodeLanguage(codeEl, preEl);
        const rawCode = codeEl ? (codeEl.textContent || '') : (preEl.textContent || '');

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

        if (isRenderedMermaidViewer(node)) {
            // Per-diagram source priority: only suppress SVG fallback if THIS diagram has explicit local source
            const hasLocalSource = hasLocalMermaidSource(node, state.rootNode);
            if (!hasLocalSource) {
                const svgEl = extractMermaidSvgElement(node);
                const sanitizedSvg = svgEl ? sanitizeSvg(svgEl) : null;
                if (sanitizedSvg) {
                    state.diagramCount++;
                    const paddedIndex = String(state.diagramCount).padStart(2, '0');
                    const companionFilename = `${state.baseName}-diagram-${paddedIndex}.svg`;
                    const asset = {
                        filename: companionFilename,
                        content: sanitizedSvg,
                        mimeType: 'image/svg+xml'
                    };
                    state.assets.push(asset);
                    state.metadata.hasSvgOnlyMermaid = true;
                    state.metadata.hasSvgFallback = true;
                    state.metadata.mermaidCount++;
                    state.metadata.imagesCount++;
                    return `![Diagram](${companionFilename})\n\n`;
                } else {
                    state.metadata.hasSvgOnlyMermaid = true;
                    state.metadata.mermaidCount++;
                    addWarning(state, 'Mermaid diagram SVG was malformed or unsafe and was not converted.');
                    return '> [!WARNING]\n> Mermaid source is unavailable; rendered SVG was not converted.\n\n';
                }
            }
            return '';
        }

        if (shouldExcludeElement(node)) return '';

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
            case 'BODY':
            case 'HTML':
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
                assets: [],
                warnings: ['Root element is missing.'],
                metadata: {}
            };
        }

        const maxChars = typeof options.maxChars === 'number' ? options.maxChars : MAX_MARKDOWN_CHARS;
        const maxDepth = typeof options.maxDepth === 'number' ? options.maxDepth : MAX_DOM_DEPTH;
        const maxNodes = typeof options.maxNodes === 'number' ? options.maxNodes : MAX_DOM_NODES;

        // Pre-scan for explicit Mermaid source code blocks in document
        const explicitMermaidSources = findDescendants(rootNode, isMermaidCodeElement);

        let docTitle = '';
        if (typeof options.title === 'string' && options.title.trim()) {
            docTitle = options.title.trim();
        } else if (options.document && typeof options.document.title === 'string' && options.document.title.trim()) {
            docTitle = options.document.title.trim();
        } else if (typeof document !== 'undefined' && typeof document.title === 'string' && document.title.trim()) {
            docTitle = document.title.trim();
        }

        let initialTitle = '';
        if (docTitle && docTitle !== 'Claude' && docTitle !== 'Artifact Viewer') {
            initialTitle = docTitle;
        }

        const baseName = sanitizeBaseName(options.baseName || initialTitle || 'artifact');

        const state = {
            warnings: [],
            visitedNodes: 0,
            maxNodes,
            maxDepth,
            maxChars,
            baseName,
            diagramCount: 0,
            rootNode,
            assets: [],
            budgetExceeded: false,
            outputBudgetExceeded: false,
            metadata: {
                title: initialTitle,
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
                hasSvgFallback: false,
                characterCount: 0
            }
        };

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
            assets: state.assets,
            warnings: state.warnings,
            metadata: state.metadata
        };
    }

    root.AygaArtifactConverter = Object.freeze({
        convertDomToMarkdown,
        sanitizeSvg,
        sanitizeBaseName,
        sanitizeUrl,
        isSafeUrl,
        createSafeFence,
        escapeInlineCode,
        extractCodeLanguage,
        isRenderedMermaidViewer,
        shouldExcludeElement,
        MAX_MARKDOWN_CHARS,
        MAX_DOM_DEPTH,
        MAX_DOM_NODES,
        MAX_SVG_BYTES
    });
})(typeof globalThis !== 'undefined' ? globalThis : this);
