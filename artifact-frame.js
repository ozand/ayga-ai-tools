(function initArtifactFrame() {
    'use strict';

    const bridge = globalThis.AygaArtifactBridge;
    if (!bridge || !bridge.isApprovedFrameHostname(location.hostname)) return;
    if (window.top === window) return;

    function sendResult(requestId, result) {
        const response = bridge.makeResponse(requestId, result);
        if (!response || !window.parent) return;
        window.parent.postMessage(response, 'https://claude.ai');
    }

    function getSourceResult() {
        const source = document.querySelector(
            'pre > code.language-mermaid, pre > code.lang-mermaid, pre > code[data-language="mermaid"], pre > code[data-lang="mermaid"]'
        );
        if (source) {
            const text = source.textContent || '';
            return text.trim()
                ? { ok: true, code: 'SOURCE_AVAILABLE', sourceAvailable: true, mermaidSourceAvailable: true }
                : { ok: false, code: 'EMPTY_SOURCE', message: 'Artifact source is empty.', sourceAvailable: false, mermaidSourceAvailable: false };
        }

        const renderedMermaid = document.querySelector('svg#claude-mermaid-0, svg[id^="claude-mermaid-"]');
        if (renderedMermaid) {
            return {
                ok: false,
                code: 'MERMAID_SOURCE_UNAVAILABLE',
                message: 'Mermaid source is unavailable; rendered SVG was not converted.',
                sourceAvailable: false,
                mermaidSourceAvailable: false
            };
        }

        const hasVisibleContent = Boolean(document.querySelector('h1,h2,h3,h4,h5,h6,p,ul,ol,blockquote,table,pre > code'));
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
