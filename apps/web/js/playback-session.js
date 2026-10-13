// A selection owns network work; each media attempt owns its listeners/timers.
// Disposing either prevents an old completion from changing the current player.
(function () {
  class PlaybackScope {
    constructor(identity, owns) {
      this.identity = Object.freeze({ ...identity });
      this.owns = owns;
      this.cleanups = new Set();
      this.closed = false;
    }
    active() { return !this.closed && this.owns(); }
    add(cleanup) { this.cleanups.add(cleanup); return cleanup; }
    listen(target, name, callback) {
      const listener = event => { if (this.active()) callback(event); };
      target.addEventListener(name, listener);
      return this.add(() => target.removeEventListener(name, listener));
    }
    timer(callback, delay) {
      const cleanup = () => clearTimeout(id);
      const id = setTimeout(() => {
        this.cleanups.delete(cleanup);
        if (this.active()) callback();
      }, delay);
      this.add(cleanup);
      return cleanup;
    }
    interval(callback, delay) {
      const id = setInterval(() => { if (this.active()) callback(); }, delay);
      return this.add(() => clearInterval(id));
    }
    dispose() {
      if (this.closed) return;
      this.closed = true;
      for (const cleanup of this.cleanups) {
        try { cleanup(); } catch (error) { console.warn('播放资源释放失败', error); }
      }
      this.cleanups.clear();
    }
  }
  const sessions = {
    current: null,
    playing: null,
    begin(identity) {
      this.current?.dispose();
      this.playing = null;
      const scope = new PlaybackScope(identity, () => this.current === scope);
      scope.add(() => scope.media?.dispose());
      scope.refreshed = false;
      this.current = scope;
      return scope;
    },
    media(session) {
      session.media?.dispose();
      this.playing = null;
      const scope = new PlaybackScope(session.identity, () => session.active() && session.media === scope);
      session.media = scope;
      return scope;
    },
    dispose() { this.current?.dispose(); this.current = null; this.playing = null; }
  };
  window.PlaybackSessions = sessions;
})();
