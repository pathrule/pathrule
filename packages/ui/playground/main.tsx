// SPDX-License-Identifier: Apache-2.0
import "../src/styles.css";
import "./playground.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, ToastProvider, TooltipProvider } from "../src/index.js";
import { Playground } from "./Playground.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider defaultTheme="dark">
      <TooltipProvider>
        <ToastProvider>
          <Playground />
        </ToastProvider>
      </TooltipProvider>
    </ThemeProvider>
  </StrictMode>,
);
