import "./console.css";
import { mountConsole } from "./console-view";

const root = document.querySelector<HTMLElement>("#app");
if (root)
  void mountConsole(root, {
    fetch: (...args) => fetch(...args),
    setInterval: (...args) => setInterval(...args),
  });
