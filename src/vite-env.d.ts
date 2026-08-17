/// <reference types="vite/client" />

declare const __BA_BUILD_FINGERPRINT__: string;

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<object, object, unknown>;
  export default component;
}
