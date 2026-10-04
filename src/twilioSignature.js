import twilio from 'twilio';

// Rejects any request that was not signed by Twilio with our Auth Token.
// Twilio signs the exact public URL it called, so we rebuild it from PUBLIC_BASE_URL
// (the API usually sits behind a proxy that changes the host and protocol).
export function verifyTwilioSignature({ authToken, publicBaseUrl }) {
  return (req, res, next) => {
    const signature = req.get('X-Twilio-Signature');
    const url = publicBaseUrl + req.originalUrl;
    if (!signature || !twilio.validateRequest(authToken, signature, url, req.body ?? {})) {
      return res.status(403).type('text/plain').send('Invalid Twilio signature');
    }
    next();
  };
}
