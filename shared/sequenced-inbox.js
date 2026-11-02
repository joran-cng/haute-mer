// Consommateur idempotent côté client : la livraison est « au moins une fois », donc
// doublons et désordre sont possibles. Chaque seq est livré une seule fois, dans l'ordre.
export class SequencedInbox {
  constructor({ lastSeq = 0, onEvent, onGap, gapTimeoutMs = 1500 }) {
    Object.assign(this, { lastSeq, onEvent, onGap, gapTimeoutMs });
    this.pending = new Map();
    this.timer = null;
    this.duplicates = 0;
    this.reordered = 0;
  }

  push(event) {
    const { seq } = event;
    if (seq <= this.lastSeq || this.pending.has(seq)) {
      this.duplicates++;
      return;
    }
    if (seq !== this.lastSeq + 1) {
      this.reordered++;
      this.pending.set(seq, event);
      this.timer ??= setTimeout(() => {
        this.timer = null;
        if (this.pending.size) this.onGap?.(this.lastSeq);
      }, this.gapTimeoutMs);
      return;
    }
    this.deliver(event);
    while (this.pending.has(this.lastSeq + 1)) {
      const next = this.pending.get(this.lastSeq + 1);
      this.pending.delete(next.seq);
      this.deliver(next);
    }
    if (this.pending.size === 0) this.disarm();
  }

  deliver(event) {
    this.lastSeq = event.seq;
    this.onEvent(event);
  }

  disarm() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  reset(lastSeq) {
    this.lastSeq = lastSeq;
    this.pending.clear();
    this.disarm();
  }
}
