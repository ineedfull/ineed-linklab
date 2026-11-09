import assert from 'node:assert/strict';
import test from 'node:test';

test('the lazy trend chart renders time series, quality markers and zoom controls', async () => {
  let charts;
  await assert.doesNotReject(async () => {
    charts = await import('../src/model/trendChart.js');
  });
  const { SVGRenderer } = await import('echarts/renderers');
  const { use } = await import('echarts/core');
  use([SVGRenderer]);
  const chart = charts.init(null, null, { renderer: 'svg', ssr: true, width: 640, height: 300 });
  try {
    chart.setOption({
      animation: false,
      aria: { enabled: true },
      grid: {},
      legend: { type: 'scroll' },
      tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
      xAxis: { type: 'time' },
      yAxis: { type: 'value' },
      dataZoom: [{ type: 'inside' }, { type: 'slider' }],
      series: [{
        name: 'Temperature', type: 'line', sampling: 'lttb',
        data: [[1700000000000, 21], [1700000001000, 23]],
        markPoint: { data: [{ name: 'Quality', coord: [1700000001000, 23] }] },
      }],
    });
    assert.match(chart.renderToSVGString(), /Temperature/);
    assert.equal(chart.getModel().getSeriesByType('line').length, 1);
    assert.equal(chart.getModel().findComponents({ mainType: 'dataZoom' }).length, 2);
    assert.ok(chart.getModel().getComponent('markPoint'));
    assert.equal(chart.getModel().getSeriesByType('line')[0].get('markPoint.data')[0].name, 'Quality');
  } finally {
    chart.dispose();
  }
});
