bool shouldExitFullscreenForPortrait({
  required bool isFullscreen,
  required bool explicitLandscapeFullscreen,
}) {
  return isFullscreen && !explicitLandscapeFullscreen;
}

bool shouldEnterFullscreenForLandscape({
  required bool isFullscreen,
  required bool suppressAutoEnter,
}) {
  return !isFullscreen && !suppressAutoEnter;
}
