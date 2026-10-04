const DEFAULT_TEMPLATE =
  "Hi, this is {business_name}. Sorry we missed your call! Reply to this text and we'll get right back to you.";

// Builds the recovery text for a client. Custom templates may use {business_name} and {booking_url}.
export function buildRecoveryMessage({ name, booking_url: bookingUrl, recovery_message: template }) {
  let body = (template?.trim() || DEFAULT_TEMPLATE)
    .replaceAll('{business_name}', name)
    .replaceAll('{booking_url}', bookingUrl ?? '');

  if (bookingUrl && !body.includes(bookingUrl)) {
    body += ` Book online: ${bookingUrl}`;
  }
  if (!/\bSTOP\b/.test(body)) {
    body += ' Reply STOP to opt out.';
  }
  return body.replace(/\s+/g, ' ').trim();
}
