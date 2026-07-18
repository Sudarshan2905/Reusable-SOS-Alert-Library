-- ==========================================================
-- SOS Library Database Schema
-- Database : standard_db
-- ==========================================================

USE standard_db;

-- ==========================================================
-- Table : sosalerts
-- Purpose:
-- Stores predefined SOS alert reasons displayed in the popup.
-- ==========================================================

DROP TABLE IF EXISTS sosalerts;

CREATE TABLE sosalerts (
    recid INT NOT NULL AUTO_INCREMENT,
    machineid VARCHAR(100) DEFAULT NULL,
    alert VARCHAR(255) NOT NULL,
    tscreated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (recid),

    INDEX idx_alert (alert),
    INDEX idx_machine (machineid)
);

-- ==========================================================
-- Table : sosalert_history
-- Purpose:
-- Stores every SOS alert submitted from the application.
-- ==========================================================

DROP TABLE IF EXISTS sosalert_history;

CREATE TABLE sosalert_history (
    recid INT NOT NULL AUTO_INCREMENT,
    machineid VARCHAR(100) DEFAULT NULL,
    alert VARCHAR(255) NOT NULL,
    tscreated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (recid),

    INDEX idx_machine (machineid),
    INDEX idx_created (tscreated),
    INDEX idx_alert (alert)
);

-- ==========================================================
-- Verify Tables
-- ==========================================================

DESC sosalerts;
DESC sosalert_history;