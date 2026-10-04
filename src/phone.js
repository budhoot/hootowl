const E164 = /^\+[1-9]\d{6,14}$/;

export function isE164(value) {
  return typeof value === 'string' && E164.test(value);
}

// Twilio's default opt-out / opt-in keywords. Twilio matches the whole message, case-insensitively.
const OPT_OUT_KEYWORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'REVOKE']);
const OPT_IN_KEYWORDS = new Set(['START', 'YES', 'UNSTOP']);

// Returns 'opt_out', 'opt_in' or null.
export function detectKeyword(body) {
  const word = String(body ?? '').trim().toUpperCase();
  if (OPT_OUT_KEYWORDS.has(word)) return 'opt_out';
  if (OPT_IN_KEYWORDS.has(word)) return 'opt_in';
  return null;
}
