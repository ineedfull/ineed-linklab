const path = require('node:path');

function appAsarRootFor(moduleDirectory) {
  let current = path.resolve(moduleDirectory);
  while (path.dirname(current) !== current) {
    if (path.basename(current) === 'app.asar') return current;
    current = path.dirname(current);
  }
  return null;
}

function contractRootFor(moduleDirectory, resourcesPath) {
  const appAsarRoot = appAsarRootFor(moduleDirectory);
  if (appAsarRoot === null) {
    return path.resolve(moduleDirectory, '..', '..', '..', 'packages');
  }
  if (typeof resourcesPath !== 'string' || resourcesPath.trim() === '') {
    throw new Error('process.resourcesPath must identify packaged Electron Resources');
  }
  return path.join(path.resolve(resourcesPath), 'contracts');
}

const contractRoot = contractRootFor(__dirname, process.resourcesPath);

function contractAssetPath(...segments) {
  return path.join(contractRoot, ...segments);
}

module.exports = { contractAssetPath, contractRootFor };
