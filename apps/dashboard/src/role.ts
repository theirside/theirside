import { createContext, useContext } from 'react';

/**
 * Whether the signed-in user is an admin. Members can't manage users, API keys, alert
 * channels, status pages or security settings: the collector refuses (403), and the
 * dashboard hides those pages and buttons.
 */
export const AdminContext = createContext(false);

export const useIsAdmin = () => useContext(AdminContext);
