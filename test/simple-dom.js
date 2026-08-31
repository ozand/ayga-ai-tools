/**
 * Minimal zero-dependency HTML DOM parser for unit testing in pure Node.js environments.
 */

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const COMMENT_NODE = 8;
const DOCUMENT_NODE = 9;

class SimpleNode {
    constructor(nodeType, nodeName) {
        this.nodeType = nodeType;
        this.nodeName = nodeName.toUpperCase();
        this.childNodes = [];
        this.parentNode = null;
    }

    appendChild(child) {
        if (child.parentNode) {
            const idx = child.parentNode.childNodes.indexOf(child);
            if (idx !== -1) child.parentNode.childNodes.splice(idx, 1);
        }
        child.parentNode = this;
        this.childNodes.push(child);
        return child;
    }

    get firstChild() {
        return this.childNodes[0] || null;
    }

    get lastChild() {
        return this.childNodes[this.childNodes.length - 1] || null;
    }

    get previousSibling() {
        if (!this.parentNode) return null;
        const idx = this.parentNode.childNodes.indexOf(this);
        return idx > 0 ? this.parentNode.childNodes[idx - 1] : null;
    }

    get nextSibling() {
        if (!this.parentNode) return null;
        const idx = this.parentNode.childNodes.indexOf(this);
        return idx >= 0 && idx < this.parentNode.childNodes.length - 1 ? this.parentNode.childNodes[idx + 1] : null;
    }

    get textContent() {
        if (this.nodeType === TEXT_NODE) return this.nodeValue;
        if (this.nodeType === COMMENT_NODE) return '';
        let text = '';
        for (const child of this.childNodes) {
            text += child.textContent;
        }
        return text;
    }

    set textContent(val) {
        this.childNodes = [];
        if (val) {
            this.appendChild(new SimpleTextNode(String(val)));
        }
    }
}

class SimpleTextNode extends SimpleNode {
    constructor(text) {
        super(TEXT_NODE, '#text');
        this.nodeValue = text;
    }
}

class SimpleCommentNode extends SimpleNode {
    constructor(data) {
        super(COMMENT_NODE, '#comment');
        this.data = data;
    }
}

class SimpleElement extends SimpleNode {
    constructor(tagName, attributes = {}) {
        super(ELEMENT_NODE, tagName);
        this.tagName = tagName.toUpperCase();
        this.attributes = { ...attributes };
        this.style = {};
        if (this.attributes.style) {
            this.parseStyle(this.attributes.style);
        }
        this.classList = new Set(
            (this.attributes.class || '').split(/\s+/).filter(Boolean)
        );
    }

    parseStyle(styleStr) {
        const parts = styleStr.split(';');
        for (const p of parts) {
            const colon = p.indexOf(':');
            if (colon !== -1) {
                const k = p.slice(0, colon).trim().toLowerCase().replace(/-([a-z])/g, (_, g) => g.toUpperCase());
                const v = p.slice(colon + 1).trim();
                this.style[k] = v;
            }
        }
    }

    getAttribute(name) {
        const val = this.attributes[name.toLowerCase()];
        return val !== undefined ? val : null;
    }

    hasAttribute(name) {
        return this.attributes[name.toLowerCase()] !== undefined;
    }

    setAttribute(name, value) {
        this.attributes[name.toLowerCase()] = String(value);
        if (name.toLowerCase() === 'class') {
            this.classList = new Set(String(value).split(/\s+/).filter(Boolean));
        }
        if (name.toLowerCase() === 'style') {
            this.parseStyle(String(value));
        }
    }

    removeAttribute(name) {
        delete this.attributes[name.toLowerCase()];
        if (name.toLowerCase() === 'class') {
            this.classList = new Set();
        }
    }

    get className() {
        return this.attributes.class || '';
    }

    set className(val) {
        this.setAttribute('class', val);
    }

    get children() {
        return this.childNodes.filter(c => c.nodeType === ELEMENT_NODE);
    }

    matches(selector) {
        const sel = selector.trim();
        // Attribute selector [data-foo] or [data-foo="bar"] or [role="button"]
        const attrMatch = sel.match(/^\[([a-zA-Z0-9_-]+)(?:=["']([^"']*)["'])?\]$/);
        if (attrMatch) {
            const attrName = attrMatch[1];
            const attrVal = attrMatch[2];
            if (attrVal !== undefined) {
                return this.getAttribute(attrName) === attrVal;
            }
            return this.hasAttribute(attrName);
        }
        // Tag with attribute selector tag[attr] or tag[attr="val"]
        const tagAttrMatch = sel.match(/^([a-zA-Z0-9-]+)\[([a-zA-Z0-9_-]+)(?:=["']([^"']*)["'])?\]$/);
        if (tagAttrMatch) {
            if (this.tagName.toLowerCase() !== tagAttrMatch[1].toLowerCase()) return false;
            const attrName = tagAttrMatch[2];
            const attrVal = tagAttrMatch[3];
            if (attrVal !== undefined) {
                return this.getAttribute(attrName) === attrVal;
            }
            return this.hasAttribute(attrName);
        }
        // Tag selector
        if (/^[a-zA-Z0-9-]+$/.test(sel)) {
            return this.tagName.toLowerCase() === sel.toLowerCase();
        }
        // Class selector .foo
        if (/^\.[a-zA-Z0-9_-]+$/.test(sel)) {
            return this.classList.has(sel.slice(1));
        }
        // ID selector #foo
        if (/^#[a-zA-Z0-9_-]+$/.test(sel)) {
            return this.getAttribute('id') === sel.slice(1);
        }
        // Compound tag.class
        const tagClassMatch = sel.match(/^([a-zA-Z0-9-]+)\.([a-zA-Z0-9_-]+)$/);
        if (tagClassMatch) {
            return this.tagName.toLowerCase() === tagClassMatch[1].toLowerCase() && this.classList.has(tagClassMatch[2]);
        }
        // Compound tag#id
        const tagIdMatch = sel.match(/^([a-zA-Z0-9-]+)#([a-zA-Z0-9_-]+)$/);
        if (tagIdMatch) {
            return this.tagName.toLowerCase() === tagIdMatch[1].toLowerCase() && this.getAttribute('id') === tagIdMatch[2];
        }
        return false;
    }

    querySelector(selector) {
        const selectors = selector.split(',').map(s => s.trim());
        for (const child of this.childNodes) {
            if (child.nodeType === ELEMENT_NODE) {
                for (const s of selectors) {
                    if (s.includes(' > ')) {
                        const parts = s.split(' > ').map(p => p.trim());
                        if (child.matches(parts[0])) {
                            const sub = child.querySelector(parts.slice(1).join(' > '));
                            if (sub && sub.parentNode === child) return sub;
                        }
                    } else if (child.matches(s)) {
                        return child;
                    }
                }
                const found = child.querySelector(selector);
                if (found) return found;
            }
        }
        return null;
    }

    querySelectorAll(selector) {
        const results = [];
        const selectors = selector.split(',').map(s => s.trim());

        const walk = (node) => {
            for (const child of node.childNodes) {
                if (child.nodeType === ELEMENT_NODE) {
                    let matched = false;
                    for (const s of selectors) {
                        if (s.includes(' > ')) {
                            const parts = s.split(' > ').map(p => p.trim());
                            if (parts.length === 2 && child.matches(parts[1]) && child.parentNode && child.parentNode.matches(parts[0])) {
                                matched = true;
                                break;
                            }
                        } else if (child.matches(s)) {
                            matched = true;
                            break;
                        }
                    }
                    if (matched) results.push(child);
                    walk(child);
                }
            }
        };

        walk(this);
        return results;
    }
}

class SimpleDocument extends SimpleNode {
    constructor() {
        super(DOCUMENT_NODE, '#document');
        this.body = null;
        this.head = null;
        this.title = '';
    }

    querySelector(selector) {
        return SimpleElement.prototype.querySelector.call(this, selector);
    }

    querySelectorAll(selector) {
        return SimpleElement.prototype.querySelectorAll.call(this, selector);
    }

    createElement(tagName) {
        return new SimpleElement(tagName);
    }

    createTextNode(text) {
        return new SimpleTextNode(text);
    }
}

const VOID_ELEMENTS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

const RAW_TEXT_ELEMENTS = new Set([
    'script', 'style', 'noscript', 'template'
]);

function decodeHtmlEntities(str) {
    if (!str) return '';
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, '\u00A0');
}

export function parseHTML(htmlString) {
    const doc = new SimpleDocument();
    let current = doc;
    let pos = 0;
    const len = htmlString.length;

    while (pos < len) {
        if (htmlString.startsWith('<!--', pos)) {
            const endComment = htmlString.indexOf('-->', pos + 4);
            const commentContent = endComment !== -1 ? htmlString.slice(pos + 4, endComment) : htmlString.slice(pos + 4);
            current.appendChild(new SimpleCommentNode(commentContent));
            pos = endComment !== -1 ? endComment + 3 : len;
            continue;
        }

        if (htmlString.startsWith('<!DOCTYPE', pos) || htmlString.startsWith('<!doctype', pos)) {
            const endDocType = htmlString.indexOf('>', pos);
            pos = endDocType !== -1 ? endDocType + 1 : len;
            continue;
        }

        if (htmlString[pos] === '<') {
            // Check closing tag
            if (htmlString[pos + 1] === '/') {
                const endTag = htmlString.indexOf('>', pos);
                const tagName = (endTag !== -1 ? htmlString.slice(pos + 2, endTag) : htmlString.slice(pos + 2)).trim().toLowerCase();
                // Pop back to matching parent
                let p = current;
                while (p && p !== doc) {
                    if (p.tagName && p.tagName.toLowerCase() === tagName) {
                        current = p.parentNode || doc;
                        break;
                    }
                    p = p.parentNode;
                }
                pos = endTag !== -1 ? endTag + 1 : len;
                continue;
            }

            // Opening tag
            const tagMatch = htmlString.slice(pos).match(/^<([a-zA-Z0-9-]+)(\s[^>]*)?(\/?)>/);
            if (tagMatch) {
                const tagName = tagMatch[1].toLowerCase();
                const rawAttrs = tagMatch[2] || '';
                const isSelfClosing = tagMatch[3] === '/' || VOID_ELEMENTS.has(tagName);
                pos += tagMatch[0].length;

                const elem = new SimpleElement(tagName);
                const attrRegex = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
                let attrM;
                while ((attrM = attrRegex.exec(rawAttrs)) !== null) {
                    const attrName = attrM[1];
                    const attrValue = attrM[2] !== undefined ? attrM[2] : (attrM[3] !== undefined ? attrM[3] : (attrM[4] !== undefined ? attrM[4] : ''));
                    elem.setAttribute(attrName, decodeHtmlEntities(attrValue));
                }

                current.appendChild(elem);
                if (tagName === 'body' && !doc.body) doc.body = elem;
                if (tagName === 'head' && !doc.head) doc.head = elem;

                if (tagName === 'title') {
                    const closeTitle = htmlString.indexOf('</title>', pos);
                    if (closeTitle !== -1) {
                        doc.title = decodeHtmlEntities(htmlString.slice(pos, closeTitle).trim());
                        elem.textContent = doc.title;
                        pos = closeTitle + 8;
                        continue;
                    }
                }

                if (RAW_TEXT_ELEMENTS.has(tagName)) {
                    const closeTag = `</${tagName}>`;
                    const closeIdx = htmlString.toLowerCase().indexOf(closeTag, pos);
                    const rawContent = closeIdx !== -1 ? htmlString.slice(pos, closeIdx) : htmlString.slice(pos);
                    elem.textContent = rawContent;
                    pos = closeIdx !== -1 ? closeIdx + closeTag.length : len;
                    continue;
                }

                if (!isSelfClosing) {
                    current = elem;
                }
                continue;
            }
        }

        // Text content
        const nextTag = htmlString.indexOf('<', pos);
        const textChunk = nextTag !== -1 ? htmlString.slice(pos, nextTag) : htmlString.slice(pos);
        if (textChunk) {
            const decoded = decodeHtmlEntities(textChunk);
            current.appendChild(new SimpleTextNode(decoded));
        }
        pos = nextTag !== -1 ? nextTag : len;
    }

    if (!doc.body) {
        doc.body = doc.querySelector('body') || doc;
    }
    return doc;
}
