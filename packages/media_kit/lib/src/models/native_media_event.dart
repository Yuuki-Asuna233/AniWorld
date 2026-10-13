/// Terminal file events and per-file readiness, distinct from diagnostic logs.
enum NativeMediaEventKind { started, loaded, ready, failed, ended }

class NativeMediaEvent {
  const NativeMediaEvent(this.kind, this.generation, {this.errorCode = 0});
  final NativeMediaEventKind kind;
  final int generation;
  final int errorCode;
}
