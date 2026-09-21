import { Type, type Static } from "typebox";
import { MAX_RESULTS } from "./duckduckgo.js";

const MAX_QUERY_LENGTH = 500;

export const parameters = Type.Object({
	query: Type.String({
		description: "Search query to send to DuckDuckGo HTML search",
		minLength: 1,
		maxLength: MAX_QUERY_LENGTH,
	}),
	limit: Type.Optional(
		Type.Integer({
			description: `Maximum number of search results to return (1-${MAX_RESULTS}, default 10)`,
			minimum: 1,
			maximum: MAX_RESULTS,
		}),
	),
});

export type SearchParameters = Static<typeof parameters>;
