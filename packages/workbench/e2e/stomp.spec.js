import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const fixture = fileURLToPath(new URL('./fixtures/previewBridge.js', import.meta.url));
async function addEndpoint(page, transport, name) {
  await page.getByRole('button', { name: '添加端点', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('传输类型').selectOption(transport);
  await dialog.locator('[name="endpoint-name"]').fill(name);
  await dialog.getByRole('button', { name: '保存端点' }).click();
  await expect(dialog).toBeHidden();
}
for (const runtime of ['electron', 'tauri']) {
  test(`${runtime} STOMP endpoints preserve independent drafts and fit display matrix`, async ({ page }, testInfo) => {
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript({ path: fixture });
    await page.goto(`http://127.0.0.1:${runtime === 'electron' ? 4173 : 4174}/`);
    const longName = 'STOMP' + 'A'.repeat(59);
    await addEndpoint(page, 'stomp-client', longName);
    await addEndpoint(page, 'stomp-server', 'STOMP 服务端验证');
    let panel = page.getByRole('region', { name: 'STOMP 工作台' }).filter({ visible: true });
    await expect(panel.getByRole('heading', { name: 'STOMP', exact: true })).toBeVisible();
    await expect(panel.getByLabel('连接角色')).toHaveCount(0);
    await expect(panel.getByLabel('已保存配置')).toHaveCount(0);
    await panel.getByLabel('要求账号密码').check();
    await panel.getByLabel('登录名', { exact: true }).fill('temporary-user');
    await panel.getByLabel('口令', { exact: true }).fill('temporary-passcode');
    await panel.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(panel.getByRole('status')).toContainText('已保存');
    await page.getByRole('button', { name: `选择 ${longName}`, exact: true }).click();
    await expect(panel.getByLabel('口令', { exact: true })).toHaveValue('');
    const longDestination = '/topic/' + '设备状态与联调消息'.repeat(30);
    const longBody = '<script>仅作为消息文本</script>\n' + '多语言正文与长内容验证。'.repeat(100);
    for (const mode of ['client', 'server']) {
      const name = mode === 'client' ? longName : 'STOMP 服务端验证';
      const shell = page.locator('.linklab-shell');
      if ((await shell.getAttribute('class')).includes('tree-collapsed')) await page.getByRole('button', { name: '展开端点列表' }).click();
      await page.getByRole('button', { name: `选择 ${name}`, exact: true }).click();
      panel = page.getByRole('region', { name: 'STOMP 工作台' }).filter({ visible: true });
      if (mode === 'server') await expect(panel.getByLabel('口令', { exact: true })).toHaveValue('temporary-passcode');
      await panel.getByRole('button', { name: '消息与订阅', exact: true }).click();
      await panel.getByLabel('发送目的地', { exact: true }).fill(longDestination);
      await panel.getByLabel('消息内容', { exact: true }).fill(longBody);
      for (const dark of [false, true]) for (const large of [false, true]) for (const collapsed of [false, true]) {
        await page.evaluate(({ dark, large }) => { globalThis.document.documentElement.dataset.theme = dark ? 'dark' : 'light'; globalThis.document.documentElement.classList.toggle('large-font', large); }, { dark, large });
        const current = (await shell.getAttribute('class')).includes('tree-collapsed');
        if (current !== collapsed) await page.getByRole('button', { name: collapsed ? '折叠端点列表' : '展开端点列表' }).click();
        for (const tab of ['连接与认证', '消息与订阅']) {
          await panel.getByRole('button', { name: tab, exact: true }).click();
          expect(await page.evaluate(() => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth)).toBe(true);
          expect(await panel.locator('.stomp-header').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
          expect(await panel.locator('.stomp-body').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
          if (tab === '消息与订阅') {
            await expect(panel.getByLabel('消息内容', { exact: true })).toHaveValue(longBody);
            if (mode === 'client') {
              const destination = await panel.getByLabel('订阅目的地', { exact: true }).boundingBox();
              const acknowledgment = await panel.locator('[name="stomp-sub-ack"]').boundingBox();
              expect(Math.abs(destination.height - acknowledgment.height)).toBeLessThanOrEqual(1);
              if (Math.abs(destination.x - acknowledgment.x) > 1) {
                expect(Math.abs(destination.y - acknowledgment.y)).toBeLessThanOrEqual(1);
              }
            }
          }
          await expect(panel.getByRole('button', { name: mode === 'client' ? '连接' : '启动服务', exact: true })).toBeInViewport();
          if (dark && large && collapsed && mode === 'server' && tab === '消息与订阅') await page.screenshot({ path: testInfo.outputPath(`${runtime}-stomp-dark-large.png`) });
        }
      }
    }
    expect(errors).toEqual([]);
  });
}
