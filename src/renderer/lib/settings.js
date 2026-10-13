// Default settings. Anything stored on disk is merged over these.
export const DEFAULT_SETTINGS = {
  enabled: true,
  mode: 'legs', // 'legs' (mode 1) | 'mocap' (mode 2)
  maxCharacters: 2,
  displayId: '',
  detectionModel: 'full', // lite | full | heavy
  minConfidence: 0.4, // pose landmarker confidence
  personModel: 'lite0', // person detector: lite0 (fast) | lite2 (accurate)
  processing: 'gpu', // pose models on 'gpu' or 'cpu'
  personThreshold: 0.35,
  cutSensitivity: 1,
  alignToScreen: true, // pin model joints onto the on-screen landmarks
  analysisWidth: 640,
  smoothing: 0.5, // 0 = raw, 1 = very smooth
  cameraFov: 50, // vertical FOV in degrees assumed for the game / video camera
  backfaceCulling: false,
  matchLighting: true,
  lightingStrength: 1.0,
  showSkeleton: false,
  gear: { x: 24, y: 24 },
  menuOpen: true,

  // Mode 1 - legs
  baseVrmPath: '',
  matchSkin: true,
  matchProportions: true,
  hideBaseClothing: true,
  showShoes: true,
  cleanupMinLoads: 2,

  // Mode 2 - motion capture
  mocapVrmPath: '',
  mocapTarget: 'largest', // largest | 0..n (track index)
  recordRootMotion: false,
  mocapFollowCharacter: true,
};

export function mergeSettings(stored) {
  const s = { ...DEFAULT_SETTINGS, ...(stored || {}) };
  s.gear = { ...DEFAULT_SETTINGS.gear, ...((stored && stored.gear) || {}) };
  return s;
}
