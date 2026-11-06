-- Collector 0.2.2 added routes with a doubled slash (`/_ah/api//x/v1/y`) for SDK 0.1.0, which kept
-- the empty segment of `//`. SDK 0.1.1 and later collapse repeated slashes (so such a route equals
-- its single-slash form) and ingest collapses what older SDKs send: the routes are dead weight.
UPDATE providers
   SET explicit_routes = ARRAY(SELECT r FROM unnest(explicit_routes) AS r WHERE r NOT LIKE '%//%'),
       updated_at = now()
 WHERE EXISTS (SELECT 1 FROM unnest(explicit_routes) AS r WHERE r LIKE '%//%');
