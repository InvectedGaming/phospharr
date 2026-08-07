CREATE TABLE `downstream_favorites` (
	`server_id` text NOT NULL,
	`user_id` text NOT NULL,
	`channel_id` integer NOT NULL,
	`seen_at` integer NOT NULL,
	PRIMARY KEY(`server_id`, `user_id`, `channel_id`),
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `downstream_favorites_channel_idx` ON `downstream_favorites` (`channel_id`);