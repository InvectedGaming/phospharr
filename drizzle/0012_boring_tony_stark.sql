CREATE TABLE `dvr_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title_match` text NOT NULL,
	`canonical_id` text,
	`enabled` integer DEFAULT true NOT NULL,
	`pad_start_sec` integer DEFAULT 30 NOT NULL,
	`pad_end_sec` integer DEFAULT 120 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `recordings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` integer NOT NULL,
	`canonical_id` text,
	`title` text NOT NULL,
	`subtitle` text,
	`description` text,
	`start_time` integer NOT NULL,
	`end_time` integer NOT NULL,
	`pad_start_sec` integer DEFAULT 30 NOT NULL,
	`pad_end_sec` integer DEFAULT 120 NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`file_path` text,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`rule_id` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `recordings_status_idx` ON `recordings` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `recordings_slot_uq` ON `recordings` (`channel_id`,`start_time`);--> statement-breakpoint
CREATE TABLE `reminders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`channel_id` integer NOT NULL,
	`title` text NOT NULL,
	`start_time` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `reminders_user_idx` ON `reminders` (`user_id`);--> statement-breakpoint
CREATE TABLE `user_favorites` (
	`user_id` integer NOT NULL,
	`channel_id` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_favorites_uq` ON `user_favorites` (`user_id`,`channel_id`);