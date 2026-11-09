import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

// Old lab links now open the existing editor with the particles option selected.
const url = new URL(location.href);
if (url.searchParams.get("workspace") === "vvflow") {
  url.searchParams.set("workspace", "2d");url.searchParams.set("animation", "vortex");
  if (url.searchParams.get("profile") === "mx5-nc") url.searchParams.set("profile", "mx5-nc-prht");
  window.history.replaceState(null, "", url);
}
createRoot(document.getElementById("root")!).render(<App />);
