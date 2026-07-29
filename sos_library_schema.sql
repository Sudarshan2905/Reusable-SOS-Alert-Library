/* ==========================================================
   SOS Alert Library - Demo Database
   ----------------------------------------------------------
   This SQL file creates the minimum database objects required
   to run the SOS Alert Library.

   Tables
   -------
   1. sosalerts
      Master table containing predefined SOS alert reasons.

   2. alert_dispatch
      Stores every alert submitted from the SOS Library.

   Import:
       mysql < database.sql

   ========================================================== */

SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS alert_dispatch;
DROP TABLE IF EXISTS sosalerts;

SET FOREIGN_KEY_CHECKS = 1;





/* ==========================================================
   MASTER TABLE
   Stores predefined SOS alert reasons.
   ========================================================== */

CREATE TABLE sosalerts
(
    recid INT NOT NULL AUTO_INCREMENT,
    alert VARCHAR(255) NOT NULL,
    tscreated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (recid),

    INDEX idx_alert (alert)
);





/* ==========================================================
   SAMPLE ALERTS
   ========================================================== */

INSERT INTO sosalerts (alert)
VALUES
    ('Oil Leakage'),
    ('Needle Broken'),
    ('Machine Jam'),
    ('Power Failure'),
    ('Emergency Stop');





/* ==========================================================
   ALERT DISPATCH
   Stores every alert generated from the SOS Library.

   source
       Name of the master table.

   source_recid
       Primary key of the master table.
       NULL when the alert is custom/free text.

   alert_type
       Library/module identifier.

   alert_text
       Final alert message including context.

   sent_on
       Business date.

   tscreated
       Insert timestamp.

   ========================================================== */

CREATE TABLE alert_dispatch
(
    recid BIGINT NOT NULL AUTO_INCREMENT,

    source VARCHAR(64) NOT NULL,

    source_recid BIGINT NULL,

    alert_type VARCHAR(32) NOT NULL,

    alert_text VARCHAR(500) NOT NULL,

    channel VARCHAR(32) DEFAULT NULL,

    sent_on DATE NOT NULL,

    sent_to VARCHAR(255) DEFAULT NULL,

    status VARCHAR(16) NOT NULL DEFAULT 'sent',

    tscreated TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

    PRIMARY KEY (recid),

    INDEX idx_source (source),

    INDEX idx_source_recid (source_recid),

    INDEX idx_status (status),

    INDEX idx_sent_on (sent_on)
);





/* ==========================================================
   SAMPLE DATA
   ========================================================== */

INSERT INTO alert_dispatch
(
    source,
    source_recid,
    alert_type,
    alert_text,
    sent_on
)
VALUES

(
    'sosalerts',
    1,
    'sos_alert',
    'Oil Leakage, ST-1, Printing',
    CURDATE()
),

(
    'sosalerts',
    2,
    'sos_alert',
    'Needle Broken, ST-2, Printing',
    CURDATE()
),

(
    'sosalerts',
    5,
    'sos_alert',
    'Emergency Stop, ST-5, Packing',
    CURDATE()
),

(
    'sosalerts',
    NULL,
    'sos_alert',
    'Machine not working near feeder, ST-1, Printing',
    CURDATE()
);