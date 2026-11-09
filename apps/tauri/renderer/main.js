import { presentationStorage } from './presentationStorage.js';
import { createWorkbench } from '@ineed-linklab/workbench';
import '@ineed-linklab/workbench/base.css';

import { createTauriRuntimeAdapter } from './runtimeAdapter.js';

createWorkbench(createTauriRuntimeAdapter(), { presentationStorage }).mount('#app');
