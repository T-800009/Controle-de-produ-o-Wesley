import React from "react";
import {createRoot} from "react-dom/client";
import Portal from "./app/portal";
import ErrorBoundary from "./app/error-boundary";
import "./app/globals.css";
import "./app/layout.css";
import "./app/dossie.css";
import "./app/polish.css";
createRoot(document.getElementById("root")!).render(<ErrorBoundary><Portal/></ErrorBoundary>);
