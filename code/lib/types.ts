/** The shapes a Code node sees. Kept tiny on purpose: these modules must run inside n8n. */
export type Json = Record<string, unknown>;
export interface Item {
  json: Json;
}
export interface Ctx {
  /** ISO timestamp of the run, injected so tests are deterministic */
  now: string;
  /** items of an earlier node, as `$('Node name').all()` returns them */
  node: (name: string) => Item[];
}
export type CodeMain = (items: Item[], ctx: Ctx) => Item[];
