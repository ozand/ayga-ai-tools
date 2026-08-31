(function initArtifactShell() {
    'use strict';

    const bridge = globalThis.AygaArtifactBridge;
    if (!bridge || location.origin !== 'https://claude.ai' || window.top !== window) return;
    if (!location.pathname.startsWith('/code/artifact/')) return;

    const REQUEST_TIMEOUT_MS = 5000;
    let requestSequence = 0;
    let activeRequest = null;

    function findArtifactFrame() {
        return document.querySelector(
            'iframe#frame-content[title="User-generated artifact content"]'
        );
    }

    function getCurrentFrame() {
        const frame = findArtifactFrame();
        if (!frame || !frame.isConnected || !frame.classList.contains('ready')) return null;
        const origin = bridge.getSafeFrameOrigin(frame.src);
        if (!origin || !frame.contentWindow) return null;
        return { frame, origin, source: frame.contentWindow };
    }

    function nextRequestId() {
        requestSequence += 1;
        return `artifact-${Date.now().toString(36)}-${requestSequence}`;
    }

    function requestArtifactExport() {
        const current = getCurrentFrame();
        if (!current) return Promise.reject(new Error('Claude Artifact frame is not ready.'));

        if (activeRequest) activeRequest.cancel();
        const request = bridge.makeRequest(nextRequestId());
        let timer;
        let settled = false;
        const onMessage = (event) => {
            if (settled || event.source !== current.source || event.origin !== current.origin) return;
            if (!bridge.isValidResponse(event.data, request.requestId)) return;
            settled = true;
            clearTimeout(timer);
            window.removeEventListener('message', onMessage);
            activeRequest = null;
            resolve(event.data.result);
        };
        let resolve;
        let reject;
        const promise = new Promise((resolvePromise, rejectPromise) => {
            resolve = resolvePromise;
            reject = rejectPromise;
        });
        const cancel = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            window.removeEventListener('message', onMessage);
            reject(new Error('Artifact export request was superseded.'));
        };
        activeRequest = { cancel };
        window.addEventListener('message', onMessage);
        timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            window.removeEventListener('message', onMessage);
            activeRequest = null;
            reject(new Error('Claude Artifact export timed out.'));
        }, REQUEST_TIMEOUT_MS);
        try {
            current.source.postMessage(request, current.origin);
        } catch (error) {
            settled = true;
            clearTimeout(timer);
            window.removeEventListener('message', onMessage);
            activeRequest = null;
            reject(new Error('Claude Artifact frame could not receive the export request.'));
        }
        return promise;
    }

    function showStatus(message, isError) {
        let status = document.querySelector('[data-ayga-artifact-status]');
        if (!status) {
            status = document.createElement('div');
            status.dataset.aygaArtifactStatus = 'true';
            status.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:8px 12px;border-radius:6px;background:#202123;color:#fff;font:13px sans-serif;box-shadow:0 2px 8px #0004;';
            document.body.appendChild(status);
        }
        status.textContent = message;
        status.style.background = isError ? '#9b1c1c' : '#202123';
    }

    function addExportControl() {
        if (!document.body || document.querySelector('[data-ayga-artifact-export]')) return;
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.aygaArtifactExport = 'true';
        button.textContent = 'Export Artifact';
        button.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:8px 12px;border:1px solid #777;border-radius:6px;background:#fff;color:#111;font:13px sans-serif;cursor:pointer;';
        button.addEventListener('click', async () => {
            button.disabled = true;
            try {
                const result = await requestArtifactExport();
                showStatus(result.ok ? 'Artifact source detected.' : result.message || result.code, !result.ok);
            } catch (error) {
                showStatus(error.message, true);
            } finally {
                button.disabled = false;
            }
        });
        document.body.appendChild(button);
    }

    const observer = new MutationObserver(addExportControl);
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'src'] });
    addExportControl();
})();
