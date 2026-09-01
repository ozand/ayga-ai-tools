import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { parseHTML } from './simple-dom.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, 'fixtures');
const rootDir = path.join(__dirname, '..');

function loadConverter() {
    const code = fs.readFileSync(path.join(rootDir, 'utils', 'artifact-converter.js'), 'utf8');
    const context = {
        globalThis: {},
        URL: globalThis.URL,
        URLSearchParams: globalThis.URLSearchParams,
        Set: globalThis.Set,
        Map: globalThis.Map,
        RegExp: globalThis.RegExp,
        String: globalThis.String,
        Number: globalThis.Number,
        Boolean: globalThis.Boolean,
        Object: globalThis.Object,
        Array: globalThis.Array,
        console: globalThis.console
    };
    vm.runInNewContext(code, context);
    return context.globalThis.AygaArtifactConverter;
}

const converter = loadConverter();
const {
    convertDomToMarkdown,
    createSafeFence,
    escapeInlineCode,
    sanitizeUrl,
    isSafeUrl,
    shouldExcludeElement,
    MAX_MARKDOWN_CHARS,
    MAX_DOM_DEPTH,
    MAX_DOM_NODES
} = converter;

function loadFixture(filename) {
    return fs.readFileSync(path.join(fixturesDir, filename), 'utf8');
}

test('Dynamic fence calculation handles varying backtick runs', () => {
    assert.equal(createSafeFence('simple code'), '```');
    assert.equal(createSafeFence('code with ``` fence'), '````');
    assert.equal(createSafeFence('code with ```` fence'), '`````');
    assert.equal(createSafeFence('code with ``` and ````'), '`````');
});

test('Inline code escaping handles arbitrary backtick runs', () => {
    assert.equal(escapeInlineCode('simple'), '`simple`');
    assert.equal(escapeInlineCode('foo `bar` baz'), '``foo `bar` baz``');
    assert.equal(escapeInlineCode('foo ``bar`` baz'), '```foo ``bar`` baz```');
    assert.equal(escapeInlineCode('`leading'), '`` `leading ``');
    assert.equal(escapeInlineCode('trailing`'), '`` trailing` ``');
    assert.equal(escapeInlineCode('`both`'), '`` `both` ``');
});

test('URL sanitizer accepts safe protocols and rejects sensitive params / unsafe schemes', () => {
    assert.equal(sanitizeUrl('https://example.com/page'), 'https://example.com/page');
    assert.equal(sanitizeUrl('http://example.com/page'), 'http://example.com/page');
    assert.equal(sanitizeUrl('mailto:user@example.com'), 'mailto:user@example.com');
    assert.equal(sanitizeUrl('/relative/path'), '/relative/path');
    assert.equal(sanitizeUrl('#section-1'), '#section-1');

    // Sensitive query parameters stripped
    assert.equal(sanitizeUrl('https://example.com/page?token=secret123&keep=1'), 'https://example.com/page?keep=1');
    assert.equal(sanitizeUrl('/relative/path?auth_token=abc&page=2'), '/relative/path?page=2');
    assert.equal(sanitizeUrl('/relative/path#token=sensitive'), '/relative/path');
    assert.equal(sanitizeUrl('/relative/path?apiKey=key1&token=tok2'), '/relative/path');

    // Unsafe schemes
    assert.equal(sanitizeUrl('javascript:alert(1)'), null);
    assert.equal(sanitizeUrl('data:text/html,test'), null);
    assert.equal(sanitizeUrl('blob:https://claude.ai/uuid'), null);
    assert.equal(sanitizeUrl('vbscript:msgbox(1)'), null);
});

test('Element exclusion correctly flags untrusted, hidden, and service UI elements', () => {
    const dom = parseHTML(`
        <script>alert(1)</script>
        <style>body{}</style>
        <noscript>no js</noscript>
        <template><p>temp</p></template>
        <div aria-hidden="true">hidden</div>
        <div hidden>hidden2</div>
        <div inert>hidden3</div>
        <div role="navigation">nav</div>
        <div role="banner">hdr</div>
        <div style="display:none">hidden4</div>
        <div style="visibility: hidden">hidden5</div>
        <button class="copy-button">Copy</button>
        <p>Safe content</p>
    `);

    const elements = dom.querySelectorAll('script, style, noscript, template, div, button, p');
    const safeP = dom.querySelector('p');

    assert.equal(shouldExcludeElement(safeP), false);
    for (const el of elements) {
        if (el !== safeP && el.tagName.toLowerCase() !== 'body') {
            assert.equal(shouldExcludeElement(el), true, `Element <${el.tagName.toLowerCase()} class="${el.className}"> should be excluded`);
        }
    }
});

test('Converts comprehensive semantic document accurately', () => {
    const html = loadFixture('artifact-frame-comprehensive-semantic.html');
    const dom = parseHTML(html);
    const root = dom.querySelector('.artifact-content');

    const result = convertDomToMarkdown(root, { document: dom });
    assert.equal(result.metadata.title, 'Comprehensive Semantic Document');
    assert.ok(result.markdown.includes('# Document Title'));
    assert.ok(result.markdown.includes('**bold text**'));
    assert.ok(result.markdown.includes('*italic text*'));
    assert.ok(result.markdown.includes('`inline code`'));

    // Lists
    assert.ok(result.markdown.includes('- First bullet item'));
    assert.ok(result.markdown.includes('- Second bullet item with **emphasis**'));
    assert.ok(result.markdown.includes('  - Sub-bullet item A'));
    assert.ok(result.markdown.includes('  - Sub-bullet item B'));
    assert.ok(result.markdown.includes('1. First step'));
    assert.ok(result.markdown.includes('2. Second step'));

    // Blockquote
    assert.ok(result.markdown.includes('> Knowledge is power, but enthusiasm pulls the switch.'));

    // Links & Images
    assert.ok(result.markdown.includes('[Example Docs](https://example.com/docs "Official Docs")'));
    assert.ok(result.markdown.includes('[Support](mailto:test@example.com)'));
    assert.ok(result.markdown.includes('![Logo image](https://example.com/logo.png "Company Logo")'));

    // Table
    assert.ok(result.markdown.includes('| Feature | Status | Count |'));
    assert.ok(result.markdown.includes('| :--- | :---: | ---: |'));
    assert.ok(result.markdown.includes('| Markdown Parser | Active | 42 |'));
    assert.ok(result.markdown.includes('| DOM Bridge | Stable | 100 |'));

    // Code blocks
    assert.ok(result.markdown.includes('```python\ndef hello_world():\n    print("Hello from Python")\n```'));
    assert.ok(result.markdown.includes('```javascript\nfunction add(a, b) {\n    return a + b;\n}\n```'));
    // Nested fence in markdown
    assert.ok(result.markdown.includes('````markdown\n# Nested Markdown Demo\n```js\nconsole.log("nested code fence");\n```\n````'));

    assert.equal(result.metadata.tablesCount, 1);
    assert.equal(result.metadata.codeBlocksCount, 3);
    assert.equal(result.metadata.hasSvgOnlyMermaid, false);
});

test('Converts explicit Mermaid source node to mermaid code fence', () => {
    const html = loadFixture('artifact-frame-with-mermaid-source.html');
    const dom = parseHTML(html);
    const root = dom.querySelector('.artifact-content');

    const result = convertDomToMarkdown(root, { document: dom });
    assert.ok(result.markdown.includes('```mermaid\ngraph TD\n    A[Client] --> B[API Gateway]\n    B --> C[Microservice A]\n    B --> D[Microservice B]\n```'));
    assert.ok(result.markdown.includes('````js\nconsole.log("Hello ```world```");\n````'));
    assert.equal(result.metadata.mermaidCount, 1);
    assert.equal(result.metadata.hasMermaidSource, true);
    assert.equal(result.metadata.hasSvgOnlyMermaid, false);
});

test('Mermaid SVG-only detection is independent of DOM order and produces companion SVG artifact', () => {
    // 1. Rendered SVG alone
    const htmlSvgOnly = loadFixture('artifact-frame-rendered-mermaid-svg-only.html');
    const domSvgOnly = parseHTML(htmlSvgOnly);
    const resSvgOnly = convertDomToMarkdown(domSvgOnly.querySelector('.artifact-content'), { document: domSvgOnly });
    assert.equal(resSvgOnly.metadata.hasSvgOnlyMermaid, true);
    assert.equal(resSvgOnly.metadata.hasMermaidSource, false);
    assert.equal(resSvgOnly.svgArtifacts.length, 1);
    assert.equal(resSvgOnly.svgArtifacts[0].filename, 'Artifact-Frame-with-Rendered-SVG-Only-diagram-01.svg');
    assert.ok(resSvgOnly.markdown.includes('![Diagram](Artifact-Frame-with-Rendered-SVG-Only-diagram-01.svg)'));
    assert.ok(!resSvgOnly.markdown.includes('<svg'));

    // 2. Rendered SVG positioned BEFORE explicit source in DOM
    const htmlSvgBeforeSource = `
      <div class="artifact-content">
        <div class="mermaid-viewer">
          <svg id="claude-mermaid-0"><g><text>Rendered</text></g></svg>
        </div>
        <pre><code class="language-mermaid">graph TD\nA --> B</code></pre>
      </div>
    `;
    const domSvgBefore = parseHTML(htmlSvgBeforeSource);
    const resSvgBefore = convertDomToMarkdown(domSvgBefore.querySelector('.artifact-content'), { document: domSvgBefore });
    assert.equal(resSvgBefore.metadata.hasSvgOnlyMermaid, false);
    assert.equal(resSvgBefore.metadata.hasMermaidSource, true);
    assert.equal(resSvgBefore.svgArtifacts.length, 0);
    assert.ok(resSvgBefore.markdown.includes('```mermaid\ngraph TD\nA --> B\n```'));
    assert.ok(!resSvgBefore.markdown.includes('![Diagram]('));
});

test('Strips untrusted, script, style, hidden, and service UI elements', () => {
    const html = loadFixture('artifact-frame-untrusted-elements.html');
    const dom = parseHTML(html);
    const root = dom.querySelector('.artifact-content');

    const result = convertDomToMarkdown(root, { document: dom });
    assert.ok(result.markdown.includes('### Content Header'));
    assert.ok(result.markdown.includes('Visible safe text paragraph.'));
    assert.ok(result.markdown.includes('> This is a blockquote.'));

    // Excluded content
    assert.ok(!result.markdown.includes('malicious script'));
    assert.ok(!result.markdown.includes('display: none'));
    assert.ok(!result.markdown.includes('JavaScript is required'));
    assert.ok(!result.markdown.includes('Hidden template content'));
    assert.ok(!result.markdown.includes('ℹ️'));
});

test('Sanitizes tokenized URLs and unsafe schemes in security fixture', () => {
    const html = loadFixture('artifact-frame-security-and-tokens.html');
    const dom = parseHTML(html);
    const root = dom.querySelector('.artifact-content');

    const result = convertDomToMarkdown(root, { document: dom });

    // Safe link preserved
    assert.ok(result.markdown.includes('[Safe Guide](https://example.com/guide)'));

    // Dangerous / tokenized links converted to plain text or stripped
    assert.ok(result.markdown.includes('Malicious JS link'));
    assert.ok(!result.markdown.includes('javascript:alert'));

    assert.ok(result.markdown.includes('Data payload link'));
    assert.ok(!result.markdown.includes('data:text/html'));

    assert.ok(result.markdown.includes('Blob URL link'));
    assert.ok(!result.markdown.includes('blob:https'));

    // Sensitive token param stripped from URL
    assert.ok(!result.markdown.includes('secret123'));

    // Safe image preserved
    assert.ok(result.markdown.includes('![Valid Pic](https://images.example.com/pic.jpg)'));

    // Unsafe images omitted or alt preserved safely
    assert.ok(!result.markdown.includes('javascript:alert(1)'));
    assert.ok(!result.markdown.includes('super_secret'));

    // Blacklisted tags omitted
    assert.ok(!result.markdown.includes('should not execute or leak'));
    assert.ok(!result.markdown.includes('Secret template markup'));
    assert.ok(!result.markdown.includes('evil.com'));
    assert.ok(!result.markdown.includes('Inline hidden text'));
    assert.ok(!result.markdown.includes('Visibility hidden text'));
    assert.ok(!result.markdown.includes('Aria hidden service text'));
    assert.ok(!result.markdown.includes('Copy code'));

    assert.ok(result.markdown.includes('Normal visible trailing paragraph.'));
});

test('Enforces traversal budget and maximum DOM depth during recursion', () => {
    // 1. Deeply nested DOM structure exceeding maxDepth
    let deepHtml = '<span>deep leaf</span>';
    for (let i = 0; i < 40; i++) {
        deepHtml = `<div>${deepHtml}</div>`;
    }
    const domDeep = parseHTML(`<div class="artifact-content">${deepHtml}</div>`);
    const resDeep = convertDomToMarkdown(domDeep.querySelector('.artifact-content'), { maxDepth: 10 });
    assert.ok(resDeep.warnings.some(w => w.includes('DOM depth limit reached')));
    assert.ok(!resDeep.markdown.includes('deep leaf'));

    // 2. Large DOM structure exceeding maxNodes
    let largeHtml = '';
    for (let i = 0; i < 100; i++) {
        largeHtml += `<p>Paragraph item ${i}</p>`;
    }
    const domLarge = parseHTML(`<div class="artifact-content">${largeHtml}</div>`);
    const resLarge = convertDomToMarkdown(domLarge.querySelector('.artifact-content'), { maxNodes: 20 });
    assert.ok(resLarge.warnings.some(w => w.includes('DOM traversal limit reached')));
    assert.ok(resLarge.markdown.includes('Paragraph item 0'));
    assert.ok(!resLarge.markdown.includes('Paragraph item 99'));

    // 3. Output character budget exceeded
    const resTrunc = convertDomToMarkdown(domLarge.querySelector('.artifact-content'), { maxChars: 50 });
    assert.ok(resTrunc.markdown.length <= 50);
    assert.ok(resTrunc.warnings.some(w => w.includes('limit reached')));
});

test('SVG sanitization handles malicious, malformed, and oversized SVGs', () => {
    // Malicious SVG with script, event handlers, foreignObject, style tag, external image
    const maliciousSvg = `
      <div class="artifact-content">
        <div class="mermaid-viewer">
          <svg id="claude-mermaid-1" width="100" height="100" onclick="alert(1)">
            <script>alert('xss')</script>
            <style>body { background: red; }</style>
            <foreignObject width="100" height="100"><iframe src="http://evil.com"></iframe></foreignObject>
            <image href="http://evil.com/leak.png" />
            <a xlink:href="javascript:alert(2)"><text>Click</text></a>
            <g class="nodes" onload="steal()">
              <rect x="0" y="0" width="50" height="50" style="behavior: url(xss.htc); fill: blue;"></rect>
              <text x="10" y="20">Safe Text</text>
            </g>
          </svg>
        </div>
      </div>
    `;
    const domMalicious = parseHTML(maliciousSvg);
    const resMalicious = convertDomToMarkdown(domMalicious.querySelector('.artifact-content'), { document: domMalicious });
    assert.equal(resMalicious.svgArtifacts.length, 1);
    const sanitized = resMalicious.svgArtifacts[0].content;
    assert.ok(!sanitized.includes('script'));
    assert.ok(!sanitized.includes('onclick'));
    assert.ok(!sanitized.includes('onload'));
    assert.ok(!sanitized.includes('foreignObject'));
    assert.ok(!sanitized.includes('evil.com'));
    assert.ok(!sanitized.includes('javascript:'));
    assert.ok(!sanitized.includes('<style'));
    assert.ok(!sanitized.includes('behavior:'));
    assert.ok(sanitized.includes('<svg'));
    assert.ok(sanitized.includes('<rect'));
    assert.ok(sanitized.includes('<text'));
    assert.ok(sanitized.includes('Safe Text'));
    assert.ok(sanitized.includes('fill: blue;'));

    // Malformed / Unbalanced SVG
    const malformedHtml = `
      <div class="artifact-content">
        <div class="mermaid-viewer">
          <svg id="claude-mermaid-2" width="100" height="100">
            <g><rect>
          </svg>
        </div>
      </div>
    `;
    const domMalformed = parseHTML(malformedHtml);
    const resMalformed = convertDomToMarkdown(domMalformed.querySelector('.artifact-content'), { document: domMalformed });
    // Should still produce well-formed sanitized XML or reject gracefully without crashing
    assert.ok(resMalformed.markdown);

    // Oversized SVG (exceeding 256KB)
    let largeInner = '';
    for (let i = 0; i < 6000; i++) {
        largeInner += `<rect x="${i}" y="${i}" width="10" height="10" />`;
    }
    const oversizedHtml = `
      <div class="artifact-content">
        <div class="mermaid-viewer">
          <svg id="claude-mermaid-3" width="100" height="100">
            ${largeInner}
          </svg>
        </div>
      </div>
    `;
    const domOversized = parseHTML(oversizedHtml);
    const resOversized = convertDomToMarkdown(domOversized.querySelector('.artifact-content'), { document: domOversized });
    assert.equal(resOversized.svgArtifacts.length, 0); // Exceeded 256KB limit
    assert.ok(!resOversized.markdown.includes('![Diagram]('));
});
