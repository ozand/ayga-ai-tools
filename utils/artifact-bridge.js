(function attachArtifactBridge(root) {
    'use strict';

    const PROTOCOL_VERSION = 1;
    const CHANNEL = 'ayga-ai-tools.artifact';
    const REQUEST_TYPE = 'EXPORT_ARTIFACT_REQUEST';
    const RESPONSE_TYPE = 'EXPORT_ARTIFACT_RESPONSE';
    const MAX_REQUEST_ID_LENGTH = 128;
    const MAX_MESSAGE_BYTES = 64 * 1024;
    const MAX_RESULT_MESSAGE_LENGTH = 512;

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

    function isValidResult(result) {
        if (!isPlainObject(result) || Object.keys(result).length > 8) return false;
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
        getSafeFrameOrigin,
        isApprovedFrameHostname,
        isValidRequestId,
        hasSafeMessageSize,
        makeRequest,
        isValidRequest,
        makeResponse,
        isValidResponse
    });
})(globalThis);
