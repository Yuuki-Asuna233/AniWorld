/// One episode selection owns this clock, including resolution and presentation.
class PlaybackStartupTrace {
  final Stopwatch _clock = Stopwatch()..start();
  final Map<String, int> phases = {};
  int get elapsedMs => _clock.elapsedMilliseconds;
  void mark(String name) => phases[name] = elapsedMs;
}
