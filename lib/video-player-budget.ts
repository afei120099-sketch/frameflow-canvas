/** Selected players outrank background poster decoders; explicitly playing media is never evicted. */
export class VideoPlayerBudget {
  private requests = new Map<object, { priority: number; active: boolean; notify: (active: boolean) => void }>();
  private limit: number;
  constructor(limit = 3) { this.limit = limit; }
  request(key: object, priority: number, notify: (active: boolean) => void) {
    notify(false);
    this.requests.set(key, { priority, active: false, notify }); this.reconcile();
    return () => { const previous=this.requests.get(key); this.requests.delete(key); previous?.notify(false); this.reconcile(); };
  }
  private reconcile() {
    const ranked = [...this.requests].sort((a,b) => b[1].priority-a[1].priority);
    const winners = new Set(ranked.filter(([,r], index) => index < this.limit || r.priority >= 100).map(([key]) => key));
    for (const [key, request] of ranked) {
      const active = winners.has(key);
      if (active !== request.active) { request.active = active; request.notify(active); }
    }
  }
}
