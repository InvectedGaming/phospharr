CREATE TABLE `view_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` integer NOT NULL,
	`kind` text DEFAULT 'watch' NOT NULL,
	`source` text DEFAULT 'passthrough' NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer NOT NULL,
	`duration_sec` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `view_events_started_idx` ON `view_events` (`started_at`);--> statement-breakpoint
CREATE INDEX `view_events_channel_idx` ON `view_events` (`channel_id`);