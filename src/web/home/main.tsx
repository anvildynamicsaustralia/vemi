import "@fontsource-variable/archivo";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "../app.css";
import "./home.css";
import { createRoot } from "react-dom/client";
import { startLight } from "../theme.js";
import { FrontHome } from "./FrontHome.js";

// The VEMI home page stands apart from the app, as the setup page does: no account, no service
// worker, no call to a copy. It keeps one thing on this device: the addresses of copies opened from it.
startLight();

const root = document.getElementById("root");
if (root === null) throw new Error("no #root element in home/index.html");

createRoot(root).render(<FrontHome />);
