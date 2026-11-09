export async function openWorkspaceTool(page, name) {
  const trigger = page.getByRole('button', { name: '打开工具箱', exact: true });
  await trigger.click();
  await page.getByRole('button', { name: `打开${name}`, exact: true }).click();
  return trigger;
}
