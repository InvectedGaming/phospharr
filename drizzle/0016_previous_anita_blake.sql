ALTER TABLE `view_events` ADD `user_id` integer REFERENCES users(id);--> statement-breakpoint
CREATE INDEX `view_events_user_started_idx` ON `view_events` (`user_id`,`started_at`);