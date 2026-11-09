# Existing form layout

Both renderers share `packages/workbench/src/styles/desktop.css`. OPC UA and
STOMP captions use a consistent line box for Latin/Chinese labels. Their
single-line inputs/selects use the existing control-height token, while toolbox
and acceptance selects explicitly use their existing 32px minimum as height.
This avoids WebKit native selects falling back to 20–21px. File inputs,
checkboxes/radios and multiline editors are excluded from fixed sizing.

Run from the repository root:

```sh
npx playwright test -c packages/workbench/playwright.form-layout.config.js
npm run lint
npm run build
```

The isolated browser suite uses both actual renderer entries in Chromium and
WebKit. Each entry/engine runs 24 light/dark × normal/large × expanded/collapsed ×
1440×900/1120×720/920×620 combinations. It inspects all 17 endpoint transports; Modbus
request/group/write dialogs and nested fields; OPC UA client connection and typed
write editor, simulator node fields; STOMP connection/subscription/composer;
nine offline toolbox helpers; acceptance forms and settings. OPC UA read values
come from a local fixture; no external server or physical network is accessed.

Measurements check parent edges, full-width fields, same-row ordinary
control tops/heights within 1px, dialog viewport/footer bounds and horizontal
overflow. Rows are compared within their actual common parent, including unequal
column widths. Conditional receive framing, slave ASCII points, request string /
boolean / float64 points, OPC UA credentials and automatic node changes, and
acceptance range assertions are included. Screenshots and JSON measurements use Playwright's configurable output
directory. Protocol panel screenshots retain internal scroll regions; these
checks concern rendered form geometry, not protocol/native integration.

The native main-window minimum is 1120×720; 920×620 is extra browser stress.
Native Electron/Tauri interaction, production installation and other OSes must
be recorded separately from this shared renderer evidence.

## Focused scroll and focus regression

The additional `focused scroll narrow large form reachability` case exercises
920×620 dark/large forms using real scrolling and focused elements. Run only this
case at both WebKit renderer entries with:

```sh
npx playwright test -c packages/workbench/playwright.form-layout.config.js --project=electron-webkit --project=tauri-webkit --grep 'focused scroll narrow'
```

It records actual scroll offsets, control/scroll-viewport bounds and screenshots.
Modal footer actions are reached with Tab; the normal workbench bottom action is
focused directly without imposing a modal focus trap on the workbench.

## Expanded form and send editor checks (2026-10-31)

Advanced TCP, Modbus and DL/T 645 options mix checkboxes with captioned numeric
inputs. A checkbox centered across the entire field was 11px above the input in
normal mode. Merely aligning its container to the bottom moved it 18–21px below
the input when a validation error appeared. Three mixed option labels now reserve
the same explicit caption line and input height as the numeric field. Other
checkbox rows retain their own size. This is shared by Electron and Tauri.
History filter inputs and selects also use the shared 32px height; their former
29px height put them 1.5px below the 32px search button in normal mode.

`expanded-form-layout.spec.js` additionally checks the separate message/log
history filters in light/dark and normal/large modes at 1440, 1120 and 920px;
mixed checkbox centers before and after numeric validation; and the send editor
at those widths, both sidebar states and both appearance settings. Editor checks
measure line-number/text alignment, usable viewport and footer reachability,
scroll to the cursor, real pointer resizing and keyboard height adjustment.

Behavior checks type rapidly into a 200-line draft, insert newlines and Chinese
text, scroll with the wheel, continue at the document end, edit an 8000-character
line, preserve manual horizontal browsing, navigate between long and short lines,
delete a selection across lines and paste multiple Chinese lines. They
compare the complete emitted UTF-8 bytes with the expected draft and verify the
outer window did not scroll. Chromium uses CDP composition updates (`zhong` →
`中文` → commit); WebKit uses Unicode text insertion. Long lines currently scroll
horizontally inside CodeMirror; this work does not add a wrapping preference.

The browser cases reproduced a Chromium defect after an 8000-character line:
pressing Enter and typing `next` could leave 8–20px of horizontal scroll, hiding
the first character behind the sticky line-number gutter. PayloadEditor now
measures the line start and caret after transactions that request caret scrolling.
It restores the horizontal origin only when the entire prefix to the caret fits
beside the gutter. Long-line typing continues to follow the caret, and manual
scroll/viewport updates do not invoke the correction. The Vue draft and emitted
bytes remain intact.
CDP composition does not exercise a real macOS Tencent WeType session or the
installed Tauri WebView. Those remain separate native reproduction boundaries.
