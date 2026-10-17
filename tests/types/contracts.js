// @ts-check
// Compile-only consumers. @ts-expect-error also fails when a contract becomes permissive.
import {
  validMessage,
  validSample,
  validState,
  validEvents,
  transientKey,
  peerRole
} from '../../extension/protocol.js';
import { fault, errorPayload, errorResponse, responseError } from '../../extension/runtime-errors.js';

/** @param {unknown} input */
export function consume(input) {
  if (validSample(input)) {
    input.time.toFixed();
    input.mediaId.toUpperCase();
    // @ts-expect-error A sample time is numeric, never server text.
    input.time.trim();
  }
  if (validState(input)) {
    input.members.host.ready.valueOf();
    // @ts-expect-error Room members use the two protocol roles.
    input.members.observer;
  }
  if (validMessage(input, 'guest')) {
    transientKey(input);
    if (input.type === 'intent' && input.intent.type === 'seek') input.intent.time.toFixed();
    // @ts-expect-error A message must be narrowed before reading its sample.
    input.sample;
  }
  if (validEvents(input, 'host')) input.events.forEach((event) => event.id.toFixed());
  const failure = errorPayload(input);
  const retryable = /** @type {boolean} */ (failure.retryable);
  const response = errorResponse(input);
  const failed = /** @type {false} */ (response.ok);
  return { retryable, failed, recovered: responseError(response).code };
}

/** @type {import('../../extension/protocol.js').Message} */
export const seek = { type: 'intent', epoch: 1, intent: { type: 'seek', time: 10 } };
// @ts-expect-error A seek requires a numeric position.
export const missingTime = /** @satisfies {import('../../extension/protocol.js').Intent} */ ({ type: 'seek' });
// @ts-expect-error A sequenced intent requires a media identity.
export const missingMedia = /** @satisfies {import('../../extension/protocol.js').Intent} */ ({ type: 'play', id: 1 });
// @ts-expect-error Only host and guest are protocol roles.
peerRole('observer');
// @ts-expect-error Misspelled error codes must not silently become ACTION_FAILED in checked callers.
fault('NETWORK_EROR');
export const retryText = /** @satisfies {import('../../extension/runtime-errors.js').ErrorPayload} */ ({
  code: 'TIMEOUT',
  category: 'connection',
  // @ts-expect-error Retry policy is boolean on the wire.
  retryable: 'yes',
  message: 'retry'
});

// Check the production UI consumer of the wire error contract too.
import { describeRoomError } from '../../extension/errors.js';
const roomError = describeRoomError(fault('TIMEOUT'), 'join', 'https://sync.example.test');
export const retry = /** @satisfies {boolean} */ (roomError.retry);
// @ts-expect-error The UI only describes create/join actions.
describeRoomError(null, 'delete', '');
// @ts-expect-error UI retry is a boolean, not a label.
export const retryLabel = /** @satisfies {string} */ (roomError.retry);

import { sealSnapshot, validateJournal, recoveryStatus } from '../../extension/update-recovery.js';
/** @param {FileSystemDirectoryHandle} directory @param {unknown} persisted */
export async function consumeRecovery(directory, persisted) {
  const snapshot = await sealSnapshot(directory, [
    { path: 'manifest.json', encoding: 'utf8', content: '{}', size: 2, sha256: 'digest' }
  ]);
  const journal = await validateJournal(persisted);
  if (journal.kind === 'install') journal.target.digest.toUpperCase();
  else {
    // @ts-expect-error A restore-only journal has no installation target.
    journal.target;
  }
  // @ts-expect-error An install journal requires the sealed target before writing.
  const incomplete = /** @satisfies {import('../../extension/update-recovery.js').Journal} */ ({
    schema: 1,
    id: 'op',
    phase: 'prepared',
    kind: 'install',
    backup: snapshot
  });
  // @ts-expect-error Unknown phases must not reach a checked journal producer.
  const phase = /** @satisfies {import('../../extension/update-recovery.js').JournalPhase} */ ('done');
  // @ts-expect-error Backup content is encoded text or absent, never an arbitrary object.
  await sealSnapshot(directory, [{ path: 'popup.js', content: { script: true } }]);
  const status = await recoveryStatus(async () => persisted);
  const canRestore = /** @satisfies {boolean} */ (status.canRestore);
  return { incomplete, phase, canRestore };
}

// Recovery schema and transport schema are separate; snapshot file entries use
// the encoded byte representation of the update transport.
/** @param {import('../../extension/update-recovery.js').Snapshot} snapshot */
export function consumeSnapshot(snapshot) {
  for (const file of snapshot.files)
    if (file.content !== null) {
      file.size.toFixed();
      file.sha256.toUpperCase();
      const encoding = /** @satisfies {'utf8' | 'base64'} */ (file.encoding);
      if (encoding === 'base64') file.content.toUpperCase();
    }
}
export const iconBytes = /** @satisfies {import('../../extension/update-recovery.js').EncodedFile} */ ({
  path: 'assets/icons/pause-16.png',
  encoding: 'base64',
  content: 'AP8=',
  size: 2,
  sha256: 'digest'
});
// @ts-expect-error Encoded entries require size and hash, not just a base64 label.
export const incompleteBytes = /** @satisfies {import('../../extension/update-recovery.js').EncodedFile} */ ({
  path: 'icon.png',
  encoding: 'base64',
  content: 'AP8='
});
