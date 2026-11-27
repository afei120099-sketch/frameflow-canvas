/** Library visibility only. Media IDs, bytes and immutable generation history stay intact. */
export type LibraryScope = { pageId: string; pageName?: string; references: ReadonlySet<string> };
let provider: (() => LibraryScope) | undefined;
let ready: Promise<void> = Promise.resolve();
export function configureCanvasLibraryScope(next?: () => LibraryScope, initialization: Promise<void> = Promise.resolve()) {
  provider = next;
  ready = initialization;
}
const emptyReferences = new Set<string>();
// During browser startup do not briefly expose the old global catalogues.
export const currentLibraryScope = (): LibraryScope | undefined => provider?.() ?? (typeof window === 'undefined' ? undefined : { pageId: '', references: emptyReferences });
export const canvasLibraryReady = () => ready;
export function belongsToCanvas(row: { canvasPageIds?: string[]; excludedCanvasPageIds?: string[] }, scope: LibraryScope | undefined, ...references: string[]) {
  return !scope || (!row.excludedCanvasPageIds?.includes(scope.pageId) && (!!row.canvasPageIds?.includes(scope.pageId) || references.some(id => scope.references.has(id))));
}
export function collectLibraryReferences(value: unknown, result = new Set<string>()): Set<string> {
  if (typeof value === 'string' && value.trim()) result.add(value);
  else if (Array.isArray(value)) for (const item of value) collectLibraryReferences(item, result);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) collectLibraryReferences(item, result);
  return result;
}
