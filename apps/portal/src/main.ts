import "./style.css";
import { createApi, startLogin } from "./api";
import { mountApp } from "./app";

const root = document.querySelector<HTMLElement>("#app");
if (root) {
  const call: typeof fetch = (...args) => fetch(...args);
  mountApp(root, {
    api: createApi(call),
    startLogin: () => startLogin(call, (path) => window.location.assign(path)),
  });
}
