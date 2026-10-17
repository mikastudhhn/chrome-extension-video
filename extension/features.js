// Experimental behavior follows the package profile fixed at build time
// (build-info.json `channel`). It must be disabled and tested in Stable packages.
const audioDiagnostics = new Set(['experimental', 'local']);
export function featuresFor(profile) {
  return { audioDiagnostics: audioDiagnostics.has(profile) };
}
