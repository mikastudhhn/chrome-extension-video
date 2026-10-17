const video = document.getElementById('video');
let offset = 0;
let objectUrl = null;
for (const version of ['a', 'b']) {
  document.getElementById(`version-${version}`).addEventListener('click', () => {
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
    offset = version === 'b' ? 5 : 0;
    video.src = `scene-${version}.webm`;
    document.getElementById('version').textContent = `Version ${version.toUpperCase()} · ${offset ? '5 Sekunden Vorspann' : 'ohne Vorspann'}`;
    for (const candidate of ['a', 'b']) document.getElementById(`version-${candidate}`).classList.toggle('selected', candidate === version);
  });
}
document.getElementById('file').addEventListener('change', event => {
  const file = event.target.files[0];
  if (!file) return;
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(file);
  video.src = objectUrl;
  offset = 0;
  document.getElementById('version').textContent = file.name;
  for (const candidate of ['a', 'b']) document.getElementById(`version-${candidate}`).classList.remove('selected');
});
video.addEventListener('timeupdate', () => {
  const scene = video.currentTime - offset;
  document.getElementById('scene').textContent = scene < 0 ? 'Vorspann' : `Szenenzeit ${scene.toFixed(1)} s`;
});
video.addEventListener('error', () => { document.getElementById('scene').textContent = 'Video fehlt oder kann nicht geladen werden.'; });
