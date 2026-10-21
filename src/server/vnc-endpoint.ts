/** Human-only Connected Chrome Unix RFB transport authority. */
export interface VncEndpoint {
  validConnection(generation: number, session: string): boolean;
  attach(close: () => void): () => unknown;
}
