import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const root = createRoot(document.getElementById("root")!);
if (new URLSearchParams(location.search).get("workspace") === "vvflow") {
  import("./vvflow/Workspace").then(({ VVWorkspace }) => root.render(<VVWorkspace />));
} else root.render(<App />);
