CREATE TABLE `sync_state` (
	`server_id` text PRIMARY KEY NOT NULL,
	`fingerprint` text,
	`refreshed_at` integer,
	`readd_at` integer,
	`last_action` text,
	`last_action_at` integer,
	`last_error` text,
	`pending_readd` text
);
