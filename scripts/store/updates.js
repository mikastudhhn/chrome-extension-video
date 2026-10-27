// Chrome Web Store package: the update view is never shown.
export function mountUpdates() {
  return { async refresh() {}, async install() { return null; } };
}
