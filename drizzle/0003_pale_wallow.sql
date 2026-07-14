DROP INDEX `smtp_configs_user_uq`;--> statement-breakpoint
ALTER TABLE `smtp_configs` ADD `label` text;--> statement-breakpoint
ALTER TABLE `smtp_configs` ADD `is_default` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `smtp_configs` ADD `deleted_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `smtp_configs_user_default_uq` ON `smtp_configs` (`user_id`) WHERE "smtp_configs"."is_default" = 1;