import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./forum.css";
import { mountAnalytics } from "./analytics/mount";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

mountAnalytics();
