-- Result of the daily broker audit (jobs/tasks/brokerAudit.js), shown on the device page.
--
-- The audit compares what the broker actually holds, from one dynsec listRoles call, with the ACLs
-- mqtt/topics.deviceAcls says each provisioned device should have. The failure it exists for is a
-- role missing its publishClientReceive ACL: the broker defaults receive to deny, so that device
-- subscribes successfully and then silently never receives a command, and nothing else reports it.
--
-- broker_fault: NULL when the last audit found nothing wrong, otherwise a sentence for the page.
-- broker_checked_epoch: when the audit last looked at this row, so the page can say how fresh it is.
ALTER TABLE DTM_device_credentials ADD broker_fault NVARCHAR(300) NULL, broker_checked_epoch BIGINT NULL;
