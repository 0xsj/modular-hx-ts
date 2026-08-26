/**
 * Typed ids. **`exports` domain.**
 *
 * Branded locally, because `S7` permits this directory exactly one import.
 */

declare const Brand: unique symbol;

type Branded<T, K extends string> = T & { readonly [Brand]: K };

export type ExportId = Branded<string, 'ExportId'>;

export const exportId = (raw: string): ExportId => raw as ExportId;
