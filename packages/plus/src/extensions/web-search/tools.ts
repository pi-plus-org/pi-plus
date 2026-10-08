/**
 * TypeBox parameter schemas for the WebSearch / WebFetch tools
 * (shapes adapted from openclaude's WebSearchTool / WebFetchTool).
 */

import { Type } from "typebox";

export const WebSearchParams = Type.Object({
	query: Type.String({ description: "The search query to use" }),
	allowed_domains: Type.Optional(
		Type.Array(Type.String(), { description: "Only include search results from these domains" }),
	),
	blocked_domains: Type.Optional(
		Type.Array(Type.String(), { description: "Never include search results from these domains" }),
	),
});

export const WebFetchParams = Type.Object({
	url: Type.String({ description: "The URL to fetch content from (https by default)" }),
	prompt: Type.Optional(
		Type.String({ description: 'What to look for in the fetched content, e.g. "the install steps"' }),
	),
});
