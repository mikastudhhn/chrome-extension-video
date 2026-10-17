import { candidatePattern } from './release-refs.js';
import { UPDATE_SCHEMA } from '../extension/package-files.js';

export function validatePromotion(release, bundle, testedCommit) {
  const match = candidatePattern.exec(release?.tag_name || '');
  if (!match || release.draft || !release.prerelease) throw new Error('Select a published Experimental candidate.');
  if (!/^[a-f0-9]{40}$/.test(testedCommit || '') || release.target_commitish !== testedCommit || bundle.commit !== testedCommit) throw new Error('The exact candidate commit must be practically accepted with --tested.');
  if (bundle.schema !== UPDATE_SCHEMA || bundle.channel !== 'stable' || bundle.candidateTag !== release.tag_name) throw new Error('Not the Stable package prepared for this candidate.');
  return `v${match[1]}`;
}
