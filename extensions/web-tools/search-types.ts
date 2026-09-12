export type RawResult = {
	title: string;
	href: string;
	snippet?: string;
};

export type Result = {
	title: string;
	url: string;
	snippet?: string;
};

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
