import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from './simple-dom.js';
import {
    convertDomToMarkdown,
    createSafeFence,
    extractCodeLanguage,
    sanitizeUrl,
    shouldExcludeElement,
    MAX_MARKDOWN_CHARS
} from '../utils/artifact-converter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesDir = path.join(__dirname, 'fixtures');

function loadFixture(filename) {
    return fs.readFileSync(path.join(fixturesDir, filename), 'utf8');
}

test('Dynamic fence calculation handles varying backtick runs', () => {
    assert.equal(createSafeFence('simple code'), '```');
    assert.equal(createSafeFence('code with ``` fence'), '````');
    assert.equal(createSafeFence('code with ```` fence'), '`````');
    assert.equal(createSafeFence('code with ``` and ````'), '`````');
});

test('Language extraction identifies standard language classes and data attributes', () => {
    const dom1 = parseHTML('<code class="language-typescript">code</code>');
    assert.equal(extractCodeLanguage(dom1.querySelector('code')), 'typescript');

    const dom2 = parseHTML('<code class="lang-python">code</code>');
    assert.equal(extractCodeLanguage(dom2.querySelector('code')), 'python');

    const dom3 = parseHTML('<code data-language="rust">code</code>');
    assert.equal(extractCodeLanguage(dom3.querySelector('code')), 'rust');

    const dom4 = parseHTML('<code data-lang="csharp">code</code>');
    assert.equal(extractCodeLanguage(dom4.querySelector('code')), 'csharp');

    const dom5 = parseHTML('<code>plain code</code>');
    assert.equal(extractCodeLanguage(dom5.querySelector('code')), '');

    const dom6 = parseHTML('<code class="language-invalid$char*">invalid</code>');
    assert.equal(extractCodeLanguage(dom6.querySelector('code')), '');
});

test('URL sanitizer accepts safe protocols and rejects javascript/data/blob/tokens', () => {
    assert.equal(sanitizeUrl('https://example.com/page'), 'https://example.com/page');
    assert.equal(sanitizeUrl('http://example.com/page'), 'http://example.com/page');
    assert.equal(sanitizeUrl('mailto:user@example.com'), 'mailto:user@example.com');
    assert.equal(sanitizeUrl('/relative/path'), '/relative/path');
    assert.equal(sanitizeUrl('#section-1'), '#section-1');

    // Unsafe schemes
    assert.equal(sanitizeUrl('javascript:alert(1)'), null);
    assert.equal(sanitizeUrl('data:text/html,test'), null);
    assert.equal(sanitizeUrl('blob:https://claude.ai/uuid'), null);
    assert.equal(sanitizeUrl('vbscript:msgbox(1)'), null);

    // Claude frame tokens and auth query params
    assert.equal(sanitizeUrl('https://abc-123.frame.claudeusercontent.com/frame?token=xyz'), null);
    assert.equal(sanitizeUrl('https://claudeusercontent.com/something?auth=123'), null);
    assert.equal(sanitizeUrl('https://example.com/api?access_token=secret'), null);
    assert.equal(sanitizeUrl('https://example.com/api?jwt=secret.payload.sig'), null);
});

test('Element exclusion correctly flags untrusted, hidden, and service UI elements', () => {
    const dom = parseHTML(`
        <script>alert(1)</script>
        <style>body{}</style>
        <noscript>no js</noscript>
        <template><p>temp</p></template>
        <div aria-hidden="true">hidden</div>
        <div hidden>hidden2</div>
        <div style="display:none">hidden3</div>
        <div style="visibility: hidden">hidden4</div>
        <button class="copy-button">Copy</button>
        <div class="sr-only">Accessibility label</div>
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

test('Handles rendered SVG-only Mermaid with neutral marker and warning without leaking', () => {
    const html = loadFixture('artifact-frame-rendered-mermaid-svg-only.html');
    const dom = parseHTML(html);
    const root = dom.querySelector('.artifact-content');

    const result = convertDomToMarkdown(root, { document: dom });
    assert.ok(result.markdown.includes('<!-- [Mermaid diagram: source code unavailable; rendered vector graphic omitted] -->'));
    assert.equal(result.metadata.hasSvgOnlyMermaid, true);
    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes('Mermaid diagram source code was unavailable'));
    // Ensure no SVG text/ids leaked into raw diagram fences
    assert.ok(!result.markdown.includes('```mermaid'));
    assert.ok(!result.markdown.includes('flowchart-A-0'));
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

    assert.ok(result.markdown.includes('Frame Sandbox Link'));
    assert.ok(!result.markdown.includes('secret123'));
    assert.ok(!result.markdown.includes('.frame.claudeusercontent.com'));

    // Safe image preserved
    assert.ok(result.markdown.includes('![Valid Pic](https://images.example.com/pic.jpg)'));

    // Unsafe images omitted or alt preserved safely
    assert.ok(!result.markdown.includes('javascript:alert(1)'));
    assert.ok(!result.markdown.includes('super_secret'));
    assert.ok(!result.markdown.includes('xyz.frame.claudeusercontent.com'));

    // Blacklisted tags omitted
    assert.ok(!result.markdown.includes('should not execute or leak'));
    assert.ok(!result.markdown.includes('Secret template markup'));
    assert.ok(!result.markdown.includes('evil.com'));
    assert.ok(!result.markdown.includes('Inline hidden text'));
    assert.ok(!result.markdown.includes('Visibility hidden text'));
    assert.ok(!result.markdown.includes('Aria hidden service text'));
    assert.ok(!result.markdown.includes('Copy code'));
    assert.ok(!result.markdown.includes('Screen reader helper'));

    assert.ok(result.markdown.includes('Normal visible trailing paragraph.'));
});

test('Enforces conversion limits (character limits)', () => {
    // Massive string limit
    const hugeText = 'A'.repeat(MAX_MARKDOWN_CHARS + 100);
    const dom = parseHTML(`<p>${hugeText}</p>`);
    const result = convertDomToMarkdown(dom.body, { document: dom });
    assert.ok(result.markdown.length <= MAX_MARKDOWN_CHARS);
    assert.ok(result.warnings.some(w => w.includes('Markdown output was truncated')));
});
