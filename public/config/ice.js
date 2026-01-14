// =============================================================
// ICE CONFIGURATION (STUN + TURN)
// =============================================================
// STUN: Tells you your public IP (Works for WiFi).
// TURN: Relays traffic when direct connection is blocked (Vital for 4G/5G).

const ICE_SERVERS = [
  // 1. Cheap/Fast STUN (Google) - First attempt
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },

  // 2. TURN Servers (The fix for Mobile/4G/5G)
  // using OpenRelay Project (Free Tier)
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
  }
];

// NOTE: If the stream is laggy or fails on mobile, the free OpenRelay
// might be overloaded. You can get your own private free credentials 
// at https://www.metered.ca/tools/openrelay/ and replace the 
// 'username' and 'credential' fields above.
