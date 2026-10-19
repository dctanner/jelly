/** Shared Unix RFB transport authority; managed and personal lifecycle stays separate. */
export interface VncEndpoint {
  validConnection(generation: number, session: string): boolean;
  attach(close: () => void): () => unknown;
}
