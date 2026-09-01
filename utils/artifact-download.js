// utils/artifact-download.js - Content-script safe Markdown download module for Claude Artifacts

(function attachArtifactDownload(root) {
    'use strict';

    const DEFAULT_FILENAME = 'artifact.md';
    const DEFAULT_BASE_NAME = 'artifact';
    const MAX_FILENAME_LENGTH = 128;
    const MAX_BASE_LENGTH = 120;
    const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
    const MAX_SVG_BYTES = 256 * 1024;
    const MAX_ASSETS_COUNT = 64;
    const MAX_AGGREGATE_ASSETS_BYTES = 1024 * 1024;
    const MIME_TYPE = 'text/markdown;charset=utf-8';
    const SVG_MIME_TYPE = 'image/svg+xml';

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

        let safeFilename;
        if (filename.toLowerCase().endsWith('.svg')) {
            safeFilename = sanitizeSvgFilename(filename);
        } else {
            safeFilename = sanitizeFilename(filename);
        }
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

    function sanitizeSvgFilename(rawInput, defaultFallback = 'diagram.svg') {
        if (typeof rawInput !== 'string') {
            return defaultFallback;
        }

        let input = rawInput.normalize('NFC').trim();
        if (!input) {
            return defaultFallback;
        }

        while (/\.svg$/i.test(input)) {
            input = input.replace(/\.svg$/i, '').trim();
        }

        input = input.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '');
        input = input.replace(/[\\/:*?"<>|]+/g, ' ');
        input = input.replace(/\s+/g, ' ').trim();
        input = input.replace(/^[.\s]+|[.\s]+$/g, '');

        if (!input) {
            return defaultFallback;
        }

        const baseUpper = input.toUpperCase().split('.')[0];
        if (RESERVED_WINDOWS_NAMES.has(baseUpper)) {
            input = `diagram-${input}`;
        }

        if (input.length > MAX_BASE_LENGTH) {
            input = input.slice(0, MAX_BASE_LENGTH).replace(/[.\s]+$/, '');
        }

        if (!input) {
            return defaultFallback;
        }

        return `${input}.svg`;
    }

    function isValidSvgContent(svgContent) {
        if (typeof svgContent !== 'string') return false;
        const len = svgContent.length;
        if (len === 0 || len > MAX_SVG_BYTES) return false;
        if (!svgContent.trim()) return false;
        return true;
    }

    function createSvgBlob(svgContent, customBlobConstructor) {
        if (!isValidSvgContent(svgContent)) {
            throw new TypeError('Invalid SVG content: must be a non-empty string within size limits.');
        }

        const BlobClass = customBlobConstructor || (typeof Blob !== 'undefined' ? Blob : null);
        if (!BlobClass) {
            throw new Error('Blob constructor is not available in the current environment.');
        }

        return new BlobClass([svgContent], { type: SVG_MIME_TYPE });
    }

    function extractReferencedSvgFilenames(markdown) {
        if (typeof markdown !== 'string') return new Set();
        const referenced = new Set();
        const regex = /!\[[^\]]*\]\(([^)]+)\)/g;
        let match;
        while ((match = regex.exec(markdown)) !== null) {
            const rawTarget = match[1].trim().split(/\s+/)[0];
            const cleanTarget = rawTarget.replace(/^['"]|['"]$/g, '');
            if (cleanTarget.toLowerCase().endsWith('.svg') && !/^[a-z]+:/i.test(cleanTarget) && !cleanTarget.startsWith('//')) {
                referenced.add(cleanTarget);
            }
        }
        return referenced;
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

    function downloadSvgCompanion(svgContent, filename, options = {}) {
        if (!isValidSvgContent(svgContent)) {
            return {
                ok: false,
                code: 'INVALID_SVG',
                error: 'SVG content is empty or invalid.'
            };
        }

        const safeFilename = sanitizeSvgFilename(filename);

        try {
            const blob = createSvgBlob(svgContent, options.Blob);
            const downloadResult = triggerDownload(blob, safeFilename, options);
            return {
                ok: true,
                filename: downloadResult.filename,
                size: downloadResult.size
            };
        } catch (err) {
            return {
                ok: false,
                code: 'DOWNLOAD_FAILED',
                error: err && err.message ? err.message : 'Local download of SVG companion failed.'
            };
        }
    }

    function downloadArtifactBundle(payload, options = {}) {
        if (!payload || typeof payload !== 'object') {
            return {
                ok: false,
                code: 'INVALID_PAYLOAD',
                error: 'Invalid payload provided for bundle download.'
            };
        }

        const markdown = payload.markdown;
        if (!isValidMarkdownContent(markdown)) {
            return {
                ok: false,
                code: 'INVALID_MARKDOWN',
                error: 'Markdown content is empty or invalid.'
            };
        }

        const targetDoc = options.document || (typeof document !== 'undefined' ? document : null);
        const mdFilename = deriveFilename(options.title || payload.metadata, targetDoc);

        const assetList = payload.assets || payload.svgFiles || payload.svgArtifacts || [];
        if (!Array.isArray(assetList)) {
            return {
                ok: false,
                code: 'INVALID_ASSETS',
                error: 'Assets must be an array.'
            };
        }

        if (assetList.length > MAX_ASSETS_COUNT) {
            return {
                ok: false,
                code: 'TOO_MANY_ASSETS',
                error: `Asset count ${assetList.length} exceeds maximum ${MAX_ASSETS_COUNT}.`
            };
        }

        // Preflight validation for all assets
        const referencedFilenames = extractReferencedSvgFilenames(markdown);
        const validatedAssets = [];
        const seenFilenames = new Set();
        let totalAssetBytes = 0;

        for (let i = 0; i < assetList.length; i++) {
            const item = assetList[i];
            if (!item || typeof item !== 'object') {
                return {
                    ok: false,
                    code: 'INVALID_ASSET_SHAPE',
                    error: `Asset at index ${i} is not a valid object.`
                };
            }

            const rawName = item.filename;
            if (typeof rawName !== 'string' || !rawName.trim()) {
                return {
                    ok: false,
                    code: 'INVALID_ASSET_FILENAME',
                    error: `Asset at index ${i} has an invalid filename.`
                };
            }

            const safeSvgName = sanitizeSvgFilename(rawName);
            if (seenFilenames.has(safeSvgName)) {
                return {
                    ok: false,
                    code: 'BUNDLE_VALIDATION_FAILED',
                    error: `Duplicate asset filename detected: ${safeSvgName}`
                };
            }
            seenFilenames.add(safeSvgName);

            const content = typeof item.content === 'string' ? item.content : item.svgContent;
            if (!isValidSvgContent(content)) {
                return {
                    ok: false,
                    code: 'BUNDLE_VALIDATION_FAILED',
                    error: `Asset ${safeSvgName} contains invalid SVG content.`
                };
            }

            const mimeType = item.mimeType;
            if (mimeType !== undefined && mimeType !== SVG_MIME_TYPE) {
                return {
                    ok: false,
                    code: 'BUNDLE_VALIDATION_FAILED',
                    error: `Asset ${safeSvgName} has invalid mimeType: ${mimeType}`
                };
            }

            totalAssetBytes += content.length;
            if (totalAssetBytes > MAX_AGGREGATE_ASSETS_BYTES) {
                return {
                    ok: false,
                    code: 'BUNDLE_VALIDATION_FAILED',
                    error: 'Aggregate asset byte limit exceeded.'
                };
            }

            if (!referencedFilenames.has(safeSvgName) && !referencedFilenames.has(rawName)) {
                return {
                    ok: false,
                    code: 'BUNDLE_VALIDATION_FAILED',
                    error: `Asset ${safeSvgName} is not referenced in the Markdown document.`
                };
            }

            validatedAssets.push({
                filename: safeSvgName,
                content
            });
        }

        // Verify every referenced local SVG in Markdown maps to an asset in the bundle
        for (const refName of referencedFilenames) {
            const cleanRef = sanitizeSvgFilename(refName);
            if (!seenFilenames.has(cleanRef) && !seenFilenames.has(refName)) {
                return {
                    ok: false,
                    code: 'BUNDLE_VALIDATION_FAILED',
                    error: `Referenced image ${refName} was not found in assets bundle.`
                };
            }
        }

        // Preflight passed! Now trigger atomic downloads
        const downloadedFiles = [];
        const errors = [];

        try {
            const mdBlob = createMarkdownBlob(markdown, options.Blob);
            const mdResult = triggerDownload(mdBlob, mdFilename, options);
            downloadedFiles.push(mdResult.filename);
        } catch (err) {
            return {
                ok: false,
                code: 'DOWNLOAD_FAILED',
                error: err && err.message ? err.message : 'Failed to download Markdown file.',
                filenames: downloadedFiles,
                errors: [err && err.message ? err.message : 'Markdown download error']
            };
        }

        let svgCount = 0;
        for (const asset of validatedAssets) {
            try {
                const svgBlob = createSvgBlob(asset.content, options.Blob);
                const svgResult = triggerDownload(svgBlob, asset.filename, options);
                downloadedFiles.push(svgResult.filename);
                svgCount++;
            } catch (err) {
                errors.push(`Failed to download ${asset.filename}: ${err && err.message ? err.message : 'Unknown error'}`);
            }
        }

        return {
            ok: errors.length === 0,
            filenames: downloadedFiles,
            markdownFilename: mdFilename,
            svgCount,
            errors
        };
    }

    root.AygaArtifactDownload = Object.freeze({
        sanitizeFilename,
        sanitizeSvgFilename,
        deriveFilename,
        isValidMarkdownContent,
        isValidSvgContent,
        createMarkdownBlob,
        createSvgBlob,
        triggerDownload,
        downloadMarkdownArtifact,
        downloadSvgCompanion,
        downloadArtifactBundle,
        extractReferencedSvgFilenames,
        DEFAULT_FILENAME,
        DEFAULT_BASE_NAME,
        MAX_FILENAME_LENGTH,
        MAX_BASE_LENGTH,
        MAX_MARKDOWN_BYTES,
        MAX_SVG_BYTES,
        MAX_ASSETS_COUNT,
        MAX_AGGREGATE_ASSETS_BYTES,
        MIME_TYPE,
        SVG_MIME_TYPE
    });
})(typeof globalThis !== 'undefined' ? globalThis : this);
