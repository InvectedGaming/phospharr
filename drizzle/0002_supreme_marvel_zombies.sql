DROP INDEX IF EXISTS `programs_lookup_idx`;--> statement-breakpoint
CREATE UNIQUE INDEX `programs_canonical_start_uq` ON `programs` (`canonical_id`,`start_time`);