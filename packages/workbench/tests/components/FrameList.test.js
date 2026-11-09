import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import FrameList from '../../src/components/FrameList.vue';
import * as dateTime from '../../src/model/dateTime.js';

describe('FrameList rendering bounds', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => {}) },
    });
  });

  test('mounts only latest 500 rows and bounds large previews', () => {
    const frames = Array.from({ length: 700 }, (_, index) => ({
      id: `frame-${index}`,
      createdAt: 1_700_000_000_000 + index,
      direction: 'in',
      format: 'text',
      bytes: index === 699 ? new Uint8Array(10_000).fill(0x41) : Uint8Array.of(0x41),
    }));

    const wrapper = mount(FrameList, { props: { frames } });
    const rows = wrapper.findAll('.frame-list__item');

    expect(rows).toHaveLength(500);
    expect(rows[0].attributes('data-frame-key')).toContain('frame-200');
    expect(rows.at(-1).get('pre').text().length).toBeLessThan(4_200);
    expect(rows.at(-1).text()).toContain('已截断');
  });

  test('copy formats the complete original frame instead of its preview', async () => {
    const bytes = new Uint8Array(6_000).fill(0x42);
    const wrapper = mount(FrameList, {
      props: { frames: [{ id: 'large', createdAt: 1, direction: 'in', format: 'text', bytes }] },
    });

    expect(wrapper.get('pre').text().length).toBeLessThan(4_200);
    await wrapper.get('[aria-label="复制消息"]').trigger('click');

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('B'.repeat(6_000));
  });

  test('preview, timestamp, and auto-scroll preferences update existing rows', async () => {
    const timestamp = new Date(2024, 6, 3, 17, 46, 40, 123).getTime();
    const frame = {
      id: 'large', createdAt: timestamp, direction: 'in', format: 'text',
      bytes: new Uint8Array(100).fill(0x41),
    };
    const wrapper = mount(FrameList, {
      attachTo: document.body,
      props: { frames: [frame], previewByteLimit: 10, autoScroll: false },
    });
    expect(wrapper.get('pre').text().length).toBeLessThan(100);
    expect(wrapper.get('time').text()).toBe('17:46:40.123');
    expect(wrapper.get('time').attributes('title')).toBe('2024-07-03 17:46:40.123');
    expect(wrapper.get('time').attributes('aria-label')).toBe('2024-07-03 17:46:40.123');
    expect(wrapper.text()).not.toContain('T17:46:40.123');
    const list = wrapper.get('.frame-list').element;
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 500 });
    list.scrollTop = 0;
    await wrapper.setProps({ previewByteLimit: 200, autoScroll: true });
    await flushPromises();
    expect(wrapper.get('pre').text()).toBe('A'.repeat(100));
    expect(list.scrollTop).toBe(500);
    wrapper.unmount();
  });
  test('streaming rows keep peer labels, detail actions and clipboard feedback current', async () => {
    const frame = Object.freeze({ id: 'first', peerId: 'peer', createdAt: 1, direction: 'in', bytes: Uint8Array.of(65) });
    const wrapper = mount(FrameList, { props: { frames: [frame], peers: [{ id: 'peer', remoteAddress: 'old-peer' }] } });
    const element = wrapper.get('.frame-list__item').element;
    await wrapper.setProps({ frames: [frame, Object.freeze({ ...frame, id: 'second', bytes: Uint8Array.of(66) })] });
    expect(wrapper.findAll('.frame-list__item')).toHaveLength(2);
    expect(wrapper.findAll('.frame-list__item')[0].element).toBe(element);
    await wrapper.setProps({ peers: [{ id: 'peer', remoteAddress: 'new-peer' }] });
    expect(wrapper.findAll('.frame-peer').map(row => row.text())).toEqual(['new-peer', 'new-peer']);
    await wrapper.findAll('[aria-label="复制消息"]')[0].trigger('click');
    await flushPromises();
    expect(wrapper.findAll('[aria-label="复制消息"]')[0].find('svg').attributes('class')?.includes('check')).toBe(true);
    navigator.clipboard.writeText.mockRejectedValueOnce(new Error('clipboard denied'));
    await wrapper.findAll('[aria-label="复制消息"]')[1].trigger('click');
    await flushPromises();
    expect(wrapper.findAll('.frame-list__item')[1].text()).toContain('复制失败');
    await wrapper.findAll('.frame-preview')[0].trigger('click');
    expect(wrapper.get('.message-inspector').text()).toContain('new-peer');
    wrapper.unmount();
  });

  test('sliding a full stream renders the new row without reformatting the other 499 rows', async () => {
    const frames = Array.from({ length: 500 }, (_, index) => Object.freeze({
      id: `frame-${index}`, createdAt: index, direction: 'in', bytes: Uint8Array.of(65),
    }));
    const clock = vi.spyOn(dateTime, 'formatClockTime');
    const lifecycle = { mounted: 0, updated: 0, unmounted: 0 };
    const observe = (instance, phase) => {
      if (instance.$options.__name === 'FrameRow') lifecycle[phase]++;
    };
    const wrapper = mount(FrameList, { props: { frames }, global: { mixins: [{
      mounted() { observe(this, 'mounted'); },
      updated() { observe(this, 'updated'); },
      unmounted() { observe(this, 'unmounted'); },
    }] } });
    const retainedElement = wrapper.findAll('.frame-list__item')[1].element;
    clock.mockClear();
    await wrapper.setProps({ frames: [...frames.slice(1), Object.freeze({
      ...frames[0], id: 'new-frame', createdAt: 501,
    })], peers: [] });
    expect(wrapper.findAll('.frame-list__item')).toHaveLength(500);
    expect(wrapper.findAll('.frame-list__item')[0].element).toBe(retainedElement);
    expect(clock).toHaveBeenCalledTimes(1);
    expect(lifecycle).toEqual({ mounted: 501, updated: 0, unmounted: 1 });
    wrapper.unmount();
    clock.mockRestore();
  });

});
