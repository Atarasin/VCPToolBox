/// <reference types="vite/client" />

/** 构建标识（vite define 注入，见 vite.config.ts 的 resolveAppBuildId）。 */
declare const __APP_BUILD__: string;

declare module '*.css'

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<
    Record<string, unknown>,
    Record<string, unknown>,
    unknown
  >
  export default component
}
