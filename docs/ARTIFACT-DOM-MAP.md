# Claude Artifact DOM and source map

## Evidence scope

This map describes the current Claude Artifact viewer observed at:

```text
https://claude.ai/code/artifact/<artifact-uuid>
```

The observations are limited to the currently displayed artifact and are not a contract for hidden or historical artifacts.

## Shell and frame boundary

The outer shell uses origin `https://claude.ai` and contains the following confirmed structural elements:

- `header#hdr` — viewer header and controls;
- `main` — shell content area;
- `iframe#frame-content[title="User-generated artifact content"]` — embedded artifact document.

The shell's main DOM does not contain the artifact body text. The displayed content is inside the iframe.

The iframe is cross-origin. Its current origin is derived from the current iframe URL and has the observed form:

```text
https://<artifact-uuid>.frame.claudeusercontent.com
```

The iframe `src` contains short-lived access/build parameters. They can be renewed or replaced and must not be persisted or included in exported content.

## Shell-side signals

Use these signals only to locate the current frame:

```js
var frame = document.querySelector(
  'iframe#frame-content[title="User-generated artifact content"]'
);
var frameOrigin = frame ? new URL(frame.src).origin : '';
```

Required checks:

- run shell logic only on `claude.ai`;
- use the top-level document, not an unrelated nested frame;
- require the frame to be connected and, when appropriate, have class `ready`;
- recompute the frame origin whenever the iframe is replaced or its `src` changes;
- bind replies to the exact `frame.contentWindow` selected for the request.

Do not use the old chat selector `.flex.min-w-0.items-center.max-md\\:text-sm` as an Artifact selector. It belongs to a different Claude UI surface and was not confirmed on the Artifact shell.

## Frame-side scope

The frame content script must run only when the current location is an approved Artifact frame host:

```js
/\.frame\.claudeusercontent\.com$/i.test(location.hostname)
```

The exporter should operate on the current frame document only. It should whitelist semantic content elements rather than selecting arbitrary `div` trees:

- `h1`–`h6`;
- `p` and `br`;
- `ul`, `ol`, `li`;
- `blockquote`;
- `a`;
- `table`, `thead`, `tbody`, `tr`, `th`, `td`;
- `pre > code`;
- `img` when a safe source and meaningful alt text are available.

The exact artifact root selector is not stable enough to assert from the shell evidence alone. The implementation should first use a confirmed artifact-content root, then use a narrow semantic fallback, and fail visibly rather than export the entire document including viewer chrome.

Exclude:

- `script`, `style`, `noscript`, `template`;
- controls and navigation;
- Claude frame chrome and extension UI;
- `aria-hidden="true"` service elements;
- unrelated nested frames.

Do not use `innerHTML` or `outerHTML` as Markdown source. Treat all artifact content as untrusted text.

## Code blocks

For `pre > code`:

1. Read `textContent`, preserving indentation and code characters.
2. Detect a language only from an explicit, allowlisted signal such as:
   - `language-<name>` or `lang-<name>` class;
   - `data-language` or `data-lang`;
   - another explicitly verified source-language attribute.
3. Emit a fenced Markdown block.
4. Use an empty language marker when the language is unknown.
5. Choose a fence longer than any backtick run inside the source so the code is not truncated.

Never execute, parse as HTML, or evaluate extracted code.

## Mermaid policy

The observed Artifact frame contains a rendered Mermaid SVG with an identifier of the form `#claude-mermaid-0` and a large renderer/CSS output. This confirms a render result, not the original Mermaid source.

Emit:

````markdown
```mermaid
<source text>
```
````

only if the frame explicitly exposes source text in a verified source representation, for example:

- `pre > code` with a verified `language-mermaid` signal;
- a dedicated, verified source node or attribute containing Mermaid text;
- another source representation confirmed by a fixture and manual browser inspection.

Use `textContent` for the source. Do not infer Mermaid from SVG, SVG text labels, CSS, canvas, or rendered geometry. Do not convert SVG back to Mermaid heuristically.

When only rendered SVG/canvas is available:

- do not emit the SVG as Mermaid source;
- do not rasterize it;
- either omit it or emit a neutral note such as `Mermaid source unavailable` according to the product policy;
- do not include tokenized frame URLs in the note or output.

## Message boundary

The shell and frame communicate with `postMessage`. A request should be sent with the exact current frame origin, never `*`.

The frame accepts a request only when all are true:

- `event.source === window.parent`;
- `event.origin === 'https://claude.ai'`;
- the payload has the expected version/type/request identifier;
- the request is for the current frame/document.

The shell accepts a response only when all are true:

- `event.source === frame.contentWindow` for the selected frame;
- `event.origin === frameOrigin` computed from the current frame URL;
- the response has the expected type, request identifier, result shape, and bounded size.

Reject stale responses after frame replacement, malformed messages, wrong origins, wrong source windows, and duplicate/expired requests. Timeouts must produce an actionable error and must not trigger top-level navigation to the tokenized frame URL.

## Dynamic behavior

The following are useful readiness/change signals:

- shell frame appears or is replaced;
- `iframe#frame-content` gains or loses `ready`;
- iframe `src` changes;
- frame DOM mutations while the artifact is loading.

Use `MutationObserver` or bounded polling. Do not depend on a fixed build identifier, access token, version, or old conversation selector.

## Confirmed unknowns

- A stable artifact-content root selector for every current Claude Artifact type is not established.
- The original Mermaid source is not confirmed to be present when the frame displays only `#claude-mermaid-0` SVG output.
- The public shell/frame protocol does not expose a general arbitrary-DOM export command to bookmarklets.

These unknowns must remain explicit. The extension should fail safely or report source unavailability instead of guessing.
