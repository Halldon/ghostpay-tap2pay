import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { UnlinkProvider } from "@unlink-xyz/react";
import App from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <UnlinkProvider chain="monad-testnet" autoSync={true}>
      <App />
    </UnlinkProvider>
  </StrictMode>
);
