type Cb<T = void> = (err: unknown, result?: T) => void;

export class MemorySessionStore {
  private readonly store = new Map<string, unknown>();

  set(sessionId: string, session: unknown, cb: Cb): void {
    this.store.set(sessionId, session);
    cb(null);
  }
  get(sessionId: string, cb: Cb<unknown>): void {
    cb(null, this.store.get(sessionId) ?? null);
  }
  destroy(sessionId: string, cb: Cb): void {
    this.store.delete(sessionId);
    cb(null);
  }
}
