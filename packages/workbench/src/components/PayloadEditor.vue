<script setup>
import { tags } from '@lezer/highlight';
import { HighlightStyle } from '@codemirror/language';
const payloadHighlightStyle = HighlightStyle.define([
  { tag: tags.propertyName, color: 'var(--payload-key)' },
  { tag: tags.string, color: 'var(--payload-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--payload-value)' },
  { tag: tags.punctuation, color: 'var(--payload-punctuation)' },
]);
import { onMounted, onUnmounted, ref, watch } from 'vue';

const props = defineProps({
  modelValue: { type: String, default: '' },
  mode: { type: String, default: 'text' },
  disabled: Boolean,
  theme: { type: String, default: 'light' },
  largeFont: Boolean,
});
const emit = defineEmits(['update:modelValue', 'submit']);
const editorHost = ref(null);
const loadError = ref(false);
let view;
let codeMirror;
let languageCompartment;
let editableCompartment;
let readOnlyCompartment;
let preferenceCompartment;
let disposed = false;
const caretScrollMeasure = {
  read(editor) {
    const { main } = editor.state.selection;
    if (!main.empty) return false;
    const line = editor.state.doc.lineAt(main.head);
    const start = editor.coordsAtPos(line.from);
    const caret = editor.coordsAtPos(main.head);
    const gutterWidth = editor.dom.querySelector('.cm-gutters')?.getBoundingClientRect().width ?? 0;
    return start && caret && Math.abs(caret.left - start.left) <= editor.scrollDOM.clientWidth - gutterWidth - 10;
  },
  write(fits, editor) {
    // Chromium can leave a short line's first characters behind the sticky
    // gutter after editing a long line. Restore its start only when the active
    // caret still fits, so long-line typing keeps scrolling to the caret.
    if (fits) editor.scrollDOM.scrollLeft = 0;
  },
};

function languageExtensions(mode) {
  if (!codeMirror || mode !== 'json') return [];
  return [
    codeMirror.json(),
    codeMirror.jsonLanguage.data.of({}),
    codeMirror.linter(codeMirror.jsonParseLinter()),
  ];
}

function preferenceExtensions(theme, largeFont) {
  if (!codeMirror) return [];
  const dark = theme === 'dark';
  return codeMirror.EditorView.theme({
    '&': {
      height: '100%',
      color: dark ? '#e1e8f5' : '#233047',
      backgroundColor: dark ? '#182231' : '#f1f4f9',
    },
    '&.cm-focused': { outline: `1px solid ${dark ? '#62a6c7' : '#4f88a8'}`, outlineOffset: '-1px' },
    '.cm-scroller': {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: largeFont ? '16px' : '13px',
    },
    '.cm-content': { caretColor: dark ? '#70b9dc' : '#176f9b', padding: '7px 0' },
    '.cm-gutters': {
      color: dark ? '#afbdd2' : '#536176',
      backgroundColor: dark ? '#22292d' : '#eef2f4',
      borderRight: `1px solid ${dark ? '#465158' : '#d4dce1'}`,
    },
    '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: dark ? '#28343a' : '#eaf2f6' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: dark ? '#31566a' : '#bdd9e8' },
    '.cm-tooltip': {
      color: dark ? '#e1e8f5' : '#233047',
      backgroundColor: dark ? '#22292d' : '#ffffff',
      border: `1px solid ${dark ? '#59666d' : '#b9c5cc'}`,
    },
  }, { dark });
}

onMounted(() => {
  void initializeEditor().catch(() => {
    if (disposed) return;
    if (view) view.destroy();
    view = undefined;
    loadError.value = true;
  });
});

async function initializeEditor() {
  const loaded = await loadCodeMirror();
  if (disposed || !editorHost.value) return;
  codeMirror = loaded;
  const {
    Compartment, EditorState, EditorView, bracketMatching,
    defaultKeymap, drawSelection, foldGutter, foldKeymap, highlightActiveLine,
    highlightActiveLineGutter, highlightSpecialChars, history, historyKeymap,
    indentOnInput, keymap, lineNumbers, lintGutter, searchKeymap,
    syntaxHighlighting,
  } = codeMirror;
  languageCompartment = new Compartment();
  editableCompartment = new Compartment();
  readOnlyCompartment = new Compartment();
  preferenceCompartment = new Compartment();
  view = new EditorView({
    parent: editorHost.value,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        EditorView.contentAttributes.of({ 'aria-label': '发送内容', 'aria-multiline': 'true' }),
        EditorView.domEventHandlers({ keydown(event) {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            emit('submit');
            return true;
          }
          return false;
        } }),
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        syntaxHighlighting(payloadHighlightStyle),
        highlightActiveLine(),
        lintGutter(),
        keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap, ...searchKeymap]),
        languageCompartment.of(languageExtensions(props.mode)),
        editableCompartment.of(EditorView.editable.of(!props.disabled)),
        readOnlyCompartment.of(EditorState.readOnly.of(props.disabled)),
        preferenceCompartment.of(preferenceExtensions(props.theme, props.largeFont)),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) emit('update:modelValue', update.state.doc.toString());
          // Scroll/viewport updates alone must preserve manual browsing.
          if (update.transactions.some(transaction => transaction.scrollIntoView)) {
            update.view.requestMeasure(caretScrollMeasure);
          }
        }),
      ],
    }),
  });
}

watch(() => props.mode, (mode) => {
  if (!view) return;
  if (mode !== 'json') view.dispatch(codeMirror.setDiagnostics(view.state, []));
  view.dispatch({ effects: languageCompartment.reconfigure(languageExtensions(mode)) });
});

watch([() => props.theme, () => props.largeFont], ([theme, largeFont]) => {
  if (view) view.dispatch({
    effects: preferenceCompartment.reconfigure(preferenceExtensions(theme, largeFont)),
  });
});

watch(() => props.disabled, (disabled) => {
  if (!view) return;
  view.dispatch({ effects: [
    editableCompartment.reconfigure(codeMirror.EditorView.editable.of(!disabled)),
    readOnlyCompartment.reconfigure(codeMirror.EditorState.readOnly.of(disabled)),
  ] });
});

watch(() => props.modelValue, (value) => {
  if (!view || value === view.state.doc.toString()) return;
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
});

onUnmounted(() => {
  disposed = true;
  if (view) view.destroy();
  view = undefined;
});

async function loadCodeMirror() {
  const [commands, jsonModule, lint, search, state, language, viewModule] = await Promise.all([
    import('@codemirror/commands'),
    import('@codemirror/lang-json'),
    import('@codemirror/lint'),
    import('@codemirror/search'),
    import('@codemirror/state'),
    import('@codemirror/language'),
    import('@codemirror/view'),
  ]);
  return {
    ...commands,
    ...jsonModule,
    ...lint,
    ...search,
    ...state,
    ...language,
    ...viewModule,
  };
}
</script>

<template>
  <div
    v-if="loadError"
    class="payload-editor payload-editor__error"
    role="status"
  >
    编辑器加载失败
  </div>
  <div
    v-else
    ref="editorHost"
    class="payload-editor"
    :aria-disabled="disabled"
  />
</template>
