import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { parseHTML } from './simple-dom.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function loadBridge() {
    const source = fs.readFileSync(path.join(root, 'utils/artifact-bridge.js'), 'utf8');
    const context = { URL, globalThis: {} };
    vm.runInNewContext(source, context);
    return context.globalThis.AygaArtifactBridge;
}

function loadFrameHandler({ hostname, frameHtml = '' }) {
    const bridge = loadBridge();
    const listeners = [];
    const messages = [];
    const document = {
        body: {
            querySelector(selector) {
                if (selector.includes('claude-mermaid') && frameHtml.includes('claude-mermaid')) {
                    return {};
                }
                if ((selector.includes('h1') || selector.includes('p')) && frameHtml.includes('safe-content')) {
                    return {};
                }
                return null;
            }
        },
        querySelector(selector) {
            if (selector.includes('artifact-content') || selector.includes('artifact-viewer')) {
                if (frameHtml && !frameHtml.includes('claude-mermaid')) {
                    return this;
                }
                return null;
            }
            if (selector.includes('language-mermaid') && frameHtml.includes('language-mermaid')) {
                return { textContent: 'graph TD\nA --> B' };
            }
            if (selector.includes('claude-mermaid') && frameHtml.includes('claude-mermaid')) {
                return {};
            }
            if ((selector.includes('h1') || selector.includes('p')) && frameHtml.includes('safe-content')) return {};
            return null;
        }
    };
    const parent = {
        postMessage(message, targetOrigin) { messages.push({ message, targetOrigin }); }
    };
    const window = {
        parent,
        top: null,
        addEventListener(type, callback) { if (type === 'message') listeners.push(callback); },
        postMessage() {}
    };
    window.top = {};
    const context = { globalThis: { AygaArtifactBridge: bridge }, location: { hostname }, document, window };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'artifact-frame.js'), 'utf8'), context);
    return {
        bridge,
        listeners,
        messages,
        parent,
        dispatch(data, origin, source = parent) {
            listeners.forEach((listener) => listener({ data, origin, source }));
        }
    };
}

describe('Artifact bridge protocol', () => {
    test('accepts only approved HTTPS frame origins', () => {
        const bridge = loadBridge();
        assert.equal(bridge.getSafeFrameOrigin('https://id.frame.claudeusercontent.com/path?token=secret'), 'https://id.frame.claudeusercontent.com');
        assert.equal(bridge.getSafeFrameOrigin('https://frame.claudeusercontent.com/path'), null);
        assert.equal(bridge.getSafeFrameOrigin('https://id.frame.claudeusercontent.com.attacker.test/path'), null);
        assert.equal(bridge.getSafeFrameOrigin('http://id.frame.claudeusercontent.com/path'), null);
    });

    test('rejects malformed, extra-field, and oversized messages', () => {
        const bridge = loadBridge();
        const request = bridge.makeRequest('request-1');
        assert.equal(bridge.isValidRequest(request), true);
        assert.equal(bridge.isValidRequest({ ...request, extra: true }), false);
        assert.equal(bridge.isValidRequest({ ...request, requestId: 'bad id' }), false);
        assert.equal(bridge.isValidResponse(bridge.makeResponse('request-1', { ok: false, message: 'x' }), 'request-1'), true);
        assert.equal(bridge.isValidResponse(bridge.makeResponse('request-1', { ok: false, message: 'x'.repeat(513) }), 'request-1'), false);
    });

    test('frame rejects wrong source/origin and responds only to valid request', () => {
        const frame = loadFrameHandler({ hostname: 'id.frame.claudeusercontent.com', frameHtml: 'safe-content' });
        const request = frame.bridge.makeRequest('request-2');
        frame.dispatch(request, 'https://evil.test');
        frame.dispatch(request, 'https://claude.ai', {});
        assert.equal(frame.messages.length, 0);
        frame.dispatch(request, 'https://claude.ai', frame.parent);
        assert.equal(frame.messages.length, 1);
        assert.equal(frame.messages[0].targetOrigin, 'https://claude.ai');
        assert.equal(frame.messages[0].message.requestId, 'request-2');
    });

    test('frame reports SVG-only Mermaid as unavailable without SVG or URL data', () => {
        const frame = loadFrameHandler({ hostname: 'id.frame.claudeusercontent.com', frameHtml: 'claude-mermaid token=secret' });
        const request = frame.bridge.makeRequest('request-3');
        frame.dispatch(request, 'https://claude.ai');
        const result = frame.messages[0].message.result;
        assert.equal(result.ok, false);
        assert.equal(result.code, 'MERMAID_SOURCE_UNAVAILABLE');
        assert.equal(JSON.stringify(result).includes('<svg'), false);
        assert.equal(JSON.stringify(result).includes('token='), false);
    });

    test('frame ignores execution when hostname is not approved or window is top frame', () => {
        const bridgeCode = fs.readFileSync(path.join(root, 'utils/artifact-bridge.js'), 'utf8');
        const frameCode = fs.readFileSync(path.join(root, 'artifact-frame.js'), 'utf8');

        // Case 1: unapproved frame hostname
        const listeners1 = [];
        const sandbox1 = {
            globalThis: {},
            window: {
                parent: {},
                top: {},
                location: { hostname: 'malicious.attacker.com' },
                addEventListener(t, cb) { if (t === 'message') listeners1.push(cb); }
            },
            document: { querySelector() { return null; } },
            location: { hostname: 'malicious.attacker.com' },
            URL,
            URLSearchParams
        };
        sandbox1.globalThis = sandbox1;
        vm.runInNewContext(bridgeCode, sandbox1);
        vm.runInNewContext(frameCode, sandbox1);
        assert.equal(listeners1.length, 0, 'Frame handler should not register listeners on unapproved hostname');

        // Case 2: top-level window (window.top === window)
        const listeners2 = [];
        const win2 = {
            parent: {},
            top: null,
            location: { hostname: '01932b12-9c34-7a1b-8f12-3456789abcde.frame.claudeusercontent.com' },
            addEventListener(t, cb) { if (t === 'message') listeners2.push(cb); }
        };
        win2.top = win2;
        const sandbox2 = {
            globalThis: {},
            window: win2,
            document: { querySelector() { return null; } },
            location: win2.location,
            URL,
            URLSearchParams
        };
        sandbox2.globalThis = sandbox2;
        vm.runInNewContext(bridgeCode, sandbox2);
        vm.runInNewContext(frameCode, sandbox2);
        assert.equal(listeners2.length, 0, 'Frame handler should not register listeners when window.top === window');
    });

    test('integration: artifact-frame valid postMessage returns converted markdown and bounds are enforced', () => {
        const bridgeCode = fs.readFileSync(path.join(root, 'utils/artifact-bridge.js'), 'utf8');
        const converterCode = fs.readFileSync(path.join(root, 'utils/artifact-converter.js'), 'utf8');
        const frameCode = fs.readFileSync(path.join(root, 'artifact-frame.js'), 'utf8');

        function createIntegrationFrame(htmlString, hostname = '01932b12-9c34-7a1b-8f12-3456789abcde.frame.claudeusercontent.com') {
            const dom = parseHTML(htmlString);
            const messages = [];
            const listeners = [];
            const parent = {
                postMessage(message, targetOrigin) {
                    messages.push({ message, targetOrigin });
                }
            };
            const window = {
                parent,
                top: {},
                location: { hostname },
                addEventListener(type, callback) {
                    if (type === 'message') listeners.push(callback);
                },
                postMessage() {}
            };

            const sandbox = {
                globalThis: {},
                window,
                document: dom,
                location: window.location,
                URL,
                URLSearchParams
            };
            sandbox.globalThis = sandbox;

            vm.runInNewContext(converterCode, sandbox);
            vm.runInNewContext(bridgeCode, sandbox);
            vm.runInNewContext(frameCode, sandbox);

            return {
                bridge: sandbox.globalThis.AygaArtifactBridge,
                messages,
                dispatch(data, origin = 'https://claude.ai', source = parent) {
                    listeners.forEach(l => l({ data, origin, source }));
                }
            };
        }

        // Test 1: Successful conversion of rich semantic content
        const richHtml = `
        <!DOCTYPE html>
        <html>
        <head><title>Integration Artifact</title></head>
        <body>
            <div class="artifact-content">
                <h1>Report Overview</h1>
                <p>Status: **Active** with <code>sample_id = 42</code></p>
                <div class="service-actions" role="toolbar"><button>Print</button></div>
                <pre><code class="language-js">console.log("Safe Code");</code></pre>
            </div>
        </body>
        </html>`;

        const frame1 = createIntegrationFrame(richHtml);
        const req1 = frame1.bridge.makeRequest('req-integration-1');
        frame1.dispatch(req1);

        assert.equal(frame1.messages.length, 1);
        assert.equal(frame1.messages[0].targetOrigin, 'https://claude.ai');
        const resp1 = frame1.messages[0].message;
        assert.equal(frame1.bridge.isValidResponse(resp1, 'req-integration-1'), true);
        assert.equal(resp1.result.ok, true);
        assert.equal(resp1.result.code, 'CONVERTED_SUCCESS');
        assert.ok(resp1.result.markdown.includes('# Report Overview'));
        assert.ok(resp1.result.markdown.includes('`sample_id = 42`'));
        assert.ok(!resp1.result.markdown.includes('Print'));

        // Test 2: Fail-closed on body with only header/controls/unconfirmed loose elements
        const controlOnlyHtml = `
        <!DOCTYPE html>
        <html>
        <head><title>Unconfirmed Shell / Controls</title></head>
        <body>
            <header><button>Claude Header Controls</button></header>
            <div class="controls"><button>Action Button</button></div>
            <div><span>Controls only</span></div>
        </body>
        </html>`;

        const frame2 = createIntegrationFrame(controlOnlyHtml);
        const req2 = frame2.bridge.makeRequest('req-integration-2');
        frame2.dispatch(req2);

        assert.equal(frame2.messages.length, 1);
        const resp2 = frame2.messages[0].message;
        assert.equal(resp2.result.ok, false);
        assert.equal(resp2.result.code, 'NO_EXPORTABLE_SOURCE');
        assert.equal(resp2.result.markdown, '');

        // Test 3: Current live-shaped frame body is accepted for prose content (h1-h6, p, etc.)
        const bodyArtifactHtml = `
        <!DOCTYPE html>
        <html>
        <head><title>Body-mounted Artifact</title></head>
        <body>
            <h1>Body Artifact</h1>
            <p>Visible content mounted directly under the frame body.</p>
        </body>
        </html>`;

        const frameBodyArtifact = createIntegrationFrame(bodyArtifactHtml);
        const reqBodyArtifact = frameBodyArtifact.bridge.makeRequest('req-body-artifact');
        frameBodyArtifact.dispatch(reqBodyArtifact);

        assert.equal(frameBodyArtifact.messages.length, 1);
        const bodyArtifactResponse = frameBodyArtifact.messages[0].message;
        assert.equal(bodyArtifactResponse.result.ok, true);
        assert.equal(bodyArtifactResponse.result.code, 'CONVERTED_SUCCESS');
        assert.ok(bodyArtifactResponse.result.markdown.includes('# Body Artifact'));
        assert.ok(bodyArtifactResponse.result.markdown.includes('Visible content mounted directly under the frame body.'));

        // Test 4: Body with only rendered Mermaid SVG returns safe companion SVG artifact and relative image link
        const bodySvgOnlyHtml = `
        <!DOCTYPE html>
        <html>
        <head><title>Rendered Mermaid Frame</title></head>
        <body>
            <div class="mermaid-viewer">
                <svg id="claude-mermaid-0" viewBox="0 0 100 100">
                    <g><text>Rendered Node</text></g>
                </svg>
            </div>
        </body>
        </html>`;

        const frameSvgOnly = createIntegrationFrame(bodySvgOnlyHtml);
        const reqSvgOnly = frameSvgOnly.bridge.makeRequest('req-svg-only');
        frameSvgOnly.dispatch(reqSvgOnly);

        assert.equal(frameSvgOnly.messages.length, 1);
        const svgOnlyResp = frameSvgOnly.messages[0].message;
        assert.equal(svgOnlyResp.result.ok, true);
        assert.equal(svgOnlyResp.result.code, 'CONVERTED_SUCCESS');
        assert.ok(svgOnlyResp.result.markdown.includes('![Diagram]('));
        assert.equal(svgOnlyResp.result.mermaidSourceAvailable, false);
        assert.equal(svgOnlyResp.result.assets.length, 1);
        assert.equal(svgOnlyResp.result.assets[0].filename, 'Rendered-Mermaid-Frame-diagram-01.svg');
        assert.ok(svgOnlyResp.result.assets[0].content.includes('<svg'));
        assert.equal(svgOnlyResp.result.markdown.includes('<svg'), false, 'Markdown must not contain raw SVG XML');
        assert.equal(JSON.stringify(svgOnlyResp).includes('token='), false, 'Response must not leak token parameters');

        // Mixed prose plus rendered SVG creates separate companion artifact
        const mixedSvgHtml = `
        <html><body>
            <h2>Safe surrounding content</h2>
            <p>This text remains exportable.</p>
            <div class="mermaid-viewer"><svg id="claude-mermaid-0"><text>Rendered only</text></svg></div>
        </body></html>`;
        const mixedSvgFrame = createIntegrationFrame(mixedSvgHtml);
        mixedSvgFrame.dispatch(mixedSvgFrame.bridge.makeRequest('req-mixed-svg'));
        const mixedSvgResponse = mixedSvgFrame.messages[0].message;
        assert.equal(mixedSvgResponse.result.ok, true);
        assert.equal(mixedSvgResponse.result.code, 'CONVERTED_SUCCESS');
        assert.ok(mixedSvgResponse.result.markdown.includes('Safe surrounding content'));
        assert.ok(mixedSvgResponse.result.markdown.includes('![Diagram]('));
        assert.equal(mixedSvgResponse.result.mermaidSourceAvailable, false);
        assert.equal(mixedSvgResponse.result.assets.length, 1);

        // Test 5: Large content bounds enforcement in frame context
        const largeHtml = `
        <!DOCTYPE html>
        <html>
        <head><title>Huge Artifact</title></head>
        <body>
            <div class="artifact-content">
                <h1>Huge Title</h1>
                <p>${'X'.repeat(60000)}</p>
            </div>
        </body>
        </html>`;

        const frame3 = createIntegrationFrame(largeHtml);
        const req3 = frame3.bridge.makeRequest('req-integration-3');
        frame3.dispatch(req3);

        assert.equal(frame3.messages.length, 1);
        const resp3 = frame3.messages[0].message;
        assert.equal(resp3.result.ok, true);
        assert.ok(resp3.result.markdown.length <= 50000);
        assert.equal(resp3.result.warnings.some(w => w.includes('limit reached') || w.includes('truncated')), true);
    });
});
