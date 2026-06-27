CREATE TABLE `attachments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`campaign_id` integer NOT NULL,
	`send_record_id` integer NOT NULL,
	`filename` text NOT NULL,
	`storage_path` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`send_record_id`) REFERENCES `send_records`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`recipient_set_id` integer NOT NULL,
	`template_id` integer NOT NULL,
	`smtp_config_id` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`worker_id` text,
	`lease_expires_at` integer,
	`total` integer DEFAULT 0 NOT NULL,
	`sent_count` integer DEFAULT 0 NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`recipient_set_id`) REFERENCES `recipient_sets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`template_id`) REFERENCES `templates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`smtp_config_id`) REFERENCES `smtp_configs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `recipient_sets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`filename` text NOT NULL,
	`columns_json` text NOT NULL,
	`row_count` integer NOT NULL,
	`storage_path` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `send_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`campaign_id` integer NOT NULL,
	`to_addr` text NOT NULL,
	`merged_subject` text NOT NULL,
	`merged_body` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`message_id` text,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`sent_at` integer,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `send_records_campaign_addr_uq` ON `send_records` (`campaign_id`,`to_addr`);--> statement-breakpoint
CREATE TABLE `smtp_configs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`host` text NOT NULL,
	`port` integer NOT NULL,
	`secure` integer NOT NULL,
	`username` text NOT NULL,
	`password_enc` blob NOT NULL,
	`password_iv` blob NOT NULL,
	`password_tag` blob NOT NULL,
	`from_addr` text NOT NULL,
	`from_name` text,
	`verified_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `templates` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
