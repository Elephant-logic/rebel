// =============================================================
// ICE CONFIGURATION (STUN + TURN + TURNS)
// =============================================================
// 1. STUN: Finds your IP (WiFi).
// 2. TURN: Relays video over UDP/TCP.
// 3. TURNS: Relays video over TLS 443 (Vital for Mobile 4G/5G).

const ICE_SERVERS = [
  // 1. Fast Google STUN (First check)
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },

  // 2. Standard TURN (OpenRelay Free Tier)
  {
    urls: 'turn:openrelay.metered.ca:80',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },
  {
    urls: 'turn:openrelay.metered.ca:443',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },
  {
    urls: 'turn:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  },

  // 3. SECURE TURNS (The "Mobile Fix")
  // Uses TLS on Port 443 to look like regular HTTPS web traffic.
  // This bypasses strict mobile carrier firewalls.
  {
    urls: 'turns:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }
];
