import type { Result } from "./duckduckgo.js";

export type ResponseData = {
	searchUrl: string;
	status: number;
	bytes: number;
	results: Result[];
};

export type Details = ResponseData & {
	query: string;
	limit: number;
	cached: boolean;
	elapsedMs: number;
};
