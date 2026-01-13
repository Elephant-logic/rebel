// ICE / STUN / TURN config
// For serious use, replace TURN with your own credentials.

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: 'turn:relay.metered.ca:80',
    username: 'openai-demo',
    credential: 'openai-demo'
  }
];
