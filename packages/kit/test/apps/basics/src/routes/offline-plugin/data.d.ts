export interface LayoutData {
	layoutSource: string;
	layoutNetwork: string;
}

export interface PageData {
	message: string;
	source: string;
	network: string;
	path: string;
	tracked: string;
	parentSource: string;
	routeId: string | null;
}

export interface StreamingData {
	eager: string;
	streamed: Promise<string>;
	failed: Promise<string>;
}

export interface MatcherData {
	source: string;
	match: string;
	value: string | number;
	valueType: string;
	routeId: string | null;
}

export interface RerouteData {
	source: string;
	routeId: string | null;
	pathname: string;
}
