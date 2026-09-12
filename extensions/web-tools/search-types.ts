import type { Result } from "./duckduckgo.js";

export type ResponseData = {
	backend: "obscura";
	searchUrl: string;
	bytes: number;
	results: Result[];
	stderr?: string;
};

export type Details = ResponseData & {
	query: string;
	limit: number;
	cached: boolean;
	elapsedMs: number;
};
