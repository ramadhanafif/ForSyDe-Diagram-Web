// Types for scenarios.mjs as the Playwright spec uses it.
type Scenario = (page: unknown, ctx: { url: string | undefined; name: string }) => Promise<void>;
export const scenarios: Record<string, Scenario>;
export const TIMEOUTS: Record<string, number>;
