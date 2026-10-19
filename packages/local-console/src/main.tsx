// SPDX-License-Identifier: Apache-2.0
import "./nonce.js";
import "@pathrule/ui/styles.css";
import "./console.css";
import { I18nProvider, ThemeProvider, ToastProvider, TooltipProvider } from "@pathrule/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App.js";
import { pickLocale } from "./messages.js";

const root = document.getElementById("root");
if (!root) throw new Error("The Local Console needs a #root element.");

createRoot(root).render(
  <StrictMode>
    <I18nProvider
      locale={pickLocale(navigator.languages ?? [])}
      onMissing={
        import.meta.env.DEV
          ? (namespace, key) => console.warn(`Missing ${namespace} string: ${key}`)
          : undefined
      }
    >
      <ThemeProvider>
        <TooltipProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </TooltipProvider>
      </ThemeProvider>
    </I18nProvider>
  </StrictMode>,
);
