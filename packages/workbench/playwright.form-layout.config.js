import {defineConfig} from '@playwright/test';
import base from './playwright.config.js';
const use={...base.use,actionTimeout:5000}; delete use.channel;
export default defineConfig({...base,use,testMatch:['form-layout.spec.js','expanded-form-layout.spec.js','dialog-sections.spec.js','workspace-tools.spec.js','modbus-simulation.spec.js'],timeout:120000,projects:['electron','tauri'].flatMap(runtime=>['chromium','webkit'].map(browser=>({name:runtime+'-'+browser,metadata:{runtime},use:{browserName:browser,channel:browser==='chromium'?'chromium':undefined}})))});
