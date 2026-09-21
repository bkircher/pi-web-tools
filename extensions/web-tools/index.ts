import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTool as registerFetchTool } from "./fetch/tool.js";
import { registerTool as registerSearchTool } from "./search/tool.js";

/** Installs both web tools. */
export default function webToolsExtension(pi: ExtensionAPI): void {
	registerSearchTool(pi);
	registerFetchTool(pi);
}
