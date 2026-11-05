import dns from 'node:dns';

// Test servers listen on 127.0.0.1 but tests call http://localhost. On hosts
// where localhost resolves to ::1 first (GitHub's Ubuntu runners), those calls
// would hit a closed IPv6 port and fail with ECONNREFUSED.
dns.setDefaultResultOrder('ipv4first');
