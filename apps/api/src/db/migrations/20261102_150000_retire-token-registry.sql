-- listen-fire 0.13: the loop breaker (the write ledger and its loop window)
-- replaced the echo drop that read these tokens, so nothing reads them.

SET search_path = automations, pg_catalog;

DROP TABLE platform_owned_token;
