/// <reference types="vite/client" />
/// <reference types="retend-web/jsx-runtime" />
import { renderToDOM } from "retend-web";
import { RetendDevTools } from "retend-web-devtools";

import "squire-ui/styles.css";
import "@/styles.css";
import App from "@/App";

const root = window.document.getElementById("root")!;

renderToDOM(root, () => (
  <RetendDevTools>
    <App />
  </RetendDevTools>
));
