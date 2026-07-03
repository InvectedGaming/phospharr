ALTER TABLE `channels` ADD `kind` text;--> statement-breakpoint
ALTER TABLE `channels` ADD `genre` text;--> statement-breakpoint
ALTER TABLE `channels` ADD `tax_locked` integer DEFAULT false NOT NULL;