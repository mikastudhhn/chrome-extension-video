import { execFileSync } from 'node:child_process';

export const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
export const candidatePattern = /^v(\d+\.\d+\.\d+)-preview\.(\d+)$/;
