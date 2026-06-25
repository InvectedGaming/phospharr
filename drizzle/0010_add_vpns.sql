CREATE TABLE `vpns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`config` text NOT NULL,
	`username` text,
	`password` text,
	`autostart` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL
);
