CREATE TABLE `vod_episodes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`series_row_id` integer NOT NULL,
	`season` integer NOT NULL,
	`episode` integer NOT NULL,
	`title` text,
	`stream_id` integer NOT NULL,
	`ext` text DEFAULT 'mp4' NOT NULL,
	`plot` text,
	`duration_sec` integer,
	FOREIGN KEY (`series_row_id`) REFERENCES `vod_series`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `vod_episodes_series_idx` ON `vod_episodes` (`series_row_id`);--> statement-breakpoint
CREATE TABLE `vod_movies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider_id` integer NOT NULL,
	`stream_id` integer NOT NULL,
	`name` text NOT NULL,
	`year` integer,
	`category` text,
	`poster_url` text,
	`ext` text DEFAULT 'mp4' NOT NULL,
	`rating` real,
	`plot` text,
	`duration_sec` integer,
	`added_at` integer,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vod_movies_prov_stream_uq` ON `vod_movies` (`provider_id`,`stream_id`);--> statement-breakpoint
CREATE INDEX `vod_movies_name_idx` ON `vod_movies` (`name`);--> statement-breakpoint
CREATE TABLE `vod_series` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider_id` integer NOT NULL,
	`series_id` integer NOT NULL,
	`name` text NOT NULL,
	`year` integer,
	`category` text,
	`poster_url` text,
	`plot` text,
	`episodes_cached_at` integer,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `vod_series_prov_series_uq` ON `vod_series` (`provider_id`,`series_id`);--> statement-breakpoint
CREATE INDEX `vod_series_name_idx` ON `vod_series` (`name`);