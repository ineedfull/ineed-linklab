import { extractFile, listPackage, statFile, uncache } from '@electron/asar';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Reject mutable test output and invalid file offsets before creating installers.
export function verifyProductionArchive(archivePath) {
  uncache(archivePath);
  let checkedFiles = 0;
  for (const entry of listPackage(archivePath)) {
    const relative = entry.replace(/^[/\\]+/, '').replaceAll('\\', '/');
    assert.ok(
      !/(?:^|\/)(?:test-results|playwright-report)(?:\/|$)/.test(relative)
        && !/^node_modules\/@ineed-linklab\/workbench(?:\/|$)/.test(relative),
      `Development-only entry in Electron archive: ${relative}`,
    );
    const metadata = statFile(archivePath, relative, false);
    if (metadata.files || metadata.link || metadata.size === undefined) continue;
    assert.equal(metadata.integrity?.algorithm, 'SHA256', `Missing integrity: ${relative}`);
    const content = extractFile(archivePath, relative);
    assert.equal(content.length, metadata.size, `Archive size mismatch: ${relative}`);
    assert.equal(
      createHash('sha256').update(content).digest('hex'),
      metadata.integrity.hash,
      `Archive integrity mismatch: ${relative}`,
    );
    checkedFiles += 1;
  }
  assert.ok(checkedFiles > 0, 'Electron archive must contain files');
  return { checkedFiles };
}

export default function afterPack(context) {
  const resources = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources');
  verifyProductionArchive(path.join(resources, 'app.asar'));
}
