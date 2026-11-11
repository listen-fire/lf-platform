-- A connection carries the settings its module declares (Slack's
-- `drop_own_messages`), so one connection hears the same way for every
-- automation on it. Every Slack connection that exists is written with the
-- app's own messages and reactions dropped, before the actor gate that stopped
-- them retires; a connection of any other module carries none.


SET search_path = automations, pg_catalog;

ALTER TABLE external_service_credentials
	ADD COLUMN module_settings jsonb DEFAULT '{}'::jsonb NOT NULL;

UPDATE external_service_credentials
SET module_settings = '{"drop_own_messages": "on"}'::jsonb
WHERE type = 'SLACK';
