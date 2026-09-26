export const SHOT_DIR: string;
export function until<T>(
  fn: () => T | Promise<T>,
  what: string,
  timeout?: number,
  every?: number,
): Promise<T>;
