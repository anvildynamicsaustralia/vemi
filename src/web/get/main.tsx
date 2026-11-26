import "@fontsource-variable/archivo";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "../app.css";
import "./get.css";
import { createRoot } from "react-dom/client";
import { startLight } from "../theme.js";
import { GetFlow } from "./GetFlow.js";

// The setup page stands apart from the app: no account, no sign-in, no service worker and no
// call to the app's own routes. It takes the app's tokens, fonts and icons, and nothing else.
// It starts light; a dark choice stored on this device is the one thing that changes that.
startLight();

const root = document.getElementById("root");
if (root === null) throw new Error("no #root element in get/index.html");

createRoot(root).render(<GetFlow />);
