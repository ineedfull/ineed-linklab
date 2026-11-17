import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import FrameList from '../../src/components/FrameList.vue';

describe('stream viewport', () => {
  let resize, wrapper;
  const frames = (start = 0, count = 500) => Array.from({ length: count }, (_, index) => Object.freeze({
    id: `frame-${start + index}`, createdAt: start + index, direction: 'in',
    bytes: Uint8Array.from(new TextEncoder().encode(`payload-${start + index}`)),
  }));
  const settle = async () => { await flushPromises(); await new Promise(resolve => requestAnimationFrame(resolve)); await flushPromises(); };
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function () { return this.classList.contains('frame-list') ? 200 : 0; });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      return { height: this.classList.contains('frame-list__item') ? 40 : 200, width: 900 };
    });
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback) { resize = callback; }
      observe() {} unobserve() {} disconnect() {}
    });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn(async () => {}) } });
  });
  afterEach(() => { wrapper?.unmount(); vi.unstubAllGlobals(); });

  test('keeps the retained messages accessible while mounting only the viewport and overscan', async () => {
    wrapper = mount(FrameList, { props: { frames: frames() } }); await settle();
    expect(wrapper.findAll('.frame-list__item').length).toBeLessThan(30);
    expect(wrapper.findAll('pre').at(-1).text()).toBe('payload-499');
    const list = wrapper.get('.frame-list');
    list.element.scrollTop = 0; await list.trigger('wheel', { deltaY: -1 }); await list.trigger('scroll'); await settle();
    expect(wrapper.findAll('pre')[0].text()).toBe('payload-0');
    expect(wrapper.findAll('.frame-list__item').length).toBeLessThan(30);
  });

  test('preserves the paused reading anchor when older messages leave the retention window', async () => {
    const initial = frames();
    wrapper = mount(FrameList, { props: { frames: initial } }); await settle();
    const list = wrapper.get('.frame-list');
    await list.trigger('wheel', { deltaY: -1 }); list.element.scrollTop = 2005; await list.trigger('scroll'); await settle();
    await wrapper.setProps({ frames: [...initial.slice(20), ...frames(500, 20)] }); await settle();
    expect(list.element.scrollTop).toBe(1205);
    expect(wrapper.text()).toContain('20 条新记录');
    await wrapper.get('.new-records').trigger('click'); await settle();
    expect(wrapper.findAll('pre').at(-1).text()).toBe('payload-519');
  });

  test('viewport actions copy and inspect the selected original payload', async () => {
    wrapper = mount(FrameList, { props: { frames: frames() } }); await settle();
    const last = wrapper.findAll('.frame-list__item').at(-1);
    await last.get('[aria-label="复制消息"]').trigger('click'); await flushPromises();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('payload-499');
    await last.get('.frame-preview').trigger('click');
    expect(wrapper.get('.message-inspector pre').text()).toBe('payload-499');
    await wrapper.setProps({ frames: [] }); await settle();
    expect(wrapper.findAll('.frame-list__item')).toHaveLength(0);
  });

  test('streaming reuses visible DOM slots and updates their payload and actions', async () => {
    wrapper = mount(FrameList, { props: { frames: frames() } }); await settle();
    const elements = wrapper.findAll('.frame-list__item').map(row => row.element);
    for (let start = 1; start <= 20; start++) {
      await wrapper.setProps({ frames: frames(start) }); await settle();
      expect(wrapper.findAll('.frame-list__item').map(row => row.element)).toEqual(elements);
    }
    const last = wrapper.findAll('.frame-list__item').at(-1);
    expect(last.get('pre').text()).toBe('payload-519');
    await last.get('[aria-label="复制消息"]').trigger('click'); await flushPromises();
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith('payload-519');
    await last.get('.frame-preview').trigger('click');
    expect(wrapper.get('.message-inspector pre').text()).toBe('payload-519');
  });

  test('resize and context changes keep the latest messages available', async () => {
    wrapper = mount(FrameList, { props: { frames: frames(), contextKey: 'first' } }); await settle();
    resize(); await settle();
    expect(wrapper.findAll('pre').at(-1).text()).toBe('payload-499');
    await wrapper.setProps({ frames: frames(1000), contextKey: 'second' }); await settle();
    expect(wrapper.findAll('pre').at(-1).text()).toBe('payload-1499');
    expect(wrapper.findAll('.frame-list__item').length).toBeLessThan(30);
  });

  test('resizing measured rows preserves the paused message and its inset', async () => {
    wrapper = mount(FrameList, { props: { frames: frames() } }); await settle();
    const list = wrapper.get('.frame-list');
    await list.trigger('wheel', { deltaY: -1 });
    list.element.scrollTop = 2005; await list.trigger('scroll'); await settle();
    const atTop = rowHeight => {
      const spacer = wrapper.find('.frame-list__spacer');
      const before = spacer.exists() ? Number.parseFloat(spacer.element.style.height) : 0;
      const offset = list.element.scrollTop - before;
      return { payload: wrapper.findAll('.frame-list__item')[Math.floor(offset / rowHeight)].get('pre').text(), inset: offset % rowHeight };
    };
    expect(atTop(40)).toEqual({ payload: 'payload-50', inset: 5 });
    HTMLElement.prototype.getBoundingClientRect.mockImplementation(function () {
      return { height: this.classList.contains('frame-list__item') ? 80 : 200, width: 900 };
    });
    resize(); await settle(); await settle();
    expect(atTop(80)).toEqual({ payload: 'payload-50', inset: 5 });
  });
});
