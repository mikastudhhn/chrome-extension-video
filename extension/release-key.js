// Public half of the Video Sync release signing key (ECDSA P-256 with SHA-256,
// JWK). Only the owner and the protected GitHub environment `release` hold the
// private key. The updater installs nothing whose update asset is not signed
// by this key. Changing this file changes who can publish installable updates;
// it is owner-reviewed (CODEOWNERS) and must never contain private material.
export const RELEASE_PUBLIC_KEY = Object.freeze({
  kty: 'EC',
  crv: 'P-256',
  x: '0xjkXpv7oA4Rc_rWkADJpF3S9evS_Q-14t0h-U31uCQ',
  y: 'g2U1MZOQY1m0pZRzezJnpVhuH5i9R4lHmiimKR9151I'
});
