/// Format hint confirmed while resolving a video source.
///
/// [auto] keeps the player's normal probing behavior. [hls] tells the native
/// player to use FFmpeg's HLS demuxer explicitly, which is required by some
/// playlists whose media segments use non-video extensions.
enum VideoSourceFormat {
  auto,
  hls,
}
