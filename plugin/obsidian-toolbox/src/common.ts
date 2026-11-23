export function errorOf(value: unknown): Error & {code?: string} {
    if (value instanceof Error) return value;
    const data = record(value);
    return Object.assign(new Error(typeof data.message === 'string' ? data.message : String(value)),
        typeof data.code === 'string' ? {code:data.code} : {});
}

export function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}


export function array(value: unknown): unknown[] { return Array.isArray(value)?value:[]; }
export function errorText(error: unknown): string { return error instanceof Error?error.message:String(error); }
export function stringValue(value: unknown, fallback=""): string { return typeof value==="string"?value:fallback; }
