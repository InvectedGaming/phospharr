CREATE TABLE `channels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`canonical_id` text,
	`name` text NOT NULL,
	`number` real,
	`logo_url` text,
	`category` text,
	`is_hidden` integer DEFAULT false NOT NULL,
	`is_favorite` integer DEFAULT false NOT NULL,
	`hidden_reason` text
);
--> statement-breakpoint
CREATE INDEX `channels_canonical_idx` ON `channels` (`canonical_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `channels_number_idx` ON `channels` (`number`);--> statement-breakpoint
CREATE TABLE `multiview_tiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`multiview_id` integer NOT NULL,
	`channel_id` integer NOT NULL,
	`position` integer NOT NULL,
	FOREIGN KEY (`multiview_id`) REFERENCES `multiviews`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `multiview_tiles_mv_idx` ON `multiview_tiles` (`multiview_id`);--> statement-breakpoint
CREATE TABLE `multiviews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`number` real,
	`layout` text DEFAULT 'auto' NOT NULL,
	`audio_channel_id` integer,
	`mode` text DEFAULT 'client' NOT NULL,
	`is_auto` integer DEFAULT false NOT NULL,
	`expires_at` integer
);
--> statement-breakpoint
CREATE TABLE `programs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`canonical_id` text NOT NULL,
	`title` text NOT NULL,
	`subtitle` text,
	`description` text,
	`start_time` integer NOT NULL,
	`end_time` integer NOT NULL,
	`category` text,
	`season` integer,
	`episode` integer,
	`epg_source` text,
	`icon_url` text
);
--> statement-breakpoint
CREATE INDEX `programs_lookup_idx` ON `programs` (`canonical_id`,`start_time`);--> statement-breakpoint
CREATE TABLE `providers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`url` text NOT NULL,
	`username` text,
	`password` text,
	`max_connections` integer DEFAULT 1 NOT NULL,
	`epg_url` text,
	`priority` integer DEFAULT 100 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_synced_at` integer
);
--> statement-breakpoint
CREATE TABLE `rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`condition` text NOT NULL,
	`action` text NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `streams` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` integer NOT NULL,
	`provider_id` integer NOT NULL,
	`url` text NOT NULL,
	`raw_name` text NOT NULL,
	`resolution` integer,
	`fps` real,
	`bitrate` integer,
	`codec` text,
	`health` text DEFAULT 'unknown' NOT NULL,
	`last_probed_at` integer,
	`quality_score` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `streams_channel_idx` ON `streams` (`channel_id`);--> statement-breakpoint
CREATE INDEX `streams_provider_idx` ON `streams` (`provider_id`);