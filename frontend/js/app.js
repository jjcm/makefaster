/**
 * Entry point for the Makefaster SPA.
 *
 * No build step, no framework: plain ES modules and custom elements, one
 * component per file. Importing app-root.js pulls in the page components,
 * which pull in the shared pieces (<site-header>, <geo-row>, <spec-footer>).
 */
import "./app-root.js";
import { interceptLinks } from "./router.js";
import { installTextureCycle } from "./textures.js";

installTextureCycle();
interceptLinks();
