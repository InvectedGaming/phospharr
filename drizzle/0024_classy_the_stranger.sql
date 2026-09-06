CREATE TABLE `guide_push_state` (
	`server_id` text NOT NULL,
	`canonical_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`pushed_at` integer NOT NULL,
	PRIMARY KEY(`server_id`, `canonical_id`)
);
