/** Room-code → roomId map (single instance). Swap for Redis when scaling out. */
const codes = new Map<string, string>();
export const registerCode = (code: string, roomId: string) => codes.set(code, roomId);
export const unregisterCode = (code: string) => codes.delete(code);
export const resolveCode = (code: string) => codes.get(code.toUpperCase().trim());
