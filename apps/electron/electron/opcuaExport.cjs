// The renderer supplies bounded content, never a filesystem destination.
function createOpcuaExporter({ dialog, files, getWindow }) {
  return async function exportOpcua(request) {
    if (
      !request ||
      ![
        'opcua-values.csv',
        'opcua-profiles.json',
        'linklab-device-template.json',
        'linklab-acceptance-plan.json',
        'linklab-acceptance-report.json',
        'linklab-acceptance-report.md',
      ].includes(request.fileName) ||
      typeof request.content !== 'string' ||
      Buffer.byteLength(request.content, 'utf8') > 1048576
    ) {
      throw new Error('OPC UA 导出名称或内容无效（最多 1 MiB）');
    }
    if (Object.hasOwn(request, 'path') || Object.hasOwn(request, 'filePath'))
      throw new Error('Renderer export paths are not accepted');
    const window = getWindow();
    if (!window || window.isDestroyed()) throw new Error('主窗口已关闭');
    const result = await dialog.showSaveDialog(window, {
      defaultPath: request.fileName,
      filters: [
        {
          name: request.fileName.endsWith('.csv')
            ? 'CSV'
            : request.fileName.endsWith('.md')
              ? 'Markdown'
              : 'JSON',
          extensions: [request.fileName.split('.').at(-1)],
        },
      ],
    });
    if (result.canceled || !result.filePath) return { saved: false };
    await files.writeFile(result.filePath, request.content, {
      encoding: 'utf8',
      mode: 0o600,
    });
    return { saved: true };
  };
}
module.exports = { createOpcuaExporter };
