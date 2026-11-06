-- Low-traffic detection: the window an incident was judged over. 5 = the normal window; 15, 30
-- or 60 when the endpoint had too few calls in 5 minutes (alerts say so).
ALTER TABLE incidents ADD COLUMN window_minutes integer NOT NULL DEFAULT 5;
