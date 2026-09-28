-- Support requests from the Help modal (DECISIONS.md "Support requests"): the page the requester
-- was on when they asked. page_url is a path on this site (starting with one "/"), never a full URL.
ALTER TABLE support_requests ADD COLUMN page_url VARCHAR(500) NULL;
ALTER TABLE support_requests ADD COLUMN page_title VARCHAR(200) NULL;
