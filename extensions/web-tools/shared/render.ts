import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";

export type RenderContext = { isError: boolean };
export type RenderTheme = Pick<Theme, "fg" | "bold">;

export function getResultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}
