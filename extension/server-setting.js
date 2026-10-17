import { serverOrigin } from './invitation.js';

// A draft belongs to this popup; room actions only use the last saved origin.
export class ServerSetting {
  constructor(server, persist) {
    this.saved = server;
    this.draft = server;
    this.persist = persist;
    this.saving = false;
    this.error = '';
    this.message = '';
  }
  edit(value) { this.draft = value; this.error = ''; this.message = ''; }
  cancel() { this.draft = this.saved; this.error = ''; this.message = 'Änderung verworfen.'; }
  get dirty() { return this.draft !== this.saved; }
  async save(value = this.draft) {
    if (this.saving) return false;
    this.error = ''; this.message = '';
    let origin;
    try { origin = serverOrigin(value); }
    catch (error) { this.error = error.message; return false; }
    this.saving = true;
    try {
      await this.persist(origin);
      this.saved = origin;
      this.draft = origin;
      this.message = 'Serveradresse gespeichert.';
      return true;
    } catch {
      this.error = 'Serveradresse konnte nicht gespeichert werden. Bitte erneut versuchen.';
      return false;
    } finally { this.saving = false; }
  }
}

export function renderServerSetting(setting, root = document) {
  const $ = id => root.getElementById(id);
  if ($('server').value !== setting.draft) $('server').value = setting.draft;
  $('server').disabled = setting.saving;
  $('server').setAttribute('aria-invalid', String(!!setting.error));
  $('server-save').disabled = setting.saving || !setting.dirty;
  $('server-cancel').disabled = setting.saving || !setting.dirty;
  $('server-save').textContent = setting.saving ? 'Speichern …' : 'Speichern';
  const message = setting.error || setting.message || (setting.dirty ? 'Noch nicht gespeichert. Neue Räume verwenden bis zum Speichern die bisherige Adresse.' : '');
  if ($('server-feedback').textContent !== message) $('server-feedback').textContent = message;
  $('server-feedback').dataset.error = String(!!setting.error);
}
