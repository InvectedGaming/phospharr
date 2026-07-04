CREATE TABLE `vod_progress` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`kind` text NOT NULL,
	`ref_id` integer NOT NULL,
	`position_sec` integer DEFAULT 0 NOT NULL,
	`duration_sec` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vod_progress_uq` ON `vod_progress` (`user_id`,`kind`,`ref_id`);--> statement-breakpoint
CREATE INDEX `vod_progress_user_idx` ON `vod_progress` (`user_id`);