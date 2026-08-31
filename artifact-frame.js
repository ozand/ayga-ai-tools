// artifact-frame.js - Runs inside https://*.frame.claudeusercontent.com frames

(function initArtifactFrame() {
    'use strict';

    const bridge = globalThis.AygaArtifactBridge;
    const converter = globalThis.AygaArtifactConverter;
    if (!bridge || !bridge.isApprovedFrameHostname(location.hostname)) return;
    if (window.top === window) return;

    function sendResult(requestId, result) {
        if (!window.parent) return;
        const response = bridge.makeResponse(requestId, result);
        window.parent.postMessage(response, 'https://claude.ai');
    }

    function findConfirmedArtifactRoot() {
        const confirmedRoot = document.querySelector(
            '.artifact-content, [data-artifact-content], main.artifact-viewer, [data-testid="artifact-content"]'
        );
        if (confirmedRoot) return confirmedRoot;

        // Current Claude Artifact frames may mount the artifact directly in body.
        // Use body only when it has a semantic Artifact signal; never use shell body.
        const frameBody = document.body;
        if (!frameBody) return null;
        const hasSemanticContent = frameBody.querySelector(
            'h1, h2, h3, h4, h5, h6, p, ul, ol, blockquote, table, pre > code, svg[id^="claude-mermaid-"]'
        );
        return hasSemanticContent ? frameBody : null;
    }

    function getSourceResult() {
        const confirmedRoot = findConfirmedArtifactRoot();

        if (!confirmedRoot) {
            return {
                ok: false,
                code: 'NO_EXPORTABLE_SOURCE',
                message: 'No exportable Artifact source was found (confirmed root element missing).',
                markdown: '',
                metadata: {},
                warnings: ['No confirmed artifact container found in frame DOM.'],
                sourceAvailable: false,
                mermaidSourceAvailable: false
            };
        }

        if (converter && typeof converter.convertDomToMarkdown === 'function') {
            const frameTitle = document.title || '';
            const conversion = converter.convertDomToMarkdown(confirmedRoot, { title: frameTitle });

            if (conversion.metadata && conversion.metadata.hasSvgOnlyMermaid) {
                return {
                    ok: false,
                    code: 'MERMAID_SOURCE_UNAVAILABLE',
                    message: 'Mermaid source is unavailable; rendered SVG was not converted.',
                    markdown: '',
                    metadata: conversion.metadata,
                    warnings: conversion.warnings,
                    sourceAvailable: false,
                    mermaidSourceAvailable: false
                };
            }

            if (!conversion.markdown) {
                return {
                    ok: false,
                    code: 'NO_EXPORTABLE_SOURCE',
                    message: 'No exportable Artifact source was found.',
                    markdown: '',
                    metadata: conversion.metadata,
                    warnings: conversion.warnings,
                    sourceAvailable: false,
                    mermaidSourceAvailable: false
                };
            }

            return {
                ok: true,
                code: 'CONVERTED_SUCCESS',
                markdown: conversion.markdown,
                metadata: conversion.metadata,
                warnings: conversion.warnings,
                sourceAvailable: true,
                mermaidSourceAvailable: !conversion.metadata.hasSvgOnlyMermaid
            };
        }

        // Fallback checks if converter is unavailable
        const source = confirmedRoot.querySelector(
            'pre > code.language-mermaid, pre > code.lang-mermaid, pre > code[data-language="mermaid"], pre > code[data-lang="mermaid"]'
        );
        if (source) {
            const text = source.textContent || '';
            return text.trim()
                ? { ok: true, code: 'SOURCE_AVAILABLE', sourceAvailable: true, mermaidSourceAvailable: true }
                : { ok: false, code: 'EMPTY_SOURCE', message: 'Artifact source is empty.', sourceAvailable: false, mermaidSourceAvailable: false };
        }

        const renderedMermaid = confirmedRoot.querySelector('svg#claude-mermaid-0, svg[id^="claude-mermaid-"]');
        if (renderedMermaid) {
            return {
                ok: false,
                code: 'MERMAID_SOURCE_UNAVAILABLE',
                message: 'Mermaid source is unavailable; rendered SVG was not converted.',
                sourceAvailable: false,
                mermaidSourceAvailable: false
            };
        }

        const hasVisibleContent = Boolean(confirmedRoot.querySelector('h1,h2,h3,h4,h5,h6,p,ul,ol,blockquote,table,pre > code'));
        return hasVisibleContent
            ? { ok: true, code: 'CONTENT_AVAILABLE', sourceAvailable: true, mermaidSourceAvailable: false }
            : { ok: false, code: 'NO_EXPORTABLE_SOURCE', message: 'No exportable Artifact source was found.', sourceAvailable: false, mermaidSourceAvailable: false };
    }

    window.addEventListener('message', (event) => {
        if (event.source !== window.parent || event.origin !== 'https://claude.ai') return;
        if (!bridge.isValidRequest(event.data)) return;
        sendResult(event.data.requestId, getSourceResult());
    });
})();
