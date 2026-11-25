- Settings → Boards sets the boards-only listener's port, bind address and index and `boards_public_url`; a save is
  validated (dashboard port, IP, URL, a port another process holds), written atomically to only those keys, and applied
  live, with no dashboard or parent restart. A wildcard or public bind asks for confirmation first.
