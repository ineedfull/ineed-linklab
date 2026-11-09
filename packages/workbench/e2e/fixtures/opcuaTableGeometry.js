import { expect } from '@playwright/test';

// Exercise the browser's actual table layout while live values, quality labels
// and missing/full timestamps change. Component DOM tests cannot measure this.
export async function expectStableOpcuaValueColumns(table) {
  const measured = await table.evaluate(async element => {
    const saved = new Map();
    const replace = (node, text) => { if (!saved.has(node)) saved.set(node, node.textContent); node.textContent = text; };
    const samples = [];
    try {
      for (const full of [false, true, false, true]) {
        for (const row of element.querySelectorAll('tbody tr')) {
          const cells = row.querySelectorAll('td');
          replace(cells[1].querySelector('code'), full ? '4294967295' : '1');
          replace(cells[2], full ? 'Good (0x00000000)' : 'Good');
          for (const time of cells[3].querySelectorAll('time')) replace(time, full ? '2026-10-22 23:59:59.999' : '--');
        }
        await new Promise(resolve => globalThis.requestAnimationFrame(resolve));
        samples.push([...element.querySelectorAll('th')].map(header => {
          const rect = header.getBoundingClientRect(); return { x: rect.x, width: rect.width };
        }));
      }
    } finally { for (const [node, text] of saved) node.textContent = text; }
    return samples;
  });
  for (let column = 0; column < measured[0].length; column++) {
    for (const field of ['x', 'width']) {
      const coordinates = measured.map(sample => sample[column][field]);
      expect(Math.max(...coordinates) - Math.min(...coordinates), `OPC UA column ${column} ${field} moves when live data changes`).toBeLessThan(0.5);
    }
  }
}
