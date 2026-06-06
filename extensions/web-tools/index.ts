import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerWebFetchTool } from "./fetch.js";
import { registerWebSearchTool } from "./search.js";

/**
 * Registers the DuckDuckGo-backed `web_search` tool.
 */
export { registerWebSearchTool } from "./search.js";

/**
 * Details returned by the `web_search` tool.
 */
export type { SearchResult, WebSearchDetails } from "./search.js";

/**
 * Registers the Obscura-backed `web_fetch` tool.
 */
export { registerWebFetchTool } from "./fetch.js";

/**
 * Details returned by the `web_fetch` tool.
 */
export type { WebFetchBaseDetails, WebFetchDetails, WebFetchDumpMode, WebFetchWaitUntil } from "./fetch.js";

/**
 * pi extension entry point that installs both web tools.
 */
export default function webToolsExtension(pi: ExtensionAPI): void {
	registerWebSearchTool(pi);
	registerWebFetchTool(pi);
}
