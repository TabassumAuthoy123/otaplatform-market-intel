-- ============================================================================
--  OTA Platform — Market Intelligence  ·  MySQL 8 DDL
--  Plain SQL mirror of prisma/schema.prisma, for handing to the dev/DBA team
--  or importing straight into the existing OTAPlatform MySQL container.
--
--  Run from the OTAPlatform folder (that is where the `mysql` service lives):
--    docker compose exec -T mysql mysql -uroot -proot < db/schema.sql
--  Creates a SEPARATE `ota_market_intel` database — the `otaplatform` database
--  is not touched.
-- ============================================================================

CREATE DATABASE IF NOT EXISTS `ota_market_intel`
  DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `ota_market_intel`;

-- ----------------------------------------------------------- reference ------

CREATE TABLE IF NOT EXISTS `divisions` (
  `id`   INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(64)  NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_divisions_name` (`name`)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `districts` (
  `id`          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`        VARCHAR(64)  NOT NULL,
  `division_id` INT UNSIGNED NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_districts_name` (`name`),
  KEY `ix_districts_division` (`division_id`),
  CONSTRAINT `fk_districts_division` FOREIGN KEY (`division_id`)
    REFERENCES `divisions` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `clusters` (
  `id`          VARCHAR(48) NOT NULL,
  `name`        VARCHAR(160) NOT NULL,
  `district_id` INT UNSIGNED NOT NULL,
  `landmarks`   JSON NULL COMMENT 'Named buildings for the walk-the-floors plan',
  `phase`       TINYINT UNSIGNED NOT NULL DEFAULT 1,
  `note`        TEXT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_clusters_district` (`district_id`),
  CONSTRAINT `fk_clusters_district` FOREIGN KEY (`district_id`)
    REFERENCES `districts` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `segments` (
  `code`          VARCHAR(4)   NOT NULL,
  `name`          VARCHAR(180) NOT NULL,
  `short_name`    VARCHAR(64)  NOT NULL,
  `description`   TEXT         NOT NULL,
  `priority_rank` TINYINT UNSIGNED NOT NULL,
  `tier_hint`     VARCHAR(64) NULL,
  PRIMARY KEY (`code`)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `sales_reps` (
  `id`         INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`       VARCHAR(120) NOT NULL,
  `email`      VARCHAR(160) NULL,
  `phone`      VARCHAR(32)  NULL,
  `active`     TINYINT(1)   NOT NULL DEFAULT 1,
  `created_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_reps_email` (`email`)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- core ------

CREATE TABLE IF NOT EXISTS `agencies` (
  `id`                     VARCHAR(16)  NOT NULL,
  `name`                   VARCHAR(200) NOT NULL,
  `address`                TEXT         NOT NULL,
  `cluster_id`             VARCHAR(48)  NOT NULL,

  -- contact
  `phone`                  VARCHAR(32)  NULL COMMENT 'NULL = not published; collect on call',
  `alt_phones`             JSON         NULL,
  `whatsapp`               VARCHAR(32)  NULL,
  `website`                VARCHAR(255) NULL,
  `facebook`               VARCHAR(255) NULL,
  `email`                  VARCHAR(160) NULL,

  -- classification
  `segment_code`           VARCHAR(4)   NOT NULL,
  `segment_secondary_code` VARCHAR(4)   NULL,
  `priority`               ENUM('A','B','C','X') NOT NULL,
  `exclusion_reason`       ENUM('has_own_platform','building_in_house','is_competitor','compliance_risk') NULL,

  -- credentials
  `caab_licence`           ENUM('verified','inferred','unknown','none') NOT NULL DEFAULT 'unknown'
                           COMMENT 'Ministry of Civil Aviation & Tourism travel-agency licence via TAMS',
  `caab_licence_no`        VARCHAR(32) NULL,
  `iata`                   ENUM('verified','inferred','unknown','none') NOT NULL DEFAULT 'unknown',
  `iata_no`                VARCHAR(32) NULL,
  `atab`                   ENUM('verified','inferred','unknown','none') NOT NULL DEFAULT 'unknown',
  `atab_no`                VARCHAR(32) NULL,
  `hajj_licence`           ENUM('verified','inferred','unknown','none') NOT NULL DEFAULT 'unknown',
  `creds_verified_at`      DATETIME NULL COMMENT 'Set only after checking the official portal',

  -- commercial signals
  `sales_mode`             ENUM('manual','sub_agent','own_platform','unknown') NOT NULL DEFAULT 'unknown',
  `has_own_platform`       TINYINT(1) NOT NULL DEFAULT 0,
  `current_system`         VARCHAR(120) NULL,
  `current_supplier`       VARCHAR(120) NULL,
  `review_count`           INT NULL COMMENT 'Public review count — scale proxy',
  `rating`                 DECIMAL(2,1) NULL,
  `open_247`               TINYINT(1) NOT NULL DEFAULT 0,
  `signal`                 TEXT NOT NULL,
  `monthly_bookings`       INT NULL,
  `staff_count`            INT NULL,
  `branch_count`           INT NULL,
  `sub_agent_count`        INT NULL,
  `suggested_tier`         ENUM('Starter','Growth','Professional','Hajj','Enterprise') NULL,

  -- CRM
  `stage`                  ENUM('not_contacted','attempted','discovery','demo_booked','demo_done',
                                'proposal_sent','negotiation','won','lost','disqualified')
                           NOT NULL DEFAULT 'not_contacted',
  `last_contacted_at`      DATETIME NULL,
  `next_action_at`         DATETIME NULL,
  `owner_rep_id`           INT UNSIGNED NULL,

  -- compliance
  `compliance_flag`        TINYINT(1) NOT NULL DEFAULT 0,
  `compliance_note`        TEXT NULL,
  `onboarding_approved`    TINYINT(1) NOT NULL DEFAULT 0,

  `created_at`             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  PRIMARY KEY (`id`),
  KEY `ix_agencies_cluster`   (`cluster_id`),
  KEY `ix_agencies_segment`   (`segment_code`),
  KEY `ix_agencies_priority`  (`priority`),
  KEY `ix_agencies_stage`     (`stage`),
  KEY `ix_agencies_caab`      (`caab_licence`),
  KEY `ix_agencies_iata`      (`iata`),
  KEY `ix_agencies_platform`  (`has_own_platform`),
  FULLTEXT KEY `ft_agencies`  (`name`,`address`,`signal`),
  CONSTRAINT `fk_agencies_cluster`   FOREIGN KEY (`cluster_id`)   REFERENCES `clusters` (`id`)   ON DELETE RESTRICT,
  CONSTRAINT `fk_agencies_segment`   FOREIGN KEY (`segment_code`) REFERENCES `segments` (`code`) ON DELETE RESTRICT,
  CONSTRAINT `fk_agencies_segment2`  FOREIGN KEY (`segment_secondary_code`) REFERENCES `segments` (`code`) ON DELETE SET NULL,
  CONSTRAINT `fk_agencies_rep`       FOREIGN KEY (`owner_rep_id`) REFERENCES `sales_reps` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `contacts` (
  `id`                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `agency_id`         VARCHAR(16)  NOT NULL,
  `name`              VARCHAR(120) NOT NULL,
  `designation`       VARCHAR(120) NULL,
  `phone`             VARCHAR(32)  NULL,
  `whatsapp`          VARCHAR(32)  NULL,
  `email`             VARCHAR(160) NULL,
  `is_decision_maker` TINYINT(1)   NOT NULL DEFAULT 0,
  `best_time_to_call` VARCHAR(64)  NULL,
  `language_pref`     VARCHAR(32)  NULL,
  `gatekeeper_name`   VARCHAR(120) NULL,
  `created_at`        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_contacts_agency` (`agency_id`),
  CONSTRAINT `fk_contacts_agency` FOREIGN KEY (`agency_id`)
    REFERENCES `agencies` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `activities` (
  `id`          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `agency_id`   VARCHAR(16)  NOT NULL,
  `rep_id`      INT UNSIGNED NULL,
  `type`        ENUM('call','whatsapp','email','visit','demo','note') NOT NULL,
  `outcome`     VARCHAR(160) NULL,
  `objection`   TEXT NULL COMMENT "Objection in the prospect's own words",
  `notes`       TEXT NULL,
  `occurred_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_activities_agency` (`agency_id`),
  KEY `ix_activities_when`   (`occurred_at`),
  CONSTRAINT `fk_activities_agency` FOREIGN KEY (`agency_id`) REFERENCES `agencies` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_activities_rep`    FOREIGN KEY (`rep_id`)    REFERENCES `sales_reps` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `deals` (
  `id`                INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `agency_id`         VARCHAR(16) NOT NULL,
  `tier`              ENUM('Starter','Growth','Professional','Hajj','Enterprise') NOT NULL,
  `monthly_bdt`       INT UNSIGNED NOT NULL,
  `setup_bdt`         INT UNSIGNED NOT NULL,
  `discount_pct`      TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `referenceable`     TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'Right to a named case study granted',
  `stage`             ENUM('not_contacted','attempted','discovery','demo_booked','demo_done',
                           'proposal_sent','negotiation','won','lost','disqualified')
                      NOT NULL DEFAULT 'proposal_sent',
  `expected_close_at` DATE NULL,
  `closed_at`         DATE NULL,
  `created_at`        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_deals_agency` (`agency_id`),
  KEY `ix_deals_stage`  (`stage`),
  CONSTRAINT `fk_deals_agency` FOREIGN KEY (`agency_id`)
    REFERENCES `agencies` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `data_sources` (
  `id`          INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `agency_id`   VARCHAR(16) NULL,
  `source_type` VARCHAR(48) NOT NULL COMMENT 'business_listing | tams | hajj_gov_bd | atab | iata_portal | field_visit',
  `source_ref`  VARCHAR(255) NULL,
  `captured_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `note`        TEXT NULL,
  PRIMARY KEY (`id`),
  KEY `ix_sources_agency` (`agency_id`)
) ENGINE=InnoDB;

-- ------------------------------------------------------------- views -------
-- The two headline numbers the CEO dashboard shows.

CREATE OR REPLACE VIEW `v_credential_summary` AS
SELECT
  COUNT(*)                                                            AS total_agencies,
  SUM(caab_licence IN ('verified','inferred'))                        AS civil_aviation_held,
  SUM(caab_licence = 'verified')                                      AS civil_aviation_verified,
  SUM(iata IN ('verified','inferred'))                                AS iata_held,
  SUM(iata = 'verified')                                              AS iata_verified,
  SUM(hajj_licence IN ('verified','inferred'))                        AS hajj_held,
  SUM(has_own_platform = 0 AND priority <> 'X')                       AS target_pool_no_platform,
  SUM(priority = 'X')                                                 AS excluded
FROM `agencies`;

CREATE OR REPLACE VIEW `v_cluster_rollup` AS
SELECT
  c.id            AS cluster_id,
  c.name          AS cluster_name,
  d.name          AS district,
  c.phase,
  COUNT(a.id)                          AS agencies,
  SUM(a.priority = 'A')                AS priority_a,
  SUM(a.priority = 'B')                AS priority_b,
  SUM(a.priority = 'C')                AS priority_c,
  SUM(a.iata IN ('verified','inferred')) AS iata_held,
  SUM(a.has_own_platform = 0 AND a.priority <> 'X') AS targetable
FROM `clusters` c
JOIN `districts` d ON d.id = c.district_id
LEFT JOIN `agencies` a ON a.cluster_id = c.id
GROUP BY c.id, c.name, d.name, c.phase
ORDER BY agencies DESC;

CREATE OR REPLACE VIEW `v_call_sheet` AS
SELECT
  a.id, a.name, c.name AS cluster, a.address, a.phone, a.priority,
  a.segment_code, a.suggested_tier, a.signal, a.stage, a.next_action_at
FROM `agencies` a
JOIN `clusters` c ON c.id = a.cluster_id
WHERE a.priority IN ('A','B') AND a.has_own_platform = 0
ORDER BY FIELD(a.priority,'A','B'), c.name, a.name;
