/// <reference types="vite/client" />

import type { DesktopApi } from "./desktop";

declare global {
  interface Window {
    bigAgentDesktop?: DesktopApi;
  }
}
