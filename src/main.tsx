import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter } from "react-router-dom";
import { Buffer } from "./polyfills/buffer";
import "./index.css";
import "./styles/defi.css";
import "./styles/wallet-layout.css";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import { WalletProvider } from "./context/WalletContext";
import { applyNumberDisplayTheme } from "./utils/numberDisplay";
import { warmDockWindow } from "./ledger/shell";
import {
  applyExtensionShellClass,
  isCompactShellPreferred,
  isHelperTab,
  markHelperTab,
} from "./utils/extensionNav";

// HashRouter so extension tabs can open deep links (e.g. index.html#/login-file).
// File pickers must not run inside the action popup — it closes when the OS
// dialog steals focus. After file login we switch this tab to a compact
// popup-sized shell (see switchToLoggedInPopupShell).

if (isHelperTab()) {
  markHelperTab();
}
warmDockWindow();
// Already logged-in compact shell (file-login success) OR real popup OR full helper tab
applyExtensionShellClass(isCompactShellPreferred());

globalThis.Buffer = globalThis.Buffer || Buffer;
applyNumberDisplayTheme();

// The error boundary sits outside everything. Without it a throw during
// render unmounts the whole tree and the document shows only the black
// page background, which in a docked sidebar is a panel the user cannot
// get back into.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <HashRouter>
        <WalletProvider>
          <App />
        </WalletProvider>
      </HashRouter>
    </ErrorBoundary>
  </StrictMode>,
);
