import { diagnosticCount, forceLinting } from '@codemirror/lint';
import { syntaxTree } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { flushPromises, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { describe, expect, test, vi } from 'vitest';

import PayloadEditor from '../../src/components/PayloadEditor.vue';

describe('PayloadEditor CodeMirror lifecycle', () => {
  test('keeps one EditorView across external document and mode reconfiguration', async () => {
    const wrapper = mount(PayloadEditor, {
      attachTo: document.body,
      props: { modelValue: 'plain', mode: 'text' },
    });
    await editorReady();
    const editorElement = wrapper.get('.cm-editor').element;
    const view = EditorView.findFromDOM(editorElement);

    expect(wrapper.findAll('.cm-editor')).toHaveLength(1);
    expect(view.state.doc.toString()).toBe('plain');
    await wrapper.setProps({ modelValue: '{"value":1}', mode: 'json' });
    await nextTick();

    expect(wrapper.get('.cm-editor').element).toBe(editorElement);
    expect(EditorView.findFromDOM(editorElement)).toBe(view);
    expect(view.state.doc.toString()).toBe('{"value":1}');
    expect(syntaxTree(view.state).type.name).toBe('JsonText');

    wrapper.unmount();
    expect(editorElement.isConnected).toBe(false);
  });

  test('reconfigures dark and large-font preferences without recreating EditorView', async () => {
    const wrapper = mount(PayloadEditor, {
      attachTo: document.body,
      props: { modelValue: 'plain', mode: 'text', theme: 'light', largeFont: false },
    });
    await editorReady();
    const editorElement = wrapper.get('.cm-editor').element;
    const view = EditorView.findFromDOM(editorElement);
    await wrapper.setProps({ theme: 'dark', largeFont: true });
    await nextTick();

    expect(EditorView.findFromDOM(editorElement)).toBe(view);
    expect(getComputedStyle(editorElement).backgroundColor).toBe('rgb(24, 34, 49)');
    expect(getComputedStyle(editorElement.querySelector('.cm-scroller')).fontSize).toBe('16px');
    wrapper.unmount();
  });

  test('clears existing JSON diagnostics in text and HEX and restores linting in JSON', async () => {
    const wrapper = mount(PayloadEditor, {
      attachTo: document.body,
      props: { modelValue: '{ invalid', mode: 'json' },
    });
    try {
      await editorReady();
      const view = EditorView.findFromDOM(wrapper.get('.cm-editor').element);
      for (const mode of ['text', 'hex']) {
        forceLinting(view);
        await vi.waitFor(() => expect(diagnosticCount(view.state)).toBeGreaterThan(0));
        await wrapper.setProps({ mode });
        expect(diagnosticCount(view.state)).toBe(0);
        expect(wrapper.find('.cm-lintRange-error').exists()).toBe(false);
        expect(wrapper.find('.cm-lint-marker-error').exists()).toBe(false);
        await wrapper.setProps({ mode: 'json' });
      }
      forceLinting(view);
      await vi.waitFor(() => expect(diagnosticCount(view.state)).toBeGreaterThan(0));
    } finally {
      wrapper.unmount();
    }
  });

  test('rapid unmount leaves no editor after lazy initialization settles', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const wrapper = mount(PayloadEditor, { attachTo: host });
    expect(host.querySelector('.cm-editor')).toBeNull();
    wrapper.unmount();

    await settleLazyInitialization();
    expect(host.querySelector('.cm-editor')).toBeNull();
    host.remove();
  });
});

async function editorReady() {
  await vi.waitFor(async () => {
    await flushPromises();
    await nextTick();
    expect(document.querySelector('.cm-editor')).not.toBeNull();
  });
}

async function settleLazyInitialization() {
  await flushPromises();
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 20));
}
