# Claude Artifact Export Deterministic Rollout Validation & Packaging Report

## 1. Overview and Scope

This document provides rollout validation, automated verification results, packaging hardening details, and manual Chrome browser test matrices for the deterministic Claude Artifact export functionality implemented in issues #1, #2, #3, and #4.

The goal of this rollout is to ensure deterministic, zero-token-leakage export of Claude Artifacts to local Markdown (`.md`) across supported operating systems (Windows and Unix/macOS) and Chromium-based environments.

---

## 2. Automated Test Matrix and Verification

All automated tests are executed via `npm test` / `make test` without external test-runner dependencies, using Node.js built-in test runner (`node:test`).

### 2.1 Automated Test Suites

| Test Suite | Purpose | Status |
| :--- | :--- | :--- |
| `test/artifact-dom-map.test.js` | Validates DOM selectors, shell/frame boundary isolation, token exclusion, and SVG-only vs Mermaid source policy. | **PASSED** |
| `test/artifact-bridge.test.js` | Validates postMessage handshake, secure origin filtering (`claude.ai` / `claudeusercontent.com`), size bounds, and bidirectional frame messaging. | **PASSED** |
| `test/artifact-converter.test.js` | Validates comprehensive DOM-to-Markdown conversion, dynamic code fence sizing, URL scheme sanitization, and recursion bounds. | **PASSED** |
| `test/artifact-download.test.js` | Validates local UTF-8 Markdown blob generation, filename sanitization matrix (Unicode, path traversal, reserved device names), and DOM anchor lifecycle. | **PASSED** |
| `test/package.test.js` | Validates cross-platform zip packaging, fallback detection (`zip` / `7z` / `7zz`), and strict exclusion lists. | **PASSED** |

### 2.2 Automated Execution Results
- **Node Test Runner**: 51 / 51 deterministic tests passed across 11 test suites.
- **Syntax Check (`node --check`)**: All extension and utility JavaScript files validated with 0 syntax errors.
- **Manifest Parse**: `manifest.json` parsed successfully as JSON; Chrome unpacked loading was observed without a reported registration error. This is not a claim of validation against an external schema.
- **Git Diff Hygiene**: `git diff --check` reported 0 trailing whitespace or format issues.

---

## 3. Packaging & Distribution Hardening

The repository packaging process (`make package` / `node utils/package.js`) is hardened for deterministic cross-platform operation.

### 3.1 Cross-Platform Packaging Fallback
- **Primary Tool**: `zip` (standard on Unix/macOS and Linux environments).
- **Secondary Fallbacks**: `7z` or `7zz` (standard on Windows and multi-platform developer workstations).
- **Implementation**: `utils/package.js` inspects `PATH` and executes the first available packaging utility with deterministic archive arguments.

### 3.2 Exclusion Rules
The packaging pipeline explicitly enforces exclusion of non-runtime assets, development directories, and sensitive metadata:
- Git metadata: `.git/`, `.git*`
- Runtime agent/session state: `.pi/`, `.pi*`
- Test fixtures and test suites: `test/`, `test*`
- Internal engineering documentation: `docs/`, `PROJECT_PLAN.md`
- Existing archives: `*.zip`, `extension.zip`
- Local screenshot and temporary dot artifacts: `*.artifact-*.png`, `.DS_Store`
- Dependencies: `node_modules*`

---

## 4. Manual Chrome Browser Validation Matrix

The following matrix documents live end-to-end verification scenarios within Chromium-based browsers.

| Scenario ID | Test Environment / Condition | Description & Target Assertion | Evidence / Validation Status |
| :--- | :--- | :--- | :--- |
| **MAN-01** | Chrome (Manifest V3 Unpacked) | Load unpacked extension in Chrome `chrome://extensions` in developer mode; verify error-free registration of background service worker and content scripts. | **PARTIAL** (Extension is loaded in the operator's Chrome and the Artifact shell control rendered; direct `chrome://extensions` inspection is restricted to the operator). |
| **MAN-02** | Live Artifact UI Injection | Navigate to `https://claude.ai/code/artifact/<uuid>`; verify one export control is injected in the shell and does not cover native Artifact controls. | **PASSED** (Live Artifact shell showed one `Export Artifact` control after extension reload; placement is bottom-right.) |
| **MAN-03** | Artifact Shell & Frame Bridge Handshake | Click "Export Artifact"; verify parent frame sends structured `postMessage` to `iframe#frame-content` and receives a safe result without cross-origin exceptions. | **PARTIAL** (Live shell/frame and SVG-only safe result were observed; a successful live Markdown response has not yet been evidenced.) |
| **MAN-04** | Direct Browser Markdown Download | Verify browser prompts or completes local `.md` file download with derived sanitized filename and UTF-8 encoding. | **MANUAL EVIDENCE PENDING** (The tested live Artifact exposed rendered SVG only, so the safe error path produced no download.) |
| **MAN-05** | Mermaid Diagram Rendering vs Source | Verify Artifacts with Mermaid code blocks export as ` ```mermaid ` fences and SVG-only diagrams report status cleanly without corrupting document output. | **PARTIAL** (Live SVG-only Artifact correctly displayed `Mermaid source is unavailable; rendered SVG was not converted.`; explicit-source live case remains pending.) |
| **MAN-06** | Negative / Chat-Only View Isolation | Navigate to a conversation without an Artifact; verify no Artifact export control is injected. | **AUTOMATED PASSED** (Fixture coverage); live chat-only evidence remains pending. |

> **Note on Manual Evidence Status**: Automated fixture-based tests and bridge emulation provide deterministic representative coverage for the converter, bridge protocol, filename derivation, and anchor download mechanics. They are not a claim of 100% code coverage. Live inspection has confirmed the shell/frame selector, readiness class, approved frame-origin shape, one visible export control, and a clean console at inspection time. Successful live Markdown download and explicit-source Mermaid cases remain unverified. Scenarios marked **MANUAL EVIDENCE PENDING** represent interactive, authenticated end-to-end browser actions on production `claude.ai` endpoints that require operator verification.

---

## 5. Packaging Verification

The rollout package was built and integrity-tested locally with the available `7z` fallback through `make package`. The standard `zip` executable was unavailable in an earlier environment; the packaging script selected `7z` from the supported fallback list.

- `make package`: **PASSED** using the detected `7z` fallback; produced `extension.zip`.
- Archive integrity test: **PASSED** (`7z t extension.zip`).
- Archive contents: runtime extension files and required distribution assets; legacy documentation screenshots under `images/screenshots/` are excluded. `.git`, `.pi`, `test/`, `docs/`, `PROJECT_PLAN.md`, archives, dependencies, and local `.artifact-*.png` artifacts are excluded.
- The package is a distributable build artifact and is intentionally not tracked in Git.

## 6. Security & Isolation Summary

1. **Origin Verification**: Frame bridge strictly validates `https://claude.ai` and the exact approved `https://<id>.frame.claudeusercontent.com` frame-origin boundary.
2. **Artifact Export Network Behavior**: Artifact Markdown export performs no additional extension-generated network request; existing legacy chat/Gist code paths are outside this claim.
3. **Safe Filenames**: Windows reserved words (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`), path separators (`/`, `\`), control characters, and dangerous punctuation are stripped before download trigger.
4. **License Attribution**: Apache License 2.0 attribution and notice headers are preserved across all components.
