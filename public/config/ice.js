// =============================================================
// ICE CONFIGURATION (STUN + TURN + TURNS)
// =============================================================
// 1. STUN: Finds your IP.
// 2. TURN: Relays video over UDP/TCP (Standard).
// 3. TURNS: Relays video over TLS 443 (The "Mobile Fix").

const ICE_SERVERS = [
  // Fast Google STUN (First check)
  { urls: 'stun:stun.l.google.com:19302' },
  
  // --- OPENRELAY (Free Tier) ---
  // Standard TURN (UDP/TCP)
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

  // *** THE MOBILE FIX (From your screenshot) ***
  // TURNS = Secure TURN over TLS.
  // This looks like HTTPS traffic to mobile carriers.
  {
    urls: 'turns:openrelay.metered.ca:443?transport=tcp',
    username: 'openrelayproject',
    credential: 'openrelayproject'
  }
];
