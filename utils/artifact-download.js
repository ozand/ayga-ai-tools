// utils/artifact-download.js - Content-script safe Markdown download module for Claude Artifacts

(function attachArtifactDownload(root) {
    'use strict';

    const DEFAULT_FILENAME = 'artifact.md';
    const DEFAULT_BASE_NAME = 'artifact';
    const MAX_FILENAME_LENGTH = 128;
    const MAX_BASE_LENGTH = 120;
    const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
    const MIME_TYPE = 'text/markdown;charset=utf-8';

    const RESERVED_WINDOWS_NAMES = new Set([
        'CON', 'PRN', 'AUX', 'NUL',
        'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
        'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
    ]);

    function sanitizeFilename(rawInput) {
        if (typeof rawInput !== 'string') {
            return DEFAULT_FILENAME;
        }

        let input = rawInput.normalize('NFC').trim();
        if (!input) {
            return DEFAULT_FILENAME;
        }

        // Strip existing markdown extensions repeatedly to avoid duplicate .md.md
        while (/\.(md|markdown)$/i.test(input)) {
            input = input.replace(/\.(md|markdown)$/i, '').trim();
        }

        // Strip control characters, zero-width spaces, and directional formatting marks
        input = input.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '');

        // Replace path separators and Windows/POSIX illegal filename characters
        input = input.replace(/[\\/:*?"<>|]+/g, ' ');

        // Collapse multiple whitespace to single space
        input = input.replace(/\s+/g, ' ').trim();

        // Strip leading and trailing dots and spaces (Windows disallows trailing dots/spaces)
        input = input.replace(/^[.\s]+|[.\s]+$/g, '');

        if (!input) {
            return DEFAULT_FILENAME;
        }

        // Check for reserved Windows device names
        const baseUpper = input.toUpperCase().split('.')[0];
        if (RESERVED_WINDOWS_NAMES.has(baseUpper)) {
            input = `artifact-${input}`;
        }

        // Enforce maximum length limit on base filename
        if (input.length > MAX_BASE_LENGTH) {
            input = input.slice(0, MAX_BASE_LENGTH).replace(/[.\s]+$/, '');
        }

        if (!input) {
            return DEFAULT_FILENAME;
        }

        return `${input}.md`;
    }

    function deriveFilename(source, fallbackDoc) {
        let candidate = '';

        if (typeof source === 'string' && source.trim()) {
            candidate = source.trim();
        } else if (source && typeof source === 'object') {
            if (typeof source.title === 'string' && source.title.trim()) {
                candidate = source.title.trim();
            } else if (typeof source.name === 'string' && source.name.trim()) {
                candidate = source.name.trim();
            }
        }

        // Fallback to document title if candidate is empty or generic viewer title
        if (!candidate && fallbackDoc && typeof fallbackDoc.title === 'string' && fallbackDoc.title.trim()) {
            const dt = fallbackDoc.title.trim();
            if (dt && dt !== 'Claude' && !/^artifact frame/i.test(dt) && !/^user-generated/i.test(dt) && !/^artifact viewer/i.test(dt)) {
                candidate = dt;
            }
        }

        return sanitizeFilename(candidate);
    }

    function isValidMarkdownContent(markdown) {
        if (typeof markdown !== 'string') return false;
        const len = markdown.length;
        if (len === 0 || len > MAX_MARKDOWN_BYTES) return false;
        if (!markdown.trim()) return false;
        return true;
    }

    function createMarkdownBlob(markdown, customBlobConstructor) {
        if (!isValidMarkdownContent(markdown)) {
            throw new TypeError('Invalid Markdown content: must be a non-empty string within size limits.');
        }

        const BlobClass = customBlobConstructor || (typeof Blob !== 'undefined' ? Blob : null);
        if (!BlobClass) {
            throw new Error('Blob constructor is not available in the current environment.');
        }

        return new BlobClass([markdown], { type: MIME_TYPE });
    }

    function triggerDownload(blob, filename, options = {}) {
        if (!blob || typeof blob !== 'object') {
            throw new TypeError('Invalid Blob provided for download.');
        }

        if (typeof filename !== 'string' || !filename.trim()) {
            throw new TypeError('Invalid filename provided for download.');
        }

        const doc = options.document || (typeof document !== 'undefined' ? document : null);
        if (!doc || typeof doc.createElement !== 'function') {
            throw new Error('Document object is not available.');
        }

        const urlApi = options.URL || (typeof URL !== 'undefined' ? URL : (typeof window !== 'undefined' ? window.URL : null));
        if (!urlApi || typeof urlApi.createObjectURL !== 'function' || typeof urlApi.revokeObjectURL !== 'function') {
            throw new Error('URL.createObjectURL / revokeObjectURL is not available.');
        }

        const safeFilename = sanitizeFilename(filename);
        const objectUrl = urlApi.createObjectURL(blob);
        let anchor = null;
        let attached = false;

        try {
            anchor = doc.createElement('a');
            anchor.href = objectUrl;
            anchor.download = safeFilename;
            anchor.rel = 'noopener noreferrer';
            anchor.style.display = 'none';

            const parentContainer = doc.body || doc.documentElement;
            if (parentContainer && typeof parentContainer.appendChild === 'function') {
                parentContainer.appendChild(anchor);
                attached = true;
            }

            if (typeof anchor.click === 'function') {
                anchor.click();
            } else if (typeof anchor.dispatchEvent === 'function' && typeof options.MouseEvent === 'function') {
                const clickEvt = new options.MouseEvent('click', { bubbles: true, cancelable: true, view: options.window });
                anchor.dispatchEvent(clickEvt);
            } else {
                throw new Error('Anchor click method is not available.');
            }

            return {
                ok: true,
                filename: safeFilename,
                size: typeof blob.size === 'number' ? blob.size : 0
            };
        } finally {
            if (anchor && attached && anchor.parentNode && typeof anchor.parentNode.removeChild === 'function') {
                try {
                    anchor.parentNode.removeChild(anchor);
                } catch (_) {
                    // Ignore removal errors
                }
            }
            if (objectUrl) {
                try {
                    urlApi.revokeObjectURL(objectUrl);
                } catch (_) {
                    // Ignore revocation errors
                }
            }
        }
    }

    function downloadMarkdownArtifact(markdown, options = {}) {
        if (!isValidMarkdownContent(markdown)) {
            return {
                ok: false,
                code: 'INVALID_MARKDOWN',
                error: 'Markdown content is empty or invalid.'
            };
        }

        const targetDoc = options.document || (typeof document !== 'undefined' ? document : null);
        const filename = deriveFilename(options.title || options.metadata, targetDoc);

        try {
            const blob = createMarkdownBlob(markdown, options.Blob);
            const downloadResult = triggerDownload(blob, filename, options);
            return {
                ok: true,
                filename: downloadResult.filename,
                size: downloadResult.size
            };
        } catch (err) {
            return {
                ok: false,
                code: 'DOWNLOAD_FAILED',
                error: err && err.message ? err.message : 'Local download failed.'
            };
        }
    }

    root.AygaArtifactDownload = Object.freeze({
        sanitizeFilename,
        deriveFilename,
        isValidMarkdownContent,
        createMarkdownBlob,
        triggerDownload,
        downloadMarkdownArtifact,
        DEFAULT_FILENAME,
        DEFAULT_BASE_NAME,
        MAX_FILENAME_LENGTH,
        MAX_BASE_LENGTH,
        MAX_MARKDOWN_BYTES,
        MIME_TYPE
    });
})(typeof globalThis !== 'undefined' ? globalThis : this);
