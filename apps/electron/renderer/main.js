import { presentationStorage } from './presentationStorage.js';
import { createWorkbench } from '@ineed-linklab/workbench';
import { createElectronRuntimeAdapter } from './runtimeAdapter.js';
import '@ineed-linklab/workbench/base.css';

createWorkbench(createElectronRuntimeAdapter(window.ineedLinkLab), { presentationStorage }).mount('#app');
