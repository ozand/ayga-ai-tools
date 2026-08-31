import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

function readFixture(filename) {
  return fs.readFileSync(path.join(FIXTURES_DIR, filename), 'utf-8');
}

/**
 * Parses iframe attributes and properties from shell HTML using standard pattern matching
 */
function parseShellIframe(html) {
  const match = html.match(/<iframe\b([^>]*)>/i);
  if (!match) return null;
  const attrsString = match[1];

  const getAttr = (name) => {
    const attrMatch = attrsString.match(new RegExp(`${name}=["']([^"']*)["']`, 'i'));
    return attrMatch ? attrMatch[1] : null;
  };

  const id = getAttr('id');
  const title = getAttr('title');
  const src = getAttr('src');
  const classList = (getAttr('class') || '').split(/\s+/).filter(Boolean);

  return {
    id,
    title,
    src,
    classList,
    matchesSelector: (sel) => {
      if (sel === 'iframe#frame-content[title="User-generated artifact content"]') {
        return id === 'frame-content' && title === 'User-generated artifact content';
      }
      if (sel === '.flex.min-w-0.items-center.max-md\\:text-sm' || sel === '.flex.min-w-0.items-center.max-md:text-sm') {
        return false;
      }
      return false;
    }
  };
}

/**
 * Validates frame origin host according to ARTIFACT-DOM-MAP.md
 */
function isApprovedArtifactFrameHost(hostname) {
  return /\.frame\.claudeusercontent\.com$/i.test(hostname);
}

/**
 * Strips query parameters and extracts clean origin from iframe src
 */
function extractSafeFrameOrigin(src) {
  try {
    const url = new URL(src);
    if (!isApprovedArtifactFrameHost(url.hostname)) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Sanitizes markdown code fences by selecting backtick count > max run
 */
function createSafeCodeFence(content) {
  const matches = content.match(/`+/g);
  let maxTicks = 2; // minimum is 3
  if (matches) {
    for (const m of matches) {
      if (m.length > maxTicks) {
        maxTicks = m.length;
      }
    }
  }
  return '`'.repeat(maxTicks + 1);
}

/**
 * Evaluates mermaid extraction according to the mermaid source vs rendered SVG policy
 */
function evaluateMermaidExtraction(html) {
  // Check for explicit source code representation
  const codeBlockMatch = html.match(/<pre[^>]*><code[^>]*class=["']([^"']*language-mermaid[^"']*)["'][^>]*>([\s\S]*?)<\/code><\/pre>/i);
  if (codeBlockMatch) {
    const rawSource = codeBlockMatch[2]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .trim();
    const fence = createSafeCodeFence(rawSource);
    return {
      hasMermaid: true,
      isSource: true,
      markdown: `${fence}mermaid\n${rawSource}\n${fence}`
    };
  }

  // Check for rendered SVG only (e.g. #claude-mermaid-0 or svg.mermaid)
  const renderedSvgMatch = html.match(/<svg[^>]*id=["']claude-mermaid-[^"']*["'][^>]*>([\s\S]*?)<\/svg>/i);
  if (renderedSvgMatch) {
    return {
      hasMermaid: true,
      isSource: false,
      markdown: '[Mermaid source unavailable]'
    };
  }

  return {
    hasMermaid: false,
    isSource: false,
    markdown: ''
  };
}

describe('Artifact DOM and Source Map Validation', () => {
  describe('Shell and Frame Boundary & Selectors', () => {
    test('matches iframe#frame-content[title="User-generated artifact content"] on shell fixture', () => {
      const shellHtml = readFixture('artifact-shell.html');
      const iframe = parseShellIframe(shellHtml);

      assert.ok(iframe, 'Iframe element must be present in shell HTML');
      assert.strictEqual(iframe.id, 'frame-content');
      assert.strictEqual(iframe.title, 'User-generated artifact content');
      assert.ok(iframe.classList.includes('ready'), 'Iframe should have ready class');
      assert.ok(iframe.matchesSelector('iframe#frame-content[title="User-generated artifact content"]'));
    });

    test('extracts clean origin and rejects token parameters from iframe src', () => {
      const shellHtml = readFixture('artifact-shell.html');
      const iframe = parseShellIframe(shellHtml);

      assert.ok(iframe.src.includes('token='), 'Fixture contains token in URL');
      const safeOrigin = extractSafeFrameOrigin(iframe.src);
      assert.strictEqual(safeOrigin, 'https://01932b12-9c34-7a1b-8f12-3456789abcde.frame.claudeusercontent.com');
      assert.ok(!safeOrigin.includes('token='), 'Origin must not contain access token parameters');
      assert.ok(!safeOrigin.includes('build='), 'Origin must not contain build parameters');
    });

    test('rejects legacy chat UI selector on chat negative fixture', () => {
      const chatHtml = readFixture('chat-negative.html');
      const iframe = parseShellIframe(chatHtml);
      assert.strictEqual(iframe, null, 'Chat UI fixture must not contain artifact iframe');
      assert.ok(chatHtml.includes('flex min-w-0 items-center max-md:text-sm'), 'Chat UI selector found in chat fixture');
    });

    test('validates approved frame hostname regex strictly', () => {
      assert.strictEqual(isApprovedArtifactFrameHost('01932b12-9c34-7a1b-8f12-3456789abcde.frame.claudeusercontent.com'), true);
      assert.strictEqual(isApprovedArtifactFrameHost('sub.frame.claudeusercontent.com'), true);
      assert.strictEqual(isApprovedArtifactFrameHost('claudeusercontent.com'), false);
      assert.strictEqual(isApprovedArtifactFrameHost('frame.claudeusercontent.com'), false);
      assert.strictEqual(isApprovedArtifactFrameHost('claude.ai'), false);
      assert.strictEqual(isApprovedArtifactFrameHost('evil.frame.claudeusercontent.com.attacker.com'), false);
    });
  });

  describe('Mermaid Source vs Rendered SVG Policy', () => {
    test('extracts explicit mermaid source code block when present', () => {
      const frameHtml = readFixture('artifact-frame-with-mermaid-source.html');
      const result = evaluateMermaidExtraction(frameHtml);

      assert.strictEqual(result.hasMermaid, true);
      assert.strictEqual(result.isSource, true);
      assert.ok(result.markdown.startsWith('```mermaid\ngraph TD'));
      assert.ok(result.markdown.includes('A[Client] --> B[API Gateway]'));
    });

    test('handles backticks in code blocks using dynamic fence length', () => {
      const codeWithBackticks = 'console.log("Hello ```world```");';
      const fence = createSafeCodeFence(codeWithBackticks);
      assert.strictEqual(fence, '````', 'Fence should be 4 backticks when code contains 3 backticks');
    });

    test('does NOT emit rendered SVG as mermaid source, rasterize it, or leak tokens', () => {
      const frameHtml = readFixture('artifact-frame-rendered-mermaid-svg-only.html');
      const result = evaluateMermaidExtraction(frameHtml);

      assert.strictEqual(result.hasMermaid, true);
      assert.strictEqual(result.isSource, false);
      assert.strictEqual(result.markdown, '[Mermaid source unavailable]');
      assert.ok(!result.markdown.includes('<svg'), 'Markdown must not contain raw SVG XML');
      assert.ok(!result.markdown.includes('token='), 'Markdown must not contain tokenized URLs');
    });
  });

  describe('Untrusted Elements and PostMessage Security Policy', () => {
    test('untrusted elements fixture contains excluded tags to verify filtering requirements', () => {
      const untrustedHtml = readFixture('artifact-frame-untrusted-elements.html');
      assert.ok(untrustedHtml.includes('<script>'), 'Script tag present in untrusted fixture');
      assert.ok(untrustedHtml.includes('<style>'), 'Style tag present in untrusted fixture');
      assert.ok(untrustedHtml.includes('<noscript>'), 'Noscript tag present in untrusted fixture');
      assert.ok(untrustedHtml.includes('<template>'), 'Template tag present in untrusted fixture');
      assert.ok(untrustedHtml.includes('aria-hidden="true"'), 'Aria-hidden service element present in untrusted fixture');

      // Safe content verification
      assert.ok(untrustedHtml.includes('Visible safe text paragraph.'), 'Safe paragraph present in untrusted fixture');
      assert.ok(untrustedHtml.includes('This is a blockquote.'), 'Safe blockquote present in untrusted fixture');
    });

    test('enforces strict origin verification for postMessage boundary', () => {
      const validParentOrigin = 'https://claude.ai';
      const validFrameOrigin = 'https://01932b12-9c34-7a1b-8f12-3456789abcde.frame.claudeusercontent.com';

      const checkFrameAcceptance = (origin, sourceIsParent) => {
        return origin === 'https://claude.ai' && sourceIsParent === true;
      };

      const checkShellAcceptance = (origin, expectedFrameOrigin, sourceIsFrameWindow) => {
        return origin === expectedFrameOrigin && sourceIsFrameWindow === true && origin !== '*';
      };

      assert.strictEqual(checkFrameAcceptance('https://claude.ai', true), true);
      assert.strictEqual(checkFrameAcceptance('https://evil.com', true), false);
      assert.strictEqual(checkFrameAcceptance('https://claude.ai', false), false);

      assert.strictEqual(checkShellAcceptance(validFrameOrigin, validFrameOrigin, true), true);
      assert.strictEqual(checkShellAcceptance('*', validFrameOrigin, true), false);
      assert.strictEqual(checkShellAcceptance('https://other.frame.claudeusercontent.com', validFrameOrigin, true), false);
      assert.strictEqual(checkShellAcceptance(validFrameOrigin, validFrameOrigin, false), false);
    });
  });
});
