// src/webview/ui/index.tsx
import "./styles.css";
import { render } from "preact";
import { App } from "./App.js";

const root = document.getElementById("root");
if (root) {
  render(<App />, root);
}
