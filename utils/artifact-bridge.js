(function attachArtifactBridge(root) {
    'use strict';

    const PROTOCOL_VERSION = 1;
    const CHANNEL = 'ayga-ai-tools.artifact';
    const REQUEST_TYPE = 'EXPORT_ARTIFACT_REQUEST';
    const RESPONSE_TYPE = 'EXPORT_ARTIFACT_RESPONSE';
    const MAX_REQUEST_ID_LENGTH = 128;
    const MAX_MESSAGE_BYTES = 512 * 1024;
    const MAX_RESULT_MESSAGE_LENGTH = 512;
    const MAX_ASSETS_COUNT = 64;
    const MAX_PER_ASSET_BYTES = 256 * 1024;
    const MAX_AGGREGATE_ASSETS_BYTES = 1024 * 1024;

    function getUtf8ByteLength(str) {
        if (typeof str !== 'string') return 0;
        if (typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function') {
            return Buffer.byteLength(str, 'utf8');
        }
        if (typeof TextEncoder !== 'undefined') {
            return new TextEncoder().encode(str).length;
        }
        return encodeURIComponent(str).replace(/%[A-F\d]{2}/g, 'U').length;
    }

    function isPlainObject(value) {
        if (value === null || typeof value !== 'object') return false;
        const prototype = Object.getPrototypeOf(value);
        if (prototype === null || prototype === Object.prototype) return true;
        const constructor = prototype && prototype.constructor;
        return typeof constructor === 'function' && constructor.name === 'Object';
    }

    function isApprovedFrameHostname(hostname) {
        return typeof hostname === 'string' && /\.frame\.claudeusercontent\.com$/i.test(hostname);
    }

    function getSafeFrameOrigin(src) {
        if (typeof src !== 'string' || src.length === 0 || src.length > 4096) return null;

        try {
            const url = new URL(src);
            if (url.protocol !== 'https:' || !isApprovedFrameHostname(url.hostname)) return null;
            return url.origin;
        } catch {
            return null;
        }
    }

    function isValidRequestId(requestId) {
        return typeof requestId === 'string' &&
            requestId.length > 0 &&
            requestId.length <= MAX_REQUEST_ID_LENGTH &&
            /^[A-Za-z0-9._:-]+$/.test(requestId);
    }

    function hasSafeMessageSize(value) {
        try {
            return JSON.stringify(value).length <= MAX_MESSAGE_BYTES;
        } catch {
            return false;
        }
    }

    function makeRequest(requestId) {
        if (!isValidRequestId(requestId)) return null;
        return {
            channel: CHANNEL,
            version: PROTOCOL_VERSION,
            type: REQUEST_TYPE,
            requestId
        };
    }

    function isValidRequest(value) {
        return isPlainObject(value) &&
            Object.keys(value).length === 4 &&
            value.channel === CHANNEL &&
            value.version === PROTOCOL_VERSION &&
            value.type === REQUEST_TYPE &&
            isValidRequestId(value.requestId) &&
            hasSafeMessageSize(value);
    }

    function makeResponse(requestId, result) {
        if (!isValidRequestId(requestId) || !isPlainObject(result)) return null;
        const response = {
            channel: CHANNEL,
            version: PROTOCOL_VERSION,
            type: RESPONSE_TYPE,
            requestId,
            result
        };
        return hasSafeMessageSize(response) ? response : null;
    }

    function isValidAsset(file) {
        if (!isPlainObject(file)) return false;
        const keys = Object.keys(file);
        if (keys.length !== 3) return false;
        if (!('filename' in file && 'content' in file && 'mimeType' in file)) {
            return false;
        }
        if (typeof file.filename !== 'string' || file.filename.length === 0 || file.filename.length > 128) return false;
        if (!file.filename.endsWith('.svg') || !/^[A-Za-z0-9._-]+$/.test(file.filename) || file.filename.includes('..')) return false;
        if (typeof file.content !== 'string' || file.content.length === 0 || getUtf8ByteLength(file.content) > MAX_PER_ASSET_BYTES) return false;
        if (file.mimeType !== 'image/svg+xml') return false;
        return true;
    }

    const ALLOWED_RESULT_KEYS = new Set([
        'ok',
        'code',
        'message',
        'markdown',
        'metadata',
        'warnings',
        'sourceAvailable',
        'mermaidSourceAvailable',
        'assets'
    ]);

    function isValidResult(result) {
        if (!isPlainObject(result)) return false;
        for (const key of Object.keys(result)) {
            if (!ALLOWED_RESULT_KEYS.has(key)) return false;
        }

        if (typeof result.ok !== 'boolean') return false;
        if (result.code !== undefined &&
            (typeof result.code !== 'string' || result.code.length > 64)) return false;
        if (result.message !== undefined &&
            (typeof result.message !== 'string' || result.message.length > MAX_RESULT_MESSAGE_LENGTH)) return false;
        if (result.markdown !== undefined && typeof result.markdown !== 'string') return false;
        if (result.metadata !== undefined && !isPlainObject(result.metadata)) return false;
        if (result.warnings !== undefined && !Array.isArray(result.warnings)) return false;
        if (result.sourceAvailable !== undefined && typeof result.sourceAvailable !== 'boolean') return false;
        if (result.mermaidSourceAvailable !== undefined && typeof result.mermaidSourceAvailable !== 'boolean') return false;

        if (result.assets !== undefined) {
            if (!Array.isArray(result.assets) || result.assets.length > MAX_ASSETS_COUNT) return false;
            let totalBytes = 0;
            const filenames = new Set();
            for (const item of result.assets) {
                if (!isValidAsset(item)) return false;
                if (filenames.has(item.filename)) return false;
                filenames.add(item.filename);
                totalBytes += getUtf8ByteLength(item.content);
                if (totalBytes > MAX_AGGREGATE_ASSETS_BYTES) return false;
            }
        }

        return true;
    }

    function isValidResponse(value, expectedRequestId) {
        return isPlainObject(value) &&
            Object.keys(value).length === 5 &&
            value.channel === CHANNEL &&
            value.version === PROTOCOL_VERSION &&
            value.type === RESPONSE_TYPE &&
            value.requestId === expectedRequestId &&
            isValidRequestId(value.requestId) &&
            isValidResult(value.result) &&
            hasSafeMessageSize(value);
    }

    root.AygaArtifactBridge = Object.freeze({
        CHANNEL,
        PROTOCOL_VERSION,
        REQUEST_TYPE,
        RESPONSE_TYPE,
        MAX_MESSAGE_BYTES,
        MAX_ASSETS_COUNT,
        MAX_PER_ASSET_BYTES,
        MAX_AGGREGATE_ASSETS_BYTES,
        getSafeFrameOrigin,
        isApprovedFrameHostname,
        isValidRequestId,
        isValidAsset,
        getUtf8ByteLength,
        hasSafeMessageSize,
        makeRequest,
        isValidRequest,
        makeResponse,
        isValidResponse
    });
})(globalThis);
