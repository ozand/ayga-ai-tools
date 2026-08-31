import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { parseHTML } from './simple-dom.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

function loadDownloader() {
    const source = fs.readFileSync(path.join(root, 'utils/artifact-download.js'), 'utf8');
    const context = { globalThis: {} };
    vm.runInNewContext(source, context);
    return context.globalThis.AygaArtifactDownload;
}

function loadBridge() {
    const source = fs.readFileSync(path.join(root, 'utils/artifact-bridge.js'), 'utf8');
    const context = { URL, globalThis: {} };
    vm.runInNewContext(source, context);
    return context.globalThis.AygaArtifactBridge;
}

function createMockEnvironment(options = {}) {
    const objectUrls = new Map();
    let urlCounter = 0;

    class MockBlob {
        constructor(parts, blobOptions = {}) {
            this.parts = parts;
            this.type = blobOptions.type || '';
            let text = '';
            for (const part of parts) {
                text += String(part);
            }
            this._content = text;
            this.size = Buffer.byteLength(text, 'utf8');
        }

        async text() {
            return this._content;
        }
    }

    const mockUrl = {
        created: [],
        revoked: [],
        createObjectURL(blob) {
            if (options.failCreateObjectURL) {
                throw new Error('Failed to create object URL');
            }
            urlCounter += 1;
            const url = `blob:https://claude.ai/mock-${urlCounter}`;
            this.created.push({ url, blob });
            objectUrls.set(url, blob);
            return url;
        },
        revokeObjectURL(url) {
            this.revoked.push(url);
            objectUrls.delete(url);
        }
    };

    const clicks = [];
    const appends = [];
    const removes = [];

    const mockAnchor = {
        href: '',
        download: '',
        rel: '',
        style: {},
        parentNode: null,
        click() {
            if (options.failClick) {
                throw new Error('Anchor click failed');
            }
            clicks.push({ href: this.href, download: this.download });
        }
    };

    const mockBody = {
        appendChild(child) {
            if (options.failAppend) {
                throw new Error('appendChild failed');
            }
            appends.push(child);
            child.parentNode = this;
            return child;
        },
        removeChild(child) {
            removes.push(child);
            child.parentNode = null;
            return child;
        }
    };

    const mockDocument = {
        title: options.documentTitle || '',
        body: mockBody,
        createElement(tagName) {
            if (tagName === 'a') {
                return { ...mockAnchor };
            }
            return {
                style: {},
                dataset: {},
                textContent: '',
                appendChild() {}
            };
        }
    };

    return {
        Blob: MockBlob,
        URL: mockUrl,
        document: mockDocument,
        clicks,
        appends,
        removes,
        mockUrl
    };
}

describe('Artifact Download Module (AygaArtifactDownload)', () => {
    const downloader = loadDownloader();

    describe('Filename Sanitization Matrix', () => {
        test('handles standard alphanumeric titles', () => {
            assert.equal(downloader.sanitizeFilename('Architecture Overview'), 'Architecture Overview.md');
            assert.equal(downloader.sanitizeFilename('report-2025_final'), 'report-2025_final.md');
        });

        test('preserves valid Unicode across multiple languages', () => {
            assert.equal(downloader.sanitizeFilename('Отчет по проекту'), 'Отчет по проекту.md');
            assert.equal(downloader.sanitizeFilename('日本語ドキュメント'), '日本語ドキュメント.md');
            assert.equal(downloader.sanitizeFilename('Données d\'analyse & Résumé'), 'Données d\'analyse & Résumé.md');
            assert.equal(downloader.sanitizeFilename('🚀 Chart-Analysis ✨'), '🚀 Chart-Analysis ✨.md');
        });

        test('strips control characters, zero-width spaces, and directional marks', () => {
            assert.equal(downloader.sanitizeFilename('Doc\u0000\u001F\u007FName'), 'DocName.md');
            assert.equal(downloader.sanitizeFilename('Hidden\u200B\u200C\u200D\uFEFFWidth'), 'HiddenWidth.md');
            assert.equal(downloader.sanitizeFilename('\u202Ereversed\u202C'), 'reversed.md');
        });

        test('replaces path separators and illegal filesystem characters', () => {
            assert.equal(downloader.sanitizeFilename('../../etc/passwd'), 'etc passwd.md');
            assert.equal(downloader.sanitizeFilename('C:\\Windows\\System32\\calc.exe'), 'C Windows System32 calc.exe.md');
            assert.equal(downloader.sanitizeFilename('file*name?with:illegal<chars>|"pipe"'), 'file name with illegal chars pipe.md');
        });

        test('collapses whitespace and strips leading/trailing dots and spaces', () => {
            assert.equal(downloader.sanitizeFilename('   ...   hello world ...   '), 'hello world.md');
            assert.equal(downloader.sanitizeFilename('multiple     spaces   inside'), 'multiple spaces inside.md');
        });

        test('prevents duplicate .md extensions', () => {
            assert.equal(downloader.sanitizeFilename('document.md'), 'document.md');
            assert.equal(downloader.sanitizeFilename('document.MD'), 'document.md');
            assert.equal(downloader.sanitizeFilename('document.markdown'), 'document.md');
            assert.equal(downloader.sanitizeFilename('document.md.md'), 'document.md');
            assert.equal(downloader.sanitizeFilename('document.md.markdown.md'), 'document.md');
            assert.equal(downloader.sanitizeFilename('.md'), 'artifact.md');
        });

        test('handles Windows reserved device names safely', () => {
            assert.equal(downloader.sanitizeFilename('CON'), 'artifact-CON.md');
            assert.equal(downloader.sanitizeFilename('prn'), 'artifact-prn.md');
            assert.equal(downloader.sanitizeFilename('aux.md'), 'artifact-aux.md');
            assert.equal(downloader.sanitizeFilename('NUL.txt'), 'artifact-NUL.txt.md');
            assert.equal(downloader.sanitizeFilename('com1'), 'artifact-com1.md');
            assert.equal(downloader.sanitizeFilename('LPT9'), 'artifact-LPT9.md');
        });

        test('truncates overly long filenames while preserving extension', () => {
            const longTitle = 'a'.repeat(200);
            const sanitized = downloader.sanitizeFilename(longTitle);
            assert.ok(sanitized.endsWith('.md'));
            assert.ok(sanitized.length <= downloader.MAX_FILENAME_LENGTH);
            assert.equal(sanitized, `${'a'.repeat(downloader.MAX_BASE_LENGTH)}.md`);
        });

        test('falls back to default filename on empty/invalid/pure-punctuation inputs', () => {
            assert.equal(downloader.sanitizeFilename(''), 'artifact.md');
            assert.equal(downloader.sanitizeFilename('   '), 'artifact.md');
            assert.equal(downloader.sanitizeFilename(null), 'artifact.md');
            assert.equal(downloader.sanitizeFilename(undefined), 'artifact.md');
            assert.equal(downloader.sanitizeFilename(123), 'artifact.md');
            assert.equal(downloader.sanitizeFilename('///:::***'), 'artifact.md');
            assert.equal(downloader.sanitizeFilename('....'), 'artifact.md');
        });
    });

    describe('Filename Derivation (deriveFilename)', () => {
        test('derives from string source directly', () => {
            assert.equal(downloader.deriveFilename('Custom Title'), 'Custom Title.md');
        });

        test('derives from metadata object with title or name', () => {
            assert.equal(downloader.deriveFilename({ title: 'Meta Title' }), 'Meta Title.md');
            assert.equal(downloader.deriveFilename({ name: 'Meta Name' }), 'Meta Name.md');
        });

        test('falls back to document title when metadata is absent or empty', () => {
            const mockDoc = { title: 'Document Title - Report' };
            assert.equal(downloader.deriveFilename(null, mockDoc), 'Document Title - Report.md');
            assert.equal(downloader.deriveFilename({}, mockDoc), 'Document Title - Report.md');
        });

        test('ignores generic Claude / viewer titles and uses default', () => {
            assert.equal(downloader.deriveFilename(null, { title: 'Claude' }), 'artifact.md');
            assert.equal(downloader.deriveFilename(null, { title: 'Artifact Frame' }), 'artifact.md');
            assert.equal(downloader.deriveFilename(null, { title: 'User-generated artifact content' }), 'artifact.md');
            assert.equal(downloader.deriveFilename(null, { title: '' }), 'artifact.md');
            assert.equal(downloader.deriveFilename(null, null), 'artifact.md');
        });

        test('never derives from iframe src or tokenized url strings', () => {
            const tokenUrl = 'https://01932b12-9c34-7a1b-8f12-3456789abcde.frame.claudeusercontent.com/?token=secret_jwt_value#data';
            // Passing a URL as source or metadata must never leak raw token / path as file unsanitized
            const derived = downloader.deriveFilename({ src: tokenUrl });
            assert.equal(derived, 'artifact.md');
        });
    });

    describe('Markdown Validation and Blob Creation', () => {
        test('validates non-empty bounded markdown', () => {
            assert.equal(downloader.isValidMarkdownContent('# Hello'), true);
            assert.equal(downloader.isValidMarkdownContent(''), false);
            assert.equal(downloader.isValidMarkdownContent('   \n\t  '), false);
            assert.equal(downloader.isValidMarkdownContent(null), false);
            assert.equal(downloader.isValidMarkdownContent(undefined), false);
            assert.equal(downloader.isValidMarkdownContent(123), false);
            assert.equal(downloader.isValidMarkdownContent('X'.repeat(downloader.MAX_MARKDOWN_BYTES + 1)), false);
        });

        test('creates Blob with exact MIME text/markdown;charset=utf-8 and preserves exact UTF-8 bytes', async () => {
            const env = createMockEnvironment();
            const mdContent = '# Title\n\nПривет, мир! 🚀\n- Item 1\n- Item 2\n\n```python\nprint("hello")\n```';
            const blob = downloader.createMarkdownBlob(mdContent, env.Blob);

            assert.equal(blob.type, 'text/markdown;charset=utf-8');
            assert.equal(await blob.text(), mdContent);
            assert.equal(blob.size, Buffer.byteLength(mdContent, 'utf8'));
        });

        test('throws TypeError on invalid markdown blob creation', () => {
            const env = createMockEnvironment();
            assert.throws(() => downloader.createMarkdownBlob('', env.Blob), /Invalid Markdown content/);
            assert.throws(() => downloader.createMarkdownBlob(null, env.Blob), /Invalid Markdown content/);
        });
    });

    describe('Trigger Download, Anchor Lifecycle, and Guaranteed Cleanup', () => {
        test('successful download workflow appends anchor, clicks, removes anchor, and revokes object URL', () => {
            const env = createMockEnvironment();
            const mdContent = '# Safe Artifact Content';
            const blob = downloader.createMarkdownBlob(mdContent, env.Blob);
            const result = downloader.triggerDownload(blob, 'my-artifact.md', env);

            assert.equal(result.ok, true);
            assert.equal(result.filename, 'my-artifact.md');
            assert.equal(env.clicks.length, 1);
            assert.equal(env.clicks[0].download, 'my-artifact.md');
            assert.ok(env.clicks[0].href.startsWith('blob:https://claude.ai/mock-'));

            // Check anchor was appended and then removed
            assert.equal(env.appends.length, 1);
            assert.equal(env.removes.length, 1);
            assert.equal(env.removes[0], env.appends[0]);

            // Check object URL was created and revoked
            assert.equal(env.mockUrl.created.length, 1);
            assert.equal(env.mockUrl.revoked.length, 1);
            assert.equal(env.mockUrl.revoked[0], env.mockUrl.created[0].url);
        });

        test('guaranteed cleanup when anchor.click() throws', () => {
            const env = createMockEnvironment({ failClick: true });
            const mdContent = '# Fails On Click';
            const blob = downloader.createMarkdownBlob(mdContent, env.Blob);

            assert.throws(() => downloader.triggerDownload(blob, 'fails.md', env), /Anchor click failed/);

            // Anchor removed and URL revoked despite click failure
            assert.equal(env.appends.length, 1);
            assert.equal(env.removes.length, 1);
            assert.equal(env.mockUrl.created.length, 1);
            assert.equal(env.mockUrl.revoked.length, 1);
            assert.equal(env.mockUrl.revoked[0], env.mockUrl.created[0].url);
        });

        test('guaranteed cleanup when appendChild throws', () => {
            const env = createMockEnvironment({ failAppend: true });
            const mdContent = '# Fails On Append';
            const blob = downloader.createMarkdownBlob(mdContent, env.Blob);

            assert.throws(() => downloader.triggerDownload(blob, 'fails.md', env), /appendChild failed/);

            // URL revoked despite append failure
            assert.equal(env.mockUrl.created.length, 1);
            assert.equal(env.mockUrl.revoked.length, 1);
            assert.equal(env.mockUrl.revoked[0], env.mockUrl.created[0].url);
        });

        test('downloadMarkdownArtifact returns safe structured result on failure without throwing', () => {
            const env = createMockEnvironment({ failClick: true });
            const result = downloader.downloadMarkdownArtifact('# Content', {
                ...env,
                title: 'test'
            });

            assert.equal(result.ok, false);
            assert.equal(result.code, 'DOWNLOAD_FAILED');
            assert.ok(result.error.includes('Anchor click failed'));

            // Even via high-level helper, URL is revoked
            assert.equal(env.mockUrl.revoked.length, 1);
        });

        test('downloadMarkdownArtifact rejects malformed or empty markdown immediately', () => {
            const env = createMockEnvironment();
            const result = downloader.downloadMarkdownArtifact('   ', env);
            assert.equal(result.ok, false);
            assert.equal(result.code, 'INVALID_MARKDOWN');
            assert.equal(env.mockUrl.created.length, 0);
            assert.equal(env.clicks.length, 0);
        });
    });

    describe('Artifact Shell Bridge & Downloader Integration', () => {
        test('successful bridge response triggers download and sets status', async () => {
            const bridge = loadBridge();
            const downloader = loadDownloader();
            const env = createMockEnvironment({ documentTitle: 'Claude Artifact Shell' });

            let buttonClickListener = null;
            let statusText = '';
            let statusColor = '';

            const shellDoc = {
                title: 'Report 2025',
                body: {
                    appendChild(elem) {
                        if (elem.tagName === 'a' || elem.download !== undefined) {
                            return env.document.body.appendChild(elem);
                        }
                    },
                    removeChild(elem) {
                        return env.document.body.removeChild(elem);
                    }
                },
                documentElement: {},
                querySelector(sel) {
                    if (sel.includes('iframe#frame-content')) {
                        return {
                            isConnected: true,
                            classList: { contains: (cls) => cls === 'ready' },
                            src: 'https://01932b12-9c34-7a1b-8f12-3456789abcde.frame.claudeusercontent.com/artifact',
                            contentWindow: mockFrameWindow
                        };
                    }
                    if (sel.includes('[data-ayga-artifact-export]')) return null;
                    if (sel.includes('[data-ayga-artifact-status]')) {
                        return {
                            dataset: {},
                            style: {
                                set background(val) { statusColor = val; }
                            },
                            set textContent(val) { statusText = val; }
                        };
                    }
                    return null;
                },
                createElement(tag) {
                    if (tag === 'button') {
                        return {
                            dataset: {},
                            style: {},
                            set disabled(val) {},
                            addEventListener(evt, handler) {
                                if (evt === 'click') buttonClickListener = handler;
                            }
                        };
                    }
                    if (tag === 'a') {
                        return env.document.createElement('a');
                    }
                    return {
                        dataset: {},
                        style: {},
                        set textContent(val) { statusText = val; }
                    };
                }
            };

            const shellListeners = [];
            const mockFrameWindow = {
                postMessage(req, origin) {
                    // Frame responds with valid bridge message containing markdown and metadata
                    const resp = bridge.makeResponse(req.requestId, {
                        ok: true,
                        code: 'CONVERTED_SUCCESS',
                        markdown: '# Integration Report\n\nContent here.',
                        metadata: { title: 'Executive Summary' }
                    });
                    for (const l of shellListeners) {
                        l({
                            source: mockFrameWindow,
                            origin: 'https://01932b12-9c34-7a1b-8f12-3456789abcde.frame.claudeusercontent.com',
                            data: resp
                        });
                    }
                }
            };

            const shellContext = {
                location: { origin: 'https://claude.ai', pathname: '/code/artifact/test-artifact' },
                window: {
                    top: null,
                    addEventListener(evt, l) { if (evt === 'message') shellListeners.push(l); },
                    removeEventListener(evt, l) {
                        const idx = shellListeners.indexOf(l);
                        if (idx !== -1) shellListeners.splice(idx, 1);
                    },
                    URL: env.URL,
                    Blob: env.Blob
                },
                document: shellDoc,
                MutationObserver: class {
                    observe() {}
                },
                globalThis: {
                    AygaArtifactBridge: bridge,
                    AygaArtifactDownload: downloader
                },
                URL: env.URL,
                Blob: env.Blob,
                setTimeout,
                clearTimeout
            };
            shellContext.window.top = shellContext.window;

            vm.runInNewContext(fs.readFileSync(path.join(root, 'artifact-shell.js'), 'utf8'), shellContext);

            assert.ok(buttonClickListener, 'Export button click handler registered');
            await buttonClickListener();

            // Check download occurred
            assert.equal(env.clicks.length, 1);
            assert.equal(env.clicks[0].download, 'Executive Summary.md');
            assert.equal(statusText, 'Exported Executive Summary.md');
            assert.equal(statusColor, '#202123'); // success color
        });

        test('malformed/error bridge response never triggers download and displays safe status', async () => {
            const bridge = loadBridge();
            const downloader = loadDownloader();
            const env = createMockEnvironment({ documentTitle: 'Claude' });

            let buttonClickListener = null;
            let statusText = '';
            let statusColor = '';

            const shellDoc = {
                title: 'Claude',
                body: {
                    appendChild(elem) {},
                    removeChild(elem) { return env.document.body.removeChild(elem); }
                },
                documentElement: {},
                querySelector(sel) {
                    if (sel.includes('iframe#frame-content')) {
                        return {
                            isConnected: true,
                            classList: { contains: (cls) => cls === 'ready' },
                            src: 'https://01932b12-9c34-7a1b-8f12-3456789abcde.frame.claudeusercontent.com/artifact',
                            contentWindow: mockFrameWindow
                        };
                    }
                    if (sel.includes('[data-ayga-artifact-export]')) return null;
                    if (sel.includes('[data-ayga-artifact-status]')) {
                        return {
                            dataset: {},
                            style: {
                                set background(val) { statusColor = val; }
                            },
                            set textContent(val) { statusText = val; }
                        };
                    }
                    return null;
                },
                createElement(tag) {
                    if (tag === 'button') {
                        return {
                            dataset: {},
                            style: {},
                            set disabled(val) {},
                            addEventListener(evt, handler) {
                                if (evt === 'click') buttonClickListener = handler;
                            }
                        };
                    }
                    if (tag === 'a') {
                        return env.document.createElement('a');
                    }
                    return {
                        dataset: {},
                        style: {},
                        set textContent(val) { statusText = val; }
                    };
                }
            };

            const shellListeners = [];
            const mockFrameWindow = {
                postMessage(req, origin) {
                    // Frame responds with error
                    const resp = bridge.makeResponse(req.requestId, {
                        ok: false,
                        code: 'MERMAID_SOURCE_UNAVAILABLE',
                        message: 'Mermaid source is unavailable; rendered SVG was not converted.'
                    });
                    for (const l of shellListeners) {
                        l({
                            source: mockFrameWindow,
                            origin: 'https://01932b12-9c34-7a1b-8f12-3456789abcde.frame.claudeusercontent.com',
                            data: resp
                        });
                    }
                }
            };

            const shellContext = {
                location: { origin: 'https://claude.ai', pathname: '/code/artifact/test-artifact' },
                window: {
                    top: null,
                    addEventListener(evt, l) { if (evt === 'message') shellListeners.push(l); },
                    removeEventListener(evt, l) {
                        const idx = shellListeners.indexOf(l);
                        if (idx !== -1) shellListeners.splice(idx, 1);
                    },
                    URL: env.URL,
                    Blob: env.Blob
                },
                document: shellDoc,
                MutationObserver: class {
                    observe() {}
                },
                globalThis: {
                    AygaArtifactBridge: bridge,
                    AygaArtifactDownload: downloader
                },
                URL: env.URL,
                Blob: env.Blob,
                setTimeout,
                clearTimeout
            };
            shellContext.window.top = shellContext.window;

            vm.runInNewContext(fs.readFileSync(path.join(root, 'artifact-shell.js'), 'utf8'), shellContext);

            assert.ok(buttonClickListener, 'Export button click handler registered');
            await buttonClickListener();

            // Zero downloads triggered
            assert.equal(env.clicks.length, 0);
            assert.equal(env.mockUrl.created.length, 0);
            assert.equal(statusText, 'Mermaid source is unavailable; rendered SVG was not converted.');
            assert.equal(statusColor, '#9b1c1c'); // error color
        });
    });
});
