const definitions = [
  {
    runtime: 'electron',
    architecture: 'arm64',
    destinationName: 'Ineed LinkLab-Electron_0.1.0_arm64.dmg',
    relativeSource: ['apps', 'electron', 'release', 'arm64'],
  },
  {
    runtime: 'electron',
    architecture: 'x64',
    destinationName: 'Ineed LinkLab-Electron_0.1.0_x64.dmg',
    relativeSource: ['apps', 'electron', 'release', 'x64'],
  },
  {
    runtime: 'tauri',
    architecture: 'arm64',
    destinationName: 'Ineed LinkLab-Tauri_0.1.0_arm64.dmg',
    relativeSource: [
      'apps',
      'tauri',
      'src-tauri',
      'target',
      'aarch64-apple-darwin',
      'release',
      'bundle',
      'dmg',
    ],
  },
  {
    runtime: 'tauri',
    architecture: 'x64',
    destinationName: 'Ineed LinkLab-Tauri_0.1.0_x64.dmg',
    relativeSource: [
      'apps',
      'tauri',
      'src-tauri',
      'target',
      'x86_64-apple-darwin',
      'release',
      'bundle',
      'dmg',
    ],
  },
];

export const MAC_DMG_MATRIX = Object.freeze(definitions.map((definition) => Object.freeze({
  ...definition,
  relativeSource: Object.freeze([...definition.relativeSource]),
})));

export const MAC_DMG_EXPECTED_NAMES = Object.freeze(
  MAC_DMG_MATRIX.map(({ destinationName }) => destinationName),
);

const OWNED_ARTIFACT_PATTERN = /^(\.ineed-dmg-collection-[A-Za-z0-9-]+-[0-3])-(stage|backup)$/;

export function matrixKey(runtime, architecture) {
  return `${runtime}:${architecture}`;
}

function transactionArtifactName(transactionId, index, kind) {
  if (typeof transactionId !== 'string' || !/^[A-Za-z0-9-]+$/.test(transactionId)) {
    throw new Error('transactionId must contain only letters, digits, and hyphens');
  }
  if (!Number.isInteger(index) || index < 0 || index >= MAC_DMG_MATRIX.length) {
    throw new Error(`matrix index must be between 0 and ${MAC_DMG_MATRIX.length - 1}`);
  }
  return `.ineed-dmg-collection-${transactionId}-${index}-${kind}`;
}

export function collectionStageName(transactionId, index) {
  return transactionArtifactName(transactionId, index, 'stage');
}

export function collectionBackupName(transactionId, index) {
  return transactionArtifactName(transactionId, index, 'backup');
}

export function ownedCollectionArtifactKind(name) {
  if (typeof name !== 'string') {
    return null;
  }
  return OWNED_ARTIFACT_PATTERN.exec(name)?.[2] ?? null;
}
