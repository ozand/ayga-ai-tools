import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

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
        querySelector(selector) {
            if (selector.includes('language-mermaid') && frameHtml.includes('language-mermaid')) {
                return { textContent: 'graph TD\nA --> B' };
            }
            if (selector.includes('claude-mermaid') && frameHtml.includes('claude-mermaid')) {
                return {};
            }
            if (selector.includes('h1,h2') && frameHtml.includes('safe-content')) return {};
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
});
