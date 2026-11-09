import { inject } from 'vue';

export const runtimeAdapterKey = Symbol.for('@ineed-linklab/workbench/runtime-adapter');

export function useRuntimeAdapter() {
  const runtimeAdapter = inject(runtimeAdapterKey, null);

  if (runtimeAdapter === null) {
    throw new Error('Ineed LinkLab runtime adapter was not provided');
  }

  return runtimeAdapter;
}

// Optional renderer-owned storage for presentation preferences only.
export const presentationStorageKey = Symbol.for('@ineed-linklab/workbench/presentation-storage');
