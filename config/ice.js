// ICE / STUN / TURN config for WAN
// For serious use, replace TURN config with your own account.
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  // Demo TURN (best-effort only; replace with your own for production):
  {
    urls: 'turn:relay.metered.ca:80',
    username: 'openai-demo',
    credential: 'openai-demo'
  }
];
