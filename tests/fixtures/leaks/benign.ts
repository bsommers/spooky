// False-positive corpus for the confidentiality filter: ordinary text that must come back byte for byte, plus an
// explicit allow-list of KNOWN over-redactions with their exact output. The allow-list is asserted exactly, so a rule
// that gets broader (or narrower) fails the test and has to be acknowledged here.

/** Text that contains no secret and must not change at all. */
export const MUST_NOT_CHANGE: readonly string[] = [
  'The keyboard: us layout is fine, the key to success is practice.',
  'Meeting at 10:30:45, ratio 3:1, see mailto:bob@example.com or ssh://git@github.com/org/repo.',
  'Hello… the product™ costs ½ of the old one; the ﬁrst ﬁle is in Ｔｏｋｙｏ.',
  'Love it ❤️ and the family 👨‍👩‍👧 agree.',
  'سلام‌دنیا و دوستان',
  'Passage: Genesis 1:1. Bearer of bad news. You shall not pass.',
  'The token_bucket: 5000 rps; tokenize the text: now.',
  'Authorization: required for admin; my secret is out there; the secret: be kind.',
  'Images live at https://example.com/path@2x.png and https://mastodon.social/@bill',
  'sk-short AKIA hf_ npm_modules glpat- are just strings',
  'max_tokens are 1000 and passport: valid',
  'Résumé of Zoë: naïve café — “quoted” text with an ellipsis…',
];

/** Known over-redactions (accepted fail-safe trade-offs, see 02-REVIEW CR-09): input -> exact output. */
export const KNOWN_OVER_REDACTIONS: readonly (readonly [string, string])[] = [
  ['secretary: Johnson', 'secretary: [REDACTED:secret_assignment]'],
  ['max_token: 1000', 'max_token: [REDACTED:secret_assignment]'],
  ['password_policy: strict', 'password_policy: [REDACTED:secret_assignment]'],
  ['secrets_manager: vault', 'secrets_manager: [REDACTED:secret_assignment]'],
  ['credential: none', 'credential: [REDACTED:secret_assignment]'],
  ['password is required', 'password is [REDACTED:secret_assignment]'],
  ['Password:\nName: Bob', 'Password:\n[REDACTED:secret_assignment] Bob'],
  ['http://localhost:3000/@user', 'http://[REDACTED:url_credential]@user'],
];
