import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTool as registerFetchTool } from "./fetch/tool.js";
import { registerTool as registerSearchTool } from "./search/tool.js";

export { registerFetchTool, registerSearchTool };

/** Details returned by the `web_search` tool. */
export type { SearchParameters } from "./search/parameters.js";
export type { Details as SearchDetails, Result as SearchResult } from "./search/types.js";

/** Details returned by the `web_fetch` tool. */
export type { FetchParameters } from "./fetch/parameters.js";
export type { Details as FetchDetails, DumpMode, WaitUntil } from "./fetch/types.js";

/** Installs both web tools. */
export default function webToolsExtension(pi: ExtensionAPI): void {
	registerSearchTool(pi);
	registerFetchTool(pi);
}
